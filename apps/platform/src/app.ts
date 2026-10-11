// API della piattaforma: registrazione con conferma email, login, sessioni, dashboard admin.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DatabaseSync } from 'node:sqlite';
import type { Mailer } from './mailer.js';
import type { Role, Status, User } from './db.js';
import { hashPassword, newToken, sha256, verifyPassword } from './crypto.js';

const SESSION_COOKIE = 'agicloud_session';
const SESSION_MS = 30 * 24 * 3600_000;
const VERIFY_MS = 24 * 3600_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class ApiError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}

export interface AppOptions {
  db: DatabaseSync;
  mailer: Mailer;
  /** Indirizzo pubblico, per i link nelle email */
  baseUrl: string;
  secureCookies: boolean;
}

const USER_COLS = 'id, email, name, role, status, created_at, last_login_at';

export function createApp({ db, mailer, baseUrl, secureCookies }: AppOptions) {
  const app = new Hono();
  const now = () => Date.now();

  // Freno ai tentativi di accesso: 8 errori in 10 minuti per email+IP
  const failures = new Map<string, number[]>();
  const keyOf = (c: Context, email: string) => `${email.toLowerCase()}|${c.req.header('x-forwarded-for') ?? 'local'}`;
  const tooMany = (k: string) => (failures.get(k) ?? []).filter((t) => t > now() - 600_000).length >= 8;
  const fail = (k: string) => failures.set(k, [...(failures.get(k) ?? []).filter((t) => t > now() - 600_000), now()]);

  const startSession = (c: Context, userId: number) => {
    const sid = newToken();
    db.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(sid), userId, now() + SESSION_MS);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
    setCookie(c, SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'Lax', secure: secureCookies, path: '/', maxAge: SESSION_MS / 1000 });
  };

  const currentUser = (c: Context): User | undefined => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (!sid) return undefined;
    return db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
      )
      .get(sha256(sid), now()) as User | undefined;
  };

  const requireUser = (c: Context): User => {
    const u = currentUser(c);
    if (!u) throw new ApiError(401, 'Accesso richiesto');
    return u;
  };
  const requireAdmin = (c: Context): User => {
    const u = requireUser(c);
    if (u.role !== 'admin') throw new ApiError(403, 'Riservato agli amministratori');
    return u;
  };

  const sendVerification = async (user: { id: number; email: string }) => {
    const token = newToken();
    db.prepare('INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), user.id, 'verify', now() + VERIFY_MS);
    await mailer.send(user.email, 'Conferma il tuo account AgiCloud', `Conferma la registrazione:\n${baseUrl}/api/auth/verify?token=${token}\n\nIl link vale 24 ore.`);
  };

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Errore interno' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/auth/register', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = String(b.email ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');
    const name = String(b.name ?? '').trim().slice(0, 80);
    if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Email non valida');
    if (password.length < 10) throw new ApiError(400, 'La password deve avere almeno 10 caratteri');
    // Risposta identica se l'email esiste gia': non si rivela chi e' registrato
    const existing = db.prepare('SELECT id, status FROM users WHERE email = ?').get(email) as { id: number; status: Status } | undefined;
    if (!existing) {
      const r = db.prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)').run(email, name, await hashPassword(password), now());
      await sendVerification({ id: Number(r.lastInsertRowid), email });
    } else if (existing.status === 'pending') {
      await sendVerification({ id: existing.id, email });
    }
    return c.json({ ok: true, message: 'Se l\'indirizzo e\' valido, ti abbiamo inviato un\'email di conferma' });
  });

  app.get('/api/auth/verify', (c) => {
    const token = c.req.query('token') ?? '';
    const row = db.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND kind = 'verify' AND expires_at > ?").get(sha256(token), now()) as { user_id: number } | undefined;
    if (!row) throw new ApiError(400, 'Link non valido o scaduto');
    db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'").run(row.user_id);
    db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(sha256(token));
    return c.redirect('/?confermato=1');
  });

  app.post('/api/auth/login', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const email = String(b.email ?? '').trim().toLowerCase();
    const k = keyOf(c, email);
    if (tooMany(k)) throw new ApiError(429, 'Troppi tentativi: riprova tra qualche minuto');
    const u = db.prepare('SELECT id, pass_hash, status FROM users WHERE email = ?').get(email) as { id: number; pass_hash: string | null; status: Status } | undefined;
    const ok = await verifyPassword(String(b.password ?? ''), u?.pass_hash ?? null);
    if (!u || !ok) {
      fail(k);
      throw new ApiError(401, 'Email o password errate');
    }
    if (u.status === 'pending') throw new ApiError(403, 'Conferma prima l\'email: controlla la posta');
    if (u.status === 'suspended') throw new ApiError(403, 'Account sospeso');
    startSession(c, u.id);
    return c.json({ ok: true, user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(u.id) });
  });

  app.post('/api/auth/logout', (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(sid));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => c.json({ user: requireUser(c) }));

  app.patch('/api/me', async (c) => {
    const u = requireUser(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name ?? '').trim().slice(0, 80), u.id);
    return c.json({ user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(u.id) });
  });

  // ---- Admin ----
  app.get('/api/admin/stats', (c) => {
    requireAdmin(c);
    const count = (where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get() as { n: number }).n;
    return c.json({
      users: count(''),
      active: count("WHERE status = 'active'"),
      pending: count("WHERE status = 'pending'"),
      suspended: count("WHERE status = 'suspended'"),
      admins: count("WHERE role = 'admin'"),
      newLast7Days: count(`WHERE created_at > ${now() - 7 * 24 * 3600_000}`),
    });
  });

  app.get('/api/admin/users', (c) => {
    requireAdmin(c);
    const q = `%${(c.req.query('q') ?? '').trim()}%`;
    const rows = db.prepare(`SELECT ${USER_COLS} FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 200`).all(q, q);
    return c.json({ users: rows });
  });

  app.patch('/api/admin/users/:id', async (c) => {
    const admin = requireAdmin(c);
    const id = Number(c.req.param('id'));
    const target = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as User | undefined;
    if (!target) throw new ApiError(404, 'Utente non trovato');
    const b = (await c.req.json().catch(() => ({}))) as { role?: Role; status?: Status };
    const role = b.role ?? target.role;
    const status = b.status ?? target.status;
    if (!['admin', 'user'].includes(role) || !['pending', 'active', 'suspended'].includes(status)) throw new ApiError(400, 'Valore non valido');
    // Un admin non puo' togliersi da solo i poteri o sospendersi: si resterebbe senza amministratori
    if (target.id === admin.id && (role !== 'admin' || status !== 'active')) throw new ApiError(409, 'Non puoi declassare o sospendere te stesso');
    db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run(role, status, id);
    if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return c.json({ user: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) });
  });

  app.delete('/api/admin/users/:id', (c) => {
    const admin = requireAdmin(c);
    const id = Number(c.req.param('id'));
    if (id === admin.id) throw new ApiError(409, 'Non puoi eliminare te stesso');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  return app;
}

/** Crea (o riallinea) l'amministratore iniziale da variabili d'ambiente */
export async function ensureAdmin(db: DatabaseSync, email: string, password: string): Promise<void> {
  const e = email.trim().toLowerCase();
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(e) as { id: number } | undefined;
  if (row) {
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(row.id);
    return;
  }
  db.prepare("INSERT INTO users (email, name, pass_hash, role, status, created_at) VALUES (?, 'Admin', ?, 'admin', 'active', ?)").run(e, await hashPassword(password), Date.now());
}
