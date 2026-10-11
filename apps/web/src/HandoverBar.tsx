// Capo di riserva: avvisi sul limite di Claude e passaggio di consegne a un altro agente.
import { useEffect, useId, useState } from 'react';
import { api, type AgentInfo, type ClaudeLimit, type ThreadSummary } from './api';
import { getLang, t, useT } from './i18n';

function when(ms: number | null): string {
  if (!ms) return '';
  const loc = getLang();
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const ora = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return t('handoverbar.alleOre', { ora });
  const giorno = d.toLocaleDateString(loc, { weekday: 'long' });
  return t('handoverbar.giornoOre', { giorno, ora });
}

function typeText(ty: string): string {
  if (ty === 'five_hour') return t('handoverbar.tipoCinqueOre');
  if (ty === 'seven_day') return t('handoverbar.tipoSettimanale');
  if (ty === 'seven_day_opus') return t('handoverbar.tipoOpus');
  if (ty === 'seven_day_sonnet') return t('handoverbar.tipoSonnet');
  return '';
}

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
  useT();
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
        {t('handoverbar.passatoA')} <a href={`#/t/${thread.handedOverTo}`}>{to?.title ?? t('handoverbar.altraConversazione')}</a>.
      </div>
    );
  }

  const origin = thread.handoverFrom ? threads.find((t) => t.id === thread.handoverFrom) : undefined;
  const claudeBack = origin?.agentId === 'claude' && limit && !limit.blocked;
  // demo: solo per le prove, imita Claude
  const isClaude = thread.agentId === 'claude' || thread.agentId === 'demo';
  const showLimit = isClaude && limit?.warning;
  if (!manual && !showLimit && !claudeBack) return null;

  const typeText_ = limit?.type ? typeText(limit.type) : '';
  return (
    <section className={`handover-bar${limit?.blocked && isClaude ? ' is-blocked' : ''}`} aria-labelledby={`${id}-t`}>
      <p id={`${id}-t`} className="handover-title">
        {claudeBack && !manual
          ? t('handoverbar.claudeDiNuovo')
          : showLimit && limit
            ? limit.blocked
              ? t('handoverbar.limiteFinito', { tipo: typeText_, azzeramento: limit.resetsAt ? t('handoverbar.azzeramento', { quando: when(limit.resetsAt) }) : '' })
              : t('handoverbar.limiteQuasi', { perc: Math.round((limit.utilization ?? 0.9) * 100), tipo: typeText_, azzeramento: limit.resetsAt ? t('handoverbar.azzeramentoParentesi', { quando: when(limit.resetsAt) }) : '' })
            : t('handoverbar.passaSpiegazione')}
      </p>
      <div className="agent-actions">
        {claudeBack && !manual ? (
          <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => void go('claude')}>
            {t('handoverbar.ripassaClaude')}
          </button>
        ) : (
          <>
            <label htmlFor={`${id}-to`} className="visually-hidden">
              {t('handoverbar.agenteDestinatario')}
            </label>
            <select id={`${id}-to`} value={target} onChange={(e) => setTarget(e.target.value)}>
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn small-btn primary" disabled={busy || !target} onClick={() => void go(target)}>
              {busy ? t('handoverbar.passaggio') : t('handoverbar.passaLavoro')}
            </button>
          </>
        )}
        {manual && (
          <button type="button" className="btn small-btn" onClick={onManualClose}>
            {t('handoverbar.annulla')}
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
