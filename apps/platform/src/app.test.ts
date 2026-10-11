import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ensureAdmin } from './app.js';
import { openDb } from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { randomSubdomain, subdomainProblem } from './subdomain.js';

async function setup() {
  const db = openDb(':memory:');
  const mails: string[] = [];
  const running = new Map<string, Record<string, string>>();
  const orchestrator: Orchestrator = {
    start: async (id, _sub, env) => (running.set(id, env), { id, status: 'running', port: 40000 }),
    info: async (id) => (running.has(id) ? { id, status: 'running', port: 40000 } : null),
    stop: async (id) => void running.delete(id),
    remove: async (id) => void running.delete(id),
  };
  const app = createApp({ db, baseUrl: 'http://t', secureCookies: false, orchestrator, rootDomain: 'agicloud.test', mailer: { send: async (_t, _s, text) => void mails.push(text) } });
  await ensureAdmin(db, 'admin@x.it', 'password-admin-1');
  const call = async (method: string, path: string, body?: unknown, cookie = '') => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { res, json: (await res.clone().json().catch(() => ({}))) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const login = async (email: string, password: string) => {
    if (email !== 'admin@x.it') {
      await call('POST', '/api/auth/register', { email, password });
      await call('GET', `/api/auth/verify?token=${mails.at(-1)!.match(/token=(\S+)/)![1]}`);
    }
    return (await call('POST', '/api/auth/login', { email, password })).cookie;
  };
  return { call, mails, db, running, login };
}

test('registrazione → conferma → login → admin gestisce utenti', async () => {
  const { call, mails } = await setup();
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.it', password: 'corta' })).res.status, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.it', password: 'password-lunga-1' })).res.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.it', password: 'password-lunga-1' })).res.status, 403); // non confermato
  const token = mails[0].match(/token=(\S+)/)![1];
  assert.equal((await call('GET', `/api/auth/verify?token=${token}`)).res.status, 302);
  assert.equal((await call('GET', `/api/auth/verify?token=${token}`)).res.status, 400); // monouso
  const user = await call('POST', '/api/auth/login', { email: 'a@b.it', password: 'password-lunga-1' });
  assert.equal(user.res.status, 200);
  assert.equal((await call('GET', '/api/admin/users', undefined, user.cookie)).res.status, 403);

  const admin = await call('POST', '/api/auth/login', { email: 'admin@x.it', password: 'password-admin-1' });
  const list = await call('GET', '/api/admin/users', undefined, admin.cookie);
  assert.equal(list.json.users.length, 2);
  const uid = list.json.users.find((u: any) => u.email === 'a@b.it').id;
  assert.equal((await call('PATCH', `/api/admin/users/${uid}`, { status: 'suspended' }, admin.cookie)).res.status, 200);
  assert.equal((await call('GET', '/api/me', undefined, user.cookie)).res.status, 401); // sessione chiusa
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.it', password: 'password-lunga-1' })).res.status, 403);
  const adminId = list.json.users.find((u: any) => u.email === 'admin@x.it').id;
  assert.equal((await call('PATCH', `/api/admin/users/${adminId}`, { role: 'user' }, admin.cookie)).res.status, 409);
  assert.equal((await call('GET', '/api/admin/stats', undefined, admin.cookie)).json.suspended, 1);
});

test('login: password errata e freno ai tentativi', async () => {
  const { call } = await setup();
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/auth/login', { email: 'admin@x.it', password: 'sbagliata' })).res.status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'admin@x.it', password: 'password-admin-1' })).res.status, 429);
});

test('nomi degli ambienti: riservati e formato', () => {
  for (const bad of ['www', 'app', 'admin', 'admin-323cloud', 'a', 'ab', '-abc', 'abc-', 'a--b', 'Abc', 'a.b', 'xn-abc']) assert.ok(subdomainProblem(bad), bad);
  for (const good of ['tino', 'mio-ambiente-2', randomSubdomain()]) assert.equal(subdomainProblem(good), null, good);
});

test('ambiente: crea (nome scelto o casuale), un solo ambiente, nomi unici, sospensione lo ferma', async () => {
  const { call, login, running } = await setup();
  const a = await login('a@b.it', 'password-lunga-1');
  const b = await login('b@b.it', 'password-lunga-2');
  const admin = await login('admin@x.it', 'password-admin-1');

  assert.equal((await call('POST', '/api/workspace', { subdomain: 'www' }, a)).res.status, 400);
  const created = await call('POST', '/api/workspace', { subdomain: 'tino' }, a);
  assert.equal(created.res.status, 200);
  assert.equal(created.json.workspace.url, 'https://tino.agicloud.test');
  assert.match(created.json.workspace.setupUrl, /\?setup=[0-9a-f]{32}$/);
  assert.equal([...running.values()][0].SETUP_TOKEN.length, 32);
  assert.equal((await call('POST', '/api/workspace', {}, a)).res.status, 409); // uno solo
  assert.equal((await call('POST', '/api/workspace', { subdomain: 'tino' }, b)).res.status, 409); // nome preso
  const random = await call('POST', '/api/workspace', {}, b);
  assert.match(random.json.workspace.subdomain, /^ac-[a-z0-9]{9}$/);

  assert.equal((await call('GET', '/api/admin/workspaces', undefined, a)).res.status, 403);
  assert.equal((await call('GET', '/api/admin/workspaces', undefined, admin)).json.workspaces.length, 2);

  const users = (await call('GET', '/api/admin/users', undefined, admin)).json.users;
  const idA = users.find((u: any) => u.email === 'a@b.it').id;
  await call('PATCH', `/api/admin/users/${idA}`, { status: 'suspended' }, admin);
  assert.equal(running.size, 1); // l'ambiente di a e' stato fermato

  assert.equal((await call('DELETE', '/api/workspace?confirm=sbagliato', undefined, b)).res.status, 400);
  assert.equal((await call('DELETE', `/api/workspace?confirm=${random.json.workspace.subdomain}`, undefined, b)).res.status, 200);
  assert.equal(running.size, 0);
});

test('cambio password e reimpostazione via email', async () => {
  const { call, login, mails } = await setup();
  const cookie = await login('a@b.it', 'password-lunga-1');

  // Cambio password dal profilo: errore password attuale errata o nuova troppo corta
  assert.equal((await call('POST', '/api/me/password', { currentPassword: 'errata', newPassword: 'nuova-password-1' }, cookie)).res.status, 401);
  assert.equal((await call('POST', '/api/me/password', { currentPassword: 'password-lunga-1', newPassword: 'corta' }, cookie)).res.status, 400);

  // Cambio password riuscito
  assert.equal((await call('POST', '/api/me/password', { currentPassword: 'password-lunga-1', newPassword: 'nuova-password-valida' }, cookie)).res.status, 200);

  // Login con la nuova password
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.it', password: 'password-lunga-1' })).res.status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.it', password: 'nuova-password-valida' })).res.status, 200);

  // Reimposta password via email (forgot-password)
  const initialMails = mails.length;
  await call('POST', '/api/auth/forgot-password', { email: 'a@b.it' });
  assert.equal(mails.length, initialMails + 1);
  const resetToken = mails.at(-1)!.match(/reset=(\S+)/)![1];

  // Reset con password non valida o token errato
  assert.equal((await call('POST', '/api/auth/reset-password', { token: 'token-falso', newPassword: 'password-reset-1' })).res.status, 400);
  assert.equal((await call('POST', '/api/auth/reset-password', { token: resetToken, newPassword: 'corta' })).res.status, 400);

  // Reset riuscito
  assert.equal((await call('POST', '/api/auth/reset-password', { token: resetToken, newPassword: 'password-reset-funzionante' })).res.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.it', password: 'password-reset-funzionante' })).res.status, 200);
});
