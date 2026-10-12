// Plugin Google Flow: video con Google Veo e immagini con Imagen/Nano, tramite gflow-cli (https://github.com/ffroliva/gflow-cli, MIT).
// gflow gira in un container (services/gflow): Chromium con uno schermo virtuale, perche' Google Flow rifiuta i browser headless.
// - Il primo accesso con Google si fa in una sessione noVNC che AgiCloud inoltra al browser (/flow-novnc/<chiave>/...); i cookie
//   restano nel profilo di gflow, in data/gflow, e dopo non serve piu' accedere.
// - Le creazioni finiscono in data/flow-output e si vedono nella galleria; gli agenti generano con gli strumenti MCP (flow-mcp.ts).
// Serve Docker sul server: negli ambienti utente (container senza Docker) il plugin risulta non disponibile.

import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { PluginSpec } from './plugins.js';
import type { UpgradeHandler } from './terminal-socket.js';

const run = promisify(execFile);
const IMAGE = process.env.GFLOW_IMAGE || 'agicloud-gflow:latest';
const DATA = join(config.threadsDir, '..', 'gflow');
const OUTPUT = join(config.threadsDir, '..', 'flow-output');
// Il nome include la porta: una seconda istanza di AgiCloud (prove) non tocca i container dell'istanza vera
const LOGIN_CONTAINER = `agicloud-gflow-login-${config.port}`;
const LOGIN_MS = 15 * 60_000;
// Un solo container Flow alla volta: tutti usano lo stesso profilo di Chromium, che non si apre due volte insieme
const MAX_RUNNING = 1;

/** Modelli e formati veri di gflow-cli (gflow models) */
export const FLOW_MODELS = [
  { id: 'omni-flash', kind: 'video', label: 'Omni Flash' },
  { id: 'veo-fast', kind: 'video', label: 'Veo 3.1 Fast' },
  { id: 'veo-quality', kind: 'video', label: 'Veo 3.1 Quality' },
  { id: 'veo-lite', kind: 'video', label: 'Veo 3.1 Lite' },
  { id: 'nano2', kind: 'image', label: 'Nano 2' },
  { id: 'nano-pro', kind: 'image', label: 'Nano Pro' },
  { id: 'imagen4', kind: 'image', label: 'Imagen 4' },
  { id: 'nano2-lite', kind: 'image', label: 'Nano 2 Lite' },
] as const;
export const FLOW_ASPECTS = { video: ['16:9', '9:16'], image: ['16:9', '9:16', '1:1', '4:3', '3:4'] } as const;

export type FlowKind = 'video' | 'image';

export interface FlowJob {
  job: string;
  kind: FlowKind;
  model: string;
  aspect: string;
  prompt: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  error?: string;
}

function ensureDirs(): void {
  mkdirSync(join(DATA, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(OUTPUT, { recursive: true });
}

/** Argomenti comuni di docker run: utente non privilegiato, risorse limitate, solo i due volumi del plugin */
export function dockerBase(extra: string[], opts: { detach?: boolean } = {}): string[] {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return [
    'run', ...(opts.detach ? ['-d'] : []), '--rm',
    '--user', `${uid}:${gid}`,
    '--memory', '2g', '--memory-swap', '2g', '--shm-size', '1g', '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', `${DATA}:/data/gflow`,
    '-v', `${OUTPUT}:/out`,
    ...extra,
  ];
}

/** Comando gflow per generare (nomi di opzioni di gflow-cli 0.83) */
export function gflowArgs(kind: FlowKind, model: string, aspect: string, prompt: string): string[] {
  return kind === 'video'
    ? ['video', 't2v', '--model', model, '--aspect', aspect, '--out-dir', '/out', '--json', prompt]
    : ['image', 't2i', '--model', model, '--aspect', aspect, '--out', '/out', '--json', prompt];
}

let imageCache: { at: number; ok: boolean } = { at: 0, ok: false };
async function dockerReady(): Promise<boolean> {
  if (Date.now() - imageCache.at < 30_000) return imageCache.ok;
  let ok = false;
  try {
    await run('docker', ['image', 'inspect', IMAGE], { timeout: 8000 });
    ok = true;
  } catch {
    ok = false;
  }
  imageCache = { at: Date.now(), ok };
  return ok;
}

/** Account Google collegato: lo scrive gflow nel profilo dopo un accesso verificato */
function linkedAccount(): { email: string; profile: string } | null {
  try {
    for (const dir of readdirSync(DATA).filter((d) => d.startsWith('profile_'))) {
      const f = join(DATA, dir, '.gflow_account');
      if (existsSync(f)) {
        const email = readFileSync(f, 'utf8').trim();
        if (email) return { email, profile: dir.slice('profile_'.length) };
      }
    }
  } catch {
    /* nessun profilo */
  }
  return null;
}

// Crediti: leggerli apre il browser (qualche decina di secondi), quindi si tiene l'ultimo valore
let credits: { n: number | null; at: number } = { n: null, at: 0 };
async function readCredits(force = false): Promise<number | null> {
  if (!linkedAccount()) return null;
  if (!force && credits.at && Date.now() - credits.at < 10 * 60_000) return credits.n;
  ensureDirs();
  try {
    const { stdout } = await run('docker', [...dockerBase([IMAGE]), 'credits', 'list'], { timeout: 90_000 });
    const m = /Total credits:\s*([\d.,]+)/i.exec(stdout);
    credits = { n: m ? Number(m[1]!.replace(/[.,]/g, '')) : null, at: Date.now() };
  } catch {
    credits = { n: null, at: Date.now() };
  }
  return credits.n;
}

// ── Accesso con Google: sessione noVNC temporanea ──────────────────────────
let login: { key: string; port: number; startedAt: number } | null = null;
let loginTimer: NodeJS.Timeout | undefined;

const loginUrl = (key: string) => `/flow-novnc/${key}/vnc.html?autoconnect=1&resize=scale&reconnect=1`; // noVNC cerca websockify accanto alla pagina

async function loginRunning(): Promise<boolean> {
  try {
    const { stdout } = await run('docker', ['ps', '-q', '--filter', `name=^${LOGIN_CONTAINER}$`], { timeout: 8000 });
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

async function stopLogin(): Promise<void> {
  clearTimeout(loginTimer);
  login = null;
  await run('docker', ['rm', '-f', LOGIN_CONTAINER], { timeout: 20_000 }).catch(() => {});
}

async function startLogin(): Promise<{ url: string }> {
  if (login && (await loginRunning())) return { url: loginUrl(login.key) };
  if (running.size > 0) throw new HttpError(409, "C'e' una generazione in corso: aspetta che finisca prima di accedere");
  await stopLogin();
  ensureDirs();
  // La porta di noVNC resta su 127.0.0.1: all'utente arriva solo tramite l'indirizzo con la chiave segreta
  await run('docker', dockerBase(['--name', LOGIN_CONTAINER, '-p', '127.0.0.1::6080', IMAGE, 'login'], { detach: true }), { timeout: 60_000 }).catch((err) => {
    throw new HttpError(409, `Avvio dell'accesso non riuscito: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  });
  // porta pubblicata da Docker, qualche istante dopo l'avvio
  let port = 0;
  for (let i = 0; i < 20 && !port; i++) {
    try {
      const { stdout } = await run('docker', ['port', LOGIN_CONTAINER, '6080/tcp'], { timeout: 5000 });
      port = Number(/:(\d+)\s*$/m.exec(stdout.trim())?.[1] ?? 0);
    } catch {
      /* ancora in avvio */
    }
    if (!port) await new Promise((r) => setTimeout(r, 500));
  }
  // La porta e' pubblicata prima che noVNC sia pronto: si aspetta che risponda, altrimenti la prima apertura dell'indirizzo da' "Bad gateway"
  let ready = false;
  for (let i = 0; i < 60 && port && !ready; i++) {
    ready = await fetch(`http://127.0.0.1:${port}/vnc.html`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 500));
  }
  if (!port || !ready) {
    await stopLogin();
    throw new HttpError(409, 'Accesso non avviato: la sessione grafica non risponde');
  }
  login = { key: randomBytes(16).toString('hex'), port, startedAt: Date.now() };
  loginTimer = setTimeout(() => void stopLogin(), LOGIN_MS);
  loginTimer.unref();
  return { url: loginUrl(login.key) };
}

const keyOk = (key: string): boolean => {
  if (!login) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(login.key);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** WebSocket di noVNC verso il container di accesso (la chiave nell'indirizzo fa da password) */
export function flowUpgrade(isEnabled: () => boolean): UpgradeHandler {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const m = /^\/flow-novnc\/([0-9a-f]+)\/websockify(?:\?.*)?$/.exec(req.url ?? '');
    if (!m) return false;
    const origin = req.headers.origin;
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (!isEnabled() || !sameOrigin || !keyOk(m[1]!) || !login) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return true;
    }
    const up = connect(login.port, '127.0.0.1', () => {
      const lines = [`GET /websockify HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return true;
  };
}

/** Ultime righe utili del log dell'ultimo accesso (se non e' andato a buon fine): spiegano perche' resta "non collegato" */
function lastLoginProblem(): string | null {
  try {
    const f = join(DATA, 'login.log');
    if (Date.now() - statSync(f).mtimeMs > 60 * 60_000) return null;
    const lines = readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{"'));
    const i = lines.findLastIndex((l) => /^(Browser closed|Authentication credential missing|Flow sign-in not detected|Error)/i.test(l));
    return i < 0 ? null : lines.slice(i, i + 4).join(' ').slice(0, 400);
  } catch {
    return null;
  }
}

// ── Lavori di generazione ───────────────────────────────────────────────────
const running = new Set<string>();
const jobFile = (job: string) => join(OUTPUT, `${job}.job.json`);

function saveJob(j: FlowJob): void {
  writeFileSync(jobFile(j.job), JSON.stringify(j), { mode: 0o640 });
}

export function listJobs(): FlowJob[] {
  ensureDirs();
  const jobs: FlowJob[] = [];
  for (const f of readdirSync(OUTPUT).filter((x) => x.endsWith('.job.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(OUTPUT, f), 'utf8')) as FlowJob;
      // Un lavoro "in corso" che questo processo non conosce e' stato interrotto da un riavvio
      if (j.status === 'running' && !running.has(j.job)) Object.assign(j, { status: 'error', error: 'interrupted', endedAt: j.endedAt ?? Date.now() });
      jobs.push(j);
    } catch {
      /* file incompleto */
    }
  }
  return jobs.sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
}

/** Motivo dell'errore dall'uscita di gflow: il riquadro JSON finale ("title" e "detail") o l'ultima riga utile */
export function failureReason(output: string): string {
  const title = /"title":\s*"((?:[^"\\]|\\.)*)"/.exec(output.slice(output.lastIndexOf('"status"')))?.[1];
  const detail = /"detail":\s*"((?:[^"\\]|\\.)*)"/.exec(output.slice(output.lastIndexOf('"status"')))?.[1];
  if (title) return `${title}${detail ? `: ${detail}` : ''}`.replace(/\\"/g, '"').slice(0, 400);
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{') && !l.startsWith('}') && !/^[─━┃│┏┓┗┛┡┩╇╈-]+$/.test(l));
  return (lines.at(-1) ?? 'gflow ha fallito').slice(0, 300);
}

function startJob(kind: FlowKind, model: string, aspect: string, prompt: string): FlowJob {
  if (login) throw new HttpError(409, "Accesso in corso: completalo o annullalo prima di generare");
  if (running.size >= MAX_RUNNING) throw new HttpError(409, `Troppe generazioni in corso (max ${MAX_RUNNING}): aspetta che finisca`);
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const job = `${kind}-${stamp}-${randomBytes(3).toString('hex')}`;
  const j: FlowJob = { job, kind, model, aspect, prompt, status: 'running', startedAt: Date.now() };
  saveJob(j);
  running.add(job);
  let tail = '';
  const child = spawn('docker', [...dockerBase(['--name', `agicloud-gflow-${config.port}-${job}`, IMAGE, ...gflowArgs(kind, model, aspect, prompt)])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (d: Buffer) => (tail = (tail + d.toString()).slice(-6000));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const finish = (code: number | null, err?: string) => {
    running.delete(job);
    saveJob({ ...j, status: code === 0 ? 'done' : 'error', endedAt: Date.now(), ...(code === 0 ? {} : { error: err ?? failureReason(tail) }) });
  };
  child.on('error', (e) => finish(null, e.message));
  child.on('close', (code) => finish(code));
  return j;
}

function parseGenerate(body: Record<string, unknown>): { prompt: string; kind: FlowKind; model: string; aspect: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'Messaggio vuoto');
  if (prompt.length > 4000) throw new HttpError(400, 'Prompt troppo lungo (max 4000 caratteri)');
  const kind: FlowKind = body.kind === 'image' ? 'image' : 'video';
  const model = FLOW_MODELS.find((m) => m.id === body.model && m.kind === kind) ?? FLOW_MODELS.find((m) => m.kind === kind)!;
  const aspects = FLOW_ASPECTS[kind] as readonly string[];
  const aspect = aspects.includes(String(body.aspect)) ? String(body.aspect) : aspects[0]!;
  return { prompt, kind, model: model.id, aspect };
}

async function generate(body: Record<string, unknown>): Promise<FlowJob> {
  const g = parseGenerate(body);
  if (!(await dockerReady())) throw new HttpError(409, 'Motore Flow non disponibile sul server (immagine Docker mancante)');
  if (!linkedAccount()) throw new HttpError(409, 'Account Google non collegato: apri la sezione Flow e accedi');
  return startJob(g.kind, g.model, g.aspect, g.prompt);
}

function gallery(): { name: string; kind: FlowKind | 'text'; size: number; mtime: number }[] {
  ensureDirs();
  return readdirSync(OUTPUT)
    .filter((f) => !f.startsWith('.') && !f.endsWith('.job.json'))
    .map((f) => {
      const st = statSync(join(OUTPUT, f));
      const ext = f.split('.').pop()?.toLowerCase() ?? '';
      const kind: FlowKind | 'text' = ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : 'text';
      return { name: f, kind, size: st.size, mtime: st.mtimeMs };
    })
    .filter((f) => f.kind !== 'text')
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200);
}

export const flowPlugin: PluginSpec = {
  id: 'flow',
  name: 'Google Flow',
  version: '1.1.0',
  description:
    'Generazione video (Google Veo) e immagini (Imagen/Nano) con Google Flow. Fornisce gli strumenti MCP per gli agenti in chat e una galleria dedicata.',
  section: { id: 'flow', label: 'Flow' },
  credits: { text: 'gflow-cli di Flavio Oliva (MIT)', url: 'https://github.com/ffroliva/gflow-cli' },
  requires: 'Docker sul server e account Google con accesso a Flow',
  routes: ['/api/flow', '/flow-api', '/flow-novnc'],
  source: 'builtin',
  health: async () => {
    if (!(await dockerReady())) return { ok: false, detail: 'motore Flow non installato sul server (immagine agicloud-gflow)' };
    const account = linkedAccount();
    if (!account) return { ok: false, detail: 'account Google non collegato: apri la sezione Flow e accedi' };
    return { ok: true, detail: `collegato come ${account.email}` };
  },
  install: async () => {
    ensureDirs();
    if (!(await dockerReady())) throw new Error(`immagine Docker ${IMAGE} non trovata: costruiscila con "docker build -t agicloud-gflow:latest services/gflow"`);
  },
};

/** Token per gli strumenti degli agenti: in memoria, cambia a ogni avvio del server */
const AGENT_TOKEN = randomBytes(24).toString('hex');
const MCP_SCRIPT = new URL('./flow-mcp.ts', import.meta.url).pathname;
const TSX = import.meta.resolve('tsx');

export function flowMcpServer(): acp.McpServer {
  return {
    name: 'flow',
    command: process.execPath,
    args: ['--import', TSX, MCP_SCRIPT],
    env: [
      { name: 'AGICLOUD_FLOW_URL', value: `http://127.0.0.1:${config.port}/flow-api/run` },
      { name: 'AGICLOUD_FLOW_TOKEN', value: AGENT_TOKEN },
    ],
  };
}

export function registerFlow(app: Hono<any>): void {
  app.get('/api/flow/status', async (c) => {
    const account = linkedAccount();
    const loginOn = login && (await loginRunning()) ? { url: loginUrl(login.key) } : null;
    return c.json({
      docker: await dockerReady(),
      linked: Boolean(account),
      account: account?.email ?? null,
      credits: credits.n,
      login: loginOn,
      loginProblem: !account && !loginOn ? lastLoginProblem() : null,
      running: running.size,
    });
  });

  app.post('/api/flow/credits', async (c) => c.json({ credits: await readCredits(true) }));

  // Accesso con Google: avvia la sessione grafica; l'interfaccia apre l'indirizzo e controlla lo stato finche' l'account risulta collegato
  app.post('/api/flow/login', async (c) => {
    if (!(await dockerReady())) throw new HttpError(409, 'Motore Flow non disponibile sul server (immagine Docker mancante)');
    return c.json(await startLogin());
  });
  app.delete('/api/flow/login', async (c) => {
    await stopLogin();
    return c.json({ ok: true });
  });

  app.get('/api/flow/models', (c) => c.json({ models: FLOW_MODELS, aspects: FLOW_ASPECTS }));
  app.get('/api/flow/gallery', (c) => c.json({ files: gallery(), jobs: listJobs() }));

  app.get('/api/flow/raw', (c) => {
    const name = basename(String(c.req.query('name') ?? ''));
    if (!name || name.startsWith('.')) throw new HttpError(400, 'Nome non valido');
    const path = join(OUTPUT, name);
    if (!path.startsWith(OUTPUT + '/') || !existsSync(path)) throw new HttpError(404, 'Non trovato');
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const mime = ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
    c.header('Content-Type', mime);
    c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    return c.body(new Uint8Array(readFileSync(path)));
  });

  app.post('/api/flow/generate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const j = await generate(body);
    return c.json({ job: j.job, model: j.model, aspect: j.aspect }, 202);
  });

  // Pagine di noVNC per l'accesso: passano dalla chiave nell'indirizzo, senza il token di AgiCloud (si apre in una scheda nuova)
  app.all('/flow-novnc/:key/*', async (c) => {
    if (!keyOk(c.req.param('key')) || !login) return c.text('Not found', 404);
    const rest = new URL(c.req.url).pathname.replace(/^\/flow-novnc\/[0-9a-f]+\//, '');
    const get = () => fetch(`http://127.0.0.1:${login!.port}/${rest}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const upstream = (await get()) ?? (await new Promise((r) => setTimeout(r, 1500)).then(get));
    if (!upstream) return c.text('Bad gateway', 502);
    // noVNC e' una pagina con uno script in linea e un WebSocket: serve una CSP piu' larga, solo per questo percorso
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'";
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': csp } });
  });

  // Dagli strumenti degli agenti (token proprio, mai il token di AgiCloud)
  app.post('/flow-api/run', async (c) => {
    if (c.req.header('x-flow-token') !== AGENT_TOKEN) return c.json({ error: 'Token non valido' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? 'generate');
    if (action === 'credits') return c.json({ linked: Boolean(linkedAccount()), credits: await readCredits() });
    if (action === 'gallery') return c.json({ files: gallery(), jobs: listJobs() });
    const j = await generate(body);
    return c.json({ job: j.job, model: j.model, aspect: j.aspect, note: 'avviato: il file compare nella galleria Flow a generazione finita' }, 202);
  });
}
