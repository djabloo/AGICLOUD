import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const env = process.env;

const dataDir = resolve(env.DATA_DIR || 'data');
const workspacesRoot = resolve(env.WORKSPACES_ROOT || `${dataDir}/workspaces`);
mkdirSync(workspacesRoot, { recursive: true });
mkdirSync(`${dataDir}/threads`, { recursive: true });

export const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 3095),
  /** Token di accesso (Bearer). Obbligatorio se il server non ascolta solo in locale. */
  authToken: env.AUTH_TOKEN || '',
  /** Conversazioni salvate (metadati + registro eventi) */
  threadsDir: `${dataDir}/threads`,
  /** Cartella per i progetti nuovi creati dall'interfaccia */
  workspacesRoot,
  /** Dove si possono aprire progetti (separate da ":"); le cartelle fuori sono rifiutate */
  projectRoots: (env.PROJECT_ROOTS || `${workspacesRoot}:/home/user:/opt:/var/www`)
    .split(':')
    .filter(Boolean)
    .flatMap((p) => {
      try {
        return [realpathSync(p)];
      } catch {
        return [];
      }
    }),
  /** Interfaccia web compilata (apps/web/dist) */
  webDist: resolve(env.WEB_DIST || new URL('../../web/dist', import.meta.url).pathname),
  /** Massimo di agenti accesi insieme: oltre, si mette in pausa quello inattivo da piu' tempo */
  maxSessions: Number(env.MAX_SESSIONS || 6),
  /** Dopo quanto un agente inattivo viene spento (riprende da solo al messaggio successivo) */
  idleMs: Number(env.IDLE_MINUTES || 30) * 60_000,
};

// Il token non deve finire nell'ambiente di agenti e terminali
delete process.env.AUTH_TOKEN;

/**
 * Variabili di una sessione Claude Code (es. se il server e' stato avviato da dentro Claude Code).
 * Ereditate da agenti e terminali, farebbero credere a `claude` di essere un sotto-processo
 * di quella sessione invece di un Claude normale con il login dell'account.
 */
export const LEAKED_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID|CLAUDE_EFFORT)$/;
for (const name of Object.keys(process.env)) if (LEAKED_SESSION_VARS.test(name)) delete process.env[name];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOCAL_HOSTS.has(config.host) && !config.authToken) {
  console.error(`Rifiuto di ascoltare su ${config.host} senza AUTH_TOKEN.`);
  process.exit(1);
}
