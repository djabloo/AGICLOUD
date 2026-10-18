// Conversazioni: metadati + registro degli eventi AG-UI, salvati su disco.
// L'agente si accende quando serve e si spegne dopo un po' di inattivita';
// al messaggio successivo riprende la stessa sessione ACP (se l'agente lo supporta).

import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentSession, AuthRequiredError, custom, ev, getAgent } from '@agicloud/bridge';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';
import { excludeFromGit, readAttachment, resolveAttachment } from './uploads.js';
import { installKit, kitPrompt, type DesignChoice } from '@agicloud/design';
import { AGY_BIN, type Settings } from './settings.js';
import type { Notice } from './push.js';
import type { WorktreeInfo } from './worktrees.js';
import type { LeadManager } from './lead.js';
import type { Limits } from './handover.js';

export { HttpError } from './errors.js';

/** idle = agente spento, si riaccende al prossimo messaggio */
export type ThreadStatus = 'idle' | 'starting' | 'ready' | 'running' | 'auth_required' | 'error';

type ConfigValue = string | boolean;

interface ThreadMeta {
  id: string;
  agentId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Sessione ACP da riprendere */
  acpSessionId?: string;
  /** Scelte dell'utente (modalita', modello...), riapplicate quando l'agente riparte */
  config: Record<string, ConfigValue>;
  /** Ultime opzioni note, per mostrarle anche ad agente spento */
  configOptions?: acp.SessionConfigOption[];
  /** Titolo scelto dall'utente: non viene piu' sostituito dal primo messaggio */
  customTitle?: boolean;
  /** Fissata in cima alla lista */
  pinned?: boolean;
  /** Nascosta dalla lista principale (non cancellata) */
  archived?: boolean;
  /** Conversazione "capo": puo' affidare compiti ad altri agenti (strumenti MCP di AgiCloud) */
  lead?: boolean;
  /** Thread affidato da un capo: id della conversazione capo */
  parentId?: string;
  /** Compito ricevuto dal capo */
  task?: string;
  /** Copia separata del progetto in cui lavora il thread affidato */
  worktree?: WorktreeInfo;
  /** Esito dell'ultimo turno: per lo stato dei thread affidati */
  lastOutcome?: 'done' | 'error' | 'cancelled';
  /** Plugin Design: skill e design system scelti; il kit va nel progetto alla prima richiesta */
  design?: DesignChoice;
  /** Plugin Browser: conversazione accanto al browser condiviso (l'agente lo usa con Playwright) */
  browser?: boolean;
  /** Passaggio di consegne: conversazione da cui arriva il lavoro */
  handoverFrom?: string;
  /** Punto del registro in cui e' iniziato il lavoro ricevuto (per riassumerlo al ritorno) */
  handoverStart?: number;
  /** Passaggio di consegne: conversazione che ha preso il lavoro */
  handedOverTo?: string;
}

export type RunOutcome = { stop?: string; error?: string };

/** Stato "vivo" mandato alla UI fuori dal registro (non salvato, cambia spesso) */
export interface ThreadState {
  status: ThreadStatus;
  configOptions: acp.SessionConfigOption[];
  commands: { name: string; description: string; hint?: string }[];
}

type Listener = (event: BaseEvent, index: number | null) => void;

const MAX_EVENTS = 200_000;

export class Thread {
  status: ThreadStatus = 'idle';
  readonly events: BaseEvent[] = [];
  lastUsed = 0;
  private commands: ThreadState['commands'] = [];
  private session: AgentSession | null = null;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private log: WriteStream | null = null;
  private readonly listeners = new Set<Listener>();
  /** Messaggi in attesa che l'agente finisca il turno (es. avvisi di AgiCloud al capo) */
  private readonly queue: { prompt: string; auto: boolean }[] = [];
  /** Richieste di permesso non ancora risolte */
  /** Richieste di permesso non ancora risolte (titolo e scelte: il capo le mostra anche nella sua chat) */
  private readonly openPermissions = new Map<string, { title: string; options: { optionId: string; name: string; kind: string }[] }>();
  /** Un turno e' in preparazione o in corso */
  private busy = false;

  constructor(
    readonly meta: ThreadMeta,
    private readonly store: ThreadStore,
  ) {}

  get id() {
    return this.meta.id;
  }

  summary() {
    const { id, agentId, cwd, title, createdAt, updatedAt } = this.meta;
    return {
      id,
      agentId,
      cwd,
      project: basename(cwd),
      title,
      status: this.status,
      createdAt,
      updatedAt,
      pinned: this.meta.pinned === true,
      archived: this.meta.archived === true,
      lead: this.meta.lead === true,
      parentId: this.meta.parentId ?? null,
      /** Thread affidato: in corso, aspetta te, finito, errore */
      childState: this.meta.parentId ? this.childState() : null,
      /** Thread affidato in attesa di un tuo permesso: si puo' rispondere anche dalla chat del capo */
      pendingPermission: this.meta.parentId ? this.pendingPermission() : null,
      worktree: this.meta.worktree ? { branch: this.meta.worktree.branch, state: this.meta.worktree.state } : null,
      design: this.meta.design ?? null,
      browser: this.meta.browser === true,
      handoverFrom: this.meta.handoverFrom ?? null,
      handedOverTo: this.meta.handedOverTo ?? null,
    };
  }

  pendingPermission() {
    const first = this.openPermissions.entries().next();
    return first.done ? null : { requestId: first.value[0], ...first.value[1] };
  }

  /** Thread affidato le cui modifiche sono gia' state unite o scartate: e' concluso */
  get closed(): boolean {
    return Boolean(this.meta.worktree && this.meta.worktree.state !== 'open');
  }

  childState(): 'running' | 'waiting' | 'done' | 'error' | 'idle' {
    if (this.closed) return 'done';
    if (this.openPermissions.size > 0) return 'waiting';
    if (this.busy || this.queue.length) return 'running';
    if (this.status === 'error' || this.status === 'auth_required' || this.meta.lastOutcome === 'error') return 'error';
    if (this.meta.lastOutcome === 'done') return 'done';
    return 'idle';
  }

  /** Comando shell per riprendere la stessa sessione dell'agente nel terminale interattivo */
  terminalCommand(): string {
    const { agentId, acpSessionId } = this.meta;
    if (agentId === 'agy') {
      let conversationId: string | null = null;
      if (acpSessionId) {
        try {
          const stateFile = join(homedir(), '.local', 'state', 'agicloud', 'agy-sessions.json');
          if (existsSync(stateFile)) {
            const data = JSON.parse(readFileSync(stateFile, 'utf8'));
            conversationId = data[acpSessionId]?.conversationId ?? null;
          }
        } catch {
          /* ignore */
        }
      }
      return conversationId ? `${AGY_BIN} --conversation ${conversationId}` : AGY_BIN;
    }
    if (agentId === 'claude') {
      return acpSessionId ? `claude --resume ${acpSessionId}` : 'claude';
    }
    if (agentId === 'opencode') {
      return acpSessionId ? `opencode -s ${acpSessionId}` : 'opencode';
    }
    if (agentId === 'cursor') {
      return 'cursor-agent';
    }
    if (agentId === 'codex') {
      return 'codex';
    }
    return '';
  }

  /** Thread affidato che passa a un altro capo (passaggio di consegne) */
  reparent(parentId: string): void {
    this.meta.parentId = parentId;
    this.saveMeta();
  }

  /** Ultima risposta dell'agente (per il capo) */
  lastReply(): string {
    const msgs = this.searchText();
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === 'assistant' && msgs[i]!.text.trim()) return msgs[i]!.text;
    return '';
  }

  /** Come run(), ma se l'agente sta lavorando il messaggio parte appena finisce */
  enqueue(prompt: string, auto = false): void {
    this.queue.push({ prompt, auto });
    if (!this.busy && this.queue.length === 1) this.enqueueNext();
  }

  /** Evento nel registro della conversazione (usato dal capo per le proposte di delega) */
  record(name: string, value: unknown): void {
    this.emit(custom(name, value));
  }

  /** Rinomina, fissa, archivia */
  update(patch: { title?: unknown; pinned?: unknown; archived?: unknown }): void {
    if (typeof patch.title === 'string') {
      const title = patch.title.trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!title) throw new HttpError(400, 'Il titolo non puo\' essere vuoto');
      this.meta.title = title;
      this.meta.customTitle = true;
    }
    if (typeof patch.pinned === 'boolean') this.meta.pinned = patch.pinned;
    if (typeof patch.archived === 'boolean') {
      this.meta.archived = patch.archived;
      if (patch.archived) {
        this.meta.pinned = false;
        void this.sleep(); // archiviata: niente agente acceso
      }
    }
    this.saveMeta();
  }

  /** Testo della conversazione (messaggi tuoi e dell'agente), per la ricerca */
  searchText(): { role: string; text: string }[] {
    const msgs = new Map<string, { role: string; text: string }>();
    for (const e of this.events as (BaseEvent & { messageId?: string; role?: string; delta?: string })[]) {
      if (e.type === EventType.TEXT_MESSAGE_START && e.messageId) msgs.set(e.messageId, { role: e.role ?? 'assistant', text: '' });
      else if (e.type === EventType.TEXT_MESSAGE_CONTENT && e.messageId) {
        const m = msgs.get(e.messageId);
        if (m) m.text += e.delta ?? '';
      }
    }
    return [...msgs.values()];
  }

  state(): ThreadState {
    return { status: this.status, configOptions: this.meta.configOptions ?? [], commands: this.commands };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Carica il registro dal disco (all'avvio del server) */
  loadEvents(): void {
    const file = this.eventsFile();
    if (!existsSync(file)) return;
    const events: BaseEvent[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* riga troncata da un arresto brusco: si salta */
      }
    }
    this.events.push(...compact(events));
    // Server fermato a meta' turno: il turno non finira' mai, lo si chiude nel registro
    const lastRun = [...this.events].reverse().find((e) => e.type === EventType.RUN_STARTED || e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR);
    if (lastRun?.type === EventType.RUN_STARTED) {
      this.emit(ev(EventType.RUN_ERROR, { message: 'Turno interrotto dal riavvio del server' }));
    }
    // Proposte di delega rimaste in sospeso: dopo un riavvio non si possono piu' decidere
    const open = new Set<string>();
    for (const e of this.events as (BaseEvent & { name?: string; value?: { id?: string } })[]) {
      if (e.type !== EventType.CUSTOM || !e.value?.id) continue;
      if (e.name === 'agicloud.delegation') open.add(e.value.id);
      else if (e.name === 'agicloud.delegation_update') open.delete(e.value.id);
    }
    for (const id of open) this.emit(custom('delegation_update', { id, state: 'expired' }));
    this.emit(custom('thread_status', { status: 'idle' }));
  }

  /** attachments: percorsi relativi in .agicloud/uploads (gia' caricati) */
  /** auto: messaggio scritto da AgiCloud (es. "il thread X ha finito"), non da te */
  async run(prompt: string, attachments: string[] = [], opts: { auto?: boolean } = {}): Promise<string> {
    if (this.status === 'running' || this.busy) throw new HttpError(409, 'L\'agente sta gia\' lavorando: attendi o interrompi');
    if (this.closed) {
      throw new HttpError(409, 'Thread concluso: le sue modifiche sono state unite o scartate e la copia separata non c\'e\' piu\'. Per altro lavoro chiedi al capo un nuovo thread.');
    }
    // Occupato da subito: tra l'avvio dell'agente e l'inizio del turno non deve partire un altro messaggio
    this.busy = true;
    let files: { rel: string; abs: string; size: number }[];
    let content: acp.ContentBlock[];
    try {
      await this.ensureStarted();
      if (this.status !== 'ready' || !this.session) throw new HttpError(409, 'L\'agente non e\' disponibile');
      files = attachments.map((p) => ({ rel: p, ...resolveAttachment(this.meta.cwd, p) }));
      // Plugin Design: alla prima richiesta il kit va nel progetto e l'agente riceve le istruzioni
      // per usarlo (in chat resta solo la tua richiesta)
      let agentPrompt = prompt;
      if (this.meta.design && !opts.auto && !this.events.some((e) => e.type === EventType.RUN_STARTED)) {
        installKit(this.meta.cwd, this.meta.design);
        excludeFromGit(this.meta.cwd);
        agentPrompt = `${kitPrompt(this.meta.design)}\n\n${prompt}`;
      }
      if (this.meta.browser && !opts.auto && !this.events.some((e) => e.type === EventType.RUN_STARTED)) {
        agentPrompt = `${BROWSER_PROMPT}\n\n${prompt}`;
      }
      // Capo non Claude: le istruzioni del server MCP potrebbero non essere lette, vanno nel primo messaggio
      if (this.meta.lead && this.meta.agentId !== 'claude' && this.store.lead && !this.events.some((e) => e.type === EventType.RUN_STARTED)) {
        agentPrompt = `[Istruzioni di AgiCloud per il capo]\n${await this.store.lead.instructions(this)}\n\nGli strumenti del capo sono nel server MCP "agicloud" (delega, stato_thread, leggi_thread, scrivi_thread).\n\n---\n\n${agentPrompt}`;
      }
      content = buildPrompt(agentPrompt, files, this.session.acceptsImages);
    } catch (err) {
      this.busy = false;
      throw err;
    }
    if (!this.meta.customTitle && !opts.auto && !this.events.some((e) => e.type === EventType.RUN_STARTED)) {
      this.meta.title = (prompt || files.map((f) => basename(f.rel)).join(', ')).slice(0, 80);
    }
    this.touch();
    const runId = randomUUID();
    const session = this.session;
    this.setStatus('running');
    // Il messaggio dell'utente entra nel registro come qualsiasi altro: lo storico e' completo
    const messageId = randomUUID();
    this.emit(ev(EventType.TEXT_MESSAGE_START, { messageId, role: 'user' }));
    this.emit(ev(EventType.TEXT_MESSAGE_CONTENT, { messageId, delta: prompt }));
    this.emit(ev(EventType.TEXT_MESSAGE_END, { messageId }));
    if (opts.auto) this.emit(custom('auto_message', { messageId }));
    if (files.length) {
      this.emit(custom('attachments', { messageId, files: files.map((f) => ({ name: attachmentName(f.rel), path: f.rel, size: f.size })) }));
    }

    void (async () => {
      // Per la notifica di fine turno: esito e inizio della risposta
      let outcome: { stop?: string; error?: string } = {};
      let reply = '';
      try {
        for await (const e of session.run(content, runId)) {
          this.emit(e);
          const x = e as BaseEvent & Record<string, any>;
          if (x.type === EventType.TEXT_MESSAGE_CONTENT && reply.length < 300) reply += x.delta ?? '';
          else if (x.type === EventType.RUN_FINISHED) outcome = { stop: x.result?.stopReason };
          else if (x.type === EventType.RUN_ERROR) outcome = { error: x.message };
          else if (x.type === EventType.CUSTOM && x.name === 'agicloud.acp.usage_update' && LIMIT_AGENTS.has(this.meta.agentId)) {
            const changed = this.store.limits?.fromMeta(x.value?._meta?.['_claude/rateLimit']);
            if (changed?.status === 'allowed_warning') {
              const pct = changed.utilization !== null ? ` (${Math.round(changed.utilization * 100)}%)` : '';
              this.notify(`Claude: limite quasi finito${pct}`, 'Se serve, dalla conversazione puoi passare il lavoro a un altro agente');
            }
          }
          else if (x.type === EventType.CUSTOM && x.name === 'agicloud.permission_request') {
            this.openPermissions.set(x.value?.requestId, {
              title: x.value?.toolCall?.title ?? 'Azione dell\'agente',
              options: (x.value?.options ?? []).map((o: any) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
            });
            // Thread affidato: la notifica porta alla chat del capo, dove si puo' rispondere senza cercarlo
            const parent = this.meta.parentId ? this.store.find(this.meta.parentId) : undefined;
            if (parent) {
              void this.store.onNotify?.({
                title: `Il thread "${this.meta.title}" aspetta te`.slice(0, 80),
                body: x.value?.toolCall?.title ?? 'L\'agente chiede conferma',
                url: `/#/t/${parent.id}`,
                tag: this.id,
              });
            } else this.notify(`Permesso richiesto · ${this.meta.title}`, x.value?.toolCall?.title ?? 'L\'agente chiede conferma');
          }
        }
      } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) };
        this.emit(ev(EventType.RUN_ERROR, { message: outcome.error }));
      } finally {
        this.busy = false;
        this.openPermissions.clear();
        this.meta.lastOutcome = outcome.error ? 'error' : outcome.stop === 'cancelled' ? 'cancelled' : 'done';
        if (this.status === 'running') this.setStatus(this.session ? 'ready' : 'idle');
        this.touch();
        this.scheduleIdle();
        // Altri messaggi in coda: si prosegue; il capo viene avvisato solo a coda vuota
        if (this.queue.length) setTimeout(() => this.enqueueNext(), 0);
        else this.store.lead?.onRunFinished(this, outcome);
        // Interrotto da te: niente notifica
        // Limite dell'abbonamento di Claude: si propone il passaggio di consegne
        if (
          outcome.error &&
          LIMIT_AGENTS.has(this.meta.agentId) &&
          this.store.limits &&
          // dal testo dell'errore oppure dallo stato del limite appena ricevuto ("rejected")
          (this.store.limits.fromError(outcome.error) || this.store.limits.get().claude?.blocked)
        ) {
          this.emit(custom('limit_reached', { ...this.store.limits.get().claude, message: '' }));
          this.notify(`Claude ha finito il limite · ${this.meta.title}`, 'Apri la conversazione per passare il lavoro a un altro agente');
        } else if (outcome.error) this.notify(`Errore · ${this.meta.title}`, outcome.error.split('\n')[0]!);
        else if (outcome.stop && outcome.stop !== 'cancelled') {
          this.notify(`Fatto · ${this.meta.title}`, reply.replace(/\s+/g, ' ').trim().slice(0, 140) || 'L\'agente ha finito');
        }
      }
    })();
    return runId;
  }

  /**
   * Strumenti che Claude usa senza chiedere: quelli del capo (la delega la approvi gia' tu nella scheda)
   * e, nelle chat del Browser, quelli del browser condiviso (lo stai guardando; per invii e acquisti
   * le istruzioni gli chiedono di domandare prima).
   */
  private claudeAllowedTools(): Record<string, unknown> | undefined {
    if (this.meta.agentId !== 'claude') return undefined;
    const allowed = [
      ...(this.meta.lead && this.store.lead ? this.store.lead.allowedTools() : []),
      ...(this.meta.browser ? ['mcp__browser'] : []),
      ...(this.store.extraAllowedTools?.() ?? []),
    ];
    return allowed.length ? { claudeCode: { options: { allowedTools: allowed } } } : undefined;
  }

  private enqueueNext(): void {
    const next = this.queue.shift();
    if (!next) return;
    void this.run(next.prompt, [], { auto: next.auto }).catch((err) => {
      this.queue.length = 0; // agente non disponibile: i messaggi in coda non partirebbero comunque
      this.emit(ev(EventType.RUN_ERROR, { message: String(err instanceof Error ? err.message : err) }));
    });
  }

  async setConfig(configId: string, value: ConfigValue): Promise<void> {
    this.meta.config[configId] = value;
    // Ad agente spento si aggiorna solo la scelta: verra' applicata alla ripartenza
    this.meta.configOptions = (this.meta.configOptions ?? []).map((o) =>
      o.id === configId ? ({ ...o, currentValue: value } as acp.SessionConfigOption) : o,
    );
    this.saveMeta();
    if (this.session && (this.status === 'ready' || this.status === 'running')) {
      try {
        await this.session.setConfigOption(configId, value);
      } catch (err) {
        throw new HttpError(400, `Impostazione non accettata dall'agente: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      this.pushState();
    }
  }

  respondPermission(requestId: string, optionId: string | null): void {
    if (!this.session?.respondPermission(requestId, optionId)) {
      throw new HttpError(404, 'Richiesta di permesso non trovata o gia\' risolta');
    }
    this.openPermissions.delete(requestId);
    this.emit(custom('permission_resolved', { requestId, optionId }));
  }

  async cancel(): Promise<void> {
    if (this.status === 'running') await this.session?.cancel();
  }

  /** Spegne l'agente; la conversazione resta e riprende al prossimo messaggio */
  async sleep(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.clearIdle();
    const s = this.session;
    this.session = null;
    await s?.close();
    if (this.status !== 'error' && this.status !== 'auth_required') this.setStatus('idle');
  }

  async destroy(): Promise<void> {
    this.clearIdle();
    await this.session?.close();
    this.session = null;
    this.listeners.clear();
    await new Promise<void>((r) => (this.log ? this.log.end(r) : r()));
    rmSync(this.eventsFile(), { force: true });
    rmSync(this.metaFile(), { force: true });
  }

  async shutdown(): Promise<void> {
    this.clearIdle();
    await this.session?.close();
    await new Promise<void>((r) => (this.log ? this.log.end(r) : r()));
  }

  /** Aspetta che l'agente sia acceso; errore chiaro se non parte (es. non installato o senza login) */
  async ready(): Promise<void> {
    await this.ensureStarted();
    if (this.status !== 'ready') {
      const last = [...this.events].reverse().find((e) => e.type === EventType.CUSTOM && (e as any).name === 'agicloud.thread_status') as any;
      throw new HttpError(409, `${getAgent(this.meta.agentId).label} non si avvia: ${last?.value?.message?.split('\n')[0] ?? this.status}`);
    }
  }

  /** Accende l'agente subito (alla creazione): opzioni e comandi sono pronti prima del primo messaggio */
  warmUp(): void {
    this.ensureStarted().catch(() => {});
  }

  private notify(title: string, body: string): void {
    void this.store.onNotify?.({ title: title.slice(0, 80), body, url: `/#/t/${this.id}`, tag: this.id });
  }

  private ensureStarted(): Promise<void> {
    if (this.session && this.status !== 'error') return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!existsSync(this.meta.cwd)) {
      // Senza cartella l'agente fallirebbe con un "ENOENT" che sembra un agente non installato
      this.setStatus('error', { message: `La cartella di lavoro non esiste piu': ${this.meta.cwd}` });
      return;
    }
    await this.store.makeRoom(this);
    this.setStatus('starting');
    const session = new AgentSession(getAgent(this.meta.agentId), {
      cwd: this.meta.cwd,
      threadId: this.id,
      env: this.store.settings.agentEnv(this.meta.agentId),
      resumeSessionId: this.meta.acpSessionId,
      mcpServers: [
        ...(this.meta.lead && this.store.lead ? [this.store.lead.mcpServerFor(this)] : []),
        ...((await this.store.extraMcpServers?.()) ?? []),
      ],
      sessionMeta: this.claudeAllowedTools(),
      onConfigOptions: (options) => {
        this.store.settings.rememberOptions(this.meta.agentId, options);
        this.meta.configOptions = options;
        this.saveMeta();
        this.pushState();
      },
      onCommands: (commands) => {
        this.commands = commands.map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint }));
        this.pushState();
      },
      onExit: (message) => {
        if (this.session !== session) return;
        this.session = null;
        this.emit(ev(EventType.RUN_ERROR, { message: `L'agente si e' fermato: riprendera' al prossimo messaggio.\n${message}` }));
        this.setStatus('idle');
      },
    });
    try {
      const res = await session.start();
      this.session = session;
      const resumed = this.meta.acpSessionId;
      this.meta.acpSessionId = res.sessionId;
      this.meta.configOptions = res.configOptions;
      this.store.settings.rememberOptions(this.meta.agentId, res.configOptions);
      this.emit(custom('agent_info', { agentInfo: res.init.agentInfo ?? null }));
      if (resumed) {
        this.emit(
          custom('session_opened', {
            origin: res.origin,
            // Ripresa fallita: l'agente non ricorda la conversazione precedente
            lostContext: res.origin === 'new',
            detail: res.resumeError,
          }),
        );
      }
      await this.applyConfig(session);
      this.saveMeta();
      this.setStatus('ready');
      this.scheduleIdle();
    } catch (err) {
      await session.close();
      if (err instanceof AuthRequiredError) {
        this.setStatus('auth_required', { message: err.message, authMethods: err.authMethods });
      } else {
        this.setStatus('error', { message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Riapplica le scelte salvate che differiscono da quelle dell'agente appena acceso */
  private async applyConfig(session: AgentSession): Promise<void> {
    for (const [id, value] of Object.entries(this.meta.config)) {
      const option = session.configOptions.find((o) => o.id === id);
      if (!option || option.currentValue === value) continue;
      try {
        await session.setConfigOption(id, value);
      } catch {
        delete this.meta.config[id]; // valore non piu' valido (es. modello ritirato)
      }
    }
    this.meta.configOptions = session.configOptions;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.sleep(), config.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private touch(): void {
    this.lastUsed = Date.now();
    this.meta.updatedAt = this.lastUsed;
    this.saveMeta();
  }

  get alive(): boolean {
    return this.session !== null;
  }

  private setStatus(status: ThreadStatus, extra: Record<string, unknown> = {}): void {
    this.status = status;
    this.emit(custom('thread_status', { status, ...extra }));
    this.pushState();
  }

  private pushState(): void {
    const e = custom('state', this.state());
    for (const l of this.listeners) l(e, null);
  }

  private emit(event: BaseEvent): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push(event);
    this.log ??= createWriteStream(this.eventsFile(), { flags: 'a' });
    this.log.write(JSON.stringify(event) + '\n');
    const index = this.events.length - 1;
    for (const l of this.listeners) l(event, index);
  }

  saveMeta(): void {
    const tmp = this.metaFile() + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.meta));
    renameSync(tmp, this.metaFile());
  }

  private metaFile() {
    return join(config.threadsDir, `${this.id}.json`);
  }

  private eventsFile() {
    return join(config.threadsDir, `${this.id}.jsonl`);
  }
}

export class ThreadStore {
  private readonly threads = new Map<string, Thread>();

  /** Notifiche (push sul telefono): impostato dal server */
  onNotify?: (notice: Notice) => Promise<unknown> | void;
  /** Capo e thread affidati: impostato dal server */
  lead?: LeadManager;
  /** Server MCP in piu' per tutti gli agenti (es. il Browser condiviso): impostato dal server */
  extraMcpServers?: () => Promise<acp.McpServer[]>;
  /** Limiti dell'abbonamento di Claude (capo di riserva): impostato dal server */
  limits?: Limits;
  /** Strumenti dei plugin preautorizzati per Claude: impostato dal server */
  extraAllowedTools?: () => string[];

  constructor(readonly settings: Settings) {}

  /** Ricarica le conversazioni salvate (agenti spenti: ripartono al primo messaggio) */
  load(): void {
    for (const file of readdirSync(config.threadsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(config.threadsDir, file), 'utf8')) as ThreadMeta;
        meta.config ??= {};
        const thread = new Thread(meta, this);
        thread.loadEvents();
        this.threads.set(meta.id, thread);
      } catch (err) {
        console.error(`Conversazione illeggibile ${file}:`, err);
      }
    }
  }

  list() {
    return [...this.threads.values()].map((t) => t.summary()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Cerca nei titoli e nel testo; per ogni conversazione un estratto attorno al primo risultato */
  search(q: string) {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const out: { id: string; snippet: string; inTitle: boolean }[] = [];
    for (const t of this.threads.values()) {
      const inTitle = t.meta.title.toLowerCase().includes(needle);
      let snippet = '';
      for (const m of t.searchText()) {
        const i = m.text.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        const start = Math.max(0, i - 50);
        snippet = `${start ? '…' : ''}${m.text.slice(start, i + needle.length + 70).replace(/\s+/g, ' ').trim()}…`;
        break;
      }
      if (inTitle || snippet) out.push({ id: t.id, snippet, inTitle });
    }
    return out.slice(0, 50);
  }

  recentProjects(): string[] {
    // i worktree dei sottoagenti spariscono dopo l'unione: niente tracce di cartelle che non esistono piu'
    return [...new Set(this.list().map((t) => t.cwd))].filter((p) => existsSync(p)).slice(0, 12);
  }

  get(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new HttpError(404, 'Conversazione non trovata');
    return t;
  }

  /** Thread affidati da un capo */
  children(parentId: string): Thread[] {
    return [...this.threads.values()].filter((t) => t.meta.parentId === parentId).sort((a, b) => a.meta.createdAt - b.meta.createdAt);
  }

  find(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  create(
    agentId: string,
    cwd: string,
    extra: Pick<ThreadMeta, 'lead' | 'parentId' | 'task' | 'worktree' | 'design' | 'browser' | 'handoverFrom'> & { title?: string } = {},
  ): Thread {
    try {
      getAgent(agentId);
    } catch {
      throw new HttpError(400, `Agente sconosciuto: ${agentId}`);
    }
    const now = Date.now();
    const thread = new Thread(
      {
        id: randomUUID(),
        agentId,
        cwd: resolveProject(cwd),
        // Il capo tiene il suo titolo (non quello del primo messaggio): si riconosce nella lista
        title: extra.title ?? (extra.lead ? `Capo · ${basename(resolveProject(cwd))}` : 'Nuova conversazione'),
        customTitle: extra.title || extra.lead ? true : undefined,
        lead: extra.lead || undefined,
        parentId: extra.parentId,
        task: extra.task,
        worktree: extra.worktree,
        design: extra.design,
        browser: extra.browser || undefined,
        handoverFrom: extra.handoverFrom,
        createdAt: now,
        updatedAt: now,
        // Modalita'/modello predefiniti dalle Impostazioni: applicati all'avvio dell'agente
        config: this.settings.agentDefaults(agentId),
      },
      this,
    );
    thread.saveMeta();
    this.threads.set(thread.id, thread);
    thread.warmUp();
    return thread;
  }

  /** Prima di accendere un agente: se si e' al limite, si spegne il meno usato tra quelli fermi */
  async makeRoom(starting: Thread): Promise<void> {
    const alive = [...this.threads.values()].filter((t) => t !== starting && t.alive);
    if (alive.length < config.maxSessions) return;
    const victim = alive.filter((t) => t.status === 'ready').sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) throw new HttpError(429, `Troppi agenti al lavoro insieme (max ${config.maxSessions})`);
    await victim.sleep();
  }

  async remove(id: string): Promise<void> {
    const t = this.get(id);
    this.threads.delete(id);
    await t.destroy();
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.threads.values()].map((t) => t.shutdown()));
  }
}

/** Unisce i pezzi di testo consecutivi dello stesso messaggio: registro piu' leggero da rileggere */
function compact(events: BaseEvent[]): BaseEvent[] {
  const out: BaseEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1] as (BaseEvent & { messageId?: string; delta?: string }) | undefined;
    const cur = e as BaseEvent & { messageId?: string; delta?: string };
    const mergeable = e.type === EventType.TEXT_MESSAGE_CONTENT || e.type === EventType.REASONING_MESSAGE_CHUNK;
    if (mergeable && prev && prev.type === e.type && prev.messageId === cur.messageId) {
      out[out.length - 1] = { ...prev, delta: (prev.delta ?? '') + (cur.delta ?? '') } as BaseEvent;
    } else {
      out.push(e);
    }
  }
  return out;
}

/** Agenti di cui si seguono i limiti dell'abbonamento (demo: solo per le prove, imita Claude) */
const LIMIT_AGENTS = new Set(['claude', 'demo']);

/** Istruzioni per l'agente di una chat del Browser (aggiunte al primo messaggio, non mostrate in chat) */
const BROWSER_PROMPT =
  '[Browser · AgiCloud] Questa chat sta accanto al browser condiviso: l'utente vede in diretta lo stesso Chromium che tu usi con gli ' +
  'strumenti browser_* (Playwright: browser_navigate, browser_snapshot, browser_click, browser_type, browser_tabs...). ' +
  'Lavorate insieme sulle stesse schede: prima di agire guarda la scheda attiva (browser_snapshot), non chiudere le schede di l'utente ' +
  'senza chiedere, e per moduli, acquisti, invii o account chiedi conferma prima del clic finale. Se gli strumenti browser_* ' +
  'non ci sono, dillo: il plugin Browser va attivato e la conversazione riaperta.';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Oltre questa dimensione l'immagine non va inline: l'agente la legge dal percorso */
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

/** Nome originale senza il prefisso data-ora aggiunto al salvataggio */
function attachmentName(rel: string): string {
  return basename(rel).replace(/^\d{8}-\d{6}-(\d+-)?/, '');
}

/** Testo + elenco dei file allegati; le immagini anche come immagini, se l'agente le accetta */
function buildPrompt(prompt: string, files: { rel: string; abs: string; size: number }[], images: boolean): acp.ContentBlock[] {
  const text = files.length
    ? `${prompt || 'Guarda i file allegati.'}\n\nFile allegati (percorsi relativi alla cartella del progetto):\n${files.map((f) => `- ${f.rel}`).join('\n')}`
    : prompt;
  const blocks: acp.ContentBlock[] = [{ type: 'text', text }];
  if (images) {
    for (const f of files) {
      const mime = IMAGE_TYPES[extname(f.rel).toLowerCase()];
      if (mime && f.size <= MAX_INLINE_IMAGE) blocks.push({ type: 'image', mimeType: mime, data: readAttachment(f.abs).toString('base64') });
    }
  }
  return blocks;
}
