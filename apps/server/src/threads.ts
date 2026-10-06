// Conversazioni: ognuna e' un agente ACP vivo + il registro dei suoi eventi AG-UI.
// Il registro permette di ricollegarsi (refresh, telefono che va in standby) senza perdere nulla.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { AgentSession, AuthRequiredError, custom, ev, getAgent } from '@agicloud/bridge';
import { config } from './config.js';

export type ThreadStatus = 'starting' | 'ready' | 'running' | 'auth_required' | 'error' | 'closed';

type Listener = (event: BaseEvent, index: number) => void;

const MAX_EVENTS = 20_000;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export class Thread {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  title = 'Nuova conversazione';
  status: ThreadStatus = 'starting';
  readonly events: BaseEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly session: AgentSession;
  private readonly ready: Promise<void>;

  constructor(
    readonly agentId: string,
    readonly workspace: string,
    authMethod?: string,
  ) {
    const cwd = workspacePath(workspace);
    mkdirSync(cwd, { recursive: true });
    this.session = new AgentSession(getAgent(agentId), { cwd, threadId: this.id, authMethod });
    this.ready = this.boot();
  }

  summary() {
    return {
      id: this.id,
      agentId: this.agentId,
      workspace: this.workspace,
      title: this.title,
      status: this.status,
      createdAt: this.createdAt,
      eventCount: this.events.length,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(prompt: string): Promise<string> {
    await this.ready;
    if (this.status !== 'ready') throw new HttpError(409, statusMessage(this.status));
    if (this.events.every((e) => e.type !== EventType.RUN_STARTED)) this.title = prompt.slice(0, 80);

    const runId = randomUUID();
    this.setStatus('running');
    // Il messaggio dell'utente entra nel registro come qualsiasi altro: lo storico e' completo
    const messageId = randomUUID();
    this.emit(ev(EventType.TEXT_MESSAGE_START, { messageId, role: 'user' }));
    this.emit(ev(EventType.TEXT_MESSAGE_CONTENT, { messageId, delta: prompt }));
    this.emit(ev(EventType.TEXT_MESSAGE_END, { messageId }));

    void (async () => {
      try {
        for await (const e of this.session.run(prompt, runId)) this.emit(e);
      } catch (err) {
        this.emit(ev(EventType.RUN_ERROR, { message: err instanceof Error ? err.message : String(err) }));
      } finally {
        if (this.status === 'running') this.setStatus('ready');
      }
    })();
    return runId;
  }

  respondPermission(requestId: string, optionId: string | null): void {
    if (!this.session.respondPermission(requestId, optionId)) {
      throw new HttpError(404, 'Richiesta di permesso non trovata o gia\' risolta');
    }
    this.emit(custom('permission_resolved', { requestId, optionId }));
  }

  async cancel(): Promise<void> {
    if (this.status === 'running') await this.session.cancel();
  }

  async close(): Promise<void> {
    this.setStatus('closed');
    await this.session.close();
    this.listeners.clear();
  }

  private async boot(): Promise<void> {
    this.emit(custom('thread_status', { status: 'starting' }));
    try {
      const init = await this.session.start();
      this.emit(custom('agent_info', { agentInfo: init.agentInfo ?? null }));
      this.setStatus('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        this.setStatus('auth_required', { message: err.message, authMethods: err.authMethods });
      } else {
        this.setStatus('error', { message: err instanceof Error ? err.message : String(err) });
      }
      await this.session.close();
    }
  }

  private setStatus(status: ThreadStatus, extra: Record<string, unknown> = {}): void {
    this.status = status;
    if (status !== 'starting') this.emit(custom('thread_status', { status, ...extra }));
  }

  private emit(event: BaseEvent): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push(event);
    const index = this.events.length - 1;
    for (const l of this.listeners) l(event, index);
  }
}

export class ThreadStore {
  private readonly threads = new Map<string, Thread>();

  list() {
    return [...this.threads.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => t.summary());
  }

  get(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new HttpError(404, 'Conversazione non trovata');
    return t;
  }

  create(agentId: string, workspace: string, authMethod?: string): Thread {
    try {
      getAgent(agentId);
    } catch {
      throw new HttpError(400, `Agente sconosciuto: ${agentId}`);
    }
    if (!WORKSPACE_NAME.test(workspace)) {
      throw new HttpError(400, 'Nome workspace non valido (lettere, numeri, . _ -; max 64)');
    }
    const alive = [...this.threads.values()].filter((t) => t.status !== 'closed' && t.status !== 'error').length;
    if (alive >= config.maxSessions) {
      throw new HttpError(429, `Troppe conversazioni attive (max ${config.maxSessions}): chiudine una`);
    }
    const thread = new Thread(agentId, workspace, authMethod);
    this.threads.set(thread.id, thread);
    return thread;
  }

  async remove(id: string): Promise<void> {
    const t = this.get(id);
    this.threads.delete(id);
    await t.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.threads.values()].map((t) => t.close()));
  }
}

export function listWorkspaces(): string[] {
  return readdirSync(config.workspacesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && WORKSPACE_NAME.test(d.name))
    .map((d) => d.name)
    .sort();
}

function workspacePath(name: string): string {
  const p = resolve(join(config.workspacesRoot, name));
  if (!p.startsWith(config.workspacesRoot + sep)) throw new HttpError(400, 'Workspace non valido');
  return p;
}

function statusMessage(status: ThreadStatus): string {
  switch (status) {
    case 'running':
      return 'L\'agente sta gia\' lavorando: attendi o interrompi';
    case 'auth_required':
      return 'L\'agente richiede il login';
    case 'closed':
      return 'Conversazione chiusa';
    default:
      return 'L\'agente non e\' disponibile';
  }
}
