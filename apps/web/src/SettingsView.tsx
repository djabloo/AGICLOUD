import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, setToken, type AgentStatus, type GeneralSettings, type TerminalSummary } from './api';
import type { ConfigOption } from './transcript';
import { Icon } from './icons';
import { VaultSection } from './VaultSection';
import { NotificationsSection } from './NotificationsSection';
import { AgentLogin } from './AgentLogin';
import { SearchSelect } from './SearchSelect';
import { getTheme, setTheme, type ThemeChoice } from './theme';

const LOGIN_TEXT: Record<AgentStatus['login']['state'], string> = {
  ok: 'Collegato',
  missing: 'Non collegato',
  unknown: 'Stato sconosciuto',
};

type PageId = 'agenti' | 'chiavi' | 'notifiche' | 'aspetto' | 'generale' | 'accesso';

const PAGES: { id: PageId; label: string; desc: string }[] = [
  { id: 'agenti', label: 'Agenti', desc: 'Login, stato e scelte predefinite' },
  { id: 'chiavi', label: 'Chiavi', desc: 'Portachiavi per processi e terminali' },
  { id: 'notifiche', label: 'Notifiche e app', desc: 'Avvisi sul telefono, installazione' },
  { id: 'aspetto', label: 'Aspetto', desc: 'Tema chiaro o scuro' },
  { id: 'generale', label: 'Cartelle e pausa', desc: 'Progetti consentiti, pausa degli agenti' },
  { id: 'accesso', label: 'Accesso', desc: 'Esci da questo dispositivo' },
];

/** page: voce scelta (#/settings/<voce>). Senza voce: su telefono l'elenco, su schermo largo la prima */
export function SettingsView({
  page,
  onOpenTerminal,
  onLogout,
}: {
  page: string | null;
  onOpenTerminal: (t: TerminalSummary) => void;
  onLogout: () => void;
}) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [announce, setAnnounce] = useState('');
  const current = PAGES.find((p) => p.id === page) ?? null;
  const shown = current ?? PAGES[0]!;
  const contentRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  const load = async (refresh = false) => {
    setRefreshing(true);
    setError('');
    try {
      const s = await api.settings(refresh);
      setAgents(s.agents);
      setGeneral(s.general);
      if (refresh) setAnnounce('Stato degli agenti aggiornato');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Cambio voce: il focus va al titolo della voce (o all'elenco tornando indietro su telefono)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (current) contentRef.current?.querySelector<HTMLElement>('h2')?.focus();
    else document.querySelector<HTMLElement>('.settings-nav a')?.focus();
  }, [page]);

  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="settings-title">Impostazioni</h1>
          <p className="chat-meta">{current ? current.label : 'Scegli una voce'}</p>
        </div>
      </header>

      <div className={`settings-body settings-layout ${current ? 'has-page' : 'no-page'}`}>
        <nav className="settings-nav" aria-label="Voci delle impostazioni">
          <ul>
            {PAGES.map((p) => (
              <li key={p.id}>
                <a href={`#/settings/${p.id}`} aria-current={p.id === shown.id ? 'page' : undefined}>
                  <span className="settings-nav-label">{p.label}</span>
                  <span className="settings-nav-desc">{p.desc}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="settings-content" ref={contentRef}>
          <a className="settings-back" href="#/settings">
            <span aria-hidden="true">‹ </span>Tutte le impostazioni
          </a>
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}

          {shown.id === 'agenti' && (
            <section aria-labelledby="agents-title" className="settings-group">
              <div className="group-head">
                <h2 id="agents-title" tabIndex={-1}>
                  Agenti
                </h2>
                <button type="button" className="btn small-btn" onClick={() => void load(true)} disabled={refreshing}>
                  <Icon name="refresh" />
                  <span>{refreshing ? 'Controllo…' : 'Ricontrolla'}</span>
                </button>
              </div>
              {!agents ? (
                <p className="hint">Controllo degli agenti in corso…</p>
              ) : (
                <ul className="agent-cards">
                  {agents.map((a) => (
                    <li key={a.id}>
                      <AgentCard agent={a} onOpenTerminal={onOpenTerminal} onChanged={() => void load(true)} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {shown.id === 'chiavi' && <VaultSection />}

          {shown.id === 'notifiche' && <NotificationsSection />}

          {shown.id === 'aspetto' && <AppearanceSection />}

          {shown.id === 'generale' && (general ? <GeneralForm general={general} onSaved={setGeneral} /> : <p className="hint">Caricamento…</p>)}

          {shown.id === 'accesso' && (
            <section aria-labelledby="access-title" className="settings-group">
              <h2 id="access-title" tabIndex={-1}>
                Accesso
              </h2>
              <p className="hint">
                Il token di accesso sta sul server in <code>/home/user/.secrets/agicloud-app.env</code>. Uscendo, questo
                browser lo dimentica e alla prossima apertura lo richiede.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setToken('');
                  onLogout();
                }}
              >
                Esci da questo dispositivo
              </button>
            </section>
          )}
        </div>
      </div>

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}

const THEMES: { id: ThemeChoice; label: string; desc: string }[] = [
  { id: 'system', label: 'Automatico', desc: 'Segue il telefono o il computer' },
  { id: 'light', label: 'Chiaro', desc: '' },
  { id: 'dark', label: 'Scuro', desc: '' },
];

function AppearanceSection() {
  const id = useId();
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme);
  const choose = (t: ThemeChoice) => {
    setTheme(t);
    setThemeState(t);
  };
  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        Aspetto
      </h2>
      <fieldset className="choice-group">
        <legend>Tema</legend>
        {THEMES.map((t) => (
          <label key={t.id} className="choice">
            <input type="radio" name={`${id}-theme`} value={t.id} checked={theme === t.id} onChange={() => choose(t.id)} />
            <span className={`theme-swatch theme-swatch-${t.id}`} aria-hidden="true" />
            <span className="choice-text">
              <span>{t.label}</span>
              {t.desc && <span className="hint">{t.desc}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="hint">Vale per questo dispositivo. Il terminale resta scuro.</p>
    </section>
  );
}

function AgentCard({
  agent,
  onOpenTerminal,
  onChanged,
}: {
  agent: AgentStatus;
  onOpenTerminal: (t: TerminalSummary) => void;
  onChanged: () => void;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const loginState = agent.installed ? agent.login.state : 'unknown';
  const [guided, setGuided] = useState(false);
  const loginBtn = useRef<HTMLButtonElement>(null);
  const wasGuided = useRef(false);
  // Chiuso il pannello di accesso, il focus torna al pulsante che l'ha aperto
  useEffect(() => {
    if (wasGuided.current && !guided) loginBtn.current?.focus();
    wasGuided.current = guided;
  }, [guided]);

  const login = async () => {
    setError('');
    try {
      onOpenTerminal(await api.agentLogin(agent.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <article className="agent-card" aria-labelledby={`${id}-name`}>
      <div className="agent-card-head">
        <h3 id={`${id}-name`}>{agent.label}</h3>
        <p className={`badge badge-${loginState}`}>
          <span className="status-dot" aria-hidden="true" />
          {agent.installed ? LOGIN_TEXT[agent.login.state] : 'Non installato'}
        </p>
      </div>
      <p className="agent-detail">
        {agent.version && <span>{agent.version}</span>}
        {agent.version && agent.login.detail && <span aria-hidden="true"> · </span>}
        {agent.login.detail}
      </p>
      {agent.note && <p className="hint">{agent.note}</p>}

      {agent.loginCommand && agent.installed && !guided && (
        <div className="agent-actions">
          {agent.guidedLogin && (
            <button ref={loginBtn} type="button" className={`btn small-btn${agent.login.state === 'ok' ? '' : ' primary'}`} onClick={() => setGuided(true)}>
              <span>{agent.login.state === 'ok' ? 'Accedi di nuovo' : 'Accedi'}</span>
            </button>
          )}
          <button type="button" className="btn small-btn" onClick={() => void login()}>
            <Icon name="terminal" />
            <span>{agent.guidedLogin ? 'Dal terminale' : agent.login.state === 'ok' ? 'Gestisci login' : 'Accedi'}</span>
          </button>
          <span className="hint">
            {agent.guidedLogin ? 'Ti serve solo il browser' : 'Apre un terminale con'} {!agent.guidedLogin && <code>{agent.loginCommand}</code>}
          </span>
        </div>
      )}
      {guided && (
        <AgentLogin
          agentId={agent.id}
          label={agent.label}
          onDone={onChanged}
          onClose={() => {
            setGuided(false);
            onChanged();
          }}
        />
      )}

      {agent.env.map((v) => (
        <SecretField key={v.name} agentId={agent.id} name={v.name} label={v.label} isSet={v.set} onChanged={onChanged} />
      ))}

      {agent.chat && <Defaults agent={agent} />}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

function SecretField({
  agentId,
  name,
  label,
  isSet,
  onChanged,
}: {
  agentId: string;
  name: string;
  label: string;
  isSet: boolean;
  onChanged: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await api.setAgentEnv(agentId, name, value.trim());
      setValue('');
      setMsg('Chiave salvata');
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.setAgentEnv(agentId, name, null);
      setMsg('Chiave rimossa');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="secret-field" onSubmit={save}>
      <label htmlFor={`${id}-v`}>
        {label} <span className="hint">({isSet ? 'impostata' : 'non impostata'})</span>
      </label>
      <div className="secret-row">
        <input
          id={`${id}-v`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isSet ? '•••••••• (inserisci per sostituire)' : name}
          aria-describedby={`${id}-msg`}
        />
        <button type="submit" className="btn small-btn" disabled={busy || !value.trim()}>
          Salva
        </button>
        {isSet && (
          <button type="button" className="btn small-btn" disabled={busy} onClick={() => void remove()}>
            Rimuovi
          </button>
        )}
      </div>
      <p id={`${id}-msg`} className="hint" aria-live="polite">
        {msg}
      </p>
    </form>
  );
}

/** Scelte predefinite (modalita', modello...) per le nuove conversazioni con questo agente */
function Defaults({ agent }: { agent: AgentStatus }) {
  const id = useId();
  const [values, setValues] = useState(agent.defaults);
  const [msg, setMsg] = useState('');
  const selects = agent.options.filter((o): o is ConfigOption & { type: 'select' } => o.type === 'select');

  if (!selects.length) {
    return (
      <p className="hint">
        Modalita' e modello predefiniti: apri una conversazione con {agent.label} e le scelte disponibili compariranno qui.
      </p>
    );
  }

  const change = async (configId: string, value: string) => {
    const v = value === '' ? null : value;
    setValues((d) => {
      const next = { ...d };
      if (v === null) delete next[configId];
      else next[configId] = v;
      return next;
    });
    try {
      await api.setAgentDefault(agent.id, configId, v);
      setMsg('Salvato: vale per le nuove conversazioni');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <fieldset className="defaults">
      <legend>Per le nuove conversazioni</legend>
      <div className="defaults-row">
        {selects.map((o) => (
          <SearchSelect
            key={o.id}
            id={`${id}-${o.id}`}
            label={o.name}
            value={String(values[o.id] ?? '')}
            options={[{ value: '', name: 'Predefinito dell\'agente' }, ...(o.options ?? [])]}
            onChange={(v) => void change(o.id, v)}
          />
        ))}
      </div>
      <p className="hint" aria-live="polite">
        {msg}
      </p>
    </fieldset>
  );
}

function GeneralForm({ general, onSaved }: { general: GeneralSettings; onSaved: (g: GeneralSettings) => void }) {
  const id = useId();
  const [roots, setRoots] = useState(general.projectRoots.join('\n'));
  const [idle, setIdle] = useState(String(general.idleMinutes));
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    setErr('');
    try {
      const g = await api.saveGeneral({
        projectRoots: roots.split('\n').map((r) => r.trim()).filter(Boolean),
        idleMinutes: Number(idle),
      });
      onSaved(g);
      setRoots(g.projectRoots.join('\n'));
      setMsg('Impostazioni salvate');
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        Cartelle e pausa
      </h2>
      <form className="general-form" onSubmit={save}>
        <label htmlFor={`${id}-roots`}>Cartelle consentite</label>
        <textarea
          id={`${id}-roots`}
          className="mono-input"
          rows={4}
          value={roots}
          onChange={(e) => setRoots(e.target.value)}
          aria-describedby={`${id}-roots-hint`}
          spellCheck={false}
        />
        <p id={`${id}-roots-hint`} className="hint">
          Una per riga. Conversazioni e terminali si possono aprire solo qui dentro.
        </p>

        <label htmlFor={`${id}-idle`}>Pausa dopo (minuti di inattivita')</label>
        <input
          id={`${id}-idle`}
          type="number"
          min={1}
          max={1440}
          inputMode="numeric"
          value={idle}
          onChange={(e) => setIdle(e.target.value)}
          className="narrow-input"
          aria-describedby={`${id}-idle-hint`}
        />
        <p id={`${id}-idle-hint`} className="hint">
          Dopo questo tempo l'agente si spegne; al messaggio successivo riprende la stessa sessione.
        </p>

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        <div className="dialog-actions start">
          <button type="submit" className="btn primary">
            Salva
          </button>
          <span className="hint" aria-live="polite">
            {msg}
          </span>
        </div>
      </form>
    </section>
  );
}
