// Impostazioni → Plugin: installa da catalogo o da link privato, attiva/disattiva, disinstalla.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type PluginInfo } from './api';
import { useT } from './i18n';

export function PluginsSection({ onChanged, features }: { onChanged: (list: PluginInfo[]) => void; features: string[] | null }) {
  const id = useId();
  const [list, setList] = useState<PluginInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [error, setError] = useState('');
  const t = useT();
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    api.plugins().then(setList).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const act = async (p: PluginInfo, kind: 'install' | 'uninstall' | 'on' | 'off') => {
    if (kind === 'uninstall' && !confirm(t('plugin.confermaDisinstalla', { nome: p.name }))) return;
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
        {
          install: t('plugin.installatoEAttivo', { nome: p.name }),
          uninstall: t('plugin.disinstallato', { nome: p.name }),
          on: t('plugin.attivato', { nome: p.name }),
          off: t('plugin.disattivato', { nome: p.name }),
        }[kind],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const installFromLink = async (e: FormEvent) => {
    e.preventDefault();
    const url = linkUrl.trim();
    if (!url) return;
    setBusy('__link__');
    setError('');
    try {
      const next = await api.installPluginLink(url);
      setList(next);
      onChanged(next);
      setLinkUrl('');
      setAnnounce(t('plugin.installatoDaLink'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        {t('plugin.titolo')}
      </h2>
      <p className="hint">
        {t('plugin.introduzione')}
      </p>

      <form className="agent-card" onSubmit={(e) => void installFromLink(e)} style={{ marginBottom: 16 }}>
        <label htmlFor={`${id}-link`} style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
          {t('plugin.installaDaLinkTitolo')}
        </label>
        <p className="hint" style={{ marginBottom: 8 }}>
          {t('plugin.installaDaLinkDesc')}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            id={`${id}-link`}
            type="text"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="agicloud://plugin/accessibility"
            style={{ flex: '1 1 260px' }}
          />
          <button type="submit" className="btn small-btn primary" disabled={busy !== null || !linkUrl.trim()}>
            {busy === '__link__' ? t('plugin.installazione') : t('plugin.installaDaLinkBtn')}
          </button>
        </div>
      </form>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!list ? (
        <p className="hint">{t('plugin.caricamento')}</p>
      ) : (
        <ul className="agent-cards">
          {list.map((p) => (
            <li key={p.id}>
              <article className="agent-card plugin-card" aria-labelledby={`${id}-${p.id}`}>
                <div className="agent-card-head">
                  <h3 id={`${id}-${p.id}`}>{p.name}</h3>
                  <p className={`badge badge-${p.enabled ? 'ok' : p.installed ? 'missing' : 'unknown'}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {p.enabled ? t('plugin.attivo') : p.installed ? t('plugin.spento') : t('plugin.nonInstallato')}
                  </p>
                </div>
                <p className="agent-detail">{t('plugin.versione', { v: p.version })}</p>
                <p className="plugin-desc">{p.description}</p>
                {p.requires && <p className="hint">{t('plugin.serve', { req: p.requires })}</p>}
                {p.health && (
                  <p className={p.health.ok ? 'hint' : 'form-error'}>
                    {p.health.ok ? t('plugin.servizioPronto') : t('plugin.servizioNonDisponibile')}: {p.health.detail}
                  </p>
                )}
                <div className="agent-actions">
                  {features !== null && !features.includes(p.id) ? (
                    <p className="hint">{t('plugin.nonInclusoNelPiano')}</p>
                  ) : !p.installed ? (
                    <button type="button" className="btn small-btn primary" disabled={busy !== null} onClick={() => void act(p, 'install')}>
                      {busy === p.id ? t('plugin.installazione') : t('plugin.installa')}
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
                        <span>{p.enabled ? t('plugin.attivo') : t('plugin.spento')}</span>
                      </label>
                      <button type="button" className="btn small-btn" disabled={busy !== null} onClick={() => void act(p, 'uninstall')}>
                        {t('plugin.disinstalla')}
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
