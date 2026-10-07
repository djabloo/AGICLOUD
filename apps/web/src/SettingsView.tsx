import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, setToken, type AgentStatus, type GeneralSettings, type TerminalSummary } from './api';
import type { ConfigOption } from './transcript';
import { Icon } from './icons';
import { VaultSection } from './VaultSection';

const LOGIN_TEXT: Record<AgentStatus['login']['state'], string> = {
  ok: 'Collegato',
  missing: 'Non collegato',
  unknown: 'Stato sconosciuto',
};

export function SettingsView({ onOpenTerminal, onLogout }: { onOpenTerminal: (t: TerminalSummary) => void; onLogout: () => void }) {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [announce, setAnnounce] = useState('');

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

  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="settings-title">Impostazioni</h1>
          <p className="chat-meta">Login degli agenti, permessi predefiniti, chiavi, cartelle, accesso</p>
        </div>
      </header>

      <div className="settings-body">
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}

        <section aria-labelledby="agents-title" className="settings-group">
          <div className="group-head">
            <h2 id="agents-title">Agenti</h2>
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

        <VaultSection />

        {general && <GeneralForm general={general} onSaved={setGeneral} />}

        <section aria-labelledby="access-title" className="settings-group">
          <h2 id="access-title">Accesso</h2>
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
      </div>

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
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

      {agent.loginCommand && agent.installed && (
        <div className="agent-actions">
          <button type="button" className="btn small-btn" onClick={() => void login()}>
            <Icon name="terminal" />
            <span>{agent.login.state === 'ok' ? 'Gestisci login' : 'Accedi'}</span>
          </button>
          <span className="hint">
            Apre un terminale con <code>{agent.loginCommand}</code>
          </span>
        </div>
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
          <label key={o.id} className="cfg" htmlFor={`${id}-${o.id}`}>
            <span className="cfg-name">{o.name}</span>
            <select id={`${id}-${o.id}`} value={String(values[o.id] ?? '')} onChange={(e) => void change(o.id, e.target.value)}>
              <option value="">Predefinito dell'agente</option>
              {(o.options ?? []).flatMap((opt) =>
                'group' in opt
                  ? opt.options.map((g) => (
                      <option key={g.value} value={g.value}>
                        {g.name}
                      </option>
                    ))
                  : [
                      <option key={opt.value} value={opt.value}>
                        {opt.name}
                      </option>,
                    ],
              )}
            </select>
          </label>
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
      <h2 id={`${id}-title`}>Generale</h2>
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
