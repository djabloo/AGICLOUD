import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createApp, ensureAdmin } from './app.js';
import { openDb } from './db.js';
import { consoleMailer } from './mailer.js';
import { httpOrchestrator } from './orchestrator.js';
import { createProxy } from './proxy.js';
import { mountStatic } from './static.js';

const port = Number(process.env.PLATFORM_PORT ?? 3110);
const dataDir = process.env.PLATFORM_DATA_DIR ?? join(process.cwd(), 'data', 'platform');
const baseUrl = process.env.PLATFORM_BASE_URL ?? `http://localhost:${port}`;
const rootDomain = process.env.PLATFORM_ROOT_DOMAIN ?? 'agicloud.dev';

const db = openDb(join(dataDir, 'platform.db'));
const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;
const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
if (adminEmail && adminPassword) await ensureAdmin(db, adminEmail, adminPassword);
else if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) console.warn('Nessun amministratore: imposta PLATFORM_ADMIN_EMAIL e PLATFORM_ADMIN_PASSWORD');

const orchestrator = httpOrchestrator(process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:3111', process.env.ORCHESTRATOR_SECRET ?? '');
const proxy = createProxy(db, orchestrator, rootDomain);

const api = createApp({
  db,
  mailer: consoleMailer(join(dataDir, 'outbox.log')),
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  orchestrator,
  rootDomain,
  onWorkspaceChange: proxy.forget,
});
const app = new Hono();
app.route('/', api);
mountStatic(app);

const listener = getRequestListener(app.fetch);
const server = createServer((req, res) => {
  if (proxy.isWorkspaceHost(req.headers.host)) proxy.http(req, res).catch(() => res.destroy());
  else listener(req, res);
});
server.on('upgrade', (req, socket, head) => void proxy.upgrade(req, socket, head).catch(() => socket.destroy()));
// Dentro il container serve ascoltare su tutte le interfacce (PLATFORM_HOST); l'host lo espone solo su 127.0.0.1
server.listen(port, process.env.PLATFORM_HOST ?? '127.0.0.1', () => console.log(`Piattaforma AgiCloud su ${baseUrl}`));
