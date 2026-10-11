import type { Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AGENTS } from '@agicloud/bridge';
import { config } from './config.js';
import { currentLang, initLastLang, parseAccept, rememberLang, tError, tNotice } from './i18n.js';
import { isAllowed, PLAN_ERROR, sectionOf } from './features.js';
import { listDirs } from './projects.js';
import { TerminalStore } from './terminals.js';
import { saveUploads } from './uploads.js';
import { Push } from './push.js';
import { createEntry, deleteEntry, listDir, rawFile, readText, renameEntry, uploadInto, writeText } from './files.js';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { LOGIN_COMMANDS, Settings } from './settings.js';
import { GuidedLogins } from './logins.js';
import { homedir } from 'node:os';
import { HttpError, ThreadStore } from './threads.js';
import { attachTerminalSockets, clientIp as wsClientIp } from './terminal-socket.js';
import { LeadManager } from './lead.js';
import { Limits, registerHandover } from './handover.js';
import { registerDesign } from './design.js';
import { catalog as designCatalog, normalizeChoice } from '@agicloud/design';
import { Plugins } from './plugins.js';
import { piiPlugin, registerPii } from './pii.js';
import { flowMcpServer, flowPlugin, flowUpgrade, registerFlow } from './flow.js';
import { registerVerdict, verdictMcpServer, verdictPlugin } from './verdict.js';
import { cloudPlugin, registerCloud } from './cloud.js';
import { NodeImageBuilder, registerNodeImageBuild } from './node-image.js';
import { browserMcpServer, browserPlugin, browserUpgrade, ensureBrowser, registerBrowserStart } from './browser.js';

const settings = new Settings();
const store = new ThreadStore(settings);
const push = new Push();
store.onNotify = (n) => push.send({ ...n, title: tNotice(n.title, currentLang()), body: tNotice(n.body, currentLang()) }).catch((err) => console.error('[push]', err));
const lead = new LeadManager(store, settings);
store.lead = lead;
const limits = new Limits();
store.limits = limits;
store.load();
const terminals = new TerminalStore(() => settings.vaultEnv('terminals'));
const app = new Hono<{ Bindings: HttpBindings }>();

// Lingua dell'interfaccia: i messaggi d'errore (anche quelli scritti direttamente con c.json({ error })) escono nella lingua scelta
initLastLang(join(config.threadsDir, '..'));
app.use('*', async (c, next) => {
  const lang = parseAccept(c.req.header('accept-language'));
  if (lang) rememberLang(lang);
  await next();
  if (!lang || lang === 'it' || c.res.status < 400 || !(c.res.headers.get('content-type') ?? '').includes('application/json')) return;
  const body = (await c.res.clone().json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error !== 'string') return;
  const translated = tError(body.error, lang);
  if (translated !== body.error) c.res = c.json({ ...body, error: translated }, c.res.status as 400);
});

app.use('*', async (c, next) => {
  await next();
  // Cache: i file in /assets hanno l'hash nel nome (immutabili); tutto il resto va sempre ricontrollato,
  // altrimenti i telefoni tengono la pagina vecchia dopo un aggiornamento
  if (c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  else c.header('Cache-Control', 'no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  // Le route con una CSP propria (es. file grezzi) la tengono
  if (!c.res.headers.has('Content-Security-Policy')) c.header(
    'Content-Security-Policy',
    // style 'unsafe-inline': il terminale (xterm.js) crea i suoi stili al volo
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
});

// ── Accesso: token Bearer, con blocco dopo troppi tentativi sbagliati ────────
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; until: number }>();

function clientIp(c: Context<{ Bindings: HttpBindings }>): string {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) return fwd.split(',')[0]!.trim();
  }
  return c.env.incoming.socket.remoteAddress ?? 'unknown';
}

function tokenOk(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.authToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Access = 'ok' | 'missing' | 'denied' | 'blocked';

/** Controllo del token condiviso da API e WebSocket dei terminali */
function checkAccess(ip: string, given: string): Access {
  // Nodo non ancora attivato: niente accesso finche' non si crea il token col link di attivazione
  if (!config.authToken) return config.setupToken ? 'missing' : 'ok';
  const f = failures.get(ip);
  if (f && f.count >= FAIL_LIMIT && f.until > Date.now()) return 'blocked';
  if (!given) return 'missing';
  if (!tokenOk(given)) {
    // Contano solo i token sbagliati: le richieste senza token (pagina appena aperta) no
    const count = f && f.until > Date.now() ? f.count + 1 : 1;
    failures.set(ip, { count, until: Date.now() + FAIL_WINDOW_MS });
    return 'denied';
  }
  failures.delete(ip);
  return 'ok';
}

// Strumenti del capo (lead-mcp.ts): fuori da /api, con il token della conversazione capo
lead.register(app);

// Attivazione di un nodo nuovo: il codice monouso del link crea il token definitivo, mostrato una volta.
// Prima del controllo del token (che a nodo non attivato non c'e' ancora).
app.post('/api/setup', async (c) => {
  const ip = clientIp(c);
  const f = failures.get(ip);
  if (f && f.count >= FAIL_LIMIT && f.until > Date.now()) return c.json({ error: 'Troppi tentativi: riprova tra qualche minuto' }, 429);
  if (config.authToken || !config.setupToken) return c.json({ error: 'Questo AgiCloud e\' gia\' attivato: entra con il tuo token' }, 409);
  const body = (await c.req.json().catch(() => ({}))) as { setup?: unknown };
  const a = Buffer.from(String(body.setup ?? ''));
  const b = Buffer.from(config.setupToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + FAIL_WINDOW_MS });
    return c.json({ error: 'Link di attivazione non valido' }, 401);
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(config.authTokenFile, token + '\n', { mode: 0o600 });
  rmSync(config.setupTokenFile, { force: true });
  config.authToken = token;
  config.setupToken = '';
  return c.json({ token });
});

app.use('/api/*', async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const access = checkAccess(clientIp(c), header.startsWith('Bearer ') ? header.slice(7) : '');
  if (access === 'blocked') return c.json({ error: 'Troppi tentativi: riprova tra qualche minuto' }, 429);
  if (access !== 'ok') return c.json({ error: 'Accesso negato' }, 401);
  return next();
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Errore interno' }, 500);
});

// ── Piano: sezioni non consentite da AGICLOUD_FEATURES (prima dei plugin, cosi' vince il 403) ──
app.use('*', async (c, next) => {
  const section = sectionOf(c.req.path);
  if (section && !isAllowed(config.features, section)) return c.json({ error: PLAN_ERROR }, 403);
  return next();
});

// Plugin: elenco, installa/attiva/disattiva; le route di un plugin spento rispondono 404.
// Va registrato prima delle route dei plugin.
const plugins = new Plugins(
  [
    {
      id: 'design',
      name: 'Design',
      version: '1.0.0',
      description:
        'Galleria di stili e skill di design: l\'agente scrive le pagine nel progetto seguendo lo stile scelto, con anteprima dal vivo nella chat. Le sessioni di design hanno la loro sezione.',
      section: { id: 'design', label: 'Design' },
      credits: { text: 'Contenuti da Open Design (Apache 2.0)', url: designCatalog().source.repo },
      routes: ['/api/design', '/preview/'],
      source: 'builtin',
    },
    piiPlugin,
    flowPlugin,
    browserPlugin,
    verdictPlugin(settings),
    cloudPlugin(settings),
  ],
  // Design era gia' in uso prima del sistema dei plugin: resta installato e attivo
  { design: { installed: true, enabled: true } },
);
plugins.register(app);

// Browser condiviso: a plugin attivo ogni agente riceve gli strumenti Playwright sullo stesso Chromium
store.extraMcpServers = async () => {
  const servers = [];
  if (plugins.isEnabled('browser')) {
    await ensureBrowser().catch(() => {});
    servers.push(browserMcpServer());
  }
  if (plugins.isEnabled('verdict')) servers.push(verdictMcpServer());
  if (plugins.isEnabled('flow')) servers.push(flowMcpServer());
  return servers;
};
// Strumenti dei plugin che Claude usa senza chiedere (Verdict: solo una lettura che costa frazioni di centesimo)
store.extraAllowedTools = () => (plugins.isEnabled('verdict') ? ['mcp__verdict'] : []);

// Plugin Design: catalogo (/api/design, col token) e anteprime (/preview, col token dell'anteprima)
registerDesign(app);
registerPii(app);
registerFlow(app);
registerBrowserStart(app);
registerVerdict(app, settings);
registerHandover(app, store, limits);
registerCloud(app, settings);
registerNodeImageBuild(app, settings, new NodeImageBuilder());

// ── API ──────────────────────────────────────────────────────────────────────
app.get('/api/session', (c) => c.json({ ok: true, authRequired: Boolean(config.authToken), setupPending: !config.authToken && Boolean(config.setupToken), features: config.featuresList }));

app.get('/api/agents', (c) =>
  c.json(Object.values(AGENTS).map(({ id, label, native, note }) => ({ id, label, native, note }))),
);

app.get('/api/projects', (c) => c.json({ roots: config.projectRoots, recent: store.recentProjects() }));

app.get('/api/dirs', (c) => c.json(listDirs(c.req.query('path') || undefined)));

app.get('/api/threads', (c) => c.json(store.list()));

app.get('/api/threads/search', (c) => c.json(store.search(c.req.query('q') ?? '')));

app.patch('/api/threads/:id', async (c) => {
  const thread = store.get(c.req.param('id'));
  thread.update(await jsonBody(c));
  return c.json(thread.summary());
});

app.post('/api/threads', async (c) => {
  const body = await jsonBody(c);
  let design;
  try {
    design = normalizeChoice(body.design) ?? undefined;
    if (design) plugins.require('design');
    if (body.browser === true) plugins.require('browser');
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const thread = store.create(String(body.agentId ?? ''), String(body.cwd ?? ''), { lead: body.lead === true, design, browser: body.browser === true || undefined });
  // agy senza finestra non puo' chiedere permessi: da capo lavora con "Consenti tutto" (le deleghe le approva l'utente)
  if (body.lead === true && thread.meta.agentId === 'agy') await thread.setConfig('permissions', 'all').catch(() => {});
  return c.json(thread.summary(), 201);
});

// Capo: decisione su una proposta di delega
app.post('/api/threads/:id/delegations/:did', async (c) => {
  const body = await jsonBody(c);
  return c.json(await lead.decide(c.req.param('id'), c.req.param('did'), body.approve === true, typeof body.note === 'string' ? body.note : ''));
});

// Thread affidato: modifiche nella sua copia, unisci nel progetto, scarta
app.get('/api/threads/:id/changes', async (c) => c.json(await lead.changes(store.get(c.req.param('id')))));

app.post('/api/threads/:id/merge', async (c) => c.json({ commit: await lead.merge(store.get(c.req.param('id'))) }));

app.post('/api/threads/:id/discard', async (c) => {
  await lead.discard(store.get(c.req.param('id')));
  return c.body(null, 204);
});

app.post('/api/threads/:id/config', async (c) => {
  const body = await jsonBody(c);
  const configId = optString(body.configId);
  const value = body.value;
  if (!configId || (typeof value !== 'string' && typeof value !== 'boolean')) {
    throw new HttpError(400, 'configId e value obbligatori');
  }
  await store.get(c.req.param('id')).setConfig(configId, value);
  return c.body(null, 204);
});

app.post('/api/threads/:id/sleep', async (c) => {
  await store.get(c.req.param('id')).sleep();
  return c.body(null, 204);
});

app.delete('/api/threads/:id', async (c) => {
  // Una copia separata ancora aperta se ne va con il thread (le modifiche non unite si perdono)
  await lead.discard(store.get(c.req.param('id'))).catch(() => {});
  await store.remove(c.req.param('id'));
  return c.body(null, 204);
});

app.post('/api/threads/:id/uploads', async (c) => {
  const thread = store.get(c.req.param('id'));
  const form = await c.req.parseBody({ all: true });
  const raw = form.files ?? form.file;
  const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
  return c.json(await saveUploads(thread.meta.cwd, files), 201);
});

app.post('/api/threads/:id/runs', async (c) => {
  const thread = store.get(c.req.param('id'));
  const body = await jsonBody(c);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a): a is string => typeof a === 'string').slice(0, 20) : [];
  if (!prompt && !attachments.length) throw new HttpError(400, 'Messaggio vuoto');
  const runId = await thread.run(prompt, attachments);
  return c.json({ runId }, 202);
});

app.post('/api/threads/:id/cancel', async (c) => {
  await store.get(c.req.param('id')).cancel();
  return c.body(null, 204);
});

app.post('/api/threads/:id/permissions/:requestId', async (c) => {
  const body = await jsonBody(c);
  store.get(c.req.param('id')).respondPermission(c.req.param('requestId'), optString(body.optionId) ?? null);
  return c.body(null, 204);
});

// Flusso SSE degli eventi AG-UI: prima lo storico da `after`, poi quelli nuovi in diretta.
// L'id di ogni messaggio e' la posizione nel registro: il client si ricollega da li'.
app.get('/api/threads/:id/events', (c) => {
  const thread = store.get(c.req.param('id'));
  const after = Math.max(-1, Number(c.req.query('after') ?? -1) || -1);
  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve();
    // Eventi senza id = stato "vivo" (opzioni, comandi): non spostano il punto di ripresa
    const send = (data: unknown, id: number | null) => {
      const message = id === null ? { data: JSON.stringify(data) } : { id: String(id), data: JSON.stringify(data) };
      chain = chain.then(() => stream.writeSSE(message)).catch(() => {});
    };
    const replayEnd = thread.events.length;
    const unsubscribe = thread.subscribe((event, index) => {
      if (index === null || index >= replayEnd) send(event, index);
    });
    for (let i = after + 1; i < replayEnd; i++) send(thread.events[i], i);
    send({ type: 'CUSTOM', name: 'agicloud.state', value: thread.state() }, null);

    const ping = setInterval(() => {
      chain = chain.then(() => stream.writeSSE({ event: 'ping', data: '' })).catch(() => {});
    }, 20_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsubscribe();
  });
});

// ── Impostazioni ─────────────────────────────────────────────────────────────
app.get('/api/settings', async (c) =>
  c.json({ general: settings.general(), agents: await settings.agents(c.req.query('refresh') === '1') }),
);

app.post('/api/settings/general', async (c) => {
  settings.setGeneral(await jsonBody(c));
  return c.json(settings.general());
});

app.post('/api/settings/agents/:id/env', async (c) => {
  const body = await jsonBody(c);
  settings.setEnv(c.req.param('id'), String(body.name ?? ''), typeof body.value === 'string' ? body.value : null);
  return c.body(null, 204);
});

app.post('/api/settings/agents/:id/defaults', async (c) => {
  const body = await jsonBody(c);
  const value = typeof body.value === 'string' || typeof body.value === 'boolean' ? body.value : null;
  settings.setDefault(c.req.param('id'), String(body.configId ?? ''), value);
  return c.body(null, 204);
});

// Portachiavi: chiavi API passate ad agenti/terminali come variabili d'ambiente, mai al browser
app.get('/api/settings/vault', (c) => c.json(settings.vaultList()));

app.post('/api/settings/vault', async (c) => {
  settings.setVault(await jsonBody(c));
  return c.json(settings.vaultList());
});

app.delete('/api/settings/vault/:name', (c) => {
  settings.deleteVault(c.req.param('name'));
  return c.json(settings.vaultList());
});

// Login guidato (senza terminale): link da aprire e, se serve, codice da incollare
const logins = new GuidedLogins((id) => settings.forgetStatus(id));

app.post('/api/settings/agents/:id/login/guided', (c) => c.json(logins.start(c.req.param('id'))));

app.get('/api/settings/agents/:id/login/guided', (c) => c.json(logins.get(c.req.param('id'))));

app.post('/api/settings/agents/:id/login/guided/code', async (c) => {
  const body = await jsonBody(c);
  return c.json(logins.sendCode(c.req.param('id'), String(body.code ?? '')));
});

app.delete('/api/settings/agents/:id/login/guided', (c) => {
  logins.cancel(c.req.param('id'));
  return c.body(null, 204);
});

// Login interattivo dell'agente: si apre un terminale col comando giusto
app.post('/api/settings/agents/:id/login', (c) => {
  const command = LOGIN_COMMANDS[c.req.param('id')];
  if (!command) throw new HttpError(400, 'Questo agente non ha un login da terminale');
  const home = homedir();
  const cwd = config.projectRoots.some((r) => home === r || home.startsWith(r + '/')) ? home : config.projectRoots[0]!;
  return c.json(terminals.create(cwd, command).summary(), 201);
});

// ── File ─────────────────────────────────────────────────────────────────────
app.get('/api/files/list', (c) => c.json(listDir(c.req.query('path') ?? '')));

app.get('/api/files/read', (c) => c.json(readText(c.req.query('path') ?? '')));

// Contenuto grezzo (anteprime di immagini/PDF/video e download). Il browser lo chiede con fetch + token.
app.get('/api/files/raw', (c) => {
  const f = rawFile(c.req.query('path') ?? '');
  const name = encodeURIComponent(f.path.split('/').pop() ?? 'file');
  c.header('Content-Type', f.mime);
  c.header('Content-Length', String(f.size));
  c.header('Content-Disposition', `${c.req.query('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`);
  // Un HTML aperto direttamente non deve poter eseguire script con i nostri permessi
  c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  return c.body(Readable.toWeb(createReadStream(f.path)) as ReadableStream);
});

app.put('/api/files/write', async (c) => {
  const body = await jsonBody(c);
  if (typeof body.content !== 'string') throw new HttpError(400, 'content obbligatorio');
  const expected = typeof body.mtime === 'number' ? body.mtime : undefined;
  return c.json(writeText(String(body.path ?? ''), body.content, expected));
});

app.post('/api/files/create', async (c) => {
  const body = await jsonBody(c);
  return c.json(createEntry(String(body.path ?? ''), body.type === 'dir' ? 'dir' : 'file'), 201);
});

app.post('/api/files/rename', async (c) => {
  const body = await jsonBody(c);
  return c.json({ path: renameEntry(String(body.path ?? ''), String(body.name ?? '')) });
});

app.delete('/api/files', (c) => {
  deleteEntry(c.req.query('path') ?? '');
  return c.body(null, 204);
});

app.post('/api/files/upload', async (c) => {
  const form = await c.req.parseBody({ all: true });
  const raw = form.files ?? form.file;
  const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
  return c.json(await uploadInto(c.req.query('dir') ?? '', files), 201);
});

// ── Notifiche push ───────────────────────────────────────────────────────────
app.get('/api/push', (c) => c.json({ publicKey: push.publicKey, devices: push.devices() }));

app.post('/api/push/subscribe', async (c) => {
  const body = await jsonBody(c);
  push.subscribe(body.subscription, String(body.device ?? ''));
  return c.json({ devices: push.devices() });
});

app.post('/api/push/unsubscribe', async (c) => {
  const body = await jsonBody(c);
  push.unsubscribe(String(body.endpoint ?? ''));
  return c.json({ devices: push.devices() });
});

app.post('/api/push/test', async (c) => {
  const sent = await push.send({ title: 'AgiCloud', body: tNotice('Le notifiche funzionano.', currentLang()), url: '/#/settings', tag: 'test' });
  return c.json({ sent });
});

// ── Terminali ────────────────────────────────────────────────────────────────
app.get('/api/terminals', (c) => c.json(terminals.list()));

app.post('/api/terminals', async (c) => {
  const body = await jsonBody(c);
  const command = body.command === 'claude' ? 'claude' : undefined; // solo comandi noti
  const t = terminals.create(String(body.cwd ?? ''), command);
  return c.json(t.summary(), 201);
});

app.delete('/api/terminals/:id', (c) => {
  terminals.remove(c.req.param('id'));
  return c.body(null, 204);
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// ── Interfaccia web ──────────────────────────────────────────────────────────
const webRoot = relative(process.cwd(), config.webDist) || '.';
const indexHtml = join(config.webDist, 'index.html');
if (existsSync(indexHtml)) {
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', (c) => c.html(readFileSync(indexHtml, 'utf8')));
} else {
  app.get('*', (c) => c.text('Interfaccia non compilata: npm run build -w @agicloud/web', 503));
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, 'JSON non valido');
  }
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`AgiCloud su http://${info.address}:${info.port} — progetti in ${config.projectRoots.join(', ')}`);
});

attachTerminalSockets(server as Server, terminals, checkAccess, [
  browserUpgrade(checkAccess, wsClientIp, () => plugins.isEnabled('browser')),
  flowUpgrade(() => plugins.isEnabled('flow')),
],
// I terminali fuori dal piano non si aprono nemmeno via WebSocket
() => isAllowed(config.features, 'terminal'));

async function shutdown() {
  terminals.detachAll();
  await store.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
