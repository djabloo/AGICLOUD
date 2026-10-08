// Login guidato degli agenti, senza terminale: il comando di login gira in un pty nascosto,
// dall'output si prendono il link da aprire e la richiesta di un codice, e l'interfaccia
// mostra solo "apri il link" e "incolla il codice". Il terminale resta come ripiego.

import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { AGENT_ENV_BLOCK } from './settings.js';
import { HttpError } from './errors.js';

interface GuidedSpec {
  command: string;
  /** Dopo il link l'agente chiede di incollare un codice (altrimenti aspetta da solo il browser) */
  needsCode: boolean;
}

/** Solo gli agenti con un login "link (+ codice)"; gli altri hanno menu interattivi e usano il terminale */
export const GUIDED_LOGINS: Record<string, GuidedSpec> = {
  claude: { command: 'claude auth login --claudeai', needsCode: true },
  cursor: { command: 'NO_OPEN_BROWSER=1 cursor-agent login', needsCode: false },
};

const TIMEOUT_MS = 10 * 60_000;
/** Testo tenuto per "mostra dettagli" (caratteri) */
const OUTPUT_TAIL = 4000;
const URL_RE = /https?:\/\/[^\s"'<>`]+/g;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g;

export type GuidedState = 'waiting' | 'checking' | 'done' | 'failed';

export interface GuidedStatus {
  agentId: string;
  state: GuidedState;
  url: string | null;
  needsCode: boolean;
  /** L'agente ha chiesto il codice ed e' in attesa */
  askingCode: boolean;
  output: string;
  error: string | null;
}

class GuidedLogin {
  private proc: pty.IPty;
  private raw = '';
  /** Punto del testo in cui e' stato inviato il codice: una nuova richiesta dopo = codice rifiutato */
  private sentAt = -1;
  private textLength = 0;
  private timer: NodeJS.Timeout;
  status: GuidedStatus;

  constructor(
    agentId: string,
    spec: GuidedSpec,
    private readonly onDone: (ok: boolean) => void,
  ) {
    this.status = { agentId, state: 'waiting', url: null, needsCode: spec.needsCode, askingCode: false, output: '', error: null };
    const env = { ...process.env, TERM: 'xterm-256color', BROWSER: 'true' } as Record<string, string>;
    for (const name of AGENT_ENV_BLOCK[agentId] ?? []) delete env[name];
    // Righe larghissime: il link esce su una riga sola. Il token di ~/.bashrc cambierebbe il login di claude
    this.proc = pty.spawn('bash', ['-lc', `unset CLAUDE_CODE_OAUTH_TOKEN; ${spec.command}`], {
      name: 'xterm-256color',
      cols: 1000,
      rows: 40,
      cwd: homedir(),
      env,
    });
    this.proc.onData((d) => this.onData(d));
    this.proc.onExit(({ exitCode }) => this.onExit(exitCode));
    this.timer = setTimeout(() => this.fail('Tempo scaduto: riprova'), TIMEOUT_MS);
    this.timer.unref();
  }

  private onData(data: string): void {
    this.raw = (this.raw + data).slice(-50_000);
    const text = this.raw.replace(ANSI_RE, '').replace(/\r/g, '');
    this.status.output = text.slice(-OUTPUT_TAIL);
    if (!this.status.url) {
      const url = text.match(URL_RE)?.[0]?.replace(/[).,;:!?\]]+$/, '');
      if (url) this.status.url = url;
    }
    if (!this.status.needsCode) return;
    const asking = /paste.*code|code.*here/i;
    if (this.status.state === 'checking') {
      // claude: "Invalid code..." e resta in attesa di un altro codice
      if (asking.test(text.slice(this.sentAt)) || /invalid code/i.test(text.slice(this.sentAt))) {
        this.status.state = 'waiting';
        this.status.askingCode = true;
        this.status.error = 'Codice non accettato: riprova (copialo intero)';
      }
    } else if (asking.test(text.slice(-300))) this.status.askingCode = true;
    this.textLength = text.length;
  }

  private onExit(code: number): void {
    clearTimeout(this.timer);
    if (this.status.state === 'failed') return;
    if (code === 0) {
      this.status.state = 'done';
      this.onDone(true);
    } else {
      const last = this.status.output.trim().split('\n').slice(-2).join(' ').trim();
      this.fail(last || `Login non riuscito (codice ${code})`);
    }
  }

  sendCode(code: string): void {
    if (this.status.state !== 'waiting') throw new HttpError(409, 'Nessun login in attesa di codice');
    const clean = code.trim();
    if (!clean || clean.length > 2000 || /[\r\n]/.test(clean)) throw new HttpError(400, 'Codice non valido');
    this.status.state = 'checking';
    this.status.askingCode = false;
    this.status.error = null;
    this.sentAt = this.textLength;
    this.proc.write(clean + '\r');
  }

  private fail(error: string): void {
    if (this.status.state === 'done' || this.status.state === 'failed') return;
    this.status.state = 'failed';
    this.status.error = error;
    this.stop();
    this.onDone(false);
  }

  stop(): void {
    clearTimeout(this.timer);
    try {
      this.proc.kill();
    } catch {
      /* gia' uscito */
    }
  }
}

export class GuidedLogins {
  private readonly active = new Map<string, GuidedLogin>();

  /** onDone: per aggiornare lo stato dell'agente (es. svuotare la cache dei controlli) */
  constructor(private readonly onDone: (agentId: string) => void) {}

  start(agentId: string): GuidedStatus {
    const spec = GUIDED_LOGINS[agentId];
    if (!spec) throw new HttpError(400, 'Per questo agente il login si fa dal terminale');
    this.active.get(agentId)?.stop();
    const login = new GuidedLogin(agentId, spec, () => this.onDone(agentId));
    this.active.set(agentId, login);
    return login.status;
  }

  get(agentId: string): GuidedStatus | null {
    return this.active.get(agentId)?.status ?? null;
  }

  sendCode(agentId: string, code: string): GuidedStatus {
    const login = this.active.get(agentId);
    if (!login) throw new HttpError(404, 'Nessun login in corso');
    login.sendCode(code);
    return login.status;
  }

  cancel(agentId: string): void {
    this.active.get(agentId)?.stop();
    this.active.delete(agentId);
  }
}
