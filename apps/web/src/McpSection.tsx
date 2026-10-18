// Impostazioni → Server MCP: elenco dei server MCP integrati (plugin) e server MCP personalizzati (stdio / http / sse).
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api } from './api';
import { useT } from './i18n';

interface BuiltinMcp {
  name: string;
  label: string;
  enabled: boolean;
}

interface CustomMcp {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export function McpSection() {
  const id = useId();
  const t = useT();
  const [builtin, setBuiltin] = useState<BuiltinMcp[]>([]);
  const [custom, setCustom] = useState<CustomMcp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [type, setType] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [cmdOrUrl, setCmdOrUrl] = useState('');
  const [argsStr, setArgsStr] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.mcp.list();
      setBuiltin(res.builtin ?? []);
      setCustom(res.custom ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addServer = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !cmdOrUrl.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.mcp.save({
        name: name.trim(),
        type,
        command: type === 'stdio' ? cmdOrUrl.trim() : undefined,
        args: type === 'stdio' ? argsStr.trim() : undefined,
        url: type !== 'stdio' ? cmdOrUrl.trim() : undefined,
        enabled: true,
      });
      setBuiltin(res.builtin ?? []);
      setCustom(res.custom ?? []);
      setName('');
      setCmdOrUrl('');
      setArgsStr('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleCustom = async (srvName: string, enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.mcp.setEnabled(srvName, enabled);
      setBuiltin(res.builtin ?? []);
      setCustom(res.custom ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async (srvName: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.mcp.remove(srvName);
      setBuiltin(res.builtin ?? []);
      setCustom(res.custom ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = (tplName: string, tplType: 'stdio' | 'http' | 'sse', tplCmd: string, tplArgs: string) => {
    setName(tplName);
    setType(tplType);
    setCmdOrUrl(tplCmd);
    setArgsStr(tplArgs);
  };

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        {t('mcp.titolo')}
      </h2>
      <p className="hint">{t('mcp.introduzione')}</p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <h3>{t('mcp.integratiTitolo')}</h3>
      {loading ? (
        <p className="hint">{t('impostazioni.caricamento')}</p>
      ) : (
        <ul className="agent-cards" style={{ marginBottom: 20 }}>
          {builtin.map((b) => (
            <li key={b.name}>
              <article className="agent-card">
                <div className="agent-card-head">
                  <h4>{b.name}</h4>
                  <p className={`badge badge-${b.enabled ? 'ok' : 'missing'}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {b.enabled ? t('plugin.attivo') : t('plugin.spento')}
                  </p>
                </div>
                <p className="plugin-desc">{b.label}</p>
              </article>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('mcp.personalizzatiTitolo')}</h3>
      {custom.length === 0 ? (
        <p className="hint" style={{ marginBottom: 16 }}>
          {t('mcp.nessunPersonalizzato')}
        </p>
      ) : (
        <ul className="agent-cards" style={{ marginBottom: 20 }}>
          {custom.map((s) => (
            <li key={s.name}>
              <article className="agent-card">
                <div className="agent-card-head">
                  <h4>
                    {s.name} <small className="hint">({s.type})</small>
                  </h4>
                  <p className={`badge badge-${s.enabled ? 'ok' : 'missing'}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {s.enabled ? t('plugin.attivo') : t('plugin.spento')}
                  </p>
                </div>
                <p className="agent-detail">
                  <code>{s.type === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}` : s.url}</code>
                </p>
                <div className="agent-actions">
                  <label className="switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={s.enabled}
                      disabled={busy}
                      onChange={(e) => void toggleCustom(s.name, e.target.checked)}
                    />
                    <span>{s.enabled ? t('plugin.attivo') : t('plugin.spento')}</span>
                  </label>
                  <button type="button" className="btn small-btn" disabled={busy} onClick={() => void removeCustom(s.name)}>
                    {t('files.elimina')}
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      <form className="agent-card" onSubmit={(e) => void addServer(e)}>
        <h3 style={{ marginTop: 0 }}>{t('mcp.aggiungiTitolo')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            type="button"
            className="btn small-btn"
            onClick={() => applyTemplate('accessibility', 'stdio', 'node', '/home/user/agicloud-plugin-accessibility/mcp-server.mjs')}
          >
            + Accessibilità (WCAG & CogaGuard)
          </button>
          <button
            type="button"
            className="btn small-btn"
            onClick={() => applyTemplate('filesystem', 'stdio', 'npx', '-y @modelcontextprotocol/server-filesystem /home/user')}
          >
            + Filesystem
          </button>
          <button
            type="button"
            className="btn small-btn"
            onClick={() => applyTemplate('fetch', 'stdio', 'npx', '-y @modelcontextprotocol/server-fetch')}
          >
            + Fetch
          </button>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <label>
            <span className="field-label">{t('mcp.nomeLabel')}</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="es. accessibility" required />
          </label>
          <label>
            <span className="field-label">{t('mcp.tipoLabel')}</span>
            <select value={type} onChange={(e) => setType(e.target.value as 'stdio' | 'http' | 'sse')}>
              <option value="stdio">stdio (comando locale)</option>
              <option value="http">HTTP (Streamable HTTP)</option>
              <option value="sse">SSE</option>
            </select>
          </label>
          <label>
            <span className="field-label">{type === 'stdio' ? t('mcp.comandoLabel') : 'URL'}</span>
            <input
              type="text"
              value={cmdOrUrl}
              onChange={(e) => setCmdOrUrl(e.target.value)}
              placeholder={type === 'stdio' ? 'node / npx / python3' : 'https://...'}
              required
            />
          </label>
          {type === 'stdio' && (
            <label>
              <span className="field-label">{t('mcp.argomentiLabel')}</span>
              <input
                type="text"
                value={argsStr}
                onChange={(e) => setArgsStr(e.target.value)}
                placeholder="/percorso/script.mjs --opzione"
              />
            </label>
          )}
          <div>
            <button type="submit" className="btn primary" disabled={busy || !name.trim() || !cmdOrUrl.trim()}>
              {t('mcp.salvaBtn')}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
