import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, getToken, setToken, type AgentInfo, type ThreadSummary } from './api';
import { Chat } from './Chat';
import { Login } from './Login';
import { NewThreadDialog } from './NewThread';
import { Icon, type IconName } from './icons';

type Auth = 'checking' | 'ok' | 'needed';

const SECTIONS: { id: string; label: string; icon: IconName; ready: boolean }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', ready: true },
  { id: 'files', label: 'File', icon: 'files', ready: false },
  { id: 'terminal', label: 'Terminale', icon: 'terminal', ready: false },
];

function threadFromHash(): string | null {
  const m = location.hash.match(/^#\/t\/([\w-]+)$/);
  return m ? m[1]! : null;
}

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [authError, setAuthError] = useState<string>();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(threadFromHash);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([api.agents(), api.threads()]);
      setAgents(a);
      setThreads(t);
      setAuth('ok');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuth('needed');
        if (getToken()) setAuthError('Token non valido');
      } else if (err instanceof ApiError && err.status === 429) {
        setAuth('needed');
        setAuthError(err.message);
      } else {
        setAuth((s) => (s === 'checking' ? 'needed' : s));
        setAuthError('Server non raggiungibile');
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Titoli e stati delle conversazioni cambiano lato server: aggiornamento leggero
  useEffect(() => {
    if (auth !== 'ok') return;
    const t = setInterval(() => api.threads().then(setThreads).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [auth]);

  useEffect(() => {
    const onHash = () => setActiveId(threadFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Drawer mobile: Esc chiude e il focus torna al pulsante del menu
  useEffect(() => {
    if (!drawerOpen) return;
    drawer.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  };

  const select = (id: string | null) => {
    location.hash = id ? `#/t/${id}` : '';
    setActiveId(id);
    setDrawerOpen(false);
  };

  const create = async (agentId: string, cwd: string) => {
    setCreating(true);
    setDialogError(undefined);
    try {
      const t = await api.createThread(agentId, cwd);
      setThreads((ts) => [t, ...ts]);
      setDialogOpen(false);
      select(t.id);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    await api.deleteThread(id).catch(() => {});
    setThreads((ts) => ts.filter((t) => t.id !== id));
    if (activeId === id) select(null);
  };

  if (auth === 'checking') return <p className="boot">Caricamento…</p>;
  if (auth === 'needed') {
    return (
      <Login
        error={authError}
        onSubmit={(token) => {
          setToken(token);
          setAuthError(undefined);
          void refresh();
        }}
      />
    );
  }

  const active = threads.find((t) => t.id === activeId) ?? null;
  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;

  return (
    <div className={`app${drawerOpen ? ' drawer-open' : ''}`}>
      <a className="skip-link" href="#main">
        Vai al contenuto
      </a>

      <header className="topbar">
        <button
          ref={menuButton}
          type="button"
          className="btn icon-btn menu-btn"
          aria-expanded={drawerOpen}
          aria-controls="sidebar"
          onClick={() => setDrawerOpen((o) => !o)}
        >
          <Icon name={drawerOpen ? 'close' : 'menu'} />
          <span className="visually-hidden">{drawerOpen ? 'Chiudi menu' : 'Apri menu'}</span>
        </button>
        <span className="brand">AgiCloud</span>
        <button type="button" className="btn icon-btn" onClick={() => setDialogOpen(true)}>
          <Icon name="plus" />
          <span className="visually-hidden">Nuova conversazione</span>
        </button>
      </header>

      <aside id="sidebar" ref={drawer} className="sidebar" aria-label="Navigazione">
        <div className="sidebar-head">
          <span className="sidebar-brand">AgiCloud</span>
          <button type="button" className="btn icon-btn drawer-close" onClick={closeDrawer}>
            <Icon name="close" />
            <span className="visually-hidden">Chiudi menu</span>
          </button>
        </div>

        <nav aria-label="Sezioni">
          <ul className="sections">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="section-btn"
                  aria-current={s.id === 'chat' ? 'page' : undefined}
                  aria-disabled={!s.ready || undefined}
                  onClick={() => s.ready && select(null)}
                >
                  <Icon name={s.icon} />
                  <span>{s.label}</span>
                  {!s.ready && <span className="soon">in arrivo</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <button type="button" className="btn primary new-btn" onClick={() => setDialogOpen(true)}>
          <Icon name="plus" />
          <span>Nuova conversazione</span>
        </button>

        <h2 className="sidebar-title" id="threads-title">
          Conversazioni
        </h2>
        {threads.length === 0 ? (
          <p className="sidebar-empty">Nessuna conversazione</p>
        ) : (
          <ul className="threads" aria-labelledby="threads-title">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="thread-btn"
                  aria-current={t.id === activeId ? 'page' : undefined}
                  onClick={() => select(t.id)}
                >
                  <span className="thread-title">{t.title}</span>
                  <span className="thread-meta">
                    {agentLabel(t.agentId)} · {t.project}
                    {t.status === 'running' && <span className="thread-running"> · al lavoro</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="backdrop" hidden={!drawerOpen} onClick={closeDrawer} />

      <main id="main" className="main" tabIndex={-1} inert={drawerOpen || undefined}>
        {active ? (
          <Chat key={active.id} thread={active} agentLabel={agentLabel(active.agentId)} onDelete={() => remove(active.id)} />
        ) : (
          <section className="welcome" aria-labelledby="welcome-title">
            <h1 id="welcome-title">Benvenuto in AgiCloud</h1>
            <p>Un'unica interfaccia per i tuoi agenti di coding. Scegli un agente e la cartella del progetto per iniziare.</p>
            <ul className="agent-list">
              {agents.map((a) => (
                <li key={a.id}>
                  <strong>{a.label}</strong>
                  {a.note && <span className="hint"> — {a.note}</span>}
                </li>
              ))}
            </ul>
            <button type="button" className="btn primary" onClick={() => setDialogOpen(true)}>
              <Icon name="plus" />
              <span>Nuova conversazione</span>
            </button>
          </section>
        )}
      </main>

      <NewThreadDialog
        open={dialogOpen}
        agents={agents}
        error={dialogError}
        busy={creating}
        onClose={() => {
          setDialogOpen(false);
          setDialogError(undefined);
        }}
        onCreate={create}
      />
    </div>
  );
}
