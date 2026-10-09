// Il "capo": una conversazione (Claude Code) che puo' affidare compiti ad altri agenti.
// - Gli strumenti glieli da' lead-mcp.ts, che parla con /lead-api usando un token per conversazione.
// - Ogni delega la approva l'utente (scheda nella chat del capo + notifica sul telefono).
// - Il thread affidato lavora in una copia separata (worktree.ts); a fine turno il capo riceve
//   un messaggio automatico e riassume. Unire o scartare le modifiche lo decide l'utente.

import { randomBytes, randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import { AGENTS, getAgent } from '@agicloud/bridge';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { Settings } from './settings.js';
import type { RunOutcome, Thread, ThreadStore } from './threads.js';
import { createWorktree, discardWorktree, mergeWorktree, repoRoot, worktreeChanges } from './worktrees.js';

const MCP_SCRIPT = new URL('./lead-mcp.ts', import.meta.url).pathname;
const TSX = import.meta.resolve('tsx');
/** Una proposta senza risposta per tanto tempo decade (il capo puo' riproporla) */
const DELEGATION_TTL_MS = 30 * 60_000;
const MAX_OPEN_CHILDREN = 6;
const MAX_TASK = 20_000;
const LEAD_TOOLS = ['delega', 'stato_thread', 'leggi_thread', 'scrivi_thread'];

interface Delegation {
  id: string;
  leadId: string;
  agentId: string;
  title: string;
  task: string;
  reason: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  /** Risposta per il capo, quando la proposta e' decisa */
  text: string;
  childId?: string;
}

export class LeadManager {
  private readonly tokens = new Map<string, string>(); // token -> id del capo
  private readonly tokenOf = new Map<string, string>(); // id del capo -> token
  private readonly delegations = new Map<string, Delegation>();

  constructor(
    private readonly store: ThreadStore,
    private readonly settings: Settings,
  ) {}

  /** Server MCP da dare al capo all'avvio della sessione. Il token resta in memoria (vale fino al riavvio) */
  mcpServerFor(lead: Thread): acp.McpServer {
    let token = this.tokenOf.get(lead.id);
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.tokens.set(token, lead.id);
      this.tokenOf.set(lead.id, token);
    }
    return {
      name: 'agicloud',
      command: process.execPath,
      args: ['--import', TSX, MCP_SCRIPT],
      env: [
        { name: 'AGICLOUD_LEAD_URL', value: `http://127.0.0.1:${config.port}/lead-api` },
        { name: 'AGICLOUD_LEAD_TOKEN', value: token },
      ],
    };
  }

  /**
   * Gli strumenti del capo non devono chiedere anche il permesso dell'agente: la delega
   * la approva gia' l'utente nella scheda di AgiCloud, il resto sono letture e messaggi ai thread.
   */
  sessionMeta(agentId: string): Record<string, unknown> | undefined {
    if (agentId !== 'claude') return undefined;
    return { claudeCode: { options: { allowedTools: LEAD_TOOLS.map((t) => `mcp__agicloud__${t}`) } } };
  }

  /** Fine di un turno di un thread affidato: il capo viene avvisato e riassume */
  onRunFinished(thread: Thread, outcome: RunOutcome): void {
    const parentId = thread.meta.parentId;
    if (!parentId || outcome.stop === 'cancelled') return;
    const lead = this.store.find(parentId);
    if (!lead) return;
    const label = agentLabel(thread.meta.agentId);
    const esito = outcome.error ? `con un errore: ${outcome.error.split('\n')[0]}` : 'il suo turno';
    lead.enqueue(
      `[Messaggio automatico di AgiCloud] Il thread "${thread.meta.title}" (${label}, id ${thread.id}) ha finito ${esito}.\n` +
        `Leggi il risultato con lo strumento leggi_thread, poi riassumi a l'utente in poche righe cosa e' stato fatto e proponi i passi successivi ` +
        `(per esempio unire le modifiche: lo fa l'utente dal thread). Non unire nulla tu.`,
      true,
    );
  }

  /** Decisione di l'utente su una proposta di delega */
  async decide(leadId: string, delegationId: string, approve: boolean, note = ''): Promise<{ childId?: string }> {
    const d = this.delegations.get(delegationId);
    if (!d || d.leadId !== leadId) throw new HttpError(404, 'Proposta non trovata: forse e\' scaduta o il server e\' stato riavviato');
    if (d.state !== 'pending') throw new HttpError(409, 'Proposta gia\' decisa');
    const lead = this.store.get(leadId);
    const nota = note.trim() ? ` Nota di l'utente: ${note.trim().slice(0, 2000)}` : '';
    if (!approve) {
      d.state = 'rejected';
      d.text = `l'utente ha rifiutato la delega "${d.title}".${nota}`;
      lead.record('delegation_update', { id: d.id, state: d.state, note: note.trim() || undefined });
      return {};
    }
    const slug = `${slugify(d.title)}-${d.id.slice(0, 4)}`;
    const wt = await createWorktree(lead.meta.cwd, slug).catch((err) => {
      throw new HttpError(409, `Copia separata non creata: ${err instanceof Error ? err.message : err}`);
    });
    const child = this.store.create(d.agentId, wt?.cwd ?? lead.meta.cwd, {
      parentId: lead.id,
      task: d.task,
      title: d.title,
      worktree: wt?.info,
    });
    const where = wt
      ? `Lavori in una copia separata del progetto (ramo ${wt.info.branch}): fai tutte le modifiche qui, non serve fare commit. Le modifiche entreranno nel progetto solo se l'utente le unisce.`
      : 'Lavori direttamente nella cartella del progetto.';
    child.enqueue(
      `${d.task}${note.trim() ? `\n\nNota di l'utente: ${note.trim()}` : ''}\n\n---\nCompito affidato dal capo (conversazione "${lead.meta.title}") tramite AgiCloud. ${where}\n` +
        'Alla fine scrivi un riepilogo breve: cosa hai fatto, file toccati, come hai verificato, cosa resta aperto.',
    );
    d.state = 'approved';
    d.childId = child.id;
    d.text =
      `l'utente ha approvato. Thread avviato: id ${child.id}, agente ${agentLabel(d.agentId)}, ` +
      (wt ? `copia separata sul ramo ${wt.info.branch}.` : 'nella cartella del progetto (non e\' un repo git con commit: nessuna copia separata).') +
      ` Riceverai un messaggio automatico quando finisce.${nota}`;
    lead.record('delegation_update', { id: d.id, state: d.state, childId: child.id, note: note.trim() || undefined });
    return { childId: child.id };
  }

  /** Thread affidato: modifiche nella sua copia */
  async changes(thread: Thread) {
    if (!thread.meta.worktree) return { files: [], patch: '', truncated: false, worktree: null };
    const c = await worktreeChanges(thread.meta.worktree);
    return { ...c, worktree: { branch: thread.meta.worktree.branch, state: thread.meta.worktree.state } };
  }

  async merge(thread: Thread): Promise<string> {
    const wt = thread.meta.worktree;
    if (!wt) throw new HttpError(400, 'Questo thread non ha una copia separata');
    if (thread.status === 'running') throw new HttpError(409, 'L\'agente sta ancora lavorando: aspetta che finisca');
    await thread.sleep(); // la cartella della copia sparisce: l'agente non deve restarci dentro
    const commit = await mergeWorktree(wt, thread.meta.title);
    thread.saveMeta();
    thread.record('worktree', { state: 'merged', commit });
    const lead = thread.meta.parentId ? this.store.find(thread.meta.parentId) : undefined;
    lead?.record('child_merged', { childId: thread.id, title: thread.meta.title, commit });
    return commit;
  }

  async discard(thread: Thread): Promise<void> {
    const wt = thread.meta.worktree;
    if (!wt || wt.state !== 'open') return;
    if (thread.status === 'running') throw new HttpError(409, 'L\'agente sta ancora lavorando: interrompilo prima');
    await thread.sleep();
    await discardWorktree(wt);
    thread.saveMeta();
    thread.record('worktree', { state: 'discarded' });
  }

  /** API usata da lead-mcp.ts (fuori da /api: si entra solo con il token della conversazione capo) */
  register(app: Hono<any>): void {
    app.use('/lead-api/*', async (c, next) => {
      const leadId = this.tokens.get(c.req.header('x-lead-token') ?? '');
      const lead = leadId ? this.store.find(leadId) : undefined;
      if (!lead) return c.json({ error: 'Token del capo non valido' }, 401);
      c.set('lead', lead);
      return next();
    });

    app.get('/lead-api/info', async (c) => c.json({ instructions: await this.instructions(c.get('lead') as Thread) }));

    app.post('/lead-api/delegate', async (c) => {
      const lead = c.get('lead') as Thread;
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const agentId = String(body.agente ?? '').trim();
      const title = String(body.titolo ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const task = String(body.compito ?? '').trim();
      const reason = String(body.motivo ?? '').trim().slice(0, 500);
      if (!AGENTS[agentId] || (agentId === 'demo' && process.env.AGICLOUD_DEMO_AGENT !== '1')) {
        throw new HttpError(400, `Agente sconosciuto: "${agentId}". Disponibili: ${chatAgents().join(', ')}`);
      }
      if (!title || !task) throw new HttpError(400, 'Servono titolo e compito');
      if (task.length > MAX_TASK) throw new HttpError(400, `Compito troppo lungo (max ${MAX_TASK} caratteri): riassumi e indica i file da leggere`);
      if ([...this.delegations.values()].some((d) => d.leadId === lead.id && d.state === 'pending' && !this.expire(d))) {
        throw new HttpError(409, 'C\'e\' gia\' una proposta in attesa di l'utente: aspetta la sua risposta');
      }
      const open = this.store.children(lead.id).filter((t) => t.childState() === 'running' || t.childState() === 'waiting').length;
      if (open >= MAX_OPEN_CHILDREN) throw new HttpError(409, `Troppi thread al lavoro (${open}): aspetta che qualcuno finisca`);
      const d: Delegation = { id: randomUUID(), leadId: lead.id, agentId, title, task, reason, state: 'pending', createdAt: Date.now(), text: '' };
      this.delegations.set(d.id, d);
      lead.record('delegation', { id: d.id, agentId, agentLabel: agentLabel(agentId), title, task, reason, state: 'pending' });
      void this.store.onNotify?.({
        title: `Il capo chiede · ${lead.meta.title}`.slice(0, 80),
        body: `Affidare "${title}" a ${agentLabel(agentId)}?`,
        url: `/#/t/${lead.id}`,
        tag: `deleg-${d.id}`,
      });
      return c.json({ id: d.id });
    });

    app.get('/lead-api/delegations/:id', (c) => {
      const d = this.delegations.get(c.req.param('id'));
      if (!d || d.leadId !== (c.get('lead') as Thread).id) throw new HttpError(404, 'Proposta non trovata');
      this.expire(d);
      return c.json({ state: d.state, text: d.text });
    });

    app.get('/lead-api/threads', async (c) => {
      const lead = c.get('lead') as Thread;
      const kids = this.store.children(lead.id);
      if (!kids.length) return c.json({ text: 'Nessun thread affidato finora.' });
      const lines = await Promise.all(kids.map(async (t) => `- ${t.id} · "${t.meta.title}" · ${agentLabel(t.meta.agentId)} · ${STATE_TEXT[t.childState()]} · ${await this.changesLine(t)}`));
      return c.json({ text: lines.join('\n') });
    });

    app.get('/lead-api/threads/:id', async (c) => {
      const t = this.child(c.get('lead') as Thread, c.req.param('id'));
      const ch = await this.changes(t);
      const reply = t.lastReply();
      let text =
        `Thread "${t.meta.title}" (${agentLabel(t.meta.agentId)}) · stato: ${STATE_TEXT[t.childState()]}\n` +
        `Copia: ${t.meta.worktree ? `ramo ${t.meta.worktree.branch} (${WT_TEXT[t.meta.worktree.state]})` : 'nessuna (cartella del progetto)'}\n` +
        `Modifiche: ${ch.files.length ? ch.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ') : 'nessuna'}\n\n` +
        `Ultima risposta dell'agente:\n${reply ? reply.slice(-8000) : '(nessuna)'}`;
      if (c.req.query('diff') && ch.patch) text += `\n\nDiff:\n${ch.patch.slice(0, 30_000)}${ch.patch.length > 30_000 || ch.truncated ? '\n[...diff troncato]' : ''}`;
      return c.json({ text });
    });

    app.post('/lead-api/threads/:id/message', async (c) => {
      const t = this.child(c.get('lead') as Thread, c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const msg = String(body.messaggio ?? '').trim();
      if (!msg) throw new HttpError(400, 'Messaggio vuoto');
      if (t.meta.worktree && t.meta.worktree.state !== 'open') throw new HttpError(409, 'Thread chiuso: le sue modifiche sono gia\' state unite o scartate');
      const busy = t.childState() === 'running' || t.childState() === 'waiting';
      t.enqueue(`[Dal capo] ${msg.slice(0, MAX_TASK)}`);
      return c.json({ text: busy ? 'Messaggio in coda: partira\' quando l\'agente finisce il turno attuale.' : 'Messaggio inviato: il thread riparte.' });
    });
  }

  private child(lead: Thread, id: string): Thread {
    const t = this.store.find(id);
    if (!t || t.meta.parentId !== lead.id) throw new HttpError(404, `Nessun thread affidato con id ${id}`);
    return t;
  }

  private async changesLine(t: Thread): Promise<string> {
    if (!t.meta.worktree) return 'cartella del progetto';
    if (t.meta.worktree.state !== 'open') return WT_TEXT[t.meta.worktree.state];
    const ch = await worktreeChanges(t.meta.worktree).catch(() => null);
    if (!ch) return 'modifiche non leggibili';
    return ch.files.length ? `${ch.files.length} file modificati` : 'nessuna modifica';
  }

  /** true se la proposta e' (ormai) scaduta */
  private expire(d: Delegation): boolean {
    if (d.state === 'pending' && Date.now() - d.createdAt > DELEGATION_TTL_MS) {
      d.state = 'expired';
      d.text = 'l'utente non ha risposto alla proposta entro 30 minuti: chiedigli in chat se vuole procedere.';
      this.store.find(d.leadId)?.record('delegation_update', { id: d.id, state: d.state });
    }
    return d.state === 'expired';
  }

  private async instructions(lead: Thread): Promise<string> {
    const agents = (await this.settings.agents()).filter((a) => a.chat && a.installed && chatAgents().includes(a.id));
    const git = await repoRoot(lead.meta.cwd);
    return [
      'Sei il "capo" di questo progetto in AgiCloud: l'utente (che spesso usa il telefono) parla con te, e tu puoi affidare compiti ad altri agenti con lo strumento delega.',
      'Regole:',
      '- Ogni delega la approva l'utente: proponila con un motivo chiaro. Se rifiuta, continua da solo o chiedigli come preferisce.',
      '- Delega solo compiti separabili e autonomi (una funzione, dei test, una ricerca nel codice, una revisione). Il compito deve essere completo: l\'altro agente non vede questa conversazione.',
      '- Scegli l\'agente adatto: agenti con piano gratuito (Cursor, agy, OpenCode) per compiti semplici o ripetitivi, cosi\' si risparmia l\'abbonamento Claude.',
      git
        ? '- Ogni thread lavora in una copia separata del progetto (git worktree, ramo proprio) partita dall\'ultimo commit: le modifiche non salvate nel progetto non ci sono. Le sue modifiche entrano nel progetto solo se l'utente sceglie "Unisci".'
        : '- Il progetto non e\' un repo git: i thread lavorano nella stessa cartella. Evita di affidare compiti che toccano gli stessi file in contemporanea.',
      '- Quando un thread finisce ricevi un messaggio automatico di AgiCloud: leggi il risultato con leggi_thread, riassumi a l'utente in poche righe e proponi i passi successivi. Non unire tu le modifiche.',
      '- Puoi correggere o guidare un thread con scrivi_thread, e vedere tutti i thread con stato_thread.',
      '',
      `Progetto: ${lead.meta.cwd}${git ? ` (repo git in ${git})` : ''}`,
      'Agenti disponibili (id: nome · login):',
      ...agents.map((a) => `- ${a.id}: ${a.label} · ${a.login.state === 'ok' ? 'collegato' : 'NON collegato'}${a.note ? ` · ${a.note}` : ''}`),
    ].join('\n');
  }
}

const STATE_TEXT = { running: 'in corso', waiting: 'aspetta l'utente (permesso)', done: 'finito', error: 'errore', idle: 'fermo' } as const;
const WT_TEXT = { open: 'aperta', merged: 'unita nel progetto', discarded: 'scartata' } as const;

function chatAgents(): string[] {
  return Object.keys(AGENTS).filter((id) => id !== 'demo' || process.env.AGICLOUD_DEMO_AGENT === '1');
}

function agentLabel(id: string): string {
  try {
    return getAgent(id).label;
  } catch {
    return id;
  }
}

function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'thread'
  );
}
