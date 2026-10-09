// Plugin: funzioni facoltative di AgiCloud (Design, PII, Browser, ...) che si installano,
// si attivano/disattivano e si disinstallano dalle Impostazioni.
// Oggi il codice dei plugin e' nella repo ("builtin") e installare = preparare quello che serve
// (es. controllare il motore di PII). In versione SaaS il catalogo indichera' da dove scaricarli:
// il resto (stato, interruttore, route bloccate quando spento) resta uguale.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';

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
  /** Da dove arriva il codice: oggi nella repo; in SaaS dal catalogo */
  source: 'builtin';
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

const STATE_FILE = join(config.threadsDir, '..', 'plugins.json');

export class Plugins {
  private readonly specs = new Map<string, PluginSpec>();
  private state: Record<string, PluginState> = {};

  constructor(specs: PluginSpec[], defaults: Record<string, PluginState> = {}) {
    for (const s of specs) this.specs.set(s.id, s);
    try {
      this.state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
    } catch {
      this.state = {};
    }
    // Plugin gia' in uso prima che esistesse questo elenco (es. Design): restano attivi
    for (const [id, st] of Object.entries(defaults)) this.state[id] ??= st;
    this.save();
  }

  isEnabled(id: string): boolean {
    const st = this.state[id];
    return Boolean(st?.installed && st.enabled);
  }

  /** Errore chiaro se una funzione del plugin viene usata a plugin spento */
  require(id: string): void {
    if (!this.isEnabled(id)) throw new HttpError(400, `Il plugin ${this.specs.get(id)?.name ?? id} non e' attivo: attivalo in Impostazioni → Plugin`);
  }

  async list() {
    return Promise.all(
      [...this.specs.values()].map(async (s) => {
        const st = this.state[s.id] ?? { installed: false, enabled: false };
        const health = st.installed && s.health ? await s.health().catch((err) => ({ ok: false, detail: String(err?.message ?? err) })) : null;
        return {
          id: s.id,
          name: s.name,
          version: s.version,
          description: s.description,
          section: s.section ?? null,
          credits: s.credits ?? null,
          requires: s.requires ?? null,
          source: s.source,
          installed: st.installed,
          enabled: st.installed && st.enabled,
          health,
        };
      }),
    );
  }

  async install(id: string): Promise<void> {
    const spec = this.spec(id);
    try {
      await spec.install?.();
    } catch (err) {
      throw new HttpError(409, `Installazione di ${spec.name} non riuscita: ${err instanceof Error ? err.message : err}`);
    }
    this.state[id] = { installed: true, enabled: true, installedAt: Date.now() };
    this.save();
  }

  async uninstall(id: string): Promise<void> {
    const spec = this.spec(id);
    await spec.uninstall?.().catch(() => {});
    this.state[id] = { installed: false, enabled: false };
    this.save();
  }

  setEnabled(id: string, enabled: boolean): void {
    const spec = this.spec(id);
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
        if (s.routes.some((r) => path.startsWith(r)) && !this.isEnabled(s.id)) {
          return c.json({ error: `Il plugin ${s.name} non e' attivo` }, 404);
        }
      }
      return next();
    });
    app.get('/api/plugins', async (c) => c.json(await this.list()));
    app.post('/api/plugins/:id/install', async (c) => {
      await this.install(c.req.param('id'));
      return c.json(await this.list());
    });
    app.post('/api/plugins/:id/uninstall', async (c) => {
      await this.uninstall(c.req.param('id'));
      return c.json(await this.list());
    });
    app.post('/api/plugins/:id/enabled', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
      this.setEnabled(c.req.param('id'), body.enabled === true);
      return c.json(await this.list());
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
  }
}
