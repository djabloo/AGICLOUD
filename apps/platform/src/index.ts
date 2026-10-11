import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createApp, ensureAdmin } from './app.js';
import { openDb } from './db.js';
import { brevoMailer, consoleMailer } from './mailer.js';
import { httpOrchestrator } from './orchestrator.js';
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

const orchestrator = httpOrchestrator(process.env.ORCHESTRATOR_URL ?? 'unix:/run/orchestrator/orchestrator.sock', process.env.ORCHESTRATOR_SECRET ?? '');
const adminHost = process.env.PLATFORM_ADMIN_HOST?.toLowerCase();

const api = createApp({
  db,
  mailer: process.env.BREVO_API_KEY
    ? brevoMailer(process.env.BREVO_API_KEY, { email: process.env.MAIL_FROM_EMAIL ?? 'noreply@agicloud.dev', name: process.env.MAIL_FROM_NAME ?? 'AgiCloud' })
    : consoleMailer(join(dataDir, 'outbox.log')),
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  orchestrator,
  rootDomain,
});
const app = new Hono();
// Le API admin rispondono solo sul dominio riservato (es. admin-323cloud.agicloud.dev): altrove sembrano non esistere
if (adminHost) {
  app.use('/api/admin/*', async (c, next) => ((c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '') === adminHost ? next() : c.notFound()));
}
app.route('/', api);
mountStatic(app);

// Gli ambienti utente (<nome>.agicloud.dev) non passano da qui: li smista il proxy di bordo (apps/edge)
const server = createServer(getRequestListener(app.fetch));
// Dentro il container serve ascoltare su tutte le interfacce (PLATFORM_HOST); l'host lo espone solo su 127.0.0.1
server.listen(port, process.env.PLATFORM_HOST ?? '127.0.0.1', () => console.log(`Piattaforma AgiCloud su ${baseUrl}`));
