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

export class Terminal {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  private buffer = '';
  exitCode: number | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly proc: pty.IPty;

  constructor(
    readonly cwd: string,
    readonly title: string,
    command: string | undefined,
    cols: number,
    rows: number,
    extraEnv: Record<string, string> = {},
  ) {
    const shell = process.env.SHELL || '/bin/bash';
    this.proc = pty.spawn(shell, command ? ['-l', '-c', command] : ['-l'], {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env: { ...process.env, ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    this.proc.onData((data) => {
      this.buffer = (this.buffer + data).slice(-SCROLLBACK);
      for (const l of this.listeners) l({ type: 'data', data });
    });
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const l of this.listeners) l({ type: 'exit', code: exitCode });
    });
  }

  summary() {
    return { id: this.id, cwd: this.cwd, project: basename(this.cwd), title: this.title, createdAt: this.createdAt, exited: this.exitCode !== null };
  }

  attach(listener: Listener): { replay: string; detach: () => void } {
    this.listeners.add(listener);
    return { replay: this.buffer, detach: () => this.listeners.delete(listener) };
  }

  write(data: string): void {
    if (this.exitCode === null) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exitCode !== null) return;
    const c = Math.max(2, Math.min(500, Math.floor(cols)));
    const r = Math.max(1, Math.min(300, Math.floor(rows)));
    try {
      this.proc.resize(c, r);
    } catch {
      /* il processo puo' essere appena uscito */
    }
  }

  kill(): void {
    this.listeners.clear();
    if (this.exitCode === null) this.proc.kill();
  }
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
    const t = new Terminal(real, title, command, 100, 30, this.extraEnv());
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
