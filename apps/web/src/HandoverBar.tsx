// Capo di riserva: avvisi sul limite di Claude e passaggio di consegne a un altro agente.
import { useEffect, useId, useState } from 'react';
import { api, type AgentInfo, type ClaudeLimit, type ThreadSummary } from './api';

function when(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString('it-IT', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}

const TYPE_TEXT: Record<string, string> = {
  five_hour: 'delle 5 ore',
  seven_day: 'settimanale',
  seven_day_opus: 'settimanale di Opus',
  seven_day_sonnet: 'settimanale di Sonnet',
};

export function HandoverBar({
  thread,
  threads,
  manual,
  onManualClose,
  onMoved,
}: {
  thread: ThreadSummary;
  threads: ThreadSummary[];
  /** Aperto dal pulsante nell'intestazione */
  manual: boolean;
  onManualClose: () => void;
  onMoved: (t: ThreadSummary) => void;
}) {
  const id = useId();
  const [limit, setLimit] = useState<ClaudeLimit | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    const load = () => api.limits().then((l) => !stop && setLimit(l.claude)).catch(() => {});
    load();
    const t = window.setInterval(load, 30_000);
    api.agents().then((a) => !stop && setAgents(a)).catch(() => {});
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [thread.id]);

  const others = agents.filter((a) => a.id !== thread.agentId);
  useEffect(() => {
    if (!target && others.length) setTarget((others.find((a) => a.id === 'agy') ?? others.find((a) => a.id !== 'demo') ?? others[0]!).id);
  }, [others.length]);

  const go = async (agentId: string) => {
    setBusy(true);
    setError('');
    try {
      const to = await api.handover(thread.id, agentId);
      onManualClose();
      onMoved(to);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Lavoro gia' passato: solo il collegamento
  if (thread.handedOverTo) {
    const to = threads.find((t) => t.id === thread.handedOverTo);
    return (
      <div className="handover-bar is-done" role="status">
        Il lavoro e' passato a <a href={`#/t/${thread.handedOverTo}`}>{to?.title ?? 'un\'altra conversazione'}</a>.
      </div>
    );
  }

  const origin = thread.handoverFrom ? threads.find((t) => t.id === thread.handoverFrom) : undefined;
  const claudeBack = origin?.agentId === 'claude' && limit && !limit.blocked;
  // demo: solo per le prove, imita Claude
  const isClaude = thread.agentId === 'claude' || thread.agentId === 'demo';
  const showLimit = isClaude && limit?.warning;
  if (!manual && !showLimit && !claudeBack) return null;

  const typeText = limit?.type ? (TYPE_TEXT[limit.type] ?? '') : '';
  return (
    <section className={`handover-bar${limit?.blocked && isClaude ? ' is-blocked' : ''}`} aria-labelledby={`${id}-t`}>
      <p id={`${id}-t`} className="handover-title">
        {claudeBack && !manual
          ? 'Claude e\' di nuovo disponibile: puoi ripassargli il lavoro, ricorda tutto quello che aveva fatto.'
          : showLimit && limit
            ? limit.blocked
              ? `Claude ha finito il limite ${typeText}${limit.resetsAt ? `: si azzera ${when(limit.resetsAt)}` : ''}. Puoi passare il lavoro a un altro agente.`
              : `Claude e' al ${Math.round((limit.utilization ?? 0.9) * 100)}% del limite ${typeText}${limit.resetsAt ? ` (si azzera ${when(limit.resetsAt)})` : ''}.`
            : 'Passa questo lavoro a un altro agente: riceve un riassunto della conversazione e i thread affidati.'}
      </p>
      <div className="agent-actions">
        {claudeBack && !manual ? (
          <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => void go('claude')}>
            Ripassa a Claude
          </button>
        ) : (
          <>
            <label htmlFor={`${id}-to`} className="visually-hidden">
              Agente a cui passare il lavoro
            </label>
            <select id={`${id}-to`} value={target} onChange={(e) => setTarget(e.target.value)}>
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn small-btn primary" disabled={busy || !target} onClick={() => void go(target)}>
              {busy ? 'Passaggio…' : 'Passa il lavoro'}
            </button>
          </>
        )}
        {manual && (
          <button type="button" className="btn small-btn" onClick={onManualClose}>
            Annulla
          </button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
