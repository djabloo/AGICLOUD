// Una sessione con un agente ACP: avvia il processo, apre (o riprende) la sessione,
// e per ogni prompt restituisce un flusso di eventi AG-UI.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { AgentSpec } from './agents.js';
import { AcpToAgui, custom, ev } from './translate.js';
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
  /** Sessione ACP da riprendere (es. dopo un riavvio del server) */
  resumeSessionId?: string;
  /** Server MCP da dare all'agente (es. gli strumenti del "capo" per delegare) */
  mcpServers?: acp.McpServer[];
  /** _meta della sessione, specifico dell'agente (es. per Claude: strumenti gia' autorizzati) */
  sessionMeta?: Record<string, unknown>;
  /** Opzioni (modalita', modello...) cambiate, anche fuori da un turno */
  onConfigOptions?: (options: acp.SessionConfigOption[]) => void;
  /** Comandi slash offerti dall'agente (arrivano anche fuori da un turno) */
  onCommands?: (commands: acp.AvailableCommand[]) => void;
  /** Il processo dell'agente e' terminato da solo */
  onExit?: (message: string) => void;
}

/** Come e' stata aperta la sessione: nuova, ripresa senza storico, ricaricata con storico */
export type SessionOrigin = 'new' | 'resume' | 'load';

export interface StartResult {
  init: acp.InitializeResponse;
  sessionId: string;
  origin: SessionOrigin;
  /** Errore della ripresa, se si e' dovuto ripartire da una sessione nuova */
  resumeError?: string;
  configOptions: acp.SessionConfigOption[];
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
const AUTH_TIMEOUT_MS = 30_000;

interface ActiveRun {
  queue: AsyncQueue<BaseEvent>;
  translator: AcpToAgui;
}

export class AgentSession {
  readonly threadId: string;
  private proc: ChildProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private _sessionId: string | null = null;
  private _configOptions: acp.SessionConfigOption[] = [];
  private stderrTail = '';
  private closing = false;
  /** true mentre session/load rimanda lo storico: quegli update non vanno nel registro */
  private replaying = false;
  private current: ActiveRun | null = null;
  private readonly pendingPermissions = new Map<string, (res: acp.RequestPermissionResponse) => void>();

  constructor(
    readonly agent: AgentSpec,
    private readonly opts: AgentSessionOptions,
  ) {
    this.threadId = opts.threadId ?? randomUUID();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get configOptions(): acp.SessionConfigOption[] {
    return this._configOptions;
  }

  private _promptCaps: acp.PromptCapabilities | undefined;

  /** L'agente accetta immagini nel messaggio? */
  get acceptsImages(): boolean {
    return this._promptCaps?.image === true;
  }

  get running(): boolean {
    return this.current !== null;
  }

  async start(): Promise<StartResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env };
    for (const name of this.agent.envBlock ?? []) delete env[name];
    const proc = spawn(this.agent.command, this.agent.args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL);
    });
    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (err) => reject(new Error(`${this.agent.label}: avvio fallito (${err.message})`)));
      proc.once('exit', (code, signal) => {
        const message = `${this.agent.label}: processo terminato (code=${code}, signal=${signal})`;
        if (!this.closing) this.opts.onExit?.(`${message}\n${this.stderrTail.slice(-1000)}`);
        this.failRun(message);
        reject(new Error(`${message}\n${this.stderrTail}`));
      });
    });
    exited.catch(() => {}); // osservata solo nelle race qui sotto
    const race = <T>(p: Promise<T>) => Promise.race([p, exited]);

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = acp
      .client({ name: 'agicloud' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => this.onUpdate(ctx.params))
      .connect(stream);
    const ctx = this.conn.agent;

    const init = await race(
      ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // Niente fs/terminal lato client: l'agente lavora direttamente nella sua cartella
        clientCapabilities: {},
        clientInfo: { name: 'agicloud', version: '0.0.1' },
      }),
    );
    const authMethod = this.opts.authMethod ?? this.agent.authMethod;
    if (authMethod) {
      try {
        // Con credenziali scadute alcuni agenti (Cursor) restano appesi: meglio un errore chiaro
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('login scaduto o non valido: rifai il login dalle Impostazioni')), AUTH_TIMEOUT_MS).unref(),
        );
        await race(Promise.race([ctx.request(acp.methods.agent.authenticate, { methodId: authMethod }), timeout]));
      } catch (err) {
        throw new AuthRequiredError(this.agent.label, init.authMethods ?? [], errorMessage(err, ''));
      }
    }

    const caps = init.agentCapabilities;
    this._promptCaps = caps?.promptCapabilities;
    const base: acp.NewSessionRequest = {
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers ?? [],
      ...(this.opts.sessionMeta ? { _meta: this.opts.sessionMeta } : {}),
    };
    let origin: SessionOrigin = 'new';
    let resumeError: string | undefined;
    let opened: { configOptions?: acp.SessionConfigOption[] | null } | null = null;
    const resumeId = this.opts.resumeSessionId;

    try {
      if (resumeId && caps?.sessionCapabilities?.resume) {
        opened = await race(ctx.request(acp.methods.agent.session.resume, { ...base, sessionId: resumeId }));
        origin = 'resume';
      } else if (resumeId && caps?.loadSession) {
        this.replaying = true;
        opened = await race(ctx.request(acp.methods.agent.session.load, { ...base, sessionId: resumeId }));
        origin = 'load';
      }
    } catch (err) {
      if (isAuthError(err)) throw new AuthRequiredError(this.agent.label, init.authMethods ?? [], errorMessage(err, ''));
      resumeError = errorMessage(err, '');
    } finally {
      this.replaying = false;
    }

    if (origin === 'new') {
      try {
        const created = await race(ctx.request(acp.methods.agent.session.new, base));
        this._sessionId = created.sessionId;
        opened = created;
      } catch (err) {
        if (isAuthError(err)) throw new AuthRequiredError(this.agent.label, init.authMethods ?? [], errorMessage(err, ''));
        throw err;
      }
    } else {
      this._sessionId = resumeId!;
    }
    this._configOptions = opened?.configOptions ?? [];
    return { init, sessionId: this._sessionId!, origin, resumeError, configOptions: this._configOptions };
  }

  /** Esegue un turno e restituisce gli eventi AG-UI man mano che arrivano */
  /** prompt: testo semplice o blocchi ACP (testo + immagini) */
  async *run(prompt: string | acp.ContentBlock[], runId: string = randomUUID()): AsyncGenerator<BaseEvent> {
    if (!this.conn || !this._sessionId) throw new Error('Sessione non avviata: chiamare start()');
    if (this.current) throw new Error('Un turno e\' gia\' in corso su questa sessione');
    const run: ActiveRun = { queue: new AsyncQueue<BaseEvent>(), translator: new AcpToAgui() };
    this.current = run;

    run.queue.push(ev(EventType.RUN_STARTED, { threadId: this.threadId, runId }));
    const request = this.conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this._sessionId,
      prompt: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt,
    });
    request.then(
      (res) => this.endRun(run, ev(EventType.RUN_FINISHED, { threadId: this.threadId, runId, result: { stopReason: res.stopReason } })),
      (err) => this.endRun(run, ev(EventType.RUN_ERROR, { message: errorMessage(err, this.stderrTail) })),
    );
    yield* run.queue;
  }

  /** Cambia un'opzione della sessione (modalita', modello, effort...) */
  async setConfigOption(configId: string, value: string | boolean): Promise<acp.SessionConfigOption[]> {
    if (!this.conn || !this._sessionId) throw new Error('Sessione non avviata');
    const params =
      typeof value === 'boolean'
        ? { sessionId: this._sessionId, configId, type: 'boolean' as const, value }
        : { sessionId: this._sessionId, configId, value };
    const res = await this.conn.agent.request(
      acp.methods.agent.session.setConfigOption,
      params as acp.SetSessionConfigOptionRequest,
    );
    this.setConfig(res.configOptions);
    return this._configOptions;
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
    if (!this._sessionId || !this.conn) return;
    this.cancelPendingPermissions();
    await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this._sessionId });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.cancelPendingPermissions();
    this.failRun('Sessione chiusa');
    this.conn?.close();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      const proc = this.proc;
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref();
    }
  }

  private onUpdate(params: acp.SessionNotification): void {
    if (this.replaying || params.sessionId !== this._sessionId) return;
    const update = params.update;
    if (update.sessionUpdate === 'config_option_update') {
      this.setConfig(update.configOptions);
      return;
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this.opts.onCommands?.(update.availableCommands);
      return;
    }
    const run = this.current;
    if (run) for (const e of run.translator.translate(update)) run.queue.push(e);
  }

  private setConfig(options: acp.SessionConfigOption[]): void {
    this._configOptions = options;
    this.opts.onConfigOptions?.(options);
  }

  private endRun(run: ActiveRun, final: BaseEvent): void {
    if (this.current !== run) return;
    for (const e of run.translator.finish()) run.queue.push(e);
    run.queue.push(final);
    this.cancelPendingPermissions();
    this.current = null;
    run.queue.close();
  }

  private failRun(message: string): void {
    if (this.current) this.endRun(this.current, ev(EventType.RUN_ERROR, { message }));
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const run = this.current;
    // Permesso chiesto fuori da un turno: nessuno puo' rispondere, si rifiuta
    if (!run) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const requestId = randomUUID();
    const request: PermissionRequest = { requestId, toolCall: params.toolCall, options: params.options };
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      run.queue.push(custom('permission_request', request));
    });
  }

  private cancelPendingPermissions(): void {
    for (const resolve of this.pendingPermissions.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermissions.clear();
  }
}

// ACP: "auth_required" = -32000; alcuni agenti lo usano anche per credenziali mancanti
function isAuthError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === -32000;
}

function errorMessage(err: unknown, stderrTail: string): string {
  const base = err instanceof Error ? err.message : JSON.stringify(err);
  return stderrTail && !base.includes(stderrTail) ? `${base}\n--- stderr ---\n${stderrTail.slice(-1000)}` : base;
}
