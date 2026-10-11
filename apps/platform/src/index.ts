import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp, ensureAdmin } from './app.js';
import { openDb } from './db.js';
import { consoleMailer } from './mailer.js';

const port = Number(process.env.PLATFORM_PORT ?? 3110);
const dataDir = process.env.PLATFORM_DATA_DIR ?? join(process.cwd(), 'data', 'platform');
const baseUrl = process.env.PLATFORM_BASE_URL ?? `http://localhost:${port}`;

const db = openDb(join(dataDir, 'platform.db'));
const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;
const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
if (adminEmail && adminPassword) await ensureAdmin(db, adminEmail, adminPassword);
else if (!(db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get())) console.warn('Nessun amministratore: imposta PLATFORM_ADMIN_EMAIL e PLATFORM_ADMIN_PASSWORD');

const app = createApp({ db, mailer: consoleMailer(join(dataDir, 'outbox.log')), baseUrl, secureCookies: baseUrl.startsWith('https://') });
serve({ fetch: app.fetch, port, hostname: process.env.PLATFORM_HOST ?? '127.0.0.1' }, () => console.log(`Piattaforma AgiCloud su ${baseUrl}`));
