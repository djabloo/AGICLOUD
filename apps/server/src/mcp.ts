// Impostazioni → Server MCP: server MCP integrati (dei plugin) e server MCP personalizzati (stdio / http / sse).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { Plugins } from './plugins.js';

export interface CustomMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

const MCP_FILE = join(config.threadsDir, '..', 'mcp-servers.json');

export class McpStore {
  private servers: Record<string, CustomMcpServer> = {};

  constructor() {
    try {
      this.servers = existsSync(MCP_FILE) ? JSON.parse(readFileSync(MCP_FILE, 'utf8')) : {};
    } catch {
      this.servers = {};
    }
  }

  /** Elenco per la UI: env e header (spesso token) mai in chiaro, solo le ultime 4 cifre */
  listCustom(): CustomMcpServer[] {
    return Object.values(this.servers).map((s) => ({ ...s, env: maskValues(s.env), headers: maskValues(s.headers) }));
  }

  upsert(raw: Record<string, unknown>): CustomMcpServer {
    const name = String(raw.name ?? '').trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new HttpError(400, 'Id non valido');
    const type = raw.type === 'http' || raw.type === 'sse' ? raw.type : 'stdio';
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (type === 'stdio' && !command) throw new HttpError(400, 'Comando obbligatorio');
    if (type !== 'stdio' && !url) throw new HttpError(400, 'URL obbligatorio');
    const args = Array.isArray(raw.args)
      ? raw.args.map((x) => String(x)).filter(Boolean)
      : typeof raw.args === 'string' && raw.args.trim()
        ? raw.args.trim().split(/\s+/)
        : [];
    const prev = this.servers[name];
    const env = unmaskValues(raw.env, prev?.env);
    const headers = unmaskValues(raw.headers, prev?.headers);
    const entry: CustomMcpServer = {
      name,
      type,
      command: type === 'stdio' ? command : undefined,
      args: type === 'stdio' ? args : undefined,
      env: Object.keys(env).length ? env : undefined,
      url: type !== 'stdio' ? url : undefined,
      headers: Object.keys(headers).length ? headers : undefined,
      enabled: raw.enabled !== false,
    };
    this.servers[name] = entry;
    this.save();
    return entry;
  }

  setEnabled(name: string, enabled: boolean): void {
    const s = this.servers[name];
    if (!s) throw new HttpError(404, 'Non trovato');
    s.enabled = enabled;
    this.save();
  }

  remove(name: string): void {
    if (!this.servers[name]) throw new HttpError(404, 'Non trovato');
    delete this.servers[name];
    this.save();
  }

  toAcpServers(): acp.McpServer[] {
    const out: acp.McpServer[] = [];
    for (const s of Object.values(this.servers)) {
      if (!s.enabled) continue;
      if (s.type === 'stdio' && s.command) {
        out.push({
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
        });
      } else if ((s.type === 'http' || s.type === 'sse') && s.url) {
        out.push({
          type: s.type,
          name: s.name,
          url: s.url,
          headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })),
        });
      }
    }
    return out;
  }

  private save(): void {
    const tmp = `${MCP_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.servers, null, 2), { mode: 0o600 });
    renameSync(tmp, MCP_FILE);
  }
}

const MASK = '••••';

function maskValues(values?: Record<string, string>): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ? MASK + v.slice(-4) : '']));
}

/** Valori dal form: quelli ancora mascherati (rimandati com'erano) tengono il valore salvato */
function unmaskValues(raw: unknown, prev?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    const value = String(v ?? '');
    out[key] = value.startsWith(MASK) && prev?.[key] !== undefined ? prev[key] : value;
  }
  return out;
}

export function registerMcp(app: Hono<any>, store: McpStore, plugins: Plugins): void {
  const state = () => ({
    builtin: [
      { name: 'agicloud', label: 'AgiCloud Capo (delega, stato_thread, leggi_thread, scrivi_thread)', enabled: true },
      { name: 'browser', label: 'Browser condiviso (Playwright MCP)', enabled: plugins.isEnabled('browser') },
      { name: 'verdict', label: 'Verdict (verdetto rapido)', enabled: plugins.isEnabled('verdict') },
      { name: 'video', label: 'Video Editor (MoviePy / FFmpeg)', enabled: plugins.isEnabled('video') },
      ...plugins.mcpInfo(),
    ],
    custom: store.listCustom(),
  });

  app.get('/api/mcp', (c) => c.json(state()));

  app.post('/api/mcp', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    store.upsert(body);
    return c.json(state());
  });

  app.post('/api/mcp/:name/enabled', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    store.setEnabled(c.req.param('name'), body.enabled === true);
    return c.json(state());
  });

  app.delete('/api/mcp/:name', (c) => {
    store.remove(c.req.param('name'));
    return c.json(state());
  });
}
