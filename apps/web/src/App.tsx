import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, getToken, setToken, type AgentInfo, type DesignChoice, type PluginInfo, type TerminalSummary, type ThreadSummary } from './api';
import { Chat } from './Chat';
import { Login } from './Login';
import { NewThreadDialog } from './NewThread';
import { NewTerminalDialog } from './NewTerminal';
import { TerminalView } from './TerminalView';
import { SettingsView } from './SettingsView';
import { ThreadList } from './ThreadList';
import { FilesView } from './FilesView';
import { DesignView } from './DesignView';
import { PiiView } from './PiiView';
import { BrowserSection } from './BrowserSection';
import { VerdictView } from './VerdictView';
import { CloudView } from './CloudView';
import { Icon, type IconName } from './icons';

type Auth = 'checking' | 'ok' | 'needed';
type Section = 'chat' | 'terminal' | 'files' | 'design' | 'pii' | 'browser' | 'verdict' | 'cloud' | 'settings';

interface Route {
  section: Section;
  id: string | null;
}

/** plugin: la sezione compare solo se il plugin e' installato e attivo */
const SECTIONS: { id: Section; label: string; icon: IconName; ready: boolean; plugin?: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', ready: true },
  { id: 'terminal', label: 'Terminale', icon: 'terminal', ready: true },
  { id: 'files', label: 'File', icon: 'files', ready: true },
  { id: 'design', label: 'Design', icon: 'design', ready: true, plugin: 'design' },
  { id: 'pii', label: 'PII', icon: 'shield', ready: true, plugin: 'pii' },
  { id: 'browser', label: 'Browser', icon: 'globe', ready: true, plugin: 'browser' },
  { id: 'verdict', label: 'Verdict', icon: 'scale', ready: true, plugin: 'verdict' },
  { id: 'cloud', label: 'Cloud', icon: 'cloud', ready: true, plugin: 'cloud' },
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
  if (/^#\/pii\/?$/.test(location.hash)) return { section: 'pii', id: null };
  if (/^#\/verdict\/?$/.test(location.hash)) return { section: 'verdict', id: null };
  if (/^#\/cloud\/?$/.test(location.hash)) return { section: 'cloud', id: null };
  // #/browser/popup = solo il browser, nella finestra a parte
  const browser = location.hash.match(/^#\/browser(\/popup)?\/?$/);
  if (browser) return { section: 'browser', id: browser[1] ? 'popup' : null };
  // #/design = galleria, #/design/t/<id> = una sessione di design
  const design = location.hash.match(/^#\/design(?:\/t\/([\w-]+))?\/?$/);
  if (design) return { section: 'design', id: design[1] ?? null };
  return { section: 'chat', id: null };
}

function hashFor(r: Route): string {
  if (r.section === 'terminal') return r.id ? `#/term/${r.id}` : '#/term';
  if (r.section === 'settings') return r.id ? `#/settings/${r.id}` : '#/settings';
  if (r.section === 'files') return r.id ? `#/files/${encodeURIComponent(r.id)}` : '#/files';
  if (r.section === 'pii') return '#/pii';
  if (r.section === 'verdict') return '#/verdict';
  if (r.section === 'cloud') return '#/cloud';
  if (r.section === 'browser') return r.id === 'popup' ? '#/browser/popup' : '#/browser';
  if (r.section === 'design') return r.id ? `#/design/t/${r.id}` : '#/design';
  return r.id ? `#/t/${r.id}` : '';
}

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [authError, setAuthError] = useState<string>();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const pluginOn = (id: string) => plugins.some((p) => p.id === id && p.enabled);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<'thread' | 'terminal' | null>(null);
  const [terminalCwd, setTerminalCwd] = useState<string>();
  const [dialogError, setDialogError] = useState<string>();
  /** Skill/design system scelti dalla galleria Design per la nuova conversazione */
  const [designPreset, setDesignPreset] = useState<DesignChoice | null>(null);
  const [creating, setCreating] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t, term, pl] = await Promise.all([api.agents(), api.threads(), api.terminals(), api.plugins()]);
      setAgents(a);
      setPlugins(pl);
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

  // Link vecchi o notifiche (#/t/<id>) di una sessione di design: si apre nella sezione Design
  useEffect(() => {
    if (route.section !== 'chat' || !route.id) return;
    const t = threads.find((x) => x.id === route.id);
    if (t?.design) {
      history.replaceState(null, '', hashFor({ section: 'design', id: t.id }));
      setRoute({ section: 'design', id: t.id });
    } else if (t?.browser) {
      localStorage.setItem('agicloud_browser_thread', t.id);
      history.replaceState(null, '', hashFor({ section: 'browser', id: null }));
      setRoute({ section: 'browser', id: null });
    }
  }, [route, threads]);

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
      setDesignPreset(null);
      setDialog('thread');
    }
  };

  const createThread = async (agentId: string, cwd: string, lead = false, design: DesignChoice | null = null) => {
    setCreating(true);
    setDialogError(undefined);
    try {
      const t = await api.createThread(agentId, cwd, lead, design);
      setThreads((ts) => [t, ...ts]);
      closeDialog();
      go({ section: t.design ? 'design' : 'chat', id: t.id });
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
    if (route.id === id) go({ section: route.section === 'design' ? 'design' : 'chat', id: null });
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
  const inDesign = route.section === 'design';
  const inPii = route.section === 'pii';
  const inBrowser = route.section === 'browser';
  const inVerdict = route.section === 'verdict';
  const inCloud = route.section === 'cloud';
  const activeThread =
    route.section === 'chat' || route.section === 'design' ? (threads.find((t) => t.id === route.id) ?? null) : null;
  // Le sessioni di design stanno nella sezione Design, le altre in Chat
  const designThreads = threads.filter((t) => t.design);
  const chatThreads = threads.filter((t) => !t.design && !t.browser);
  const browserSection = (popup: boolean) => (
    <BrowserSection
      popup={popup}
      threads={threads}
      agents={agents}
      agentLabel={agentLabel}
      onCreated={(t) => setThreads((ts) => [t, ...ts])}
      onDelete={(tid) => void removeThread(tid)}
      onOpenTerminal={(cwd) => {
        setTerminalCwd(cwd);
        setDialog('terminal');
      }}
    />
  );
  const activeTerminal = inTerminals ? (terminals.find((t) => t.id === route.id) ?? null) : null;
  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const newLabel = inTerminals ? 'Nuovo terminale' : 'Nuova conversazione';

  // Finestra a parte del Browser: solo lo schermo, senza menu
  if (inBrowser && route.id === 'popup') {
    return (
      <main id="main" className="popup-main">
        {pluginOn('browser') ? browserSection(true) : <p className="boot">Il plugin Browser non e' attivo.</p>}
      </main>
    );
  }

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
            {SECTIONS.filter((s) => !s.plugin || pluginOn(s.plugin)).map((s) => (
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

        {inDesign && (
          <>
            <button
              type="button"
              className="btn primary new-btn"
              aria-current={route.id === null ? 'page' : undefined}
              onClick={() => go({ section: 'design', id: null })}
            >
              <Icon name="plus" />
              <span>Nuova sessione di design</span>
            </button>
            {designThreads.length === 0 ? (
              <p className="sidebar-empty">Nessuna sessione di design: scegli uno stile nella galleria e premi Prova</p>
            ) : (
              <ThreadList
                threads={designThreads}
                title="Sessioni di design"
                activeId={route.id}
                agentLabel={agentLabel}
                onSelect={(tid) => go({ section: 'design', id: tid })}
                onChanged={(t) => setThreads((ts) => ts.map((x) => (x.id === t.id ? t : x)))}
                onDelete={(tid) => void removeThread(tid)}
              />
            )}
          </>
        )}

        {!inSettings && !inFiles && !inDesign && !inPii && !inBrowser && !inVerdict && !inCloud && (
          <button type="button" className="btn primary new-btn" onClick={openNew}>
            <Icon name="plus" />
            <span>{newLabel}</span>
          </button>
        )}

        {inSettings || inFiles || inDesign || inPii || inBrowser || inVerdict || inCloud ? null : inTerminals ? (
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
              threads={chatThreads}
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
        ) : inCloud ? (
          pluginOn('cloud') ? (
            <CloudView />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">Cloud non attivo</h1>
              <p>
                Il plugin Cloud e' spento o non installato. Puoi attivarlo in <a href="#/settings/plugin">Impostazioni → Plugin</a>.
              </p>
            </section>
          )
        ) : inVerdict ? (
          pluginOn('verdict') ? (
            <VerdictView />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">Verdict non attivo</h1>
              <p>
                Il plugin Verdict e' spento o non installato. Puoi attivarlo in <a href="#/settings/plugin">Impostazioni → Plugin</a>.
              </p>
            </section>
          )
        ) : inBrowser ? (
          pluginOn('browser') ? (
            browserSection(false)
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">Browser non attivo</h1>
              <p>
                Il plugin Browser e' spento o non installato. Puoi attivarlo in <a href="#/settings/plugin">Impostazioni → Plugin</a>.
              </p>
            </section>
          )
        ) : inPii ? (
          pluginOn('pii') ? (
            <PiiView />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">PII non attivo</h1>
              <p>
                Il plugin PII e' spento o non installato. Puoi attivarlo in <a href="#/settings/plugin">Impostazioni → Plugin</a>.
              </p>
            </section>
          )
        ) : inDesign && !pluginOn('design') ? (
          <section className="welcome" aria-labelledby="welcome-title">
            <h1 id="welcome-title">Design non attivo</h1>
            <p>
              Il plugin Design e' spento o non installato. Puoi attivarlo in <a href="#/settings/plugin">Impostazioni → Plugin</a>.
            </p>
          </section>
        ) : inDesign && !activeThread ? (
          <DesignView
            onTry={(choice) => {
              setDesignPreset(choice);
              setDialog('thread');
            }}
          />
        ) : inSettings ? (
          <SettingsView
            page={route.id}
            onPluginsChanged={setPlugins}
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
        preset={designPreset}
        designEnabled={pluginOn('design')}
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
