// Client HTTP del server AgiCloud: REST per i comandi, SSE (via fetch) per gli eventi AG-UI.

import type { BaseEvent } from '@ag-ui/core';

export interface AgentInfo {
  id: string;
  label: string;
  native: boolean;
  note?: string;
}

export type ThreadStatus = 'idle' | 'starting' | 'ready' | 'running' | 'auth_required' | 'error';

export interface ThreadSummary {
  id: string;
  agentId: string;
  cwd: string;
  project: string;
  title: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalSummary {
  id: string;
  cwd: string;
  project: string;
  title: string;
  createdAt: number;
  exited: boolean;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string; git: boolean }[];
}

const TOKEN_KEY = 'agicloud_token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage non disponibile: il token vale solo per questa pagina */
  }
  memoryToken = token;
}

let memoryToken = getToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(memoryToken ? { authorization: `Bearer ${memoryToken}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `Errore ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  session: () => request<{ ok: boolean }>('GET', '/session'),
  agents: () => request<AgentInfo[]>('GET', '/agents'),
  projects: () => request<{ roots: string[]; recent: string[] }>('GET', '/projects'),
  dirs: (path?: string) => request<DirListing>('GET', `/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  threads: () => request<ThreadSummary[]>('GET', '/threads'),
  createThread: (agentId: string, cwd: string) => request<ThreadSummary>('POST', '/threads', { agentId, cwd }),
  terminals: () => request<TerminalSummary[]>('GET', '/terminals'),
  createTerminal: (cwd: string, command?: 'claude') => request<TerminalSummary>('POST', '/terminals', { cwd, command }),
  deleteTerminal: (id: string) => request<void>('DELETE', `/terminals/${id}`),
  setConfig: (id: string, configId: string, value: string | boolean) =>
    request<void>('POST', `/threads/${id}/config`, { configId, value }),
  deleteThread: (id: string) => request<void>('DELETE', `/threads/${id}`),
  run: (id: string, prompt: string) => request<{ runId: string }>('POST', `/threads/${id}/runs`, { prompt }),
  cancel: (id: string) => request<void>('POST', `/threads/${id}/cancel`),
  respondPermission: (id: string, requestId: string, optionId: string | null) =>
    request<void>('POST', `/threads/${id}/permissions/${requestId}`, { optionId }),
};

/**
 * Segue gli eventi di una conversazione. Si ricollega da solo (rete che cade,
 * telefono in standby) ripartendo dall'ultimo evento ricevuto.
 */
export function followEvents(
  threadId: string,
  onEvent: (event: BaseEvent) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const abort = new AbortController();
  let lastId = -1;
  let delay = 1000;

  (async () => {
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`/api/threads/${threadId}/events?after=${lastId}`, {
          headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {},
          signal: abort.signal,
        });
        if (res.status === 404 || res.status === 401) return;
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        onConnection(true);
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let data = '';
            let id: number | null = null;
            let event = 'message';
            for (const line of block.split('\n')) {
              if (line.startsWith('data:')) data += line.slice(5).trimStart();
              else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
              else if (line.startsWith('event:')) event = line.slice(6).trim();
            }
            if (event !== 'message' || !data) continue;
            if (id !== null) lastId = id;
            onEvent(JSON.parse(data));
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      onConnection(false);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  })();

  return () => abort.abort();
}

/** Token in uso (anche se il browser non permette di salvarlo) */
export function currentToken(): string {
  return memoryToken;
}
