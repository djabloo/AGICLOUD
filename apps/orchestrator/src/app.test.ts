import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildRunArgs, Runners, type Exec } from './docker.js';

const cfg = { image: 'img:1', internalPort: 3095, network: 'net', dataRoot: '/tmp/orch-test', user: '1000:1000' };
const SECRET = 's'.repeat(32);

test('argomenti docker: sicurezza e nessun segreto in chiaro', () => {
  const args = buildRunArgs(cfg, 'abc-123', { cpus: '0.5', memory: '512m', pids: 256 }, ['TOKEN']).join(' ');
  for (const must of ['--cap-drop ALL', 'no-new-privileges:true', '--read-only', '-p 127.0.0.1::3095', '--memory 512m', '-e TOKEN']) assert.ok(args.includes(must), must);
  assert.ok(!args.includes('0.0.0.0:'));
});

test('API: segreto obbligatorio, id validato, avvio e stato', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === 'inspect' && args[1] === '--format' && args[3] === 'agicloud-u-abc-123') return calls.some((c) => c[0] === 'run') ? 'running|{"3095/tcp":[{"HostIp":"127.0.0.1","HostPort":"32768"}]}' : (() => { throw new Error('no such'); })();
    return '';
  };
  const app = createApp(new Runners(cfg, exec), SECRET);
  const req = (method: string, path: string, body?: unknown, auth = `Bearer ${SECRET}`) => app.request(path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await req('GET', '/v1/runners', undefined, 'Bearer sbagliato')).status, 401);
  assert.equal((await req('POST', '/v1/runners', { id: '../etc' })).status, 400);
  assert.equal((await req('POST', '/v1/runners', { id: 'abc-123', limits: { memory: '1; rm -rf' } })).status, 400);
  const ok = await req('POST', '/v1/runners', { id: 'abc-123' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: 'abc-123', status: 'running', port: 32768 });
  assert.ok(calls.some((c) => c[0] === 'run'));
});
