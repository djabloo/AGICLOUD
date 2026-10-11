import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from './proxy.js';

test('instrada per host, 404 per host sconosciuto, rilegge il file quando cambia', async () => {
  const backend = createServer((req, res) => res.end(`backend:${req.url}`)).listen(0, '127.0.0.1');
  await new Promise((r) => backend.once('listening', r));
  const bport = (backend.address() as { port: number }).port;
  const file = join(mkdtempSync(join(tmpdir(), 'edge-')), 'routes.json');
  writeFileSync(file, JSON.stringify({ 'tino.agicloud.dev': bport }));
  const edge = createServer(createProxy(file).http).listen(0, '127.0.0.1');
  await new Promise((r) => edge.once('listening', r));
  const eport = (edge.address() as { port: number }).port;
  const get = (host: string) =>
    new Promise<readonly [number, string]>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: eport, path: '/x', headers: { host }, agent: false }, (r) => {
        let body = '';
        r.on('data', (d) => (body += d));
        r.on('end', () => resolve([r.statusCode ?? 0, body] as const));
      });
      req.on('error', reject).end();
    });
  assert.deepEqual(await get('tino.agicloud.dev'), [200, 'backend:/x']);
  assert.equal((await get('altro.agicloud.dev'))[0], 404);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(file, '{}');
  assert.equal((await get('tino.agicloud.dev'))[0], 404);
  edge.close(); backend.close();
});
