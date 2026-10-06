// Una sessione con un agente ACP: avvia il processo, apre la sessione,
// e per ogni prompt restituisce un flusso di eventi AG-UI.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { AgentSpec } from './agents.js';
import { AcpToAgui, custom } from './translate.js';
import { AsyncQueue } from './queue.js';

export interface PermissionRequest {
  requestId: string;
  toolCall: acp.ToolCallUpdate;
  options: acp.PermissionOption[];
}

export interface AgentSessionOptions {
  /** Cartella di lavoro dell'agente (assoluta) */
  cwd: string;
  /** Id della conversazione lato UI; se manca se ne crea uno */
  threadId?: string;
  env?: NodeJS.ProcessEnv;
  /** Metodo di login ACP da usare prima di aprire la sessione (es. "oauth-personal") */
  authMethod?: string;
}

/** L'agente vuole un login: la UI deve far scegliere uno di questi metodi */
export class AuthRequiredError extends Error {
  constructor(
    readonly agentLabel: string,
    readonly authMethods: acp.AuthMethod[],
    detail: string,
  ) {
    super(`${agentLabel}: login richiesto (${detail}). Metodi: ${authMethods.map((m) => m.id).join(', ') || 'nessuno'}`);
  }
}

const STDERR_TAIL = 4000;

export class AgentSession {
  readonly threadId: string;
  private proc: ChildProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private session: acp.ActiveSession | null = null;
  private stderrTail = '';
  private running = false;
  /** Coda degli eventi del run in corso: i permessi arrivano fuori dal ciclo degli update */
  private runQueue: AsyncQueue<BaseEvent> | null = null;
  private readonly pendingPermissions = new Map<string, (res: acp.RequestPermissionResponse) => void>();

  constructor(
    readonly agent: AgentSpec,
    private readonly opts: AgentSessionOptions,
  ) {
    this.threadId = opts.threadId ?? randomUUID();
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  async start(): Promise<acp.InitializeResponse> {
    const proc = spawn(this.agent.command, this.agent.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL);
    });
    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (err) => reject(new Error(`${this.agent.label}: avvio fallito (${err.message})`)));
      proc.once('exit', (code, signal) =>
        reject(new Error(`${this.agent.label}: processo terminato (code=${code}, signal=${signal})\n${this.stderrTail}`)),
      );
    });
    exited.catch(() => {}); // osservata solo nelle race qui sotto

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = acp
      .client({ name: 'agicloud' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .connect(stream);

    const ctx = this.conn.agent;
    const init = await Promise.race([
      ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // Niente fs/terminal lato client: l'agente lavora direttamente nella sua cartella
        clientCapabilities: {},
        clientInfo: { name: 'agicloud', version: '0.0.1' },
      }),
      exited,
    ]);
    if (this.opts.authMethod) {
      await Promise.race([ctx.request(acp.methods.agent.authenticate, { methodId: this.opts.authMethod }), exited]);
    }
    try {
      this.session = await Promise.race([ctx.buildSession(this.opts.cwd).start(), exited]);
    } catch (err) {
      if (isAuthError(err)) {
        throw new AuthRequiredError(this.agent.label, init.authMethods ?? [], errorMessage(err, ''));
      }
      throw err;
    }
    return init;
  }

  /** Esegue un turno e restituisce gli eventi AG-UI man mano che arrivano */
  async *run(prompt: string, runId: string = randomUUID()): AsyncGenerator<BaseEvent> {
    if (!this.session) throw new Error('Sessione non avviata: chiamare start()');
    if (this.running) throw new Error('Un turno e\' gia\' in corso su questa sessione');
    this.running = true;
    const queue = new AsyncQueue<BaseEvent>();
    this.runQueue = queue;
    const translator = new AcpToAgui();
    const session = this.session;

    queue.push(ev(EventType.RUN_STARTED, { threadId: this.threadId, runId }));
    const pump = (async () => {
      try {
        session.prompt(prompt).catch(() => {}); // l'esito arriva come messaggio "stop"
        for (;;) {
          const msg = await session.nextUpdate();
          if (msg.kind === 'stop') {
            for (const e of translator.finish()) queue.push(e);
            queue.push(
              ev(EventType.RUN_FINISHED, {
                threadId: this.threadId,
                runId,
                result: { stopReason: msg.stopReason },
              }),
            );
            break;
          }
          for (const e of translator.translate(msg.update)) queue.push(e);
        }
      } catch (err) {
        for (const e of translator.finish()) queue.push(e);
        queue.push(ev(EventType.RUN_ERROR, { message: errorMessage(err, this.stderrTail) }));
      } finally {
        this.cancelPendingPermissions();
        this.runQueue = null;
        this.running = false;
        queue.close();
      }
    })();

    try {
      yield* queue;
    } finally {
      await pump;
    }
  }

  /** Risposta della UI a una richiesta di permesso (optionId = una delle options ricevute) */
  respondPermission(requestId: string, optionId: string | null): boolean {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    return true;
  }

  /** Interrompe il turno in corso (l'agente chiude con stopReason "cancelled") */
  async cancel(): Promise<void> {
    if (!this.session || !this.conn) return;
    this.cancelPendingPermissions();
    await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId });
  }

  async close(): Promise<void> {
    this.cancelPendingPermissions();
    this.session?.dispose();
    this.conn?.close();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      const proc = this.proc;
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref();
    }
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const queue = this.runQueue;
    // Permesso chiesto fuori da un turno: nessuno puo' rispondere, si rifiuta
    if (!queue) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const requestId = randomUUID();
    const request: PermissionRequest = { requestId, toolCall: params.toolCall, options: params.options };
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      queue.push(custom('permission_request', request));
    });
  }

  private cancelPendingPermissions(): void {
    for (const resolve of this.pendingPermissions.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermissions.clear();
  }
}

function ev(type: EventType, fields: Record<string, unknown>): BaseEvent {
  return { type, timestamp: Date.now(), ...fields } as BaseEvent;
}

// ACP: "auth_required" = -32000; alcuni agenti lo usano anche per credenziali mancanti
function isAuthError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === -32000;
}

function errorMessage(err: unknown, stderrTail: string): string {
  const base = err instanceof Error ? err.message : JSON.stringify(err);
  return stderrTail && !base.includes(stderrTail) ? `${base}\n--- stderr ---\n${stderrTail.slice(-1000)}` : base;
}
