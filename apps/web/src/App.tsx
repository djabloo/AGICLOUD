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
import { VideoSection } from './VideoSection';
import { NotebookSection } from './NotebookSection';
import { AccessibilitySection } from './AccessibilitySection';
import { SetupDone } from './Login';
import { Icon, type IconName } from './icons';
import { useT } from './i18n';

type Auth = 'checking' | 'ok' | 'needed';
type Section = 'chat' | 'terminal' | 'files' | 'design' | 'pii' | 'browser' | 'verdict' | 'cloud' | 'video' | 'notebook' | 'accessibility' | 'settings';

interface Route {
  section: Section;
  id: string | null;
}

/** plugin: la sezione compare solo se il plugin e' installato e attivo */
interface SectionDef {
  id: Section;
  icon: IconName;
  ready: boolean;
  plugin?: string;
}
const SECTION_DEFS: SectionDef[] = [
  { id: 'chat', icon: 'chat', ready: true },
  { id: 'terminal', icon: 'terminal', ready: true },
  { id: 'files', icon: 'files', ready: true },
  { id: 'design', icon: 'design', ready: true, plugin: 'design' },
  { id: 'pii', icon: 'shield', ready: true, plugin: 'pii' },
  { id: 'browser', icon: 'globe', ready: true, plugin: 'browser' },
  { id: 'verdict', icon: 'scale', ready: true, plugin: 'verdict' },
  { id: 'cloud', icon: 'cloud', ready: true, plugin: 'cloud' },
  { id: 'video', icon: 'video', ready: true, plugin: 'video' },
  { id: 'notebook', icon: 'notebook', ready: true, plugin: 'notebook' },
  { id: 'accessibility', icon: 'accessibility', ready: true, plugin: 'accessibility' },
  { id: 'settings', icon: 'settings', ready: true },
];
const SECTION_KEYS: Record<Section, string> = {
  chat: 'app.sezioneChat',
  terminal: 'app.sezioneTerminale',
  files: 'app.sezioneFile',
  design: 'app.sezioneDesign',
  pii: 'app.sezionePii',
  browser: 'app.sezioneBrowser',
  verdict: 'app.sezioneVerdict',
  cloud: 'app.sezioneCloud',
  video: 'app.sezioneVideo',
  notebook: 'app.sezioneNotebook',
  accessibility: 'app.sezioneAccessibility',
  settings: 'app.sezioneImpostazioni',
};
type TFn = (key: string, params?: Record<string, string | number>) => string;
function sectionDefs(t: TFn): { id: Section; label: string; icon: IconName; ready: boolean; plugin?: string }[] {
  return SECTION_DEFS.map((s) => ({ ...s, label: t(SECTION_KEYS[s.id]) }));
}

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
  if (/^#\/video\/?$/.test(location.hash)) return { section: 'video', id: null };
  if (/^#\/notebook\/?$/.test(location.hash)) return { section: 'notebook', id: null };
  if (/^#\/accessibility\/?$/.test(location.hash)) return { section: 'accessibility', id: null };
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
  if (r.section === 'video') return '#/video';
  if (r.section === 'notebook') return '#/notebook';
  if (r.section === 'accessibility') return '#/accessibility';
  if (r.section === 'browser') return r.id === 'popup' ? '#/browser/popup' : '#/browser';
  if (r.section === 'design') return r.id ? `#/design/t/${r.id}` : '#/design';
  return r.id ? `#/t/${r.id}` : '';
}

export function App() {
  const t = useT();
  const [auth, setAuth] = useState<Auth>('checking');
  const [authError, setAuthError] = useState<string>();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const pluginOn = (id: string) => plugins.some((p) => p.id === id && p.enabled);
  /** Sezioni consentite dal piano (null = tutto); impostazioni sempre visibili */
  const [features, setFeatures] = useState<string[] | null>(null);
  const allowed = (id: Section) => id === 'settings' || id === 'chat' || features === null || features.includes(id);
  const pluginAllowed = (id: string) => features === null || features.includes(id);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<'thread' | 'terminal' | null>(null);
  const [terminalCwd, setTerminalCwd] = useState<string>();
  /** Comando rapido scelto dalla dashboard: preimposta il dialogo del terminale */
  const [terminalPreset, setTerminalPreset] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  /** Skill/design system scelti dalla galleria Design per la nuova conversazione */
  const [designPreset, setDesignPreset] = useState<DesignChoice | null>(null);
  const [creating, setCreating] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  useEffect(() => {
    document.title = t('app.titolo');
  });

  const refresh = useCallback(async () => {
    try {
      // Terminali e plugin possono rispondere 403 se fuori dal piano: non e' un errore di accesso
      const [a, t, term, pl, s] = await Promise.all([
        api.agents(),
        api.threads(),
        api.terminals().catch(() => [] as TerminalSummary[]),
        api.plugins().catch(() => [] as PluginInfo[]),
        api.session(),
      ]);
      setAgents(a);
      setPlugins(pl);
      setThreads(t);
      setTerminals(term);
      setFeatures(s.features ?? null);
      setAuth('ok');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuth('needed');
        if (getToken()) setAuthError(t('app.erroreTokenNonValido'));
      } else if (err instanceof ApiError && err.status === 429) {
        setAuth('needed');
        setAuthError(err.message);
      } else {
        setAuth((s) => (s === 'checking' ? 'needed' : s));
        setAuthError(t('app.erroreServer'));
      }
    }
  }, []);

  // Link di attivazione di un nodo nuovo (?setup=...): crea il token e lo mostra una volta
  const [newToken, setNewToken] = useState<string | null>(null);
  useEffect(() => {
    const setup = new URLSearchParams(location.search).get('setup');
    if (!setup) return;
    history.replaceState(null, '', location.pathname + location.hash);
    api
      .setup(setup)
      .then((r) => {
        setToken(r.token);
        setNewToken(r.token);
      })
      .catch((err) => setAuthError(err instanceof Error ? err.message : String(err)));
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
    setTerminalPreset(false);
  };

  const openNew = () => {
    if (route.section === 'terminal') {
      setTerminalCwd(undefined);
      setTerminalPreset(false);
      setDialog('terminal');
    } else {
      setDesignPreset(null);
      setDialog('thread');
    }
  };

  /** Comando rapido dalla dashboard: apre il dialogo con "claude" preimpostato se serve */
  const openTerminalPreset = (claude: boolean) => {
    setTerminalCwd(undefined);
    setTerminalPreset(claude);
    setDialog('terminal');
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

  if (newToken) return <SetupDone token={newToken} onContinue={() => { setNewToken(null); void refresh(); }} />;
  if (auth === 'checking') return <p className="boot">{t('app.caricamento')}</p>;
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
  const inVideo = route.section === 'video';
  const inNotebook = route.section === 'notebook';
  const inAccessibility = route.section === 'accessibility';
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
  const newLabel = inTerminals ? t('app.nuovoTerminale') : t('app.nuovaConversazione');
  const SECTIONS = sectionDefs(t);
  /** Prompt pronti della dashboard chat: click = dialogo di nuova conversazione */
  const chatStarters = [
    { title: t('app.starterFunzionalita'), badge: t('app.badgeSviluppo'), desc: t('app.descFunzionalita') },
    { title: t('app.starterAnalisi'), badge: t('app.badgeComprensione'), desc: t('app.descAnalisi') },
    { title: t('app.starterRefactoring'), badge: t('app.badgeQualita'), desc: t('app.descRefactoring') },
    { title: t('app.starterTest'), badge: t('app.badgeTest'), desc: t('app.descTest') },
  ];
  /** Comandi pronti della dashboard terminale: click = dialogo con preset */
  const terminalStarters: { title: string; badge: string; desc: string; cmd: string; claude: boolean }[] = [
    { title: 'Claude Code', badge: t('app.badgeAgente'), desc: t('app.descClaude'), cmd: 'claude', claude: true },
    { title: 'agy / Antigravity', badge: t('app.badgeAgente'), desc: t('app.descAgy'), cmd: 'agy', claude: false },
    { title: 'OpenCode', badge: t('app.badgeAgente'), desc: t('app.descOpencode'), cmd: 'opencode', claude: false },
    { title: t('app.cmdShell'), badge: t('app.badgeShell'), desc: t('app.descShell'), cmd: '', claude: false },
    { title: 'Git status', badge: t('app.badgeGit'), desc: t('app.descGit'), cmd: 'git status', claude: false },
    { title: t('app.cmdLogs'), badge: t('app.badgeServer'), desc: t('app.descLogs'), cmd: 'pm2 logs --lines 50', claude: false },
  ];

  // Finestra a parte del Browser: solo lo schermo, senza menu
  if (inBrowser && route.id === 'popup') {
    return (
      <main id="main" className="popup-main">
        {pluginOn('browser') ? browserSection(true) : <p className="boot">{t('app.pluginBrowserNonAttivo')}</p>}
      </main>
    );
  }

  return (
    <div className={`app${drawerOpen ? ' drawer-open' : ''}`}>
      <a className="skip-link" href="#main">
        {t('app.vaiAlContenuto')}
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
          <span className="visually-hidden">{drawerOpen ? t('app.chiudiMenu') : t('app.apriMenu')}</span>
        </button>
        <span className="brand">AgiCloud</span>
        <button type="button" className="btn icon-btn" onClick={openNew}>
          <Icon name="plus" />
          <span className="visually-hidden">{newLabel}</span>
        </button>
      </header>

      <aside id="sidebar" ref={drawer} className="sidebar" aria-label={t('app.navPrincipale')}>
        <div className="sidebar-head">
          <span className="sidebar-brand">AgiCloud</span>
          <button type="button" className="btn icon-btn drawer-close" onClick={closeDrawer}>
            <Icon name="close" />
            <span className="visually-hidden">{t('app.chiudiMenu')}</span>
          </button>
        </div>

        <nav aria-label={t('app.navSezioni')}>
          <ul className="sections">
            {SECTIONS.filter((s) => (!s.plugin || pluginOn(s.plugin)) && allowed(s.id)).map((s) => (
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
                  {!s.ready && <span className="soon">{t('app.inArrivo')}</span>}
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
              <span>{t('app.nuovaSessioneDesign')}</span>
            </button>
            {designThreads.length === 0 ? (
              <p className="sidebar-empty">{t('app.nessunaSessioneDesign')}</p>
            ) : (
              <ThreadList
                threads={designThreads}
                title={t('app.sessioniDesign')}
                activeId={route.id}
                agentLabel={agentLabel}
                onSelect={(tid) => go({ section: 'design', id: tid })}
                onChanged={(t) => setThreads((ts) => ts.map((x) => (x.id === t.id ? t : x)))}
                onDelete={(tid) => void removeThread(tid)}
              />
            )}
          </>
        )}

        {!inSettings && !inFiles && !inDesign && !inPii && !inBrowser && !inVerdict && !inCloud && !inVideo && !inNotebook && !inAccessibility && (
          <button type="button" className="btn primary new-btn" onClick={openNew}>
            <Icon name="plus" />
            <span>{newLabel}</span>
          </button>
        )}

        {inSettings || inFiles || inDesign || inPii || inBrowser || inVerdict || inCloud || inVideo || inNotebook || inAccessibility ? null : inTerminals ? (
          <>
            <h2 className="sidebar-title" id="list-title">
              {t('app.terminali')}
            </h2>
            {terminals.length === 0 ? (
              <p className="sidebar-empty">{t('app.nessunTerminale')}</p>
            ) : (
              <ul className="threads" aria-labelledby="list-title">
                {terminals.map((term) => (
                  <li key={term.id}>
                    <button
                      type="button"
                      className="thread-btn"
                      aria-current={term.id === route.id ? 'page' : undefined}
                      onClick={() => go({ section: 'terminal', id: term.id })}
                    >
                      <span className="thread-title">{term.title}</span>
                      <span className="thread-meta">
                        {term.cwd}
                        {term.exited && <span>{t('app.terminato')}</span>}
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
        {!allowed(route.section) ? (
          <section className="welcome" aria-labelledby="welcome-title">
            <h1 id="welcome-title">{t('app.pianoTitolo')}</h1>
            <p>
              {t('app.pianoTesto', { chat: '\u0000' }).split('\u0000')[0]}
              <a href="#">{t('app.chatLink')}</a>
              {t('app.pianoTesto', { chat: '\u0000' }).split('\u0000')[1]}
            </p>
          </section>
        ) : inVideo ? (
          pluginOn('video') ? (
            <VideoSection />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.videoNonAttivo')}</h1>
              <p>
                {t('app.pluginVideoTesto', { link: '\u0000' }).split('\u0000')[0]}
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
                {t('app.pluginVideoTesto', { link: '\u0000' }).split('\u0000')[1]}
              </p>
            </section>
          )
        ) : inNotebook ? (
          pluginOn('notebook') ? (
            <NotebookSection />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.notebookNonAttivo')}</h1>
              <p>
                {t('app.pluginNotebookTesto', { link: '\u0000' }).split('\u0000')[0]}
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
                {t('app.pluginNotebookTesto', { link: '\u0000' }).split('\u0000')[1]}
              </p>
            </section>
          )
        ) : inAccessibility ? (
          pluginOn('accessibility') ? (
            <AccessibilitySection
              agents={agents}
              browserEnabled={pluginOn('browser')}
              onThreadCreated={() => void refresh()}
            />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.sezioneAccessibility')}</h1>
              <p>
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
              </p>
            </section>
          )
        ) : inFiles ? (
          <FilesView path={route.id} onNavigate={(p) => go({ section: 'files', id: p })} />
        ) : inCloud ? (
          pluginOn('cloud') ? (
            <CloudView />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.cloudNonAttivo')}</h1>
              <p>
                {t('app.pluginCloudTesto', { link: '\u0000' }).split('\u0000')[0]}
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
                {t('app.pluginCloudTesto', { link: '\u0000' }).split('\u0000')[1]}
              </p>
            </section>
          )
        ) : inVerdict ? (
          pluginOn('verdict') ? (
            <VerdictView />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.verdictNonAttivo')}</h1>
              <p>
                {t('app.pluginVerdictTesto', { link: '\u0000' }).split('\u0000')[0]}
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
                {t('app.pluginVerdictTesto', { link: '\u0000' }).split('\u0000')[1]}
              </p>
            </section>
          )
        ) : inBrowser ? (
          pluginOn('browser') ? (
            browserSection(false)
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.browserNonAttivo')}</h1>
              <p>
                {t('app.pluginBrowserTesto', { link: '\u0000' }).split('\u0000')[0]}
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
                {t('app.pluginBrowserTesto', { link: '\u0000' }).split('\u0000')[1]}
              </p>
            </section>
          )
        ) : inPii ? (
          pluginOn('pii') ? (
            <PiiView />
          ) : (
            <section className="welcome" aria-labelledby="welcome-title">
              <h1 id="welcome-title">{t('app.piiNonAttivo')}</h1>
              <p>
                {t('app.pluginPiiTesto', { link: '\u0000' }).split('\u0000')[0]}
                <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
                {t('app.pluginPiiTesto', { link: '\u0000' }).split('\u0000')[1]}
              </p>
            </section>
          )
        ) : inDesign && !pluginOn('design') ? (
          <section className="welcome" aria-labelledby="welcome-title">
            <h1 id="welcome-title">{t('app.designNonAttivo')}</h1>
            <p>
              {t('app.pluginDesignTesto', { link: '\u0000' }).split('\u0000')[0]}
              <a href="#/settings/plugin">{t('app.linkImpostazioniPlugin')}</a>
              {t('app.pluginDesignTesto', { link: '\u0000' }).split('\u0000')[1]}
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
            features={features}
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
          <section className="dash" aria-labelledby="dash-term-title">
            <div className="dash-inner">
              <div className="dash-head">
                <h1 id="dash-term-title">{t('app.terminaliTitolo')}</h1>
                <p>{t('app.terminaliTesto')}</p>
              </div>
              <div className="dash-actions">
                <button type="button" className="btn primary" onClick={openNew}>
                  <Icon name="plus" />
                  <span>{t('app.nuovoTerminale')}</span>
                </button>
              </div>
              <div className="dash-section">
                <h2 className="mini-title">{t('app.dashboardComandi')}</h2>
                <ul className="starter-grid">
                  {terminalStarters.map((s) => (
                    <li key={s.title}>
                      <button type="button" className="starter-card" onClick={() => openTerminalPreset(s.claude)}>
                        <h3>{s.title}</h3>
                        <p className="starter-badge">{s.badge}</p>
                        <p className="starter-desc">{s.desc}</p>
                        {s.cmd && <span className="starter-cmd">{s.cmd}</span>}
                        <span className="starter-go">{t('app.dashboardAvvia')} →</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {terminals.length > 0 && (
                <div className="dash-section">
                  <h2 className="mini-title" id="dash-term-open">{t('app.dashboardTerminaliAperti')}</h2>
                  <ul className="dash-list" aria-labelledby="dash-term-open">
                    {terminals.map((term) => (
                      <li key={term.id}>
                        <button type="button" className="thread-btn" onClick={() => go({ section: 'terminal', id: term.id })}>
                          <span className="thread-title">{term.title}</span>
                          <span className="thread-meta">
                            {term.cwd}
                            {term.exited && <span>{t('app.terminato')}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="dash" aria-labelledby="dash-chat-title">
            <div className="dash-inner">
              <div className="dash-head">
                <h1 id="dash-chat-title">{t('app.benvenutoTitolo')}</h1>
                <p>{t('app.benvenutoTesto')}</p>
              </div>
              <div className="dash-actions">
                <button type="button" className="btn primary" onClick={openNew}>
                  <Icon name="plus" />
                  <span>{t('app.nuovaConversazione')}</span>
                </button>
              </div>
              {chatThreads.length > 0 && (
                <div className="dash-section">
                  <h2 className="mini-title" id="dash-chat-recent">{t('app.dashboardRecenti')}</h2>
                  <ul className="dash-list" aria-labelledby="dash-chat-recent">
                    {chatThreads.slice(0, 5).map((th) => (
                      <li key={th.id}>
                        <button type="button" className="thread-btn" onClick={() => go({ section: 'chat', id: th.id })}>
                          <span className="thread-title">{th.title}</span>
                          <span className="thread-meta">{agentLabel(th.agentId)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="dash-section">
                <h2 className="mini-title">{t('app.dashboardPrompt')}</h2>
                <ul className="starter-grid">
                  {chatStarters.map((s) => (
                    <li key={s.title}>
                      <button type="button" className="starter-card" onClick={openNew}>
                        <h3>{s.title}</h3>
                        <p className="starter-badge">{s.badge}</p>
                        <p className="starter-desc">{s.desc}</p>
                        <span className="starter-go">{t('app.dashboardAvvia')} →</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
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
        initialClaude={terminalPreset}
        error={dialogError}
        busy={creating}
        onClose={closeDialog}
        onCreate={createTerminal}
      />
    </div>
  );
}
