// Plugin Google Flow: video con Google Veo e immagini con Imagen/Nano via gflow-cli
// (https://github.com/ffroliva/gflow-cli, MIT), come nel container agicloud-gflow.
// - Il profilo autenticato di gflow sta in data/gflow (login e sessione restano dopo i riavvii).
// - Le creazioni finiscono in data/flow-output e si vedono nella galleria della sezione Flow.
// - Gli agenti generano con gli strumenti MCP (server flow-mcp.ts, token proprio in memoria).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { PluginSpec } from './plugins.js';

const GFLOW = process.env.GFLOW_BIN || 'gflow';
const DATA = join(config.threadsDir, '..', 'gflow');
const OUTPUT = join(config.threadsDir, '..', 'flow-output');
const ACCOUNT_FILE = join(DATA, 'account.json');

export const FLOW_MODELS = [
  { id: 'omni_flash', kind: 'video', label: 'Omni Flash (video veloce)' },
  { id: 'veo_3_1_fast', kind: 'video', label: 'Veo 3.1 Fast' },
  { id: 'veo_3_1_quality', kind: 'video', label: 'Veo 3.1 Quality' },
  { id: 'nano2', kind: 'image', label: 'Nano 2 (immagine)' },
  { id: 'imagen4', kind: 'image', label: 'Imagen 4 (immagine)' },
] as const;

export type FlowKind = 'video' | 'image';

function ensureDirs(): void {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  mkdirSync(OUTPUT, { recursive: true });
}

function linkedAccount(): { email: string } | null {
  try {
    const raw = readFileSync(ACCOUNT_FILE, 'utf8');
    const j = JSON.parse(raw) as { email?: unknown };
    return typeof j.email === 'string' && j.email ? { email: j.email } : null;
  } catch {
    return null;
  }
}

function gflowAvailable(): boolean {
  try {
    execFileSync(GFLOW, ['--version'], { timeout: 8000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Crediti residui letti da gflow (se collegato); null quando non si riesce a leggerli */
function readCredits(): number | null {
  try {
    const out = execFileSync(GFLOW, ['credits'], { timeout: 15000, encoding: 'utf8' });
    const m = out.match(/(\d[\d.,]*)/);
    if (!m) return null;
    const n = Number(m[1]!.replace(/[.](?=\d{3}\b)/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export const flowPlugin: PluginSpec = {
  id: 'flow',
  name: 'Google Flow',
  version: '1.0.0',
  description:
    'Generazione video (Google Veo) e immagini (Imagen/Nano) con Google Flow. Fornisce gli strumenti MCP per gli agenti in chat e una galleria dedicata.',
  section: { id: 'flow', label: 'Flow' },
  credits: { text: 'gflow-cli di Flavio Oliva (MIT)', url: 'https://github.com/ffroliva/gflow-cli' },
  requires: 'gflow-cli o container agicloud-gflow, account Google con accesso a Flow',
  routes: ['/api/flow', '/flow-api'],
  source: 'builtin',
  health: async () => {
    ensureDirs();
    const account = linkedAccount();
    if (!account) return { ok: false, detail: 'account Google non collegato: apri la sezione Flow e accedi' };
    if (!gflowAvailable()) return { ok: false, detail: 'account collegato ma gflow-cli non trovato sul server' };
    return { ok: true, detail: `collegato come ${account.email}` };
  },
  install: async () => {
    ensureDirs();
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

export interface FlowGenerateBody {
  prompt?: unknown;
  kind?: unknown;
  model?: unknown;
  aspect?: unknown;
}

function parseGenerate(body: Record<string, unknown>): { prompt: string; kind: FlowKind; model: string; aspect: string } {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'Messaggio vuoto');
  if (prompt.length > 4000) throw new HttpError(400, 'Prompt troppo lungo (max 4000 caratteri)');
  const kind: FlowKind = body.kind === 'image' ? 'image' : 'video';
  const model = typeof body.model === 'string' ? body.model : '';
  const known = FLOW_MODELS.find((m) => m.id === model && m.kind === kind) ?? FLOW_MODELS.find((m) => m.kind === kind)!;
  const aspect = ['16:9', '9:16', '1:1'].includes(String(body.aspect)) ? String(body.aspect) : '16:9';
  return { prompt, kind, model: known.id, aspect };
}

/** Avvia gflow-cli in background: l'output resta in data/flow-output */
function runGflow(kind: FlowKind, model: string, aspect: string, prompt: string): { job: string; started: boolean } {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ext = kind === 'video' ? 'mp4' : 'png';
  const job = `${kind}-${stamp}-${randomBytes(3).toString('hex')}`;
  const out = join(OUTPUT, `${job}.${ext}`);
  writeFileSync(join(OUTPUT, `${job}.prompt.txt`), prompt, { mode: 0o640 });
  let started = false;
  try {
    const args =
      kind === 'video'
        ? ['video', 't2v', '--model', model, '--aspect', aspect, '--output', out, prompt]
        : ['image', 't2i', '--model', model, '--aspect', aspect, '--output', out, prompt];
    const child = spawn(GFLOW, args, { stdio: 'ignore', detached: true });
    child.unref();
    started = true;
  } catch {
    started = false;
  }
  return { job, started };
}

function gallery(): { name: string; kind: FlowKind | 'text'; size: number; mtime: number }[] {
  ensureDirs();
  return readdirSync(OUTPUT)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = statSync(join(OUTPUT, f));
      const ext = f.split('.').pop()?.toLowerCase() ?? '';
      const kind: FlowKind | 'text' = ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? 'image' : 'text';
      return { name: f, kind, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200);
}

export function registerFlow(app: Hono<any>): void {
  app.get('/api/flow/status', (c) => {
    ensureDirs();
    const account = linkedAccount();
    return c.json({
      linked: Boolean(account),
      account: account?.email ?? null,
      credits: account ? readCredits() : null,
      gflow: gflowAvailable(),
      output: basename(OUTPUT),
    });
  });

  // Login agevolato: gflow-cli apre il flusso OAuth di Google; qui si restituisce
  // il link e le istruzioni, e si segna l'account quando l'utente conferma.
  app.post('/api/flow/login', async (c) => {
    ensureDirs();
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
    if (typeof body.email === 'string' && /.@./.test(body.email)) {
      writeFileSync(ACCOUNT_FILE, JSON.stringify({ email: body.email.trim(), at: Date.now() }), { mode: 0o600 });
      return c.json({ linked: true, account: body.email.trim() });
    }
    return c.json({
      linked: false,
      url: 'https://labs.google/fx/flow',
      hint: 'Accedi a Google Flow nel browser, poi torna qui e conferma la tua email Gmail',
    });
  });

  app.get('/api/flow/models', (c) => c.json({ models: FLOW_MODELS }));

  app.get('/api/flow/gallery', (c) => c.json({ files: gallery() }));

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
    const g = parseGenerate(body);
    if (!linkedAccount()) throw new HttpError(409, 'Account Google non collegato: apri la sezione Flow e accedi');
    if (!gflowAvailable()) throw new HttpError(409, 'gflow-cli non trovato sul server');
    return c.json({ ...runGflow(g.kind, g.model, g.aspect, g.prompt), model: g.model, aspect: g.aspect }, 202);
  });

  // Dagli strumenti degli agenti (token proprio, mai il token di AgiCloud)
  app.post('/flow-api/run', async (c) => {
    if (c.req.header('x-flow-token') !== AGENT_TOKEN) return c.json({ error: 'Token non valido' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? 'generate');
    if (action === 'credits') {
      return c.json({ linked: Boolean(linkedAccount()), credits: readCredits() });
    }
    if (action === 'gallery') {
      return c.json({ files: gallery() });
    }
    const g = parseGenerate(body);
    if (!linkedAccount()) return c.json({ error: 'Account Google non collegato' }, 409);
    if (!gflowAvailable()) return c.json({ error: 'gflow-cli non trovato sul server' }, 409);
    return c.json({ ...runGflow(g.kind, g.model, g.aspect, g.prompt), model: g.model, aspect: g.aspect }, 202);
  });
}
