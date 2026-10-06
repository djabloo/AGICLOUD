import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, type AgentInfo, type DirListing } from './api';

interface Props {
  open: boolean;
  agents: AgentInfo[];
  error?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (agentId: string, cwd: string) => void;
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
  const [recent, setRecent] = useState<string[]>([]);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [browseError, setBrowseError] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      api
        .projects()
        .then((p) => {
          setRecent(p.recent);
          setCwd((c) => c || p.recent[0] || '');
        })
        .catch(() => {});
      void browse(undefined);
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (agentId || !agents.length) return;
    const last = lastAgent();
    setAgentId(agents.some((a) => a.id === last) ? last : (agents.find((a) => a.id === 'claude') ?? agents[0]!).id);
  }, [agents, agentId]);

  const browse = async (path: string | undefined) => {
    setBrowseError('');
    try {
      setListing(await api.dirs(path));
      if (path) setCwd(path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  };

  const selected = agents.find((a) => a.id === agentId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!agentId || !cwd.trim()) return;
    try {
      localStorage.setItem(LAST_AGENT_KEY, agentId);
    } catch {
      /* solo una comodita' */
    }
    onCreate(agentId, cwd.trim());
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

        <label htmlFor={`${id}-cwd`}>Cartella del progetto</label>
        <input
          id={`${id}-cwd`}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/opt/progetto"
          autoComplete="off"
          spellCheck={false}
          className="mono-input"
          required
        />

        {recent.length > 0 && (
          <div className="recent">
            <h3 className="mini-title" id={`${id}-recent`}>
              Recenti
            </h3>
            <ul className="chips" aria-labelledby={`${id}-recent`}>
              {recent.map((r) => (
                <li key={r}>
                  <button type="button" className="chip" aria-pressed={cwd === r} onClick={() => setCwd(r)} title={r}>
                    {r.split('/').filter(Boolean).pop() ?? r}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="browser">
          <div className="browser-head">
            <h3 className="mini-title" id={`${id}-browse`}>
              Sfoglia
            </h3>
            <span className="browser-path" title={listing?.path ?? undefined}>
              {listing?.path ? shortPath(listing.path) : 'Radici consentite'}
            </span>
          </div>
          <ul className="dir-list" aria-labelledby={`${id}-browse`}>
            {listing?.path && (
              <li>
                <button type="button" className="dir-btn" onClick={() => void browse(listing.parent ?? undefined)}>
                  <span aria-hidden="true">↑</span> {listing.parent ? 'Cartella superiore' : 'Radici consentite'}
                </button>
              </li>
            )}
            {listing?.dirs.map((d) => (
              <li key={d.path}>
                <button type="button" className="dir-btn" onClick={() => void browse(d.path)}>
                  <span aria-hidden="true">📁</span> {d.name}
                  {d.git && <span className="git-badge">git</span>}
                </button>
              </li>
            ))}
            {listing && listing.dirs.length === 0 && <li className="hint">Nessuna sottocartella</li>}
          </ul>
          {browseError && (
            <p className="form-error" role="alert">
              {browseError}
            </p>
          )}
        </div>

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

/** Percorsi lunghi: si tiene la parte finale, la piu' utile */
function shortPath(p: string, max = 48): string {
  return p.length > max ? `…${p.slice(-(max - 1))}` : p;
}
