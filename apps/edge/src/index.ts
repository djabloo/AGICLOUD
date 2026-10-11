import { createServer } from 'node:http';
import { createProxy } from './proxy.js';

const proxy = createProxy(process.env.ROUTES_FILE ?? '/opt/agicloud/run/routes.json');
const port = Number(process.env.EDGE_PORT ?? 3112);
const server = createServer((req, res) => proxy.http(req, res));
server.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));
// Mai 0.0.0.0: davanti c'e' Caddy
server.listen(port, '127.0.0.1', () => console.log(`Proxy ambienti su 127.0.0.1:${port}`));
