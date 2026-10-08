// Terminali persistenti. Ogni terminale e' una sessione tmux su un socket dedicato (-L agicloud):
// sopravvive alla chiusura della pagina, alla rete che cade e anche ai riavvii del server.
// Il server si collega alla sessione con un pty "spettatore" (tmux attach) e ne inoltra l'output.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as pty from 'node-pty';
import { config, LEAKED_SESSION_VARS } from './config.js';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';

const MAX_TERMINALS = 10;
/** Output tenuto per la riconnessione del browser (caratteri) */
const SCROLLBACK = 400_000;
/** Se nessuno si collega entro questo tempo la sessione parte comunque, con misure standard */
const START_FALLBACK_MS = 15_000;

const TMUX_SOCKET = 'agicloud';
const TMUX_CONF = new URL('../tmux.conf', import.meta.url).pathname;
const TERMINAL_RC = new URL('../terminal.bashrc', import.meta.url).pathname;
const PREFIX = 'agc-';
const META_FILE = join(config.threadsDir, '..', 'terminals.json');

type Listener = (msg: { type: 'data'; data: string } | { type: 'exit'; code: number }) => void;

interface TerminalMeta {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
}

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', TMUX_SOCKET, '-f', TMUX_CONF, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Il server tmux tiene l'ambiente di chi l'ha avviato: si tolgono le variabili di sessione Claude Code */
function cleanTmuxEnvironment(): void {
  let lines: string[] = [];
  try {
    lines = tmux(['show-environment', '-g']).split('\n');
  } catch {
    return; // server tmux non ancora avviato: nascera' dall'ambiente gia' pulito
  }
  for (const line of lines) {
    const name = line.split('=')[0]!.replace(/^-/, '');
    if (LEAKED_SESSION_VARS.test(name)) {
      try {
        tmux(['set-environment', '-g', '-u', name]);
      } catch {
        /* gia' tolta */
      }
    }
  }
}

function tmuxSessions(): Set<string> {
  try {
    return new Set(tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter((s) => s.startsWith(PREFIX)));
  } catch {
    return new Set(); // nessun server tmux attivo = nessuna sessione
  }
}

export class Terminal {
  private buffer = '';
  exitCode: number | null = null;
  private readonly listeners = new Set<Listener>();
  /** pty che guarda la sessione tmux (si ricrea se cade) */
  private viewer: pty.IPty | null = null;
  private fallback: NodeJS.Timeout | null = null;

  constructor(
    readonly meta: TerminalMeta,
    /** true = sessione tmux gia' esistente (ritrovata dopo un riavvio) */
    private created: boolean,
    private readonly command?: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    if (!created) {
      // La sessione nasce quando arriva il primo browser, gia' con le sue misure
      this.fallback = setTimeout(() => this.ensureSession(100, 30), START_FALLBACK_MS);
      this.fallback.unref();
    }
  }

  get id() {
    return this.meta.id;
  }

  private get session() {
    return PREFIX + this.meta.id;
  }

  summary() {
    const { id, cwd, title, createdAt } = this.meta;
    return { id, cwd, project: basename(cwd), title, createdAt, exited: this.exitCode !== null };
  }

  private ensureSession(cols: number, rows: number): void {
    if (this.created || this.exitCode !== null) return;
    if (this.fallback) clearTimeout(this.fallback);
    const env = Object.entries(this.extraEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const shell = process.env.SHELL || '/bin/bash';
    const bash = basename(shell) === 'bash';
    // CLAUDE_CODE_OAUTH_TOKEN (da ~/.bashrc) farebbe usare a `claude` un token diverso dal login dell'account
    const cmd = this.command
      ? [shell, '-l', '-c', `unset CLAUDE_CODE_OAUTH_TOKEN; ${this.command}`]
      : bash
        ? [shell, '--rcfile', TERMINAL_RC, '-i']
        : [shell, '-l'];
    tmux([
      'new-session', '-d', '-s', this.session,
      '-x', String(clampCols(cols)), '-y', String(clampRows(rows)),
      '-c', this.meta.cwd, ...env, ...cmd,
    ]);
    this.created = true;
  }

  /** Collega (o ricollega) lo spettatore alla sessione tmux */
  private ensureViewer(cols: number, rows: number): void {
    if (this.viewer || this.exitCode !== null) return;
    this.ensureSession(cols, rows);
    if (!tmuxSessions().has(this.session)) {
      this.markExited(0);
      return;
    }
    const viewer = pty.spawn('tmux', ['-L', TMUX_SOCKET, '-f', TMUX_CONF, 'attach-session', '-t', this.session], {
      name: 'xterm-256color',
      cwd: this.meta.cwd,
      cols: clampCols(cols),
      rows: clampRows(rows),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    this.viewer = viewer;
    viewer.onData((data) => {
      this.buffer = (this.buffer + data).slice(-SCROLLBACK);
      for (const l of this.listeners) l({ type: 'data', data });
    });
    viewer.onExit(({ exitCode }) => {
      if (this.viewer !== viewer) return;
      this.viewer = null;
      // Lo spettatore esce quando la sessione finisce (programma terminato o chiusa)
      if (!tmuxSessions().has(this.session)) this.markExited(exitCode);
    });
  }

  private markExited(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const l of this.listeners) l({ type: 'exit', code });
  }

  /** cols/rows: misure del browser che si collega */
  attach(listener: Listener, cols?: number, rows?: number): { replay: string; detach: () => void } {
    this.listeners.add(listener);
    if (cols && rows) {
      if (!this.viewer) this.ensureViewer(cols, rows);
      else this.resize(cols, rows);
    }
    return { replay: this.buffer, detach: () => this.listeners.delete(listener) };
  }

  write(data: string): void {
    if (this.exitCode === null) this.viewer?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exitCode !== null || !this.viewer) return;
    try {
      this.viewer.resize(clampCols(cols), clampRows(rows));
    } catch {
      /* lo spettatore puo' essere appena uscito */
    }
  }

  /** Chiude davvero: termina la sessione tmux e i suoi processi */
  kill(): void {
    if (this.fallback) clearTimeout(this.fallback);
    this.listeners.clear();
    try {
      if (this.created) tmux(['kill-session', '-t', this.session]);
    } catch {
      /* gia' terminata */
    }
    this.viewer?.kill();
  }

  /** Arresto del server: si stacca lo spettatore, la sessione tmux resta viva */
  detachViewer(): void {
    this.listeners.clear();
    const v = this.viewer;
    this.viewer = null;
    v?.kill();
  }
}

export class TerminalStore {
  private readonly terminals = new Map<string, Terminal>();

  /** extraEnv: chiavi del portachiavi abilitate per i terminali (lette a ogni apertura) */
  constructor(private readonly extraEnv: () => Record<string, string> = () => ({})) {
    cleanTmuxEnvironment();
    this.restore();
  }

  /** Dopo un riavvio: si ritrovano le sessioni tmux ancora vive */
  private restore(): void {
    const alive = tmuxSessions();
    let saved: TerminalMeta[] = [];
    try {
      saved = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : [];
    } catch {
      saved = [];
    }
    for (const meta of saved) {
      if (alive.has(PREFIX + meta.id)) this.terminals.set(meta.id, new Terminal(meta, true));
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

  /** Arresto del server: i terminali restano vivi in tmux */
  detachAll(): void {
    for (const t of this.terminals.values()) t.detachViewer();
  }
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
