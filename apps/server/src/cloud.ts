// Plugin Cloud: i server Hetzner dentro AgiCloud (stato, costi, accensione, backup, snapshot,
// nuove VPS da un'immagine). Token HETZNER_API_TOKEN dal portachiavi, mai al browser.
//
// Regole di sicurezza (come in AgyCloud):
// - eliminare, reinstallare da un'immagine: SOLO server creati da AgiCloud (etichetta agicloud=worker)
//   e mai con la protezione di Hetzner attiva; il server di produzione non si tocca;
// - eliminare uno snapshot: mai quello indicato come immagine dei nodi;
// - creare una VPS costa: la UI mostra il prezzo e chiede conferma.

import type { Hono } from 'hono';
import { HttpError } from './errors.js';
import type { PluginSpec } from './plugins.js';
import type { Settings } from './settings.js';

const API = 'https://api.hetzner.cloud/v1';
const KEY_NAME = 'HETZNER_API_TOKEN';
const WORKER_LABEL = 'agicloud';
/** Snapshot base dei nodi (oggi quello di AgyCloud v3): protetto dall'eliminazione */
const NODE_IMAGE = process.env.CLOUD_NODE_IMAGE || '438404993';

type Json = Record<string, any>;

async function hz(token: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 409, `Hetzner: ${data.error?.message ?? `HTTP ${res.status}`}`);
  return data;
}

async function list(token: string, path: string, key: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page < 20; page++) {
    const d = await hz(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=50`);
    out.push(...(d[key] ?? []));
    if (!d.meta?.pagination?.next_page) break;
  }
  return out;
}

const gross = (p: Json | undefined, k = 'price_monthly') => Number(p?.[k]?.gross ?? 0);

/** Stato completo per la sezione Cloud, con i costi mensili stimati (IVA inclusa) */
async function overview(token: string) {
  const [servers, snapshots, backups, volumes, pricing, types, locations] = await Promise.all([
    list(token, '/servers', 'servers'),
    list(token, '/images?type=snapshot', 'images'),
    list(token, '/images?type=backup', 'images'),
    list(token, '/volumes', 'volumes'),
    hz(token, 'GET', '/pricing').then((d) => d.pricing),
    list(token, '/server_types', 'server_types'),
    list(token, '/locations', 'locations'),
  ]);
  const imgGb = Number(pricing.image?.price_per_gb_month?.gross ?? 0);
  const volGb = Number(pricing.volume?.price_per_gb_month?.gross ?? 0);
  const ipv4 = gross(pricing.primary_ips?.find((p: Json) => p.type === 'ipv4')?.prices?.[0]);
  const locOf = (s: Json) => (s.location ?? s.datacenter?.location)?.name as string;
  const priceOf = (type: string, loc: string) =>
    gross(pricing.server_types.find((t: Json) => t.name === type)?.prices.find((p: Json) => p.location === loc));

  const srv = servers.map((s) => {
    const loc = locOf(s);
    const price = priceOf(s.server_type.name, loc);
    const worker = s.labels?.[WORKER_LABEL] === 'worker';
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      type: s.server_type.name,
      cores: s.server_type.cores,
      memory: s.server_type.memory,
      disk: s.server_type.disk,
      arch: s.server_type.architecture,
      location: loc,
      ipv4: s.public_net?.ipv4?.ip ?? null,
      created: s.created,
      backups: Boolean(s.backup_window),
      protected: Boolean(s.protection?.delete || s.protection?.rebuild),
      /** Creato da AgiCloud: si puo' eliminare o reinstallare */
      worker,
      monthly: price + (s.backup_window ? price * 0.2 : 0) + (s.public_net?.ipv4 ? ipv4 : 0),
      image: s.image?.description ?? s.image?.name ?? null,
    };
  });
  const img = (i: Json) => ({
    id: i.id,
    type: i.type,
    description: i.description,
    sizeGb: Number(i.image_size ?? 0),
    created: i.created,
    from: i.created_from?.name ?? null,
    nodeImage: String(i.id) === NODE_IMAGE,
    // I backup sono compresi nel 20% del server; gli snapshot si pagano a GB
    monthly: i.type === 'snapshot' ? Number(i.image_size ?? 0) * imgGb : 0,
    arch: i.architecture,
  });
  const vols = volumes.map((v) => ({ id: v.id, name: v.name, sizeGb: v.size, server: v.server, monthly: v.size * volGb }));
  const total = srv.reduce((a, s) => a + s.monthly, 0) + snapshots.reduce((a, i) => a + Number(i.image_size ?? 0) * imgGb, 0) + vols.reduce((a, v) => a + v.monthly, 0);
  return {
    servers: srv,
    images: [...snapshots, ...backups].map(img).sort((a, b) => b.created.localeCompare(a.created)),
    volumes: vols,
    monthlyTotal: total,
    // Per il dialogo "Nuova VPS": tipi e posti disponibili, con il prezzo per posto
    serverTypes: types
      .filter((t) => !t.deprecation)
      .map((t) => ({
        name: t.name,
        cores: t.cores,
        memory: t.memory,
        disk: t.disk,
        arch: t.architecture,
        prices: Object.fromEntries(pricing.server_types.find((p: Json) => p.name === t.name)?.prices.map((p: Json) => [p.location, gross(p)]) ?? []),
      }))
      .sort((a, b) => a.cores - b.cores || a.memory - b.memory),
    locations: locations.map((l) => ({ name: l.name, city: l.city, country: l.country })),
    nodeImage: NODE_IMAGE,
  };
}

async function server(token: string, id: number): Promise<Json> {
  return (await hz(token, 'GET', `/servers/${id}`)).server;
}

/** Solo i server creati da AgiCloud, senza protezione: si possono eliminare o reinstallare */
async function requireWorker(token: string, id: number): Promise<Json> {
  const s = await server(token, id);
  if (s.labels?.[WORKER_LABEL] !== 'worker') throw new HttpError(409, `"${s.name}" non e' stato creato da AgiCloud: per sicurezza non si elimina ne' si reinstalla da qui`);
  if (s.protection?.delete || s.protection?.rebuild) throw new HttpError(409, `"${s.name}" ha la protezione di Hetzner attiva`);
  return s;
}

export function cloudPlugin(settings: Settings): PluginSpec {
  const health = async () => {
    const t = settings.vaultValue(KEY_NAME);
    if (!t) return { ok: false, detail: `manca ${KEY_NAME} nel portachiavi` };
    try {
      await hz(t, 'GET', '/locations?per_page=1');
      return { ok: true, detail: 'collegato a Hetzner Cloud' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    id: 'cloud',
    name: 'Cloud',
    version: '1.0.0',
    description:
      'I tuoi server Hetzner dentro AgiCloud: stato e costi, accensione, backup e snapshot, nuove VPS da un\'immagine. Eliminare o reinstallare si puo\' solo per le VPS create da AgiCloud: il server di produzione e\' protetto.',
    section: { id: 'cloud', label: 'Cloud' },
    requires: `un token Hetzner Cloud nel portachiavi (${KEY_NAME})`,
    routes: ['/api/cloud'],
    source: 'builtin',
    health,
    install: async () => {
      const h = await health();
      if (!h.ok) throw new Error(h.detail);
    },
  };
}

export function registerCloud(app: Hono<any>, settings: Settings): void {
  const token = () => {
    const t = settings.vaultValue(KEY_NAME);
    if (!t) throw new HttpError(409, `Manca ${KEY_NAME} nel portachiavi (Impostazioni → Chiavi)`);
    return t;
  };
  const num = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Id non valido');
    return n;
  };

  app.get('/api/cloud', async (c) => c.json(await overview(token())));

  // Accendi / spegni (ordinato) / riavvia: anche il server principale (Hetzner chiede comunque conferma a noi)
  app.post('/api/cloud/servers/:id/power', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Json;
    const action = ({ on: 'poweron', off: 'shutdown', reboot: 'reboot' } as Record<string, string>)[String(body.action)];
    if (!action) throw new HttpError(400, 'Azione: on, off o reboot');
    await hz(token(), 'POST', `/servers/${num(c.req.param('id'))}/actions/${action}`);
    return c.json({ ok: true });
  });

  app.post('/api/cloud/servers/:id/backups', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Json;
    await hz(token(), 'POST', `/servers/${num(c.req.param('id'))}/actions/${body.enabled ? 'enable_backup' : 'disable_backup'}`);
    return c.json({ ok: true });
  });

  app.post('/api/cloud/servers/:id/snapshot', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Json;
    const s = await server(token(), num(c.req.param('id')));
    const description = String(body.description ?? '').trim().slice(0, 120) || `${s.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    await hz(token(), 'POST', `/servers/${s.id}/actions/create_image`, { type: 'snapshot', description, labels: { [WORKER_LABEL]: 'snapshot' } });
    return c.json({ ok: true, description });
  });

  // Nuova VPS: etichetta agicloud=worker (cosi' si potra' eliminare da qui), backup su richiesta
  app.post('/api/cloud/servers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Json;
    const name = String(body.name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) throw new HttpError(400, 'Nome: lettere minuscole, numeri e trattini (es. vps-prova-1)');
    const t = token();
    const keys = (await list(t, '/ssh_keys', 'ssh_keys')).map((k) => k.name);
    const res = await hz(t, 'POST', '/servers', {
      name,
      server_type: String(body.type ?? ''),
      location: String(body.location ?? ''),
      image: String(body.image ?? 'ubuntu-24.04'),
      labels: { [WORKER_LABEL]: 'worker' },
      ssh_keys: keys,
      start_after_create: true,
    });
    if (body.backups === true) await hz(t, 'POST', `/servers/${res.server.id}/actions/enable_backup`).catch(() => {});
    return c.json({ id: res.server.id, ipv4: res.server.public_net?.ipv4?.ip ?? null, rootPassword: res.root_password ? 'inviata da Hetzner' : null });
  });

  // Reinstalla da un'immagine (ripristino): solo VPS di AgiCloud
  app.post('/api/cloud/servers/:id/rebuild', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Json;
    const s = await requireWorker(token(), num(c.req.param('id')));
    await hz(token(), 'POST', `/servers/${s.id}/actions/rebuild`, { image: String(body.image ?? '') });
    return c.json({ ok: true });
  });

  // Elimina: solo VPS di AgiCloud, e il nome va riscritto (come su Hetzner)
  app.delete('/api/cloud/servers/:id', async (c) => {
    const s = await requireWorker(token(), num(c.req.param('id')));
    if (c.req.query('confirm') !== s.name) throw new HttpError(400, `Per eliminare scrivi il nome del server: ${s.name}`);
    await hz(token(), 'DELETE', `/servers/${s.id}`);
    return c.json({ ok: true });
  });

  app.delete('/api/cloud/images/:id', async (c) => {
    const id = num(c.req.param('id'));
    if (String(id) === NODE_IMAGE) throw new HttpError(409, 'E\' l\'immagine dei nodi: non si elimina da qui');
    const img = (await hz(token(), 'GET', `/images/${id}`)).image;
    if (img.type !== 'snapshot') throw new HttpError(409, 'Si eliminano solo gli snapshot (i backup li gestisce Hetzner)');
    if (c.req.query('confirm') !== 'elimina') throw new HttpError(400, 'Conferma mancante');
    await hz(token(), 'DELETE', `/images/${id}`);
    return c.json({ ok: true });
  });
}
