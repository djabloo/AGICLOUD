import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';

// Serve la SPA in public/: file statici + fallback a index.html fuori da /api.
export function mountStatic(app: Hono) {
  const root = join(new URL('.', import.meta.url).pathname, '..', 'public');
  app.use('/*', serveStatic({ root }));
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api')) return c.notFound();
    return c.html(await readFile(join(root, 'index.html'), 'utf8'));
  });
}
