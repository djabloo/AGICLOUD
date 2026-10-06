import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AgentInfo } from './api';

interface Props {
  open: boolean;
  agents: AgentInfo[];
  workspaces: string[];
  error?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (agentId: string, workspace: string) => void;
}

/** Dialogo nativo: trappola del focus, Esc e ritorno del focus li gestisce il browser */
export function NewThreadDialog({ open, agents, workspaces, error, busy, onClose, onCreate }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [agentId, setAgentId] = useState('');
  const [workspace, setWorkspace] = useState('default');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agents, agentId]);

  const selected = agents.find((a) => a.id === agentId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (agentId && workspace.trim()) onCreate(agentId, workspace.trim());
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

        <label htmlFor={`${id}-ws`}>Workspace</label>
        <input
          id={`${id}-ws`}
          list={`${id}-ws-list`}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
          aria-describedby={`${id}-ws-hint`}
          required
        />
        <datalist id={`${id}-ws-list`}>
          {workspaces.map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>
        <p id={`${id}-ws-hint`} className="hint">
          Cartella di lavoro condivisa: agenti diversi possono lavorare nello stesso workspace. Lettere, numeri, punto,
          trattino e trattino basso.
        </p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className="btn primary" disabled={busy || !agentId}>
            {busy ? 'Avvio…' : 'Inizia'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
