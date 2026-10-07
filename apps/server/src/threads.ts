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
import { basename, extname, join } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentSession, AuthRequiredError, custom, ev, getAgent } from '@agicloud/bridge';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';
import { readAttachment, resolveAttachment } from './uploads.js';
import type { Settings } from './settings.js';
import type { Notice } from './push.js';

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
}

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

  constructor(
    readonly meta: ThreadMeta,
    private readonly store: ThreadStore,
  ) {}

  get id() {
    return this.meta.id;
  }

  summary() {
    const { id, agentId, cwd, title, createdAt, updatedAt } = this.meta;
    return { id, agentId, cwd, project: basename(cwd), title, status: this.status, createdAt, updatedAt };
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
    this.emit(custom('thread_status', { status: 'idle' }));
  }

  /** attachments: percorsi relativi in .agicloud/uploads (gia' caricati) */
  async run(prompt: string, attachments: string[] = []): Promise<string> {
    if (this.status === 'running') throw new HttpError(409, 'L\'agente sta gia\' lavorando: attendi o interrompi');
    await this.ensureStarted();
    if (this.status !== 'ready' || !this.session) throw new HttpError(409, 'L\'agente non e\' disponibile');

    const files = attachments.map((p) => ({ rel: p, ...resolveAttachment(this.meta.cwd, p) }));
    const content = buildPrompt(prompt, files, this.session.acceptsImages);
    if (!this.events.some((e) => e.type === EventType.RUN_STARTED)) {
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
          else if (x.type === EventType.CUSTOM && x.name === 'agicloud.permission_request') {
            this.notify(`Permesso richiesto · ${this.meta.title}`, x.value?.toolCall?.title ?? 'L\'agente chiede conferma');
          }
        }
      } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) };
        this.emit(ev(EventType.RUN_ERROR, { message: outcome.error }));
      } finally {
        if (this.status === 'running') this.setStatus(this.session ? 'ready' : 'idle');
        this.touch();
        this.scheduleIdle();
        // Interrotto da te: niente notifica
        if (outcome.error) this.notify(`Errore · ${this.meta.title}`, outcome.error.split('\n')[0]!);
        else if (outcome.stop && outcome.stop !== 'cancelled') {
          this.notify(`Fatto · ${this.meta.title}`, reply.replace(/\s+/g, ' ').trim().slice(0, 140) || 'L\'agente ha finito');
        }
      }
    })();
    return runId;
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
    await this.store.makeRoom(this);
    this.setStatus('starting');
    const session = new AgentSession(getAgent(this.meta.agentId), {
      cwd: this.meta.cwd,
      threadId: this.id,
      env: this.store.settings.agentEnv(this.meta.agentId),
      resumeSessionId: this.meta.acpSessionId,
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

  recentProjects(): string[] {
    return [...new Set(this.list().map((t) => t.cwd))].slice(0, 12);
  }

  get(id: string): Thread {
    const t = this.threads.get(id);
    if (!t) throw new HttpError(404, 'Conversazione non trovata');
    return t;
  }

  create(agentId: string, cwd: string): Thread {
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
        title: 'Nuova conversazione',
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
