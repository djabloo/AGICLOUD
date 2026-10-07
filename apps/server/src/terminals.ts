// Terminali persistenti: la shell resta viva se la pagina si chiude o la rete cade.
// Alla riconnessione si rimanda l'ultima parte dell'output, poi si prosegue in diretta.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as pty from 'node-pty';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';

const MAX_TERMINALS = 10;
/** Output tenuto per la riconnessione (caratteri) */
const SCROLLBACK = 400_000;

type Listener = (msg: { type: 'data'; data: string } | { type: 'exit'; code: number }) => void;

/** Se nessuno si collega entro questo tempo il processo parte comunque, con misure standard */
const START_FALLBACK_MS = 15_000;

export class Terminal {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  private buffer = '';
  exitCode: number | null = null;
  private readonly listeners = new Set<Listener>();
  private proc: pty.IPty | null = null;
  private readonly fallback: NodeJS.Timeout;

  constructor(
    readonly cwd: string,
    readonly title: string,
    private readonly command: string | undefined,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    // Il processo parte quando arriva il primo browser, gia' con le sue misure:
    // i programmi a schermo intero (login, menu) si disegnano subito della larghezza giusta
    this.fallback = setTimeout(() => this.start(100, 30), START_FALLBACK_MS);
    this.fallback.unref();
  }

  private start(cols: number, rows: number): void {
    if (this.proc || this.exitCode !== null) return;
    clearTimeout(this.fallback);
    const shell = process.env.SHELL || '/bin/bash';
    const proc = pty.spawn(shell, this.command ? ['-l', '-c', this.command] : ['-l'], {
      name: 'xterm-256color',
      cwd: this.cwd,
      cols: clampCols(cols),
      rows: clampRows(rows),
      env: { ...process.env, ...this.extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    this.proc = proc;
    proc.onData((data) => {
      this.buffer = (this.buffer + data).slice(-SCROLLBACK);
      for (const l of this.listeners) l({ type: 'data', data });
    });
    proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const l of this.listeners) l({ type: 'exit', code: exitCode });
    });
  }

  summary() {
    return { id: this.id, cwd: this.cwd, project: basename(this.cwd), title: this.title, createdAt: this.createdAt, exited: this.exitCode !== null };
  }

  /** cols/rows: misure del browser che si collega (avviano il processo se non e' ancora partito) */
  attach(listener: Listener, cols?: number, rows?: number): { replay: string; detach: () => void } {
    this.listeners.add(listener);
    if (!this.proc && cols && rows) this.start(cols, rows);
    else if (cols && rows) this.resize(cols, rows);
    return { replay: this.buffer, detach: () => this.listeners.delete(listener) };
  }

  write(data: string): void {
    if (this.exitCode === null) this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exitCode !== null || !this.proc) return;
    try {
      this.proc.resize(clampCols(cols), clampRows(rows));
    } catch {
      /* il processo puo' essere appena uscito */
    }
  }

  kill(): void {
    clearTimeout(this.fallback);
    this.listeners.clear();
    if (this.exitCode === null) this.proc?.kill();
  }
}

function clampCols(n: number): number {
  return Math.max(2, Math.min(500, Math.floor(n)));
}

function clampRows(n: number): number {
  return Math.max(1, Math.min(300, Math.floor(n)));
}

export class TerminalStore {
  private readonly terminals = new Map<string, Terminal>();

  /** extraEnv: chiavi del portachiavi abilitate per i terminali (lette a ogni apertura) */
  constructor(private readonly extraEnv: () => Record<string, string> = () => ({})) {}

  list() {
    return [...this.terminals.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => t.summary());
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
    const title = command ? `${command} · ${basename(real)}` : basename(real);
    const t = new Terminal(real, title, command, this.extraEnv());
    this.terminals.set(t.id, t);
    return t;
  }

  remove(id: string): void {
    this.get(id).kill();
    this.terminals.delete(id);
  }

  killAll(): void {
    for (const t of this.terminals.values()) t.kill();
  }
}
