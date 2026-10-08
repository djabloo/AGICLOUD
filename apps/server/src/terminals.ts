// Terminali persistenti. Ogni terminale ha un custode (term-host.ts): un processo staccato dal server
// che tiene in vita la shell e il suo output. Il server ci parla su un socket Unix, quindi il terminale
// sopravvive alla chiusura della pagina, alla rete che cade e anche ai riavvii del server.
// L'output arriva al browser cosi' com'e' (nessun multiplexer che ridisegna lo schermo).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';

const MAX_TERMINALS = 10;
/** Se nessuno si collega entro questo tempo la shell parte comunque, con misure standard */
const START_FALLBACK_MS = 15_000;

const HOST_SCRIPT = new URL('./term-host.ts', import.meta.url).pathname;
const TSX = import.meta.resolve('tsx');
const TERMINAL_RC = new URL('../terminal.bashrc', import.meta.url).pathname;
const DATA_DIR = join(config.threadsDir, '..');
const META_FILE = join(DATA_DIR, 'terminals.json');
const SOCKET_DIR = join(DATA_DIR, 'terminals');

type Listener = (msg: { type: 'data'; data: string } | { type: 'exit'; code: number }) => void;
type HostMsg = { type: 'replay'; data: string; exited: boolean; code: number | null } | { type: 'data'; data: string } | { type: 'exit'; code: number };

interface TerminalMeta {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
}

export class Terminal {
  /** Copia dell'output del custode, per chi si collega dal browser */
  private buffer = '';
  exitCode: number | null = null;
  private readonly listeners = new Set<Listener>();
  private sock: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private fallback: NodeJS.Timeout | null = null;
  /** Misure da mandare appena il custode risponde */
  private pendingSize: [number, number] | null = null;

  constructor(
    readonly meta: TerminalMeta,
    /** true = custode gia' attivo (ritrovato dopo un riavvio) */
    private started: boolean,
    private readonly command?: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    if (started) void this.connectHost();
    else {
      // La shell nasce quando arriva il primo browser, gia' con le sue misure
      this.fallback = setTimeout(() => this.start(100, 30), START_FALLBACK_MS);
      this.fallback.unref();
    }
  }

  get id() {
    return this.meta.id;
  }

  private get socketPath() {
    return join(SOCKET_DIR, `${this.meta.id}.sock`);
  }

  summary() {
    const { id, cwd, title, createdAt } = this.meta;
    return { id, cwd, project: basename(cwd), title, createdAt, exited: this.exitCode !== null };
  }

  /** Avvia il custode (staccato dal server: `setsid -f` lo affida a init, PM2 non lo chiude) */
  private start(cols: number, rows: number): void {
    if (this.started || this.exitCode !== null) return;
    this.started = true;
    if (this.fallback) clearTimeout(this.fallback);
    const shell = process.env.SHELL || '/bin/bash';
    // CLAUDE_CODE_OAUTH_TOKEN (da ~/.bashrc) farebbe usare a `claude` un token diverso dal login dell'account
    const argv = this.command
      ? [shell, '-l', '-c', `unset CLAUDE_CODE_OAUTH_TOKEN; ${this.command}`]
      : basename(shell) === 'bash'
        ? [shell, '--rcfile', TERMINAL_RC, '-i']
        : [shell, '-l'];
    mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
    const child = spawn('setsid', ['-f', process.execPath, '--import', TSX, HOST_SCRIPT], {
      cwd: this.meta.cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => this.markExited(1));
    child.stdin.end(
      JSON.stringify({
        socket: this.socketPath,
        cwd: this.meta.cwd,
        cols: clampCols(cols),
        rows: clampRows(rows),
        argv,
        env: this.extraEnv,
      }),
    );
    void this.connectHost();
  }

  /** Collegamento al custode; al primo avvio il socket compare dopo qualche centinaio di ms */
  private connectHost(): Promise<void> {
    if (this.sock || this.connecting) return this.connecting ?? Promise.resolve();
    this.connecting = (async () => {
      for (let attempt = 0; attempt < 50 && this.exitCode === null; attempt++) {
        const sock = await tryConnect(this.socketPath);
        if (sock) return this.useSocket(sock);
        await new Promise((r) => setTimeout(r, 100));
      }
      this.markExited(1); // custode morto o mai partito
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private useSocket(sock: Socket): void {
    this.sock = sock;
    sock.setEncoding('utf8');
    let pending = '';
    sock.on('data', (chunk: string) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        try {
          this.onHost(JSON.parse(line) as HostMsg);
        } catch {
          /* riga rovinata */
        }
      }
    });
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.markExited(this.exitCode ?? 0); // il custode se n'e' andato
    });
    sock.on('error', () => {});
    if (this.pendingSize) {
      this.toHost({ type: 'resize', cols: this.pendingSize[0], rows: this.pendingSize[1] });
      this.pendingSize = null;
    }
  }

  private onHost(msg: HostMsg): void {
    if (msg.type === 'replay') {
      this.buffer = msg.data;
      if (msg.exited) this.markExited(msg.code ?? 0);
    } else if (msg.type === 'data') {
      this.buffer += msg.data;
      for (const l of this.listeners) l(msg);
    } else if (msg.type === 'exit') this.markExited(msg.code);
  }

  private toHost(msg: unknown): void {
    if (this.sock && !this.sock.destroyed) this.sock.write(JSON.stringify(msg) + '\n');
  }

  private markExited(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const l of this.listeners) l({ type: 'exit', code });
  }

  /** cols/rows: misure del browser che si collega. Si aspetta il custode per avere tutto l'output */
  async attach(listener: Listener, cols?: number, rows?: number): Promise<{ replay: string; detach: () => void }> {
    if (cols && rows) {
      if (!this.started) this.start(cols, rows);
      else this.resize(cols, rows);
    }
    await this.connectHost();
    this.listeners.add(listener);
    return { replay: this.buffer, detach: () => this.listeners.delete(listener) };
  }

  write(data: string): void {
    if (this.exitCode === null) this.toHost({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    if (this.exitCode !== null) return;
    const size: [number, number] = [clampCols(cols), clampRows(rows)];
    if (this.sock) this.toHost({ type: 'resize', cols: size[0], rows: size[1] });
    else this.pendingSize = size;
  }

  /** Chiude davvero: il custode termina la shell e se ne va */
  kill(): void {
    if (this.fallback) clearTimeout(this.fallback);
    this.listeners.clear();
    this.toHost({ type: 'kill' });
    this.sock?.end();
    this.sock = null;
  }

  /** Arresto del server: ci si stacca, il custode e la shell restano vivi */
  disconnect(): void {
    this.listeners.clear();
    const s = this.sock;
    this.sock = null;
    s?.destroy();
  }
}

export class TerminalStore {
  private readonly terminals = new Map<string, Terminal>();

  /** extraEnv: chiavi del portachiavi abilitate per i terminali (lette a ogni apertura) */
  constructor(private readonly extraEnv: () => Record<string, string> = () => ({})) {
    this.restore();
  }

  /** Dopo un riavvio: si ritrovano i custodi ancora vivi (quelli morti si scoprono al collegamento) */
  private restore(): void {
    let saved: TerminalMeta[] = [];
    try {
      saved = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : [];
    } catch {
      saved = [];
    }
    for (const meta of saved) {
      if (existsSync(join(SOCKET_DIR, `${meta.id}.sock`))) this.terminals.set(meta.id, new Terminal(meta, true));
    }
    this.save();
  }

  private save(): void {
    const tmp = `${META_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.terminals.values()].map((t) => t.meta)));
    renameSync(tmp, META_FILE);
  }

  list() {
    return [...this.terminals.values()].sort((a, b) => b.meta.createdAt - a.meta.createdAt).map((t) => t.summary());
  }

  get(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw new HttpError(404, 'Terminale non trovato');
    return t;
  }

  create(cwd: string, command?: string): Terminal {
    const alive = [...this.terminals.values()].filter((t) => t.exitCode === null).length;
    if (alive >= MAX_TERMINALS) throw new HttpError(429, `Troppi terminali aperti (max ${MAX_TERMINALS}): chiudine uno`);
    const real = resolveProject(cwd);
    const title = command ? `${commandLabel(command)} · ${basename(real)}` : basename(real);
    const t = new Terminal({ id: randomUUID(), cwd: real, title, createdAt: Date.now() }, false, command, this.extraEnv());
    this.terminals.set(t.id, t);
    this.save();
    return t;
  }

  remove(id: string): void {
    this.get(id).kill();
    this.terminals.delete(id);
    this.save();
  }

  /** Arresto del server: i terminali restano vivi nei loro custodi */
  detachAll(): void {
    for (const t of this.terminals.values()) t.disconnect();
  }
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(null);
    const sock = connect(path);
    sock.once('connect', () => resolve(sock));
    sock.once('error', () => resolve(null));
  });
}

/** "NO_OPEN_BROWSER=1 /percorso/cursor-agent login" -> "cursor-agent login" */
function commandLabel(command: string): string {
  const words = command.split(' ').filter((w) => w && !/^[A-Z_]+=/.test(w));
  if (words[0]) words[0] = basename(words[0]);
  return words.join(' ');
}

function clampCols(n: number): number {
  return Math.max(2, Math.min(500, Math.floor(n)));
}

function clampRows(n: number): number {
  return Math.max(1, Math.min(300, Math.floor(n)));
}
