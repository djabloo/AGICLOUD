import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, getToken, setToken, type AgentInfo, type TerminalSummary, type ThreadSummary } from './api';
import { Chat } from './Chat';
import { Login } from './Login';
import { NewThreadDialog } from './NewThread';
import { NewTerminalDialog } from './NewTerminal';
import { TerminalView } from './TerminalView';
import { SettingsView } from './SettingsView';
import { ThreadList } from './ThreadList';
import { FilesView } from './FilesView';
import { Icon, type IconName } from './icons';

type Auth = 'checking' | 'ok' | 'needed';
type Section = 'chat' | 'terminal' | 'files' | 'settings';

interface Route {
  section: Section;
  id: string | null;
}

const SECTIONS: { id: Section; label: string; icon: IconName; ready: boolean }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', ready: true },
  { id: 'terminal', label: 'Terminale', icon: 'terminal', ready: true },
  { id: 'files', label: 'File', icon: 'files', ready: true },
  { id: 'settings', label: 'Impostazioni', icon: 'settings', ready: true },
];

/** #/t/<id> = conversazione, #/term = terminali, #/term/<id> = un terminale */
function routeFromHash(): Route {
  const t = location.hash.match(/^#\/t\/([\w-]+)$/);
  if (t) return { section: 'chat', id: t[1]! };
  const term = location.hash.match(/^#\/term(?:\/([\w-]+))?$/);
  if (term) return { section: 'terminal', id: term[1] ?? null };
  const settings = location.hash.match(/^#\/settings(?:\/([\w-]+))?$/);
  if (settings) return { section: 'settings', id: settings[1] ?? null };
  const files = location.hash.match(/^#\/files(?:\/(.+))?$/);
  if (files) return { section: 'files', id: files[1] ? decodeURIComponent(files[1]) : null };
  return { section: 'chat', id: null };
}

function hashFor(r: Route): string {
  if (r.section === 'terminal') return r.id ? `#/term/${r.id}` : '#/term';
  if (r.section === 'settings') return r.id ? `#/settings/${r.id}` : '#/settings';
  if (r.section === 'files') return r.id ? `#/files/${encodeURIComponent(r.id)}` : '#/files';
  return r.id ? `#/t/${r.id}` : '';
}

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [authError, setAuthError] = useState<string>();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<'thread' | 'terminal' | null>(null);
  const [terminalCwd, setTerminalCwd] = useState<string>();
  const [dialogError, setDialogError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t, term] = await Promise.all([api.agents(), api.threads(), api.terminals()]);
      setAgents(a);
      setThreads(t);
      setTerminals(term);
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

  // Titoli e stati cambiano lato server: aggiornamento leggero
  useEffect(() => {
    if (auth !== 'ok') return;
    const t = setInterval(() => {
      api.threads().then(setThreads).catch(() => {});
      api.terminals().then(setTerminals).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [auth]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
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

  const go = (r: Route) => {
    const hash = hashFor(r);
    if (location.hash !== hash) location.hash = hash;
    setRoute(r);
    setDrawerOpen(false);
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError(undefined);
  };

  const openNew = () => {
    if (route.section === 'terminal') {
      setTerminalCwd(undefined);
      setDialog('terminal');
    } else {
      setDialog('thread');
    }
  };

  const createThread = async (agentId: string, cwd: string, lead = false) => {
    setCreating(true);
    setDialogError(undefined);
    try {
      const t = await api.createThread(agentId, cwd, lead);
      setThreads((ts) => [t, ...ts]);
      closeDialog();
      go({ section: 'chat', id: t.id });
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const createTerminal = async (cwd: string, command?: 'claude') => {
    setCreating(true);
    setDialogError(undefined);
    try {
      const t = await api.createTerminal(cwd, command);
      setTerminals((ts) => [t, ...ts]);
      closeDialog();
      go({ section: 'terminal', id: t.id });
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const removeThread = async (id: string) => {
    await api.deleteThread(id).catch(() => {});
    setThreads((ts) => ts.filter((t) => t.id !== id));
    if (route.id === id) go({ section: 'chat', id: null });
  };

  const removeTerminal = async (id: string) => {
    await api.deleteTerminal(id).catch(() => {});
    setTerminals((ts) => ts.filter((t) => t.id !== id));
    if (route.id === id) go({ section: 'terminal', id: null });
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

  const inTerminals = route.section === 'terminal';
  const inSettings = route.section === 'settings';
  const inFiles = route.section === 'files';
  const activeThread = route.section === 'chat' ? (threads.find((t) => t.id === route.id) ?? null) : null;
  const activeTerminal = inTerminals ? (terminals.find((t) => t.id === route.id) ?? null) : null;
  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const newLabel = inTerminals ? 'Nuovo terminale' : 'Nuova conversazione';

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
        <button type="button" className="btn icon-btn" onClick={openNew}>
          <Icon name="plus" />
          <span className="visually-hidden">{newLabel}</span>
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
                  aria-current={s.id === route.section ? 'page' : undefined}
                  aria-disabled={!s.ready || undefined}
                  onClick={() => s.ready && go({ section: s.id, id: null })}
                >
                  <Icon name={s.icon} />
                  <span>{s.label}</span>
                  {!s.ready && <span className="soon">in arrivo</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {!inSettings && !inFiles && (
          <button type="button" className="btn primary new-btn" onClick={openNew}>
            <Icon name="plus" />
            <span>{newLabel}</span>
          </button>
        )}

        {inSettings || inFiles ? null : inTerminals ? (
          <>
            <h2 className="sidebar-title" id="list-title">
              Terminali
            </h2>
            {terminals.length === 0 ? (
              <p className="sidebar-empty">Nessun terminale aperto</p>
            ) : (
              <ul className="threads" aria-labelledby="list-title">
                {terminals.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="thread-btn"
                      aria-current={t.id === route.id ? 'page' : undefined}
                      onClick={() => go({ section: 'terminal', id: t.id })}
                    >
                      <span className="thread-title">{t.title}</span>
                      <span className="thread-meta">
                        {t.cwd}
                        {t.exited && <span> · terminato</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <ThreadList
              threads={threads}
              activeId={route.section === 'chat' ? route.id : null}
              agentLabel={agentLabel}
              onSelect={(tid) => go({ section: 'chat', id: tid })}
              onChanged={(t) => setThreads((ts) => ts.map((x) => (x.id === t.id ? t : x)))}
              onDelete={(tid) => void removeThread(tid)}
            />
          </>
        )}
      </aside>

      <div className="backdrop" hidden={!drawerOpen} onClick={closeDrawer} />

      <main id="main" className="main" tabIndex={-1} inert={drawerOpen || undefined}>
        {inFiles ? (
          <FilesView path={route.id} onNavigate={(p) => go({ section: 'files', id: p })} />
        ) : inSettings ? (
          <SettingsView
            page={route.id}
            onOpenTerminal={(t) => {
              setTerminals((ts) => [t, ...ts]);
              go({ section: 'terminal', id: t.id });
            }}
            onLogout={() => {
              setAuthError(undefined);
              setAuth('needed');
            }}
          />
        ) : activeThread ? (
          <Chat
            key={activeThread.id}
            thread={activeThread}
            threads={threads}
            agentLabel={agentLabel(activeThread.agentId)}
            onDelete={() => removeThread(activeThread.id)}
            onOpenTerminal={() => {
              setTerminalCwd(activeThread.cwd);
              setDialog('terminal');
            }}
          />
        ) : activeTerminal ? (
          <TerminalView key={activeTerminal.id} terminal={activeTerminal} onClose={() => removeTerminal(activeTerminal.id)} />
        ) : inTerminals ? (
          <section className="welcome" aria-labelledby="welcome-title">
            <h1 id="welcome-title">Terminali</h1>
            <p>
              Shell vere sul server, nella cartella del progetto. Restano aperte anche se chiudi la pagina: ci ritrovi
              l'output quando torni.
            </p>
            <button type="button" className="btn primary" onClick={openNew}>
              <Icon name="plus" />
              <span>Nuovo terminale</span>
            </button>
          </section>
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
            <button type="button" className="btn primary" onClick={openNew}>
              <Icon name="plus" />
              <span>Nuova conversazione</span>
            </button>
          </section>
        )}
      </main>

      <NewThreadDialog
        open={dialog === 'thread'}
        agents={agents}
        error={dialogError}
        busy={creating}
        onClose={closeDialog}
        onCreate={createThread}
      />
      <NewTerminalDialog
        open={dialog === 'terminal'}
        initialCwd={terminalCwd}
        error={dialogError}
        busy={creating}
        onClose={closeDialog}
        onCreate={createTerminal}
      />
    </div>
  );
}
