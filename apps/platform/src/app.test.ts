import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ensureAdmin } from './app.js';
import { openDb } from './db.js';

async function setup() {
  const db = openDb(':memory:');
  const mails: string[] = [];
  const app = createApp({ db, baseUrl: 'http://t', secureCookies: false, mailer: { send: async (_t, _s, text) => void mails.push(text) } });
  await ensureAdmin(db, 'admin@x.it', 'password-admin-1');
  const call = async (method: string, path: string, body?: unknown, cookie = '') => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { res, json: (await res.clone().json().catch(() => ({}))) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  return { call, mails, db };
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
