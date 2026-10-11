// Sezione Browser: il browser condiviso e, accanto, la chat con l'agente che lo usa.
// Computer: affiancati. Telefono: si passa da "Browser" a "Chat" con un tocco.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type AgentInfo, type ThreadSummary } from './api';
import { BrowserView } from './BrowserView';
import { useT } from './i18n';
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
  const t = useT();
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
      if (!cwd) throw new Error(t('browsersection.nessunaCartella'));
      const th = await api.createThread(agentId, cwd, false, null, true);
      onCreated(th);
      choose(th.id);
      setPane('chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startForm = (
    <form className="browser-chat-start" onSubmit={(e) => void start(e)}>
      <h2>{t('browsersection.chattaTitolo')}</h2>
      <p className="hint">{t('browsersection.chattaHint')}</p>
      <label htmlFor={`${id}-agent`}>{t('browsersection.agente')}</label>
      <select id={`${id}-agent`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <button type="submit" className="btn primary" disabled={busy || !agentId}>
        {busy ? t('browsersection.avvio') : t('browsersection.inizia')}
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
      <div className="browser-switch" role="group" aria-label={t('browsersection.mostra')}>
        <button type="button" className="btn small-btn" aria-pressed={pane === 'browser'} onClick={() => setPane('browser')}>
          {t('browsersection.pannelloBrowser')}
        </button>
        <button type="button" className="btn small-btn" aria-pressed={pane === 'chat'} onClick={() => setPane('chat')}>
          {current?.status === 'running' ? t('browsersection.pannelloChatLavoro') : t('browsersection.pannelloChat')}
        </button>
      </div>

      <div className="browser-pane">
        <BrowserView popup={popup} />
      </div>

      <aside className="browser-chat" aria-label={t('browsersection.chatLabel')}>
        {chats.length > 0 && (
          <div className="browser-chat-pick">
            <label htmlFor={`${id}-pick`} className="visually-hidden">
              {t('browsersection.chatDelBrowser')}
            </label>
            <select id={`${id}-pick`} value={current?.id ?? ''} onChange={(e) => (e.target.value === '__new' ? setSelected('__new') : choose(e.target.value))}>
              {chats.map((th) => (
                <option key={th.id} value={th.id}>
                  {t('browsersection.chatOpzione', { title: th.title, agent: agentLabel(th.agentId) })}
                </option>
              ))}
              <option value="__new">{t('browsersection.nuovaChat')}</option>
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
