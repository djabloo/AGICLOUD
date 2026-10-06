import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AGENTS } from '@agicloud/bridge';
import { config } from './config.js';
import { HttpError, ThreadStore, listWorkspaces } from './threads.js';

const store = new ThreadStore();
const app = new Hono<{ Bindings: HttpBindings }>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

app.use('/api/*', async (c, next) => {
  if (!config.authToken) return next();
  const ip = clientIp(c);
  const f = failures.get(ip);
  if (f && f.count >= FAIL_LIMIT && f.until > Date.now()) {
    return c.json({ error: 'Troppi tentativi: riprova tra qualche minuto' }, 429);
  }
  const header = c.req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given) return c.json({ error: 'Accesso negato' }, 401);
  if (!tokenOk(given)) {
    // Contano solo i token sbagliati: le richieste senza token (pagina appena aperta) no
    const next = f && f.until > Date.now() ? f.count + 1 : 1;
    failures.set(ip, { count: next, until: Date.now() + FAIL_WINDOW_MS });
    return c.json({ error: 'Accesso negato' }, 401);
  }
  failures.delete(ip);
  return next();
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Errore interno' }, 500);
});

// ── API ──────────────────────────────────────────────────────────────────────
app.get('/api/session', (c) => c.json({ ok: true, authRequired: Boolean(config.authToken) }));

app.get('/api/agents', (c) =>
  c.json(Object.values(AGENTS).map(({ id, label, native, note }) => ({ id, label, native, note }))),
);

app.get('/api/workspaces', (c) => c.json(listWorkspaces()));

app.get('/api/threads', (c) => c.json(store.list()));

app.post('/api/threads', async (c) => {
  const body = await jsonBody(c);
  const thread = store.create(String(body.agentId ?? ''), String(body.workspace ?? ''), optString(body.authMethod));
  return c.json(thread.summary(), 201);
});

app.delete('/api/threads/:id', async (c) => {
  await store.remove(c.req.param('id'));
  return c.body(null, 204);
});

app.post('/api/threads/:id/runs', async (c) => {
  const thread = store.get(c.req.param('id'));
  const body = await jsonBody(c);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'Messaggio vuoto');
  const runId = await thread.run(prompt);
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
    const send = (data: unknown, id: number) => {
      chain = chain.then(() => stream.writeSSE({ id: String(id), data: JSON.stringify(data) })).catch(() => {});
    };
    const replayEnd = thread.events.length;
    const unsubscribe = thread.subscribe((event, index) => {
      if (index >= replayEnd) send(event, index);
    });
    for (let i = after + 1; i < replayEnd; i++) send(thread.events[i], i);

    const ping = setInterval(() => {
      chain = chain.then(() => stream.writeSSE({ event: 'ping', data: '' })).catch(() => {});
    }, 20_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsubscribe();
  });
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
  console.log(`AgiCloud su http://${info.address}:${info.port} — workspace in ${config.workspacesRoot}`);
});

async function shutdown() {
  await store.closeAll();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
