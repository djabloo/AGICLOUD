// Capo e thread affidati: proposta di delega (approva/rifiuta), elenco dei thread del capo,
// e nel thread affidato la provenienza e le modifiche della sua copia (unisci/scarta).
import { useEffect, useId, useState } from 'react';
import { api, type ThreadSummary, type WorktreeChanges } from './api';
import type { Item } from './transcript';
import { childStateText } from './ThreadList';
import { DiffStat, PatchView } from './DiffView';
import { fmtNumber, t, useT } from './i18n';

type Delegation = Extract<Item, { kind: 'delegation' }>;

function delegationState(s: Delegation['state']): string {
  if (s === 'pending') return t('leadviews.statoAttesa');
  if (s === 'approved') return t('leadviews.statoApprovata');
  if (s === 'rejected') return t('leadviews.statoRifiutata');
  return t('leadviews.statoScaduta');
}

export function DelegationView({ item, threadId, threads }: { item: Delegation; threadId: string; threads: ThreadSummary[] }) {
  const t = useT();
  const id = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const child = item.childId ? threads.find((t) => t.id === item.childId) : undefined;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      await api.decideDelegation(threadId, item.id, approve, note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <section className={`delegation delegation-${item.state}`} aria-labelledby={`${id}-t`}>
      <p className="delegation-kicker">{t('leadviews.proposta')}</p>
      <h2 id={`${id}-t`} className="delegation-title">
        {item.title}
      </h2>
      <p className="delegation-agent">
        a <strong>{item.agentLabel}</strong>
        {item.reason && <> · {item.reason}</>}
      </p>
      <details className="delegation-task">
        <summary>{t('leadviews.istruzioni')}</summary>
        <p>{item.task}</p>
      </details>

      {item.state === 'pending' ? (
        <>
          <label htmlFor={`${id}-note`} className="delegation-note-label">
            {t('leadviews.notaLabel')}
          </label>
          <textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
          <div className="permission-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void decide(true)}>
              {t('leadviews.approva')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)}>
              {t('leadviews.rifiuta')}
            </button>
          </div>
        </>
      ) : (
        <p className="delegation-outcome">
          {delegationState(item.state)}
          {item.note && <> · {t('leadviews.nota', { nota: item.note })}</>}
          {child && (
            <>
              {' · '}
              <a href={`#/t/${child.id}`}>
                {t('leadviews.apriThread')}{child.childState && <> ({childStateText(child.childState)})</>}
              </a>
            </>
          )}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Nella conversazione del capo: i suoi thread con lo stato in diretta */
export function LeadChildren({ lead, threads }: { lead: ThreadSummary; threads: ThreadSummary[] }) {
  const t = useT();
  const kids = threads.filter((t) => t.parentId === lead.id && !t.archived).sort((a, b) => a.createdAt - b.createdAt);
  if (!kids.length) return null;
  const waiting = kids.filter((k) => k.pendingPermission);
  return (
    <>
    {waiting.map((k) => (
      <ChildPermission key={`${k.id}-${k.pendingPermission!.requestId}`} child={k} />
    ))}
    <nav className="lead-children" aria-label={t('leadviews.threadAffidati')}>
      <ul>
        {kids.map((k) => (
          <li key={k.id}>
            <a href={`#/t/${k.id}`} className={`child-chip child-${k.childState ?? 'idle'}`}>
              <span className="status-dot" aria-hidden="true" />
              <span className="child-chip-title">{k.title}</span>
              <span className="child-chip-state">{k.childState ? childStateText(k.childState) : ''}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
    </>
  );
}

/** Permesso chiesto da un thread affidato, con la risposta direttamente dalla chat del capo */
function ChildPermission({ child }: { child: ThreadSummary }) {
  const t = useT();
  const id = useId();
  const p = child.pendingPermission!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answer = async (optionId: string) => {
    setBusy(true);
    setError('');
    try {
      await api.respondPermission(child.id, p.requestId, optionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="permission child-permission" role="group" aria-labelledby={`${id}-t`}>
      <p id={`${id}-t`} className="permission-title">
        <span>
          {t('leadviews.threadParola')} <a href={`#/t/${child.id}`}>{child.title}</a> {t('leadviews.permessoAttesa')}: <strong>{p.title}</strong>
        </span>
      </p>
      <div className="permission-actions">
        {p.options.map((o) => (
          <button key={o.optionId} type="button" className={`btn ${o.kind.startsWith('allow') ? 'primary' : ''}`} disabled={busy} onClick={() => void answer(o.optionId)}>
            {o.name}
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Nel thread affidato: da quale capo arriva e cosa ha cambiato nella sua copia */
export function ChildPanel({ thread, threads, running }: { thread: ThreadSummary; threads: ThreadSummary[]; running: boolean }) {
  const t = useT();
  const id = useId();
  const lead = threads.find((t) => t.id === thread.parentId);
  const [changes, setChanges] = useState<WorktreeChanges | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const wtOpen = thread.worktree?.state === 'open';

  // Le modifiche si rileggono quando l'agente finisce un turno o si apre il pannello
  useEffect(() => {
    if (!thread.worktree || running) return;
    api.threadChanges(thread.id).then(setChanges).catch(() => {});
  }, [thread.id, thread.worktree?.state, running, open]);

  const act = async (kind: 'merge' | 'discard') => {
    if (kind === 'discard' && !confirm(t('leadviews.scartaConferma'))) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'merge') {
        const r = await api.mergeThread(thread.id);
        setMessage(t('leadviews.uniteCommit', { commit: r.commit }));
      } else {
        await api.discardThread(thread.id);
        setMessage(t('leadviews.scartateMsg'));
      }
      setChanges(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const added = changes?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = changes?.files.reduce((n, f) => n + f.removed, 0) ?? 0;
  const nFiles = changes?.files.length ?? 0;

  return (
    <div className="child-panel">
      <p className="child-origin">
        {t('leadviews.affidatoDa')} {lead ? <a href={`#/t/${lead.id}`}>{lead.title}</a> : t('leadviews.conversazioneChiusa')}
        {thread.worktree && (
          <>
            {' · '}{t('leadviews.copiaSeparata')} <code>{thread.worktree.branch}</code>
            {thread.worktree.state !== 'open' && <> ({thread.worktree.state === 'merged' ? t('leadviews.unita') : t('leadviews.scartata')})</>}
          </>
        )}
      </p>
      {wtOpen && (
        <div className="child-changes">
          <button type="button" className="btn small-btn" aria-expanded={open} aria-controls={`${id}-diff`} onClick={() => setOpen((v) => !v)}>
            <span>{nFiles ? t('leadviews.modifiche', { n: fmtNumber(nFiles) }) : t('leadviews.nessunaModifica')}</span>
            {nFiles > 0 && <DiffStat added={added} removed={removed} />}
          </button>
          <button type="button" className="btn small-btn primary" disabled={busy || running || !nFiles} onClick={() => void act('merge')}>
            {t('leadviews.unisci')}
          </button>
          <button type="button" className="btn small-btn" disabled={busy || running} onClick={() => void act('discard')}>
            {t('leadviews.scarta')}
          </button>
          {running && <span className="hint">{t('leadviews.disponibileFinito')}</span>}
        </div>
      )}
      <div id={`${id}-diff`} hidden={!open || !wtOpen}>
        {changes?.patch ? (
          <PatchView patch={changes.patch} />
        ) : (
          <p className="hint">{t('leadviews.nessunaModificaProgetto')}</p>
        )}
        {changes?.truncated && <p className="hint">{t('leadviews.diffGrande')}</p>}
      </div>
      {thread.worktree && thread.worktree.state !== 'open' && (
        <p className="hint">{t('leadviews.threadConcluso')}</p>
      )}
      <div aria-live="polite" className="child-message">
        {message}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
