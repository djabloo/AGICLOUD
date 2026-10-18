// Plugin: funzioni facoltative di AgiCloud (Design, PII, Browser, ...) che si installano,
// si attivano/disattivano e si disinstallano dalle Impostazioni.
// Due provenienze: "builtin" (codice nella repo) ed "external" (cartella con manifest.json, fuori dalla repo).
// Un plugin esterno arriva dal catalogo della macchina (AGICLOUD_PLUGINS_DIR, es. montato dalla piattaforma)
// oppure da un link (URL Git o cartella locale), e dichiara nel manifest cosa porta:
//   mcp    server MCP stdio dato agli agenti (nome = id del plugin)
//   server modulo ESM con register(app, ctx): le sue route stanno sotto /api/x/<id>/
//   web    cartella statica mostrata come sezione del menu (/plugin-ui/<id>/, stessa origine dell'app)
// Il codice di un plugin esterno gira con gli stessi permessi di AgiCloud: si installano solo plugin fidati.

import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { parseAccept, tPlugin, type Lang } from './i18n.js';
import { isAllowed, PLAN_ERROR } from './features.js';

/** Testo del manifest: stringa unica oppure una per lingua ({ it, en, de, cs, ru }) */
type LangText = string | Partial<Record<Lang, string>>;

interface ExternalInfo {
  dir: string;
  origin: 'catalog' | 'link';
  url?: string;
  texts: { name: LangText; description: LangText; requires?: LangText; section?: LangText };
  icon?: string;
  mcp?: { command: string; args: string[]; env: Record<string, string>; autoAllow: boolean };
  server?: string;
  web?: string;
}

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
  /** Da dove arriva il codice: builtin nella repo oppure external (catalogo o link) */
  source: 'builtin' | 'external';
  /** Solo per i plugin esterni: cartella e contenuto dichiarato nel manifest */
  external?: ExternalInfo;
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

/** Plugin installati da link (quelli del catalogo si ritrovano a ogni avvio) */
interface LinkEntry {
  id: string;
  dir: string;
  url: string;
}

const STATE_FILE = join(config.dataDir, 'plugins.json');
const LINKS_FILE = join(config.dataDir, 'external-plugins.json');
const DOWNLOAD_DIR = join(config.dataDir, 'plugins');
const PLUGIN_DATA_DIR = join(config.dataDir, 'plugin-data');
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const langText = (v: unknown): LangText | undefined => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const out: Partial<Record<Lang, string>> = {};
    for (const [k, s] of Object.entries(v)) if (typeof s === 'string') out[k as Lang] = s;
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
};

/** Testo nella lingua chiesta, poi italiano, poi inglese, poi il primo che c'e' */
const pick = (t: LangText | undefined, lang: Lang): string => {
  if (t === undefined) return '';
  if (typeof t === 'string') return t;
  return t[lang] ?? t.it ?? t.en ?? Object.values(t)[0] ?? '';
};

/** Percorso del manifest dentro la cartella del plugin (mai fuori) */
const inside = (dir: string, rel: unknown): string | undefined => {
  if (typeof rel !== 'string' || !rel) return undefined;
  const abs = resolve(dir, rel);
  return abs === dir || abs.startsWith(dir + sep) ? abs : undefined;
};

export function specFromManifest(rawDir: string, origin: ExternalInfo['origin'], url?: string): PluginSpec {
  const dir = resolve(rawDir);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new HttpError(400, 'Link plugin non valido: manifest.json non trovato');
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new HttpError(400, 'Link plugin non valido: manifest.json malformato');
  }
  const id = String(raw.id ?? '').trim();
  if (!ID_RE.test(id)) throw new HttpError(400, 'Link plugin non valido: id mancante');
  const texts: ExternalInfo['texts'] = {
    name: langText(raw.name) ?? id,
    description: langText(raw.description) ?? '',
    requires: langText(raw.requires),
    section: raw.section ? (langText(raw.section.label) ?? langText(raw.name) ?? id) : undefined,
  };
  const pluginData = join(PLUGIN_DATA_DIR, id);
  const subst = (s: string) => s.replaceAll('${PLUGIN_DIR}', dir).replaceAll('${PLUGIN_DATA}', pluginData);
  let mcp: ExternalInfo['mcp'];
  if (raw.mcp && typeof raw.mcp.command === 'string') {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.mcp.env ?? {})) if (typeof v === 'string') env[k] = subst(v);
    mcp = {
      command: subst(raw.mcp.command),
      args: Array.isArray(raw.mcp.args) ? raw.mcp.args.map((a: unknown) => subst(String(a))) : [],
      env: { ...env, AGICLOUD_PLUGIN_DIR: dir, AGICLOUD_PLUGIN_DATA: pluginData },
      autoAllow: raw.mcp.autoAllow === true,
    };
  }
  const web = inside(dir, raw.web);
  const server = inside(dir, raw.server);
  return {
    id,
    name: pick(texts.name, 'it'),
    version: String(raw.version || '1.0.0'),
    description: pick(texts.description, 'it'),
    section: texts.section && web ? { id, label: pick(texts.section, 'it') } : undefined,
    credits:
      raw.credits && typeof raw.credits.text === 'string' && typeof raw.credits.url === 'string'
        ? { text: raw.credits.text, url: raw.credits.url }
        : undefined,
    requires: texts.requires ? pick(texts.requires, 'it') : undefined,
    routes: [`/api/x/${id}`, `/plugin-ui/${id}`],
    source: 'external',
    external: {
      dir,
      origin,
      url,
      texts,
      icon: typeof raw.section?.icon === 'string' ? raw.section.icon : undefined,
      mcp,
      server: server && existsSync(server) ? server : undefined,
      web: web && existsSync(web) ? web : undefined,
    },
  };
}

/** Plugin del catalogo: sottocartelle con manifest.json delle cartelle di AGICLOUD_PLUGINS_DIR */
function scanCatalog(): PluginSpec[] {
  const out: PluginSpec[] = [];
  for (const root of config.pluginsDirs) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      if (!existsSync(join(dir, 'manifest.json'))) continue;
      try {
        out.push(specFromManifest(dir, 'catalog'));
      } catch (err) {
        console.error(`Plugin del catalogo ignorato (${dir}):`, err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}

function git(args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile('git', args, { timeout: 120_000 }, (err) => (err ? rej(err) : res())));
}

/** Contesto passato a register() del modulo server di un plugin esterno */
export interface PluginContext {
  id: string;
  pluginDir: string;
  /** Cartella dati del plugin (creata), separata per ogni plugin */
  dataDir: string;
  HttpError: typeof HttpError;
}

export class Plugins {
  private readonly specs = new Map<string, PluginSpec>();
  private readonly builtinIds = new Set<string>();
  private state: Record<string, PluginState> = {};
  private links: Record<string, LinkEntry> = {};
  /** Moduli server dei plugin esterni gia' caricati (per id) */
  private readonly servers = new Map<string, Promise<Hono>>();

  constructor(specs: PluginSpec[], defaults: Record<string, PluginState> = {}) {
    for (const s of specs) {
      this.specs.set(s.id, s);
      this.builtinIds.add(s.id);
    }
    try {
      this.state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
    } catch {
      this.state = {};
    }
    for (const s of scanCatalog()) if (!this.builtinIds.has(s.id)) this.specs.set(s.id, s);
    try {
      this.links = existsSync(LINKS_FILE) ? JSON.parse(readFileSync(LINKS_FILE, 'utf8')) : {};
    } catch {
      this.links = {};
    }
    for (const [id, entry] of Object.entries(this.links)) {
      try {
        const spec = specFromManifest(entry.dir, 'link', entry.url);
        if (spec.id !== id || this.builtinIds.has(id)) throw new Error('id cambiato');
        this.specs.set(id, spec);
      } catch {
        delete this.links[id];
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
    return Boolean(this.specs.has(id) && st?.installed && st.enabled);
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
        const ext = s.external;
        return {
          id: s.id,
          name: ext ? pick(ext.texts.name, lang) : s.name,
          version: s.version,
          description: ext ? pick(ext.texts.description, lang) : tPlugin(s.description, lang),
          section: s.section ? (ext ? { id: s.id, label: pick(ext.texts.section, lang), icon: ext.icon ?? null, ui: `/plugin-ui/${s.id}/` } : s.section) : null,
          credits: s.credits ? { ...s.credits, text: ext ? s.credits.text : tPlugin(s.credits.text, lang) } : null,
          requires: ext ? pick(ext.texts.requires, lang) || null : s.requires ? tPlugin(s.requires, lang) : null,
          source: s.source,
          origin: ext?.origin ?? null,
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

  /** Installa (o aggiorna) un plugin esterno da un link: URL Git (https/ssh) oppure cartella sul server */
  async installFromLink(rawUrl: string): Promise<void> {
    const url = rawUrl.trim();
    if (!url) throw new HttpError(400, 'Inserisci il link del plugin');
    let dir: string;
    if (/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/i.test(url)) {
      const slug = (url.replace(/\.git$/i, '').split(/[/:]/).pop() ?? '').replace(/[^a-zA-Z0-9_-]/g, '-');
      if (!slug || slug.startsWith('-')) throw new HttpError(400, 'Link plugin non riconosciuto');
      mkdirSync(DOWNLOAD_DIR, { recursive: true });
      dir = join(DOWNLOAD_DIR, slug);
      try {
        // Gia' scaricato: si aggiorna (reinstallare = prendere l'ultima versione)
        if (existsSync(join(dir, '.git'))) await git(['-C', dir, 'pull', '--ff-only']);
        else await git(['clone', '--depth', '1', '--', url, dir]);
      } catch {
        throw new HttpError(400, 'Impossibile scaricare il plugin dal link fornito');
      }
    } else if (url.startsWith('file://') || isAbsolute(url)) {
      dir = resolve(url.startsWith('file://') ? url.slice('file://'.length) : url);
    } else {
      throw new HttpError(400, 'Link plugin non riconosciuto');
    }

    const spec = specFromManifest(dir, 'link', url);
    if (this.builtinIds.has(spec.id)) throw new HttpError(409, `Plugin sconosciuto: ${spec.id}`);
    this.requirePlan(spec.id);
    this.specs.set(spec.id, spec);
    this.servers.delete(spec.id);
    this.links[spec.id] = { id: spec.id, dir, url };
    this.state[spec.id] = { installed: true, enabled: true, installedAt: Date.now() };
    this.save();
  }

  async uninstall(id: string): Promise<void> {
    const spec = this.spec(id);
    await spec.uninstall?.().catch(() => {});
    this.servers.delete(id);
    if (spec.external?.origin === 'link') {
      // Installato da link: sparisce dall'elenco finche' non viene reinstallato col link
      delete this.links[id];
      delete this.state[id];
      const fromCatalog = scanCatalog().find((s) => s.id === id);
      if (fromCatalog) this.specs.set(id, fromCatalog);
      else this.specs.delete(id);
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

  /** Server MCP dei plugin esterni attivi (il nome del server e' l'id del plugin) */
  mcpServers(): acp.McpServerStdio[] {
    return this.activeExternal()
      .filter((s) => s.external!.mcp)
      .map((s) => {
        const m = s.external!.mcp!;
        mkdirSync(join(PLUGIN_DATA_DIR, s.id), { recursive: true });
        return { name: s.id, command: m.command, args: m.args, env: Object.entries(m.env).map(([name, value]) => ({ name, value })) };
      });
  }

  /** Strumenti che Claude usa senza chiedere (plugin con mcp.autoAllow) */
  allowedTools(): string[] {
    return this.activeExternal()
      .filter((s) => s.external!.mcp?.autoAllow)
      .map((s) => `mcp__${s.id}`);
  }

  /** Server MCP dei plugin esterni attivi, per Impostazioni → Server MCP */
  mcpInfo(): { name: string; label: string; enabled: boolean }[] {
    return this.activeExternal()
      .filter((s) => s.external!.mcp)
      .map((s) => ({ name: s.id, label: s.name, enabled: true }));
  }

  private activeExternal(): PluginSpec[] {
    return [...this.specs.values()].filter((s) => s.external && this.isEnabled(s.id));
  }

  /** Modulo server di un plugin esterno: caricato alla prima richiesta, con le route sotto /api/x/<id> */
  private serverOf(spec: PluginSpec): Promise<Hono> {
    let p = this.servers.get(spec.id);
    if (!p) {
      p = (async () => {
        const file = spec.external!.server!;
        // ?v= fa ricaricare il modulo dopo un aggiornamento (reinstallazione da link)
        const mod = await import(`${pathToFileURL(file).href}?v=${this.state[spec.id]?.installedAt ?? 0}`);
        if (typeof mod.register !== 'function') throw new Error(`${basename(file)}: manca export register(app, ctx)`);
        const sub = new Hono().basePath(`/api/x/${spec.id}`);
        sub.onError((err, c) => {
          const status = (err as { status?: number }).status;
          if (typeof status === 'number' && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
          console.error(`Plugin ${spec.id}:`, err);
          return c.json({ error: 'Errore interno' }, 500);
        });
        const dataDir = join(PLUGIN_DATA_DIR, spec.id);
        mkdirSync(dataDir, { recursive: true });
        const ctx: PluginContext = { id: spec.id, pluginDir: spec.external!.dir, dataDir, HttpError };
        await mod.register(sub, ctx);
        return sub;
      })();
      p.catch(() => this.servers.delete(spec.id));
      this.servers.set(spec.id, p);
    }
    return p;
  }

  /** Route dei plugin (/api/plugins), blocco delle route dei plugin spenti, API e interfaccia dei plugin esterni */
  register(app: Hono<any>): void {
    app.use('*', async (c, next) => {
      const path = c.req.path;
      for (const s of this.specs.values()) {
        if (!s.routes.some((r) => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'))) continue;
        // Prima il piano (403), poi il plugin spento (404)
        if (!isAllowed(config.features, s.id)) return c.json({ error: PLAN_ERROR }, 403);
        if (!this.isEnabled(s.id)) {
          return c.json({ error: `Il plugin ${s.name} non e' attivo` }, 404);
        }
      }
      return next();
    });
    const lang = (c: { req: { header: (n: string) => string | undefined } }) => parseAccept(c.req.header('accept-language')) ?? 'it';
    app.get('/api/plugins', async (c) => c.json(await this.list(lang(c))));
    app.post('/api/plugins/install-link', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
      await this.installFromLink(String(body.url ?? ''));
      return c.json(await this.list(lang(c)));
    });
    app.post('/api/plugins/:id/install', async (c) => {
      await this.install(c.req.param('id'));
      return c.json(await this.list(lang(c)));
    });
    app.post('/api/plugins/:id/uninstall', async (c) => {
      await this.uninstall(c.req.param('id'));
      return c.json(await this.list(lang(c)));
    });
    app.post('/api/plugins/:id/enabled', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
      this.setEnabled(c.req.param('id'), body.enabled === true);
      return c.json(await this.list(lang(c)));
    });

    // API dei plugin esterni (col token, come tutto /api)
    const dispatch = async (c: any) => {
      const spec = this.specs.get(c.req.param('id'));
      if (!spec?.external?.server) throw new HttpError(404, 'Non trovato');
      return (await this.serverOf(spec)).fetch(c.req.raw, c.env);
    };
    app.all('/api/x/:id', dispatch);
    app.all('/api/x/:id/*', dispatch);

    // Interfaccia dei plugin esterni: file statici (senza token, come l'app); i dati li chiede a /api col token
    app.get('/plugin-ui/:id/*', (c) => {
      const spec = this.specs.get(c.req.param('id'));
      const root = spec?.external?.web;
      if (!root) return c.notFound();
      const rel = decodeURIComponent(c.req.path.slice(`/plugin-ui/${spec.id}/`.length)) || 'index.html';
      const file = inside(root, rel);
      if (!file || !existsSync(file) || !statSync(file).isFile()) return c.notFound();
      c.header('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('X-Content-Type-Options', 'nosniff');
      // Come l'app, ma mostrabile dentro l'app stessa (frame-ancestors 'self')
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
      );
      return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
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
    const linksTmp = `${LINKS_FILE}.tmp`;
    writeFileSync(linksTmp, JSON.stringify(this.links, null, 2));
    renameSync(linksTmp, LINKS_FILE);
  }
}
