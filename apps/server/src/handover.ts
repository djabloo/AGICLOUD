// Capo di riserva: limiti di Claude e passaggio di consegne a un altro agente.
// - Claude manda a ogni turno lo stato del limite dell'abbonamento (_claude/rateLimit: allowed,
//   allowed_warning, rejected; utilizzo e ora di azzeramento); quando lo supera il turno fallisce
//   con un errore di limite. AgiCloud tiene l'ultimo stato e avvisa prima che finisca.
// - Passaggio di consegne: dalla conversazione si costruisce un dossier (senza modelli, quindi
//   senza spendere token), si apre una conversazione con un altro agente sullo stesso progetto,
//   gli si passano i thread affidati e si riparte dal dossier. Quando Claude torna disponibile
//   si puo' ripassare il lavoro alla conversazione originale, che ricorda tutto.

import { EventType, type BaseEvent } from '@ag-ui/core';
import { getAgent } from '@agicloud/bridge';
import type { Hono } from 'hono';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { Thread, ThreadStore } from './threads.js';
import { worktreeChanges } from './worktrees.js';
import { user } from './user.js';

export interface LimitState {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** five_hour, seven_day... */
  type: string | null;
  /** 0..1 */
  utilization: number | null;
  /** ms */
  resetsAt: number | null;
  at: number;
  /** Testo dell'errore, se il limite e' stato scoperto da un turno fallito */
  message?: string;
}

/** Testi dei turni falliti per limite dell'abbonamento */
const LIMIT_TEXT = /usage limit|rate.?limit|limit reached|hit your limit|limite (di utilizzo )?raggiunto|out of (extra )?usage/i;
/** Da qui in su si avvisa prima che finisca */
const WARN_AT = 0.9;

const LIMITS_FILE = join(config.threadsDir, '..', 'limits.json');

export class Limits {
  /** Salvato su disco: dopo un riavvio di AgiCloud l'avviso resta */
  private claude: LimitState | null = (() => {
    try {
      return existsSync(LIMITS_FILE) ? (JSON.parse(readFileSync(LIMITS_FILE, 'utf8')).claude as LimitState) : null;
    } catch {
      return null;
    }
  })();

  private save(): void {
    try {
      writeFileSync(LIMITS_FILE, JSON.stringify({ claude: this.claude }));
    } catch {
      /* solo una comodita' */
    }
  }

  /** Stato dal _meta di usage_update di Claude */
  fromMeta(info: any): LimitState | null {
    if (!info || typeof info.status !== 'string') return null;
    const prev = this.claude;
    this.claude = {
      status: info.status,
      type: info.rateLimitType ?? null,
      utilization: typeof info.utilization === 'number' ? info.utilization : null,
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
      at: Date.now(),
    };
    this.save();
    return prev?.status !== this.claude.status ? this.claude : null;
  }

  /** Turno fallito: se il testo e' un limite, Claude e' fermo fino all'azzeramento */
  fromError(message: string): boolean {
    if (!LIMIT_TEXT.test(message)) return false;
    this.claude = { status: 'rejected', type: this.claude?.type ?? null, utilization: 1, resetsAt: guessReset(message) ?? this.claude?.resetsAt ?? null, at: Date.now(), message: message.slice(0, 300) };
    this.save();
    return true;
  }

  get() {
    const s = this.claude;
    if (!s) return { claude: null };
    // Passata l'ora di azzeramento il limite non vale piu'
    const expired = s.resetsAt !== null && Date.now() > s.resetsAt;
    const status = expired ? 'allowed' : s.status;
    return {
      claude: {
        ...s,
        status,
        warning: status === 'rejected' || status === 'allowed_warning' || (s.utilization ?? 0) >= WARN_AT,
        blocked: status === 'rejected',
      },
    };
  }
}

/** "resets 4pm (Europe/Berlin)" e simili: se non si capisce, null */
function guessReset(message: string): number | null {
  const m = message.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3]?.toLowerCase() === 'pm') h += 12;
  else if (!m[3]) h = Number(m[1]);
  const d = new Date();
  d.setHours(h, Number(m[2] ?? 0), 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ── Dossier ─────────────────────────────────────────────────────────────────

type Ev = BaseEvent & Record<string, any>;

function messages(events: BaseEvent[]): { role: string; text: string; auto: boolean }[] {
  const out = new Map<string, { role: string; text: string; auto: boolean }>();
  for (const e of events as Ev[]) {
    if (e.type === EventType.TEXT_MESSAGE_START) out.set(e.messageId, { role: e.role ?? 'assistant', text: '', auto: false });
    else if (e.type === EventType.TEXT_MESSAGE_CONTENT && out.has(e.messageId)) out.get(e.messageId)!.text += e.delta ?? '';
    else if (e.type === EventType.CUSTOM && e.name === 'agicloud.auto_message' && out.has(e.value?.messageId)) out.get(e.value.messageId)!.auto = true;
  }
  return [...out.values()].filter((m) => m.text.trim());
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Riassunto del lavoro dalla conversazione: niente modelli, solo i fatti che ci sono gia' */
export async function buildDossier(thread: Thread, store: ThreadStore, since = 0): Promise<string> {
  const all = messages(thread.events.slice(since));
  const firstUser = messages(thread.events).find((m) => m.role === 'user' && !m.auto);
  const recent = all.slice(-12);
  const plan = [...(thread.events as Ev[])].reverse().find((e) => e.type === EventType.CUSTOM && e.name === 'agicloud.plan')?.value?.entries as
    | { content: string; status: string }[]
    | undefined;
  const kids = store.children(thread.id);
  const kidLines = await Promise.all(
    kids.map(async (k) => {
      let changes = '';
      if (k.meta.worktree?.state === 'open') {
        const c = await worktreeChanges(k.meta.worktree).catch(() => null);
        changes = c ? ` · ${c.files.length} file modificati, non ancora uniti` : '';
      } else if (k.meta.worktree) changes = ` · modifiche ${k.meta.worktree.state === 'merged' ? 'unite' : 'scartate'}`;
      return `- "${k.meta.title}" (${getAgent(k.meta.agentId).label}, id ${k.id}) · stato: ${k.childState()}${changes}`;
    }),
  );
  return [
    `Progetto: ${thread.meta.cwd}`,
    `Conversazione: "${thread.meta.title}" (${getAgent(thread.meta.agentId).label})`,
    firstUser ? `\nRichiesta iniziale ${user.di}:\n${clip(firstUser.text, 1500)}` : '',
    plan?.length ? `\nPiano:\n${plan.map((p) => `- [${p.status}] ${p.content}`).join('\n')}` : '',
    kidLines.length ? `\nThread affidati (ora seguiti da te):\n${kidLines.join('\n')}` : '',
    `\nUltimi messaggi (dal piu' vecchio):\n${recent.map((m) => `### ${m.auto ? 'AgiCloud' : m.role === 'user' ? user.Name : 'Agente'}\n${clip(m.text, 1500)}`).join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Passaggio di consegne ───────────────────────────────────────────────────

export async function handover(store: ThreadStore, from: Thread, agentId: string): Promise<Thread> {
  try {
    getAgent(agentId);
  } catch {
    throw new HttpError(400, `Agente sconosciuto: ${agentId}`);
  }
  if (from.status === 'running') throw new HttpError(409, 'La conversazione sta lavorando: interrompila o aspetta che finisca');

  // Ritorno: si ripassa il lavoro alla conversazione da cui era partito, che ricorda tutto
  const origin = from.meta.handoverFrom ? store.find(from.meta.handoverFrom) : undefined;
  if (origin && origin.meta.agentId === agentId) {
    const dossier = await buildDossier(from, store, from.meta.handoverStart ?? 0);
    for (const k of store.children(from.id)) k.reparent(origin.id);
    from.meta.handedOverTo = origin.id;
    from.saveMeta();
    from.record('handover', { to: origin.id, agentId, back: true });
    origin.meta.handedOverTo = undefined;
    origin.saveMeta();
    origin.enqueue(
      `[Passaggio di consegne di AgiCloud] Bentornato: mentre eri fermo per il limite, ${getAgent(from.meta.agentId).label} ha portato avanti il lavoro. ` +
        `Ecco cosa e' successo nel frattempo:\n\n${dossier}\n\n---\nRiprendi da qui: riassumi ${user.a} in poche righe cosa e' cambiato e proponi il prossimo passo.`,
      true,
    );
    return origin;
  }

  const project = from.meta.cwd.split('/').filter(Boolean).pop() ?? 'progetto';
  const to = store.create(agentId, from.meta.cwd, {
    lead: from.meta.lead,
    title: `${from.meta.lead ? 'Capo' : 'Continua'} · ${project} (${getAgent(agentId).label})`,
    handoverFrom: from.id,
  });
  if (from.meta.lead && agentId === 'agy') await to.setConfig('permissions', 'all').catch(() => {});
  // Prima di spostare qualcosa, il nuovo agente deve partire davvero
  try {
    await to.ready();
  } catch (err) {
    await store.remove(to.id).catch(() => {});
    throw err;
  }
  const dossier = await buildDossier(from, store);
  for (const k of store.children(from.id)) k.reparent(to.id);
  from.meta.handedOverTo = to.id;
  from.saveMeta();
  from.record('handover', { to: to.id, agentId });
  to.meta.handoverStart = to.events.length;
  to.saveMeta();
  to.enqueue(
    `[Passaggio di consegne di AgiCloud] Prendi in mano questo lavoro: era seguito da ${getAgent(from.meta.agentId).label}, ` +
      `che si e' fermato (limite dell'abbonamento o scelta ${user.di}). Non rifare quello che e' gia' fatto.\n\n${dossier}\n\n---\n` +
      `Per prima cosa riassumi ${user.a} in 3-5 righe dove siamo e proponi il prossimo passo; poi aspetta la risposta.`,
    true,
  );
  return to;
}

export function registerHandover(app: Hono<any>, store: ThreadStore, limits: Limits): void {
  app.get('/api/limits', (c) => c.json(limits.get()));
  app.post('/api/threads/:id/handover', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const to = await handover(store, store.get(c.req.param('id')), String(body.agentId ?? ''));
    return c.json(to.summary());
  });
}
