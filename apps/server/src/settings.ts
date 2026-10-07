// Impostazioni modificabili dall'interfaccia: default per agente, chiavi API, cartelle, pausa.
// Le chiavi stanno in un file separato (600) e non tornano mai al browser: solo "impostata si'/no".

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AGENTS } from '@agicloud/bridge';
import { config } from './config.js';
import { HttpError } from './errors.js';

type ConfigValue = string | boolean;

interface SettingsFile {
  projectRoots?: string[];
  idleMinutes?: number;
  /** Modalita'/modello/... per le nuove conversazioni, per agente */
  agentDefaults: Record<string, Record<string, ConfigValue>>;
  /** Ultime opzioni viste per agente: servono a mostrare le scelte possibili */
  agentOptions: Record<string, acp.SessionConfigOption[]>;
}

/** Variabili d'ambiente impostabili per agente (solo queste: niente iniezioni arbitrarie) */
/** Chiavi per singolo agente: oggi nessuna, gli agenti usano i loro account e le chiavi stanno nel portachiavi */
const AGENT_ENV: Record<string, { name: string; label: string }[]> = {};

/**
 * Variabili del portachiavi da NON passare a certi agenti: cambierebbero il loro login.
 * Con ANTHROPIC_API_KEY nell'ambiente Claude Code fatturerebbe sull'API invece dell'abbonamento.
 */
const AGENT_ENV_BLOCK: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
};

/** agy e' installato da tino: lo si usa da li' (con il login dell'utente che lo lancia) */
export const AGY_BIN = process.env.AGY_BIN || '/home/tino/.local/bin/agy';

/** Strumenti con login ma non ancora usabili in chat */
const TOOLS: { id: string; label: string; note?: string }[] = [];

/** Comando di login da lanciare in un terminale, per agente */
export const LOGIN_COMMANDS: Record<string, string> = {
  claude: 'claude auth login',
  opencode: 'opencode auth login',
  codex: 'codex login',
  // Niente browser sul server: stampa il link da aprire sul telefono/PC
  cursor: 'NO_OPEN_BROWSER=1 cursor-agent login',
  // agy non ha un comando di login: al primo avvio interattivo chiede l'accesso Google
  agy: AGY_BIN,
};

const settingsFile = join(config.threadsDir, '..', 'settings.json');
const secretsFile = join(config.threadsDir, '..', 'secrets.json');
const vaultFile = join(config.threadsDir, '..', 'vault.json');

/** Chiave del portachiavi: il valore non esce mai dal server */
interface VaultEntry {
  value: string;
  note: string;
  /** Passata come variabile d'ambiente agli agenti (chat) */
  agents: boolean;
  /** Passata ai terminali */
  terminals: boolean;
  updatedAt: number;
}

const VAULT_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Nomi che cambierebbero il comportamento di shell e programmi: vietati */
const VAULT_FORBIDDEN = /^(PATH|HOME|SHELL|USER|LOGNAME|PWD|TERM|LANG|TZ|TMPDIR|IFS|PS\d|ENV|BASH_ENV|AUTH_TOKEN|LD_.*|NODE_.*|NPM_.*|DYLD_.*|PYTHON.*|GIT_.*|SSH_.*|XDG_.*|DISPLAY)$/;

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? { ...fallback, ...JSON.parse(readFileSync(file, 'utf8')) } : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown, mode = 0o640): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export interface LoginStatus {
  state: 'ok' | 'missing' | 'unknown';
  detail: string;
}

export class Settings {
  private data: SettingsFile = readJson(settingsFile, { agentDefaults: {}, agentOptions: {} });
  private secrets: Record<string, Record<string, string>> = readJson(secretsFile, {});
  private vault: Record<string, VaultEntry> = readJson(vaultFile, {});
  private statusCache = new Map<string, { at: number; value: { installed: boolean; version: string | null; login: LoginStatus } }>();

  constructor() {
    if (this.data.projectRoots?.length) this.applyRoots(this.data.projectRoots);
    if (this.data.idleMinutes) config.idleMs = this.data.idleMinutes * 60_000;
  }

  /** Ambiente extra da passare all'agente (chiavi API) */
  agentEnv(agentId: string): Record<string, string> {
    const env = { ...this.vaultEnv('agents'), ...this.secrets[agentId] };
    for (const name of AGENT_ENV_BLOCK[agentId] ?? []) delete env[name];
    return env;
  }

  /** Chiavi del portachiavi abilitate per agenti o terminali, come variabili d'ambiente */
  vaultEnv(scope: 'agents' | 'terminals'): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, e] of Object.entries(this.vault)) if (e[scope]) env[name] = e.value;
    return env;
  }

  /** Elenco per la UI: mai il valore, solo le ultime 4 cifre per riconoscerla */
  vaultList() {
    return Object.entries(this.vault)
      .map(([name, e]) => ({
        name,
        note: e.note,
        agents: e.agents,
        terminals: e.terminals,
        updatedAt: e.updatedAt,
        last4: e.value.slice(-4),
        // Agenti a cui questa chiave non arriva comunque (per non cambiarne il login)
        blockedFor: Object.entries(AGENT_ENV_BLOCK)
          .filter(([, names]) => names.includes(name))
          .map(([agent]) => AGENTS[agent]?.label ?? agent),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  setVault(input: { name?: unknown; value?: unknown; note?: unknown; agents?: unknown; terminals?: unknown }): void {
    const name = String(input.name ?? '').trim();
    if (!VAULT_NAME.test(name)) throw new HttpError(400, 'Nome non valido: maiuscole, numeri e _ (es. FAL_KEY)');
    if (VAULT_FORBIDDEN.test(name)) throw new HttpError(400, `Nome riservato al sistema: ${name}`);
    const prev = this.vault[name];
    const value = typeof input.value === 'string' ? input.value.trim() : '';
    if (!prev && !value) throw new HttpError(400, 'Valore obbligatorio per una chiave nuova');
    if (value.includes('\n')) throw new HttpError(400, 'Il valore non puo\' andare a capo');
    this.vault[name] = {
      value: value || prev!.value,
      note: typeof input.note === 'string' ? input.note.trim().slice(0, 200) : (prev?.note ?? ''),
      agents: typeof input.agents === 'boolean' ? input.agents : (prev?.agents ?? true),
      terminals: typeof input.terminals === 'boolean' ? input.terminals : (prev?.terminals ?? true),
      updatedAt: Date.now(),
    };
    writeJson(vaultFile, this.vault, 0o600);
  }

  deleteVault(name: string): void {
    if (!this.vault[name]) throw new HttpError(404, 'Chiave non trovata');
    delete this.vault[name];
    writeJson(vaultFile, this.vault, 0o600);
  }

  agentDefaults(agentId: string): Record<string, ConfigValue> {
    return { ...this.data.agentDefaults[agentId] };
  }

  rememberOptions(agentId: string, options: acp.SessionConfigOption[]): void {
    if (!options.length) return;
    const prev = JSON.stringify(this.data.agentOptions[agentId] ?? []);
    // Si salvano senza currentValue: conta solo l'elenco delle scelte
    const clean = options.map((o) => ({ ...o, currentValue: o.type === 'boolean' ? false : '' })) as acp.SessionConfigOption[];
    if (JSON.stringify(clean) === prev) return;
    this.data.agentOptions[agentId] = clean;
    this.save();
  }

  setDefault(agentId: string, configId: string, value: ConfigValue | null): void {
    if (!AGENTS[agentId]) throw new HttpError(404, 'Agente sconosciuto');
    const d = (this.data.agentDefaults[agentId] ??= {});
    if (value === null) delete d[configId];
    else d[configId] = value;
    this.save();
  }

  setEnv(agentId: string, name: string, value: string | null): void {
    if (!AGENT_ENV[agentId]?.some((v) => v.name === name)) throw new HttpError(400, `Variabile non consentita per ${agentId}: ${name}`);
    const s = (this.secrets[agentId] ??= {});
    if (value === null || value === '') delete s[name];
    else s[name] = value.trim();
    writeJson(secretsFile, this.secrets, 0o600);
    this.statusCache.delete(agentId);
  }

  general() {
    return { projectRoots: config.projectRoots, idleMinutes: Math.round(config.idleMs / 60_000) };
  }

  setGeneral(input: { projectRoots?: unknown; idleMinutes?: unknown }): void {
    if (input.projectRoots !== undefined) {
      if (!Array.isArray(input.projectRoots) || !input.projectRoots.every((p) => typeof p === 'string')) {
        throw new HttpError(400, 'projectRoots deve essere un elenco di percorsi');
      }
      const roots = input.projectRoots.map((p) => p.trim()).filter(Boolean);
      if (!roots.length) throw new HttpError(400, 'Serve almeno una cartella consentita');
      for (const r of roots) {
        if (!r.startsWith('/')) throw new HttpError(400, `Percorso non assoluto: ${r}`);
        if (!existsSync(r)) throw new HttpError(400, `Cartella inesistente: ${r}`);
      }
      this.applyRoots(roots);
      this.data.projectRoots = roots;
    }
    if (input.idleMinutes !== undefined) {
      const m = Number(input.idleMinutes);
      if (!Number.isInteger(m) || m < 1 || m > 24 * 60) throw new HttpError(400, 'Minuti di pausa: da 1 a 1440');
      config.idleMs = m * 60_000;
      this.data.idleMinutes = m;
    }
    this.save();
  }

  /** Stato di ogni agente: installato, versione, login. Controlli lenti: risultato in cache 1 minuto */
  async agents(force = false) {
    const list = [
      ...Object.values(AGENTS).map((a) => ({ id: a.id, label: a.label, note: a.note, chat: true })),
      ...TOOLS.map((t) => ({ ...t, chat: false })),
    ];
    return Promise.all(
      list.map(async (a) => {
        let status = this.statusCache.get(a.id);
        if (force || !status || Date.now() - status.at > 60_000) {
          status = { at: Date.now(), value: await this.probe(a.id) };
          this.statusCache.set(a.id, status);
        }
        return {
          id: a.id,
          label: a.label,
          note: a.note,
          chat: a.chat,
          ...status.value,
          loginCommand: LOGIN_COMMANDS[a.id] ?? null,
          env: (AGENT_ENV[a.id] ?? []).map((v) => ({ ...v, set: Boolean(this.secrets[a.id]?.[v.name] || process.env[v.name]) })),
          defaults: this.data.agentDefaults[a.id] ?? {},
          options: this.data.agentOptions[a.id] ?? [],
        };
      }),
    );
  }

  private applyRoots(roots: string[]): void {
    const real = roots.flatMap((p) => {
      try {
        return [realpathSync(p)];
      } catch {
        return [];
      }
    });
    if (real.length) config.projectRoots.splice(0, config.projectRoots.length, ...real);
  }

  private save(): void {
    writeJson(settingsFile, this.data);
  }

  private async probe(agentId: string): Promise<{ installed: boolean; version: string | null; login: LoginStatus }> {
    const env = { ...process.env, ...this.secrets[agentId] };
    switch (agentId) {
      case 'claude': {
        const version = await run('claude', ['--version'], env);
        if (version === null) return { installed: false, version: null, login: { state: 'unknown', detail: 'claude non installato' } };
        const out = await run('claude', ['auth', 'status'], env);
        try {
          const s = JSON.parse(out ?? '');
          return {
            installed: true,
            version: firstLine(version),
            login: s.loggedIn
              ? { state: 'ok', detail: [s.authMethod, s.subscriptionType && `piano ${s.subscriptionType}`].filter(Boolean).join(', ') }
              : { state: 'missing', detail: 'Non collegato' },
          };
        } catch {
          return { installed: true, version: firstLine(version), login: { state: 'unknown', detail: 'Stato non leggibile' } };
        }
      }
      case 'opencode': {
        const version = await run('opencode', ['--version'], env);
        if (version === null) return { installed: false, version: null, login: { state: 'unknown', detail: 'opencode non installato' } };
        const out = stripAnsi((await run('opencode', ['auth', 'list'], env)) ?? '');
        const n = Number(/(\d+)\s+credentials?/.exec(out)?.[1] ?? 0);
        return {
          installed: true,
          version: firstLine(version),
          // Senza credenziali OpenCode usa comunque i suoi modelli gratuiti
          login: n > 0 ? { state: 'ok', detail: `${n} provider collegati` } : { state: 'missing', detail: 'Nessun provider: solo modelli gratuiti' },
        };
      }
      case 'codex': {
        const version = await run('codex', ['--version'], env);
        if (version === null) return { installed: false, version: null, login: { state: 'unknown', detail: 'codex non installato' } };
        const out = (await run('codex', ['login', 'status'], env)) ?? '';
        const logged = /logged in/i.test(out);
        return {
          installed: true,
          version: firstLine(version),
          login: logged
            ? { state: 'ok', detail: /api key/i.test(out) ? 'Chiave API' : 'Account ChatGPT' }
            : { state: 'missing', detail: 'Non collegato' },
        };
      }
      case 'cursor': {
        const version = await run('cursor-agent', ['--version'], env);
        if (version === null) return { installed: false, version: null, login: { state: 'unknown', detail: 'cursor-agent non installato' } };
        const out = stripAnsi((await run('cursor-agent', ['status'], env)) ?? '');
        const logged = /logged in/i.test(out) && !/not logged in/i.test(out);
        return {
          installed: true,
          version: firstLine(version),
          login: logged
            ? /unable to fetch/i.test(out)
              ? { state: 'unknown', detail: 'Login presente ma non verificabile: se le chat non partono, rifai il login' }
              : { state: 'ok', detail: firstLine(out.replace(/^.*Login successful!?\s*/i, '')) }
            : { state: 'missing', detail: 'Non collegato' },
        };
      }
      case 'agy': {
        const version = await run(AGY_BIN, ['--version'], env);
        if (version === null) return { installed: false, version: null, login: { state: 'unknown', detail: `agy non trovato in ${AGY_BIN}` } };
        // Senza login agy resta in attesa: se in 20 secondi elenca i modelli, il login c'e'
        const models = await run(AGY_BIN, ['models'], env, 20_000);
        const ok = models !== null && models.trim().length > 0 && !/login|sign in|authenticat/i.test(models);
        return {
          installed: true,
          version: firstLine(version),
          login: ok ? { state: 'ok', detail: 'Account Google collegato' } : { state: 'missing', detail: 'Non collegato per l\'utente di AgiCloud' },
        };
      }
      default:
        return { installed: true, version: null, login: { state: 'ok', detail: 'Nessun login richiesto' } };
    }
  }
}

/** Esegue un comando breve; null se non esiste o fallisce */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 1024 * 1024, cwd: '/tmp' }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      if (err && err.killed) return resolve(null); // scaduto il tempo
      resolve(err && !stdout ? (stderr || null) : `${stdout}${stderr}`);
    });
  });
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0]!.slice(0, 80);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
