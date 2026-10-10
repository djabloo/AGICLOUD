// Sezione Browser: il browser condiviso e, accanto, la chat con l'agente che lo usa.
// Computer: affiancati. Telefono: si passa da "Browser" a "Chat" con un tocco.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type AgentInfo, type ThreadSummary } from './api';
import { BrowserView } from './BrowserView';
import { Chat } from './Chat';

const SELECTED_KEY = 'agicloud_browser_thread';

export function BrowserSection({
  popup = false,
  threads,
  agents,
  agentLabel,
  onCreated,
  onDelete,
  onOpenTerminal,
}: {
  popup?: boolean;
  threads: ThreadSummary[];
  agents: AgentInfo[];
  agentLabel: (id: string) => string;
  onCreated: (t: ThreadSummary) => void;
  onDelete: (id: string) => void;
  onOpenTerminal: (cwd: string) => void;
}) {
  const id = useId();
  const chats = threads.filter((t) => t.browser && !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY));
  const [pane, setPane] = useState<'browser' | 'chat'>('browser');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = chats.find((t) => t.id === selected) ?? chats[0] ?? null;

  useEffect(() => {
    if (!agentId && agents.length) setAgentId((agents.find((a) => a.id === 'claude') ?? agents[0]!).id);
  }, [agents, agentId]);

  const choose = (tid: string) => {
    setSelected(tid);
    localStorage.setItem(SELECTED_KEY, tid);
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // La chat del browser lavora nella cartella del progetto piu' recente (serve solo come base)
      const p = await api.projects();
      const cwd = p.recent[0] ?? p.roots[0];
      if (!cwd) throw new Error('Nessuna cartella di progetto disponibile');
      const t = await api.createThread(agentId, cwd, false, null, true);
      onCreated(t);
      choose(t.id);
      setPane('chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startForm = (
    <form className="browser-chat-start" onSubmit={(e) => void start(e)}>
      <h2>Chatta con un agente sul browser</h2>
      <p className="hint">L'agente vede e usa lo stesso browser: chiedigli di cercare, leggere, confrontare o compilare, e segui tutto in diretta.</p>
      <label htmlFor={`${id}-agent`}>Agente</label>
      <select id={`${id}-agent`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <button type="submit" className="btn primary" disabled={busy || !agentId}>
        {busy ? 'Avvio…' : 'Inizia la chat'}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );

  return (
    <div className={`browser-layout show-${pane}${popup ? ' is-popup' : ''}`}>
      <div className="browser-switch" role="group" aria-label="Mostra">
        <button type="button" className="btn small-btn" aria-pressed={pane === 'browser'} onClick={() => setPane('browser')}>
          Browser
        </button>
        <button type="button" className="btn small-btn" aria-pressed={pane === 'chat'} onClick={() => setPane('chat')}>
          Chat{current?.status === 'running' ? ' · al lavoro' : ''}
        </button>
      </div>

      <div className="browser-pane">
        <BrowserView popup={popup} />
      </div>

      <aside className="browser-chat" aria-label="Chat con l'agente sul browser">
        {chats.length > 0 && (
          <div className="browser-chat-pick">
            <label htmlFor={`${id}-pick`} className="visually-hidden">
              Chat del browser
            </label>
            <select id={`${id}-pick`} value={current?.id ?? ''} onChange={(e) => (e.target.value === '__new' ? setSelected('__new') : choose(e.target.value))}>
              {chats.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} · {agentLabel(t.agentId)}
                </option>
              ))}
              <option value="__new">+ Nuova chat del browser</option>
            </select>
          </div>
        )}
        {selected === '__new' || !current ? (
          startForm
        ) : (
          <Chat
            key={current.id}
            thread={current}
            threads={threads}
            agentLabel={agentLabel(current.agentId)}
            onDelete={() => {
              localStorage.removeItem(SELECTED_KEY);
              onDelete(current.id);
            }}
            onOpenTerminal={() => onOpenTerminal(current.cwd)}
          />
        )}
      </aside>
    </div>
  );
}
