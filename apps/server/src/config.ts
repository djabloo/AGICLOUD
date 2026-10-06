import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const env = process.env;

export const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 3095),
  /** Token di accesso (Bearer). Obbligatorio se il server non ascolta solo in locale. */
  authToken: env.AUTH_TOKEN || '',
  /** Ogni workspace e' una sottocartella: piu' agenti possono lavorare sulla stessa */
  workspacesRoot: resolve(env.WORKSPACES_ROOT || 'data/workspaces'),
  /** Interfaccia web compilata (apps/web/dist) */
  webDist: resolve(env.WEB_DIST || new URL('../../web/dist', import.meta.url).pathname),
  /** Massimo di agenti vivi insieme: ogni conversazione tiene acceso un processo */
  maxSessions: Number(env.MAX_SESSIONS || 6),
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOCAL_HOSTS.has(config.host) && !config.authToken) {
  console.error(`Rifiuto di ascoltare su ${config.host} senza AUTH_TOKEN.`);
  process.exit(1);
}

mkdirSync(config.workspacesRoot, { recursive: true });
