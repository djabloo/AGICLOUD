// Impostazioni → Plugin: installa, attiva/disattiva, disinstalla.
import { useEffect, useId, useState } from 'react';
import { api, type PluginInfo } from './api';

export function PluginsSection({ onChanged, features }: { onChanged: (list: PluginInfo[]) => void; features: string[] | null }) {
  const id = useId();
  const [list, setList] = useState<PluginInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    api.plugins().then(setList).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const act = async (p: PluginInfo, kind: 'install' | 'uninstall' | 'on' | 'off') => {
    if (kind === 'uninstall' && !confirm(`Disinstallare ${p.name}? La sua sezione sparisce; potrai reinstallarlo quando vuoi.`)) return;
    setBusy(p.id);
    setError('');
    try {
      const next =
        kind === 'install'
          ? await api.installPlugin(p.id)
          : kind === 'uninstall'
            ? await api.uninstallPlugin(p.id)
            : await api.setPluginEnabled(p.id, kind === 'on');
      setList(next);
      onChanged(next);
      setAnnounce(
        { install: `${p.name} installato e attivo`, uninstall: `${p.name} disinstallato`, on: `${p.name} attivato`, off: `${p.name} disattivato` }[kind],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        Plugin
      </h2>
      <p className="hint">
        Funzioni in piu' da aggiungere quando servono. Un plugin spento sparisce dal menu ma resta installato; disinstallato
        libera anche quello che aveva preparato sul server.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!list ? (
        <p className="hint">Caricamento…</p>
      ) : (
        <ul className="agent-cards">
          {list.map((p) => (
            <li key={p.id}>
              <article className="agent-card plugin-card" aria-labelledby={`${id}-${p.id}`}>
                <div className="agent-card-head">
                  <h3 id={`${id}-${p.id}`}>{p.name}</h3>
                  <p className={`badge badge-${p.enabled ? 'ok' : p.installed ? 'missing' : 'unknown'}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {p.enabled ? 'Attivo' : p.installed ? 'Spento' : 'Non installato'}
                  </p>
                </div>
                <p className="agent-detail">Versione {p.version}</p>
                <p className="plugin-desc">{p.description}</p>
                {p.requires && <p className="hint">Serve: {p.requires}</p>}
                {p.health && (
                  <p className={p.health.ok ? 'hint' : 'form-error'}>
                    {p.health.ok ? 'Servizio pronto' : 'Servizio non disponibile'}: {p.health.detail}
                  </p>
                )}
                <div className="agent-actions">
                  {features !== null && !features.includes(p.id) ? (
                    <p className="hint">Non incluso nel tuo piano</p>
                  ) : !p.installed ? (
                    <button type="button" className="btn small-btn primary" disabled={busy !== null} onClick={() => void act(p, 'install')}>
                      {busy === p.id ? 'Installazione…' : 'Installa'}
                    </button>
                  ) : (
                    <>
                      <label className="switch">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={p.enabled}
                          disabled={busy !== null}
                          onChange={(e) => void act(p, e.target.checked ? 'on' : 'off')}
                        />
                        <span>{p.enabled ? 'Attivo' : 'Spento'}</span>
                      </label>
                      <button type="button" className="btn small-btn" disabled={busy !== null} onClick={() => void act(p, 'uninstall')}>
                        Disinstalla
                      </button>
                    </>
                  )}
                </div>
                {p.credits && (
                  <p className="hint">
                    <a href={p.credits.url} target="_blank" rel="noopener noreferrer">
                      {p.credits.text}
                    </a>
                  </p>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}
