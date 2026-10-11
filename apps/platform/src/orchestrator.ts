// Client dell'orchestratore (servizio che parla con Docker). La piattaforma non tocca mai Docker direttamente.

import { request } from 'node:http';

export interface RunnerInfo {
  id: string;
  status: string;
  port: number | null;
}

export interface Orchestrator {
  start(id: string, subdomain: string, env: Record<string, string>): Promise<RunnerInfo>;
  info(id: string): Promise<RunnerInfo | null>;
  stop(id: string): Promise<void>;
  remove(id: string, purge: boolean): Promise<void>;
}

interface Reply {
  status: number;
  json(): Promise<any>;
}

/** Indirizzo "unix:/percorso/socket" (consigliato: nessuna rete) oppure "http://host:porta" */
export function httpOrchestrator(address: string, secret: string): Orchestrator {
  const call = (method: string, path: string, body?: unknown): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const target = address.startsWith('unix:') ? { socketPath: address.slice(5), path } : { ...(() => { const u = new URL(address); return { host: u.hostname, port: u.port }; })(), path };
      const req = request({ ...target, method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, timeout: 60_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          const status = res.statusCode ?? 500;
          const parse = async () => JSON.parse(text || '{}');
          if (status >= 400 && status !== 404) parse().then((j) => reject(new Error(`Orchestratore: ${j.error ?? status}`)), () => reject(new Error(`Orchestratore: ${status}`)));
          else resolve({ status, json: parse });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Orchestratore: nessuna risposta')));
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  return {
    start: async (id, subdomain, env) => (await (await call('POST', '/v1/runners', { id, subdomain, env })).json()) as RunnerInfo,
    info: async (id) => {
      const res = await call('GET', `/v1/runners/${id}`);
      return res.status === 404 ? null : ((await res.json()) as RunnerInfo);
    },
    stop: async (id) => void (await call('POST', `/v1/runners/${id}/stop`)),
    remove: async (id, purge) => void (await call('DELETE', `/v1/runners/${id}${purge ? '?purge=1' : ''}`)),
  };
}
