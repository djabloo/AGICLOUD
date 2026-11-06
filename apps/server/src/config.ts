import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseFeatures } from './features.js';

const env = process.env;

function readSecret(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

const dataDir = resolve(env.DATA_DIR || 'data');
const workspacesRoot = resolve(env.WORKSPACES_ROOT || `${dataDir}/workspaces`);
mkdirSync(workspacesRoot, { recursive: true });
mkdirSync(`${dataDir}/threads`, { recursive: true });

const features = parseFeatures(env.AGICLOUD_FEATURES);

export const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 3095),
  /**
   * Token di accesso (Bearer). Obbligatorio se il server non ascolta solo in locale.
   * Dall'ambiente, oppure dal file creato al primo accesso con il link di attivazione (nodi).
   */
  authToken: env.AUTH_TOKEN || readSecret(`${dataDir}/auth-token`),
  /** Codice di attivazione monouso (nodi nuovi): finche' non c'e' un token, serve per crearlo */
  setupToken: env.SETUP_TOKEN || readSecret(`${dataDir}/setup-token`),
  /** File in cui si salva il token creato con l'attivazione */
  authTokenFile: `${dataDir}/auth-token`,
  setupTokenFile: `${dataDir}/setup-token`,
  /** Conversazioni salvate (metadati + registro eventi) */
  threadsDir: `${dataDir}/threads`,
  /** Cartella per i progetti nuovi creati dall'interfaccia */
  workspacesRoot,
  /** Dove si possono aprire progetti (separate da ":"); le cartelle fuori sono rifiutate */
  projectRoots: (env.PROJECT_ROOTS || `${workspacesRoot}:${homedir()}:/opt:/var/www`)
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
  /** Sezioni consentite dal piano (AGICLOUD_FEATURES): null = tutto */
  features,
  /** Elenco per l'interfaccia (GET /api/session): null = tutto */
  featuresList: features ? [...features] : null,
  /** Nome della persona che usa AgiCloud, come lo leggono gli agenti (es. "Marco"). Vuoto = "l'utente" */
  userName: (env.AGICLOUD_USER_NAME || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60),
  /** Dati dei plugin esterni (plugin-data/<id>) e plugin scaricati da link (plugins/<slug>) */
  dataDir,
  /**
   * Catalogo di plugin esterni gia' presenti sulla macchina (separate da ":"): ogni sottocartella con
   * un manifest.json compare in Impostazioni → Plugin, pronta da installare. La piattaforma ci monta i suoi.
   */
  pluginsDirs: (env.AGICLOUD_PLUGINS_DIR || '').split(':').filter(Boolean).map((p) => resolve(p)),
};

// Il token non deve finire nell'ambiente di agenti e terminali
delete process.env.AUTH_TOKEN;
delete process.env.SETUP_TOKEN;

/**
 * Variabili di una sessione Claude Code (es. se il server e' stato avviato da dentro Claude Code).
 * Ereditate da agenti e terminali, farebbero credere a `claude` di essere un sotto-processo
 * di quella sessione invece di un Claude normale con il login dell'account.
 */
export const LEAKED_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID|CLAUDE_EFFORT)$/;
for (const name of Object.keys(process.env)) if (LEAKED_SESSION_VARS.test(name)) delete process.env[name];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOCAL_HOSTS.has(config.host) && !config.authToken && !config.setupToken) {
  console.error(`Rifiuto di ascoltare su ${config.host} senza AUTH_TOKEN.`);
  process.exit(1);
}
