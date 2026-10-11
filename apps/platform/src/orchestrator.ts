// Client dell'orchestratore (servizio che parla con Docker). La piattaforma non tocca mai Docker direttamente.

export interface RunnerInfo {
  id: string;
  status: string;
  port: number | null;
}

export interface Orchestrator {
  start(id: string, env: Record<string, string>): Promise<RunnerInfo>;
  info(id: string): Promise<RunnerInfo | null>;
  stop(id: string): Promise<void>;
  remove(id: string, purge: boolean): Promise<void>;
}

export function httpOrchestrator(baseUrl: string, secret: string): Orchestrator {
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Orchestratore: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
    return res;
  };
  return {
    start: async (id, env) => (await (await call('POST', '/v1/runners', { id, env })).json()) as RunnerInfo,
    info: async (id) => {
      const res = await call('GET', `/v1/runners/${id}`);
      return res.status === 404 ? null : ((await res.json()) as RunnerInfo);
    },
    stop: async (id) => void (await call('POST', `/v1/runners/${id}/stop`)),
    remove: async (id, purge) => void (await call('DELETE', `/v1/runners/${id}${purge ? '?purge=1' : ''}`)),
  };
}
