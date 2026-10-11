// Proxy di bordo: <sottodominio>.agicloud.dev → container dell'utente su 127.0.0.1 (HTTP e WebSocket).
// Non ha accesso a Docker, database o segreti: legge solo la tabella host → porta scritta dall'orchestratore.

import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

export function createProxy(routesFile: string) {
  let cached: { mtime: number; routes: Record<string, number> } = { mtime: -1, routes: {} };

  const routes = (): Record<string, number> => {
    try {
      const mtime = statSync(routesFile).mtimeMs;
      if (mtime !== cached.mtime) cached = { mtime, routes: JSON.parse(readFileSync(routesFile, 'utf8')) };
    } catch {
      cached = { mtime: -1, routes: {} };
    }
    return cached.routes;
  };
  const portOf = (host: string | undefined): number | null => {
    const port = routes()[(host ?? '').toLowerCase().replace(/:\d+$/, '')];
    return Number.isInteger(port) ? port : null;
  };
  const fail = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
  };

  return {
    http(req: IncomingMessage, res: ServerResponse): void {
      const port = portOf(req.headers.host);
      if (!port) return fail(res, 404, 'Ambiente non trovato o spento');
      const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => (res.headersSent ? res.destroy() : fail(res, 502, 'Ambiente non raggiungibile')));
      req.pipe(up);
    },

    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      const port = portOf(req.headers.host);
      if (!port) return void socket.destroy();
      const up = connect(port, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    },
  };
}
