import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AgentInfo } from './api';
import { ProjectPicker } from './ProjectPicker';

interface Props {
  open: boolean;
  agents: AgentInfo[];
  error?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (agentId: string, cwd: string, lead: boolean) => void;
}

const LAST_AGENT_KEY = 'agicloud_last_agent';

function lastAgent(): string {
  try {
    return localStorage.getItem(LAST_AGENT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Dialogo nativo: trappola del focus, Esc e ritorno del focus li gestisce il browser */
export function NewThreadDialog({ open, agents, error, busy, onClose, onCreate }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [agentId, setAgentId] = useState('');
  const [cwd, setCwd] = useState('');
  const [lead, setLead] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (agentId || !agents.length) return;
    const last = lastAgent();
    setAgentId(agents.some((a) => a.id === last) ? last : (agents.find((a) => a.id === 'claude') ?? agents[0]!).id);
  }, [agents, agentId]);

  const selected = agents.find((a) => a.id === agentId);
  /** Per ora il capo e' solo Claude Code: gli strumenti MCP e i permessi preautorizzati sono suoi */
  const canLead = agentId === 'claude';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!agentId || !cwd.trim()) return;
    try {
      localStorage.setItem(LAST_AGENT_KEY, agentId);
    } catch {
      /* solo una comodita' */
    }
    onCreate(agentId, cwd.trim(), canLead && lead);
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${id}-title`}>Nuova conversazione</h2>

        <fieldset>
          <legend>Agente</legend>
          <div className="agent-options">
            {agents.map((a) => (
              <label key={a.id} className="agent-option">
                <input
                  type="radio"
                  name="agent"
                  value={a.id}
                  checked={agentId === a.id}
                  onChange={() => setAgentId(a.id)}
                />
                <span>{a.label}</span>
              </label>
            ))}
          </div>
          {selected?.note && <p className="hint">{selected.note}</p>}
        </fieldset>

        {canLead && (
          <label className="choice lead-choice">
            <input type="checkbox" checked={lead} onChange={(e) => setLead(e.target.checked)} aria-describedby={`${id}-lead-hint`} />
            <span className="choice-text">
              <span>Conversazione capo</span>
              <span className="hint" id={`${id}-lead-hint`}>
                Puo' proporti di affidare compiti ad altri agenti, ognuno in una copia separata del progetto. Approvi tu ogni delega.
              </span>
            </span>
          </label>
        )}

        <ProjectPicker active={open} cwd={cwd} onChange={setCwd} />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className="btn primary" disabled={busy || !agentId || !cwd.trim()}>
            {busy ? 'Avvio…' : 'Inizia'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
