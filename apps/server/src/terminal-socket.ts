// WebSocket dei terminali: /api/terminals/:id/ws
// Il token arriva nel primo messaggio (mai nell'URL, che finisce nei log);
// l'Origin deve coincidere con l'host, cosi' un altro sito non puo' aprire la shell.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TerminalStore } from './terminals.js';

type Access = 'ok' | 'missing' | 'denied' | 'blocked';
type CheckAccess = (ip: string, token: string) => Access;

const PATH = /^\/api\/terminals\/([\w-]+)\/ws$/;
const AUTH_TIMEOUT_MS = 5000;
const MAX_MESSAGE = 1024 * 1024;

export function attachTerminalSockets(server: Server, terminals: TerminalStore, checkAccess: CheckAccess): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PATH.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (!match || !sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, req, match[1]!));
  });

  function serve(ws: WebSocket, req: IncomingMessage, id: string): void {
    let detach: (() => void) | null = null;
    const send = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg: { type?: string; token?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!detach) {
        if (msg.type !== 'auth') return ws.close(4001, 'auth required');
        clearTimeout(authTimer);
        const access = checkAccess(clientIp(req), String(msg.token ?? ''));
        if (access !== 'ok') return ws.close(4001, access === 'blocked' ? 'blocked' : 'denied');
        let term;
        try {
          term = terminals.get(id);
        } catch {
          return ws.close(4004, 'not found');
        }
        if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
        const attached = term.attach((m) => send(m));
        detach = attached.detach;
        send({ type: 'replay', data: attached.replay, exited: term.exitCode !== null, code: term.exitCode });
        return;
      }
      const term = safeGet(terminals, id);
      if (!term) return;
      if (msg.type === 'input' && typeof msg.data === 'string') term.write(msg.data);
      else if (msg.type === 'resize' && msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      detach?.();
    });
  }
}

function safeGet(terminals: TerminalStore, id: string) {
  try {
    return terminals.get(id);
  } catch {
    return null;
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
