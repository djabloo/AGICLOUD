// Custode di un terminale: un processo staccato dal server (avviato con `setsid -f`) che tiene
// in vita la shell e il suo output. Il server ci parla su un socket Unix; se il server si riavvia,
// la shell resta qui e al ricollegamento si rimanda tutto l'output, cosi' com'e'.
// Niente tmux in mezzo: xterm riceve l'output originale (scorrimento, selezione e link naturali).
//
// Configurazione via stdin (JSON), non da riga di comando: le chiavi del portachiavi
// finirebbero in /proc/<pid>/cmdline, leggibile da tutti gli utenti.
//
// Protocollo: una riga JSON per messaggio.
//   host -> server: {type:'replay', data, exited, code} al collegamento, poi {type:'data', data}, {type:'exit', code}
//   server -> host: {type:'input', data}, {type:'resize', cols, rows}, {type:'kill'}

import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import * as pty from 'node-pty';

interface HostConfig {
  socket: string;
  cwd: string;
  cols: number;
  rows: number;
  argv: string[];
  env: Record<string, string>;
  /** Variabili da togliere dall'ambiente ereditato (es. un token che farebbe usare l'account sbagliato) */
  unsetEnv?: string[];
}

/** Output tenuto per la riconnessione (caratteri) */
const SCROLLBACK = 400_000;
/** Dopo la fine del programma si resta in attesa che il browser veda l'uscita, poi ci si chiude */
const LINGER_MS = 60 * 60_000;

const cfg = JSON.parse(await readStdin()) as HostConfig;
const clients = new Set<Socket>();
let buffer = '';
let exitCode: number | null = null;

const shellEnv = { ...process.env, ...cfg.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
for (const name of cfg.unsetEnv ?? []) delete shellEnv[name];

const shell = pty.spawn(cfg.argv[0]!, cfg.argv.slice(1), {
  name: 'xterm-256color',
  cwd: cfg.cwd,
  cols: cfg.cols,
  rows: cfg.rows,
  env: shellEnv,
});

shell.onData((data) => {
  buffer = (buffer + data).slice(-SCROLLBACK);
  broadcast({ type: 'data', data });
});

shell.onExit(({ exitCode: code }) => {
  exitCode = code;
  broadcast({ type: 'exit', code });
  setTimeout(shutdown, LINGER_MS).unref();
});

const server = createServer((sock) => {
  clients.add(sock);
  sock.setEncoding('utf8');
  send(sock, { type: 'replay', data: buffer, exited: exitCode !== null, code: exitCode });
  let pending = '';
  sock.on('data', (chunk: string) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      handle(line);
    }
  });
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
});

// Le named pipe di Windows non sono file: chmod non si applica (e non serve, non sono condivise)
server.listen(cfg.socket, () => {
  if (process.platform !== 'win32') chmodSync(cfg.socket, 0o600);
});

process.on('SIGTERM', shutdown);
process.on('SIGHUP', () => {}); // la chiusura del gruppo del server non ci riguarda

function handle(line: string): void {
  let msg: { type?: string; data?: string; cols?: number; rows?: number };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'kill') return shutdown();
  if (exitCode !== null) return;
  if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data);
  else if (msg.type === 'resize' && msg.cols && msg.rows) {
    try {
      shell.resize(msg.cols, msg.rows);
    } catch {
      /* programma appena uscito */
    }
  }
}

function send(sock: Socket, msg: unknown): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}

function broadcast(msg: unknown): void {
  for (const c of clients) send(c, msg);
}

function shutdown(): void {
  if (exitCode === null) {
    try {
      shell.kill('SIGHUP');
    } catch {
      /* gia' uscito */
    }
  }
  for (const c of clients) c.end();
  server.close();
  try {
    unlinkSync(cfg.socket);
  } catch {
    /* gia' tolto */
  }
  // Lascia il tempo di consegnare l'ultimo messaggio
  setTimeout(() => process.exit(0), 200);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}
