// Plugin Design (packages/design): catalogo per l'interfaccia e anteprime dal vivo delle pagine HTML.
// Le anteprime girano su /preview/<token>/...: il token vale solo per una cartella, in sola lettura,
// e scade. La pagina e' in una sandbox senza allow-same-origin (origine opaca): i suoi script
// non vedono il token di AgiCloud e non possono chiamare le API.

import { randomBytes } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { catalog, getSkill, getSystem, skillDir, systemDir } from '@agicloud/design';
import { HttpError } from './errors.js';
import { mimeOf, resolveExisting } from './files.js';

const TTL_MS = 6 * 60 * 60_000;
const MAX_TOKENS = 500;

// Le pagine generate usano spesso font e librerie da CDN: permessi, ma solo dentro la sandbox
const PREVIEW_CSP =
  "sandbox allow-scripts allow-popups allow-forms allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'";

export class Previews {
  private readonly tokens = new Map<string, { root: string; expires: number }>();

  /** URL di anteprima per una cartella (riusa il token se e' ancora valido a lungo) */
  urlFor(root: string): { url: string; expires: number } {
    const now = Date.now();
    for (const [token, p] of this.tokens) {
      if (p.expires <= now) this.tokens.delete(token);
      else if (p.root === root && p.expires - now > TTL_MS / 2) return { url: `/preview/${token}/`, expires: p.expires };
    }
    if (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    const token = randomBytes(18).toString('base64url');
    const expires = now + TTL_MS;
    this.tokens.set(token, { root, expires });
    return { url: `/preview/${token}/`, expires };
  }

  /** File dentro la cartella del token (percorso reale: niente symlink o ".." per uscire) */
  resolve(token: string, rel: string): string {
    const p = this.tokens.get(token);
    if (!p || p.expires <= Date.now()) throw new HttpError(404, 'Anteprima scaduta: riaprila da AgiCloud');
    // Niente file o cartelle nascosti (.env, .git, .agicloud...): la pagina in anteprima ha accesso alla rete
    if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) throw new HttpError(404, 'Non trovato');
    let real: string;
    try {
      real = realpathSync(join(p.root, rel));
    } catch {
      throw new HttpError(404, 'Non trovato');
    }
    if (real !== p.root && !real.startsWith(p.root + sep)) throw new HttpError(404, 'Non trovato');
    if (statSync(real).isDirectory()) return this.resolve(token, join(rel, 'index.html'));
    return real;
  }
}

/** Route del plugin: /api/design/* (dietro al token di accesso) e /preview/* (token dell'anteprima) */
export function registerDesign(app: Hono<any>, previews = new Previews()): void {
  app.get('/api/design/catalog', (c) => c.json(catalog()));

  // body: { dir } cartella di un progetto, oppure { system } / { skill } del catalogo
  app.post('/api/design/previews', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let root: string;
    if (typeof body.system === 'string' && getSystem(body.system)) root = systemDir(body.system);
    else if (typeof body.skill === 'string' && getSkill(body.skill)) root = skillDir(body.skill);
    else if (typeof body.dir === 'string' && body.dir) root = resolveExisting(body.dir);
    else throw new HttpError(400, 'Serve dir, system o skill');
    root = realpathSync(root);
    if (!statSync(root).isDirectory()) throw new HttpError(400, 'Non e\' una cartella');
    return c.json(previews.urlFor(root));
  });

  app.get('/preview/:token/*', (c) => {
    const token = c.req.param('token');
    const rel = decodeURIComponent(c.req.path.slice(`/preview/${token}/`.length));
    let file: string;
    try {
      file = previews.resolve(token, rel);
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status);
      throw err;
    }
    const mime = mimeOf(file);
    c.header('Content-Type', mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime);
    c.header('Content-Security-Policy', PREVIEW_CSP);
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });
}
