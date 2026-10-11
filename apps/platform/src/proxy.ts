// Proxy per host: <sottodominio>.agicloud.dev → container dell'utente su 127.0.0.1 (HTTP e WebSocket).
// Caddy gira davanti e gestisce HTTPS; qui si sceglie solo il container giusto.

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { Orchestrator } from './orchestrator.js';

const CACHE_MS = 5_000;

export function createProxy(db: DatabaseSync, orchestrator: Orchestrator, rootDomain: string) {
  const cache = new Map<string, { port: number | null; at: number }>();
  const suffix = `.${rootDomain}`;

  /** Sottodominio richiesto, se l'host e' uno spazio utente */
  const subdomainOf = (host: string | undefined): string | null => {
    const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
    return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes('.') ? h.slice(0, -suffix.length) : null;
  };

  const portFor = async (sub: string): Promise<number | null> => {
    const hit = cache.get(sub);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.port;
    const row = db.prepare("SELECT id FROM workspaces WHERE subdomain = ? AND status = 'running'").get(sub) as { id: string } | undefined;
    const port = row ? ((await orchestrator.info(row.id).catch(() => null))?.port ?? null) : null;
    cache.set(sub, { port, at: Date.now() });
    return port;
  };

  const notFound = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
  };

  return {
    isWorkspaceHost: (host: string | undefined) => subdomainOf(host) !== null,
    forget: (sub: string) => void cache.delete(sub),

    async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const port = await portFor(subdomainOf(req.headers.host)!);
      if (!port) return notFound(res, 404, 'Ambiente non trovato o spento');
      const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => (res.headersSent ? res.destroy() : notFound(res, 502, 'Ambiente non raggiungibile')));
      req.pipe(up);
    },

    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
      const port = await portFor(subdomainOf(req.headers.host) ?? '');
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
