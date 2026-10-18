// Plugin: funzioni facoltative di AgiCloud (Design, PII, Browser, ...) che si installano,
// si attivano/disattivano e si disinstallano dalle Impostazioni, piu' plugin privati esterni
// installabili da link (senza bottone fisso nel catalogo predefinito).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { parseAccept, tPlugin, type Lang } from './i18n.js';
import { isAllowed, PLAN_ERROR } from './features.js';

export interface PluginSpec {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Sezione nel menu principale, quando il plugin e' attivo */
  section?: { id: string; label: string };
  /** Riconoscimenti (es. contenuti di terzi e licenza) */
  credits?: { text: string; url: string };
  /** Cosa serve sul server (mostrato prima di installare) */
  requires?: string;
  /** Prefissi delle route del plugin: bloccate (404) quando e' spento */
  routes: string[];
  /** Da dove arriva il codice: builtin nella repo oppure external installato da link */
  source: 'builtin' | 'external';
  /** Preparazione all'installazione (es. controllare o scaricare un motore). Errore = installazione fallita */
  install?: () => Promise<void>;
  /** Pulizia alla disinstallazione */
  uninstall?: () => Promise<void>;
  /** Stato del servizio che serve al plugin (es. motore acceso) */
  health?: () => Promise<{ ok: boolean; detail: string }>;
}

interface PluginState {
  installed: boolean;
  enabled: boolean;
  installedAt?: number;
}

interface ExternalPluginEntry {
  id: string;
  dir: string;
  url: string;
}

const STATE_FILE = join(config.threadsDir, '..', 'plugins.json');
const EXTERNAL_FILE = join(config.threadsDir, '..', 'external-plugins.json');
const EXTERNAL_DIR = join(config.threadsDir, '..', 'plugins');

const KNOWN_LINK_ALIASES: Record<string, string> = {
  'agicloud://plugin/accessibility': '/home/user/agicloud-plugin-accessibility',
  'https://accessibility-wcag.com/plugin/accessibility': '/home/user/agicloud-plugin-accessibility',
  'https://cogaguard.com/plugin/accessibility': '/home/user/agicloud-plugin-accessibility',
};

function specFromManifest(dir: string): PluginSpec {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new HttpError(400, 'Link plugin non valido: manifest.json non trovato');
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new HttpError(400, 'Link plugin non valido: manifest.json malformato');
  }
  const id = String(raw.id || raw.name || basename(dir)).trim();
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) throw new HttpError(400, 'Link plugin non valido: id mancante');
  return {
    id,
    name: String(raw.name || raw.displayName || id),
    version: String(raw.version || '1.0.0'),
    description: String(raw.description || ''),
    section:
      raw.section && typeof raw.section.id === 'string' && typeof raw.section.label === 'string'
        ? { id: raw.section.id, label: raw.section.label }
        : undefined,
    credits:
      raw.credits && typeof raw.credits.text === 'string' && typeof raw.credits.url === 'string'
        ? { text: raw.credits.text, url: raw.credits.url }
        : undefined,
    requires: typeof raw.requires === 'string' ? raw.requires : undefined,
    routes: Array.isArray(raw.routes) ? raw.routes.filter((r: unknown) => typeof r === 'string') : [`/api/${id}`],
    source: 'external',
  };
}

export class Plugins {
  private readonly specs = new Map<string, PluginSpec>();
  private state: Record<string, PluginState> = {};
  private external: Record<string, ExternalPluginEntry> = {};

  constructor(specs: PluginSpec[], defaults: Record<string, PluginState> = {}) {
    for (const s of specs) this.specs.set(s.id, s);
    try {
      this.state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
    } catch {
      this.state = {};
    }
    try {
      this.external = existsSync(EXTERNAL_FILE) ? JSON.parse(readFileSync(EXTERNAL_FILE, 'utf8')) : {};
    } catch {
      this.external = {};
    }
    for (const [id, entry] of Object.entries(this.external)) {
      try {
        if (existsSync(entry.dir)) {
          const spec = specFromManifest(entry.dir);
          this.specs.set(spec.id, spec);
        } else {
          delete this.external[id];
        }
      } catch {
        delete this.external[id];
      }
    }
    // Plugin gia' in uso prima che esistesse questo elenco (es. Design): restano attivi
    for (const [id, st] of Object.entries(defaults)) this.state[id] ??= st;
    this.save();
  }

  isEnabled(id: string): boolean {
    const st = this.state[id];
    // Un plugin non consentito dal piano non risulta mai attivo
    if (!isAllowed(config.features, id)) return false;
    return Boolean(st?.installed && st.enabled);
  }

  /** Errore se il plugin non e' consentito dal piano */
  private requirePlan(id: string): void {
    if (!isAllowed(config.features, id)) throw new HttpError(409, `${this.specs.get(id)?.name ?? id}: ${PLAN_ERROR.toLowerCase()}`);
  }

  /** Errore chiaro se una funzione del plugin viene usata a plugin spento */
  require(id: string): void {
    if (!this.isEnabled(id)) throw new HttpError(400, `Il plugin ${this.specs.get(id)?.name ?? id} non e' attivo: attivalo in Impostazioni → Plugin`);
  }

  async list(lang: Lang = 'it') {
    return Promise.all(
      [...this.specs.values()].map(async (s) => {
        const st = this.state[s.id] ?? { installed: false, enabled: false };
        const health = st.installed && s.health ? await s.health().catch((err) => ({ ok: false, detail: String(err?.message ?? err) })) : null;
        return {
          id: s.id,
          name: s.name,
          version: s.version,
          description: tPlugin(s.description, lang),
          section: s.section ?? null,
          credits: s.credits ? { ...s.credits, text: tPlugin(s.credits.text, lang) } : null,
          requires: s.requires ? tPlugin(s.requires, lang) : null,
          source: s.source,
          installed: st.installed,
          enabled: st.installed && st.enabled && isAllowed(config.features, s.id),
          health,
        };
      }),
    );
  }

  async install(id: string): Promise<void> {
    const spec = this.spec(id);
    this.requirePlan(id);
    try {
      await spec.install?.();
    } catch (err) {
      throw new HttpError(409, `Installazione di ${spec.name} non riuscita: ${err instanceof Error ? err.message : err}`);
    }
    this.state[id] = { installed: true, enabled: true, installedAt: Date.now() };
    this.save();
  }

  /** Installa un plugin privato esterno a partire da un link (alias agicloud://, percorso VPS o URL Git) */
  async installFromLink(rawUrl: string): Promise<void> {
    const url = rawUrl.trim();
    if (!url) throw new HttpError(400, 'Inserisci il link del plugin');
    let targetDir = KNOWN_LINK_ALIASES[url] ?? '';
    if (!targetDir) {
      if (url.startsWith('file://')) targetDir = resolve(url.slice('file://'.length));
      else if (url.startsWith('/')) targetDir = resolve(url);
      else if (/^https?:\/\/|^git@/i.test(url)) {
        mkdirSync(EXTERNAL_DIR, { recursive: true });
        const slug =
          url
            .replace(/\.git$/i, '')
            .split('/')
            .pop()
            ?.replace(/[^a-zA-Z0-9_-]/g, '-') || `plugin-${Date.now()}`;
        const cloneDir = join(EXTERNAL_DIR, slug);
        if (!existsSync(cloneDir)) {
          await new Promise<void>((res, rej) => {
            execFile('git', ['clone', '--depth', '1', url, cloneDir], { timeout: 60_000 }, (err) => (err ? rej(err) : res()));
          }).catch(() => {
            throw new HttpError(400, 'Impossibile scaricare il plugin dal link fornito');
          });
        }
        targetDir = cloneDir;
      } else {
        throw new HttpError(400, 'Link plugin non riconosciuto');
      }
    }

    const spec = specFromManifest(targetDir);
    this.requirePlan(spec.id);
    this.specs.set(spec.id, spec);
    this.external[spec.id] = { id: spec.id, dir: targetDir, url };
    this.state[spec.id] = { installed: true, enabled: true, installedAt: Date.now() };
    this.save();
  }

  async uninstall(id: string): Promise<void> {
    const spec = this.spec(id);
    await spec.uninstall?.().catch(() => {});
    if (spec.source === 'external') {
      // Un plugin esterno disinstallato sparisce dal catalogo finche' non viene reinstallato col link
      this.specs.delete(id);
      delete this.external[id];
      delete this.state[id];
    } else {
      this.state[id] = { installed: false, enabled: false };
    }
    this.save();
  }

  setEnabled(id: string, enabled: boolean): void {
    const spec = this.spec(id);
    if (enabled) this.requirePlan(id);
    const st = this.state[id];
    if (!st?.installed) throw new HttpError(409, `${spec.name} non e' installato`);
    st.enabled = enabled;
    this.save();
  }

  /** Route dei plugin (/api/plugins) e blocco delle route dei plugin spenti */
  register(app: Hono<any>): void {
    app.use('*', async (c, next) => {
      const path = c.req.path;
      for (const s of this.specs.values()) {
        if (!s.routes.some((r) => path.startsWith(r))) continue;
        // Prima il piano (403), poi il plugin spento (404)
        if (!isAllowed(config.features, s.id)) return c.json({ error: PLAN_ERROR }, 403);
        if (!this.isEnabled(s.id)) {
          return c.json({ error: `Il plugin ${s.name} non e' attivo` }, 404);
        }
      }
      return next();
    });
    app.get('/api/plugins', async (c) => c.json(await this.list(parseAccept(c.req.header('accept-language')) ?? 'it')));
    app.post('/api/plugins/install-link', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
      await this.installFromLink(String(body.url ?? ''));
      return c.json(await this.list(parseAccept(c.req.header('accept-language')) ?? 'it'));
    });
    app.post('/api/plugins/:id/install', async (c) => {
      await this.install(c.req.param('id'));
      return c.json(await this.list(parseAccept(c.req.header('accept-language')) ?? 'it'));
    });
    app.post('/api/plugins/:id/uninstall', async (c) => {
      await this.uninstall(c.req.param('id'));
      return c.json(await this.list(parseAccept(c.req.header('accept-language')) ?? 'it'));
    });
    app.post('/api/plugins/:id/enabled', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
      this.setEnabled(c.req.param('id'), body.enabled === true);
      return c.json(await this.list(parseAccept(c.req.header('accept-language')) ?? 'it'));
    });
  }

  private spec(id: string): PluginSpec {
    const s = this.specs.get(id);
    if (!s) throw new HttpError(404, `Plugin sconosciuto: ${id}`);
    return s;
  }

  private save(): void {
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, STATE_FILE);
    const extTmp = `${EXTERNAL_FILE}.tmp`;
    writeFileSync(extTmp, JSON.stringify(this.external, null, 2));
    renameSync(extTmp, EXTERNAL_FILE);
  }
}
