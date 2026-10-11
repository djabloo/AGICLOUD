// API dell'orchestratore (solo 127.0.0.1, protetta da un segreto condiviso con la piattaforma).

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { ID_RE, type Limits, type Runners } from './docker.js';

const DEFAULT_LIMITS: Limits = { cpus: '0.5', memory: '512m', pids: 256 };
const CPUS_RE = /^\d+(\.\d+)?$/;
const MEM_RE = /^\d+[mg]$/;

export function createApp(runners: Runners, secret: string) {
  const app = new Hono();
  const expected = Buffer.from(secret);

  app.use('*', async (c, next) => {
    const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer /, ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: 'Non autorizzato' }, 401);
    return next();
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : 'Errore interno' }, 500);
  });

  app.get('/v1/runners', async (c) => c.json({ runners: await runners.list() }));

  app.post('/v1/runners', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { id?: string; limits?: Partial<Limits>; env?: Record<string, string> };
    if (!b.id || !ID_RE.test(b.id)) return c.json({ error: 'Id non valido' }, 400);
    const limits = { ...DEFAULT_LIMITS, ...b.limits };
    if (!CPUS_RE.test(String(limits.cpus)) || !MEM_RE.test(String(limits.memory)) || !Number.isInteger(limits.pids)) return c.json({ error: 'Limiti non validi' }, 400);
    return c.json(await runners.start(b.id, { cpus: String(limits.cpus), memory: String(limits.memory), pids: limits.pids }, b.env));
  });

  app.get('/v1/runners/:id', async (c) => {
    const info = await runners.info(c.req.param('id'));
    return info ? c.json(info) : c.json({ error: 'Non trovato' }, 404);
  });

  app.post('/v1/runners/:id/stop', async (c) => {
    await runners.stop(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.delete('/v1/runners/:id', async (c) => {
    await runners.remove(c.req.param('id'), c.req.query('purge') === '1');
    return c.json({ ok: true });
  });

  return app;
}
