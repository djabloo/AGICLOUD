import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type AgentInfo } from './api';
import { useT } from './i18n';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const idx = s.indexOf(',');
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error('File read error'));
    reader.readAsDataURL(file);
  });
}

export function AccessibilitySection({
  agents,
  browserEnabled,
  onThreadCreated,
}: {
  agents: AgentInfo[];
  browserEnabled: boolean;
  onThreadCreated?: (id: string) => void;
}) {
  const id = useId();
  const t = useT();
  const [tab, setTab] = useState<'audit' | 'vision' | 'coga' | 'pdf' | 'reports'>('audit');
  const [url, setUrl] = useState('https://');
  const [mode, setMode] = useState<'full' | 'wcag-pro' | 'wcag-standard' | 'cogaguard'>('full');
  const [agentId, setAgentId] = useState<string>(() => agents.find((a) => a.id === 'agy')?.id ?? agents[0]?.id ?? 'agy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auditResult, setAuditResult] = useState<{ wcag: any; cogaguard: any; report: any } | null>(null);

  // Vision
  const [visionContext, setVisionContext] = useState('');
  const [visionResult, setVisionResult] = useState<any>(null);

  // CogaGuard Decision Card
  const [cogaText, setCogaText] = useState('');
  const [cogaResult, setCogaResult] = useState<any>(null);

  // PDF to Markdown
  const [pdfMdResult, setPdfMdResult] = useState<string>('');

  // Reports
  const [reports, setReports] = useState<any[]>([]);

  const loadReports = async () => {
    try {
      const r = await api.accessibility.reports();
      setReports(r.reports ?? []);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void loadReports();
  }, []);

  const runAudit = async (e: FormEvent) => {
    e.preventDefault();
    const target = url.trim();
    if (!target || target === 'https://') return;
    setBusy(true);
    setError('');
    setAuditResult(null);
    try {
      const res = await api.accessibility.audit({ url: target, mode });
      setAuditResult(res);
      void loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const launchAgentInBrowser = async () => {
    const target = url.trim();
    if (!target || target === 'https://') {
      setError(t('a11y.inserisciUrl'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const proj = await api.projects().catch(() => ({ roots: ['/home/user/agicloud'], recent: [] }));
      const cwd = proj.recent[0] || proj.roots[0] || '/home/user/agicloud';
      const { skill } = await api.accessibility.skill().catch(() => ({ skill: '' }));
      const thread = await api.createThread(agentId, cwd, false, null, browserEnabled);
      if (agentId === 'agy') {
        await api.setConfig(thread.id, 'permissions', 'all').catch(() => {});
      }
      const prompt = [
        skill || '',
        '',
        `Esegui un Audit e Test Utente Reale di Accessibilita' a 360° sul sito: ${target}`,
        `1. Usa gli strumenti MCP del server "accessibility" (wcag_audit_pro / wcag_audit e cogaguard_scan) su ${target}.`,
        `2. Apri ${target} nel Browser condiviso e testa realmente l'esperienza utente davanti al monitor per:`,
        `   - Cecita' e Screen Reader (albero ARIA, landmark, headings, alt-text, form labels)`,
        `   - Ipovisione, Daltonismo e Zoom 200%/400% (contrasti e tenuta del layout, screenshot con wcag_vision_expert)`,
        `   - Sordita' e Ipoacusia (sottotitoli <track kind="captions">, trascrizioni, segnali visivi)`,
        `   - Disabilita' Motorie e Navigazione solo da Tastiera (Tab, Shift+Tab, Enter, Escape, focus visibile, skip link, assenza di keyboard traps)`,
        `   - Problemi Cognitivi, DSA e ADHD (chiarezza testi, moduli, errori, animazioni distraenti con CogaGuard)`,
        `3. Al termine genera il report completo nei 3 formati (PDF, HTML e Markdown) con lo strumento MCP "accessibility_save_report" includendo tutti i suggerimenti di codice per migliorare il sito.`,
      ].join('\n');
      await api.run(thread.id, prompt);
      onThreadCreated?.(thread.id);
      window.location.hash = `#/t/${thread.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVisionUpload = async (file: File) => {
    setBusy(true);
    setError('');
    setVisionResult(null);
    try {
      const image_base64 = await fileToBase64(file);
      const res = await api.accessibility.vision({ image_base64, context: visionContext || file.name });
      setVisionResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVisionFromBrowser = async () => {
    setBusy(true);
    setError('');
    setVisionResult(null);
    try {
      const blob = await api.browserScreenshot();
      const file = new File([blob], 'browser-screenshot.png', { type: 'image/png' });
      const image_base64 = await fileToBase64(file);
      const res = await api.accessibility.vision({ image_base64, context: visionContext || 'Browser condiviso' });
      setVisionResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSimplify = async (e: FormEvent) => {
    e.preventDefault();
    if (!cogaText.trim()) return;
    setBusy(true);
    setError('');
    setCogaResult(null);
    try {
      const res = await api.accessibility.simplify({ text: cogaText.trim() });
      setCogaResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePdfUpload = async (file: File) => {
    setBusy(true);
    setError('');
    setPdfMdResult('');
    try {
      const pdf_base64 = await fileToBase64(file);
      const res = await api.accessibility.pdfToMd({ pdf_base64, fileName: file.name, pageCount: 1 });
      setPdfMdResult(String(res?.markdown || JSON.stringify(res, null, 2)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings" aria-labelledby={`${id}-title`}>
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>{t('a11y.titolo')}</h1>
          <p className="chat-meta">{t('a11y.sottotitolo')}</p>
        </div>
      </header>

      <div className="settings-body" style={{ padding: 20, maxWidth: 1040, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'audit'} className={`btn small-btn ${tab === 'audit' ? 'primary' : ''}`} onClick={() => setTab('audit')}>
            {t('a11y.tabAudit')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'vision'} className={`btn small-btn ${tab === 'vision' ? 'primary' : ''}`} onClick={() => setTab('vision')}>
            {t('a11y.tabVision')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'coga'} className={`btn small-btn ${tab === 'coga' ? 'primary' : ''}`} onClick={() => setTab('coga')}>
            {t('a11y.tabCoga')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'pdf'} className={`btn small-btn ${tab === 'pdf' ? 'primary' : ''}`} onClick={() => setTab('pdf')}>
            {t('a11y.tabPdf')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'reports'}
            className={`btn small-btn ${tab === 'reports' ? 'primary' : ''}`}
            onClick={() => {
              setTab('reports');
              void loadReports();
            }}
          >
            {t('a11y.tabReport')} ({reports.length})
          </button>
        </div>

        {error && (
          <p className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>
            {error}
          </p>
        )}

        {tab === 'audit' && (
          <div style={{ display: 'grid', gap: 16 }}>
            <form className="agent-card" onSubmit={(e) => void runAudit(e)}>
              <h2 style={{ marginTop: 0 }}>{t('a11y.auditTitolo')}</h2>
              <p className="hint">{t('a11y.auditDesc')}</p>
              <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                <label>
                  <span className="field-label">URL</span>
                  <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://esempio.it" required />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                  <label>
                    <span className="field-label">{t('a11y.modalitaLabel')}</span>
                    <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                      <option value="full">{t('a11y.modeFull')}</option>
                      <option value="wcag-pro">{t('a11y.modeWcagPro')}</option>
                      <option value="wcag-standard">{t('a11y.modeWcagStd')}</option>
                      <option value="cogaguard">{t('a11y.modeCoga')}</option>
                    </select>
                  </label>
                  <label>
                    <span className="field-label">{t('impostazioni.voceAgenti')}</span>
                    <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
                  <button type="submit" className="btn primary" disabled={busy}>
                    {busy ? t('a11y.analisiInCorso') : t('a11y.avviaAuditN8n')}
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void launchAgentInBrowser()}>
                    {t('a11y.avviaAgenteBrowser')}
                  </button>
                </div>
              </div>
            </form>

            {auditResult?.report && (
              <article className="agent-card">
                <div className="agent-card-head">
                  <h3>{auditResult.report.title}</h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {auditResult.report.hasPdf && (
                      <a className="btn small-btn primary" href={api.accessibility.reportUrl(auditResult.report.id, 'pdf', true)} target="_blank" rel="noopener noreferrer">
                        PDF
                      </a>
                    )}
                    <a className="btn small-btn" href={api.accessibility.reportUrl(auditResult.report.id, 'html', false)} target="_blank" rel="noopener noreferrer">
                      HTML
                    </a>
                    <a className="btn small-btn" href={api.accessibility.reportUrl(auditResult.report.id, 'md', true)} target="_blank" rel="noopener noreferrer">
                      Markdown (.md)
                    </a>
                  </div>
                </div>
                <p className="hint" style={{ marginTop: 8 }}>
                  WCAG: <strong>{auditResult.report.scores?.wcag ?? '—'}</strong> &middot; Visivo:{' '}
                  <strong>{auditResult.report.scores?.visual ?? '—'}</strong> &middot; CogaGuard Cognitivo:{' '}
                  <strong>{auditResult.report.scores?.cognitive ?? '—'}</strong> &middot; Globale:{' '}
                  <strong>{auditResult.report.scores?.overall ?? '—'}</strong>
                </p>
              </article>
            )}
          </div>
        )}

        {tab === 'vision' && (
          <div className="agent-card" style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ marginTop: 0 }}>{t('a11y.tabVision')}</h2>
            <p className="hint">{t('a11y.visionDesc')}</p>
            <label>
              <span className="field-label">{t('a11y.contestoLabel')}</span>
              <input type="text" value={visionContext} onChange={(e) => setVisionContext(e.target.value)} placeholder="es. Homepage desktop, Modulo login..." />
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label className="btn primary" style={{ cursor: 'pointer' }}>
                {t('a11y.caricaImmagine')}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleVisionUpload(f);
                  }}
                />
              </label>
              {browserEnabled && (
                <button type="button" className="btn" disabled={busy} onClick={() => void handleVisionFromBrowser()}>
                  {t('chat.screenshotCondiviso')}
                </button>
              )}
            </div>
            {visionResult && (
              <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', padding: 12, borderRadius: 8, background: 'var(--bg-elevated)' }}>
                {JSON.stringify(visionResult, null, 2)}
              </pre>
            )}
          </div>
        )}

        {tab === 'coga' && (
          <form className="agent-card" onSubmit={(e) => void handleSimplify(e)} style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ marginTop: 0 }}>{t('a11y.tabCoga')}</h2>
            <p className="hint">{t('a11y.cogaDesc')}</p>
            <textarea rows={6} value={cogaText} onChange={(e) => setCogaText(e.target.value)} placeholder={t('a11y.cogaPlaceholder')} required />
            <div>
              <button type="submit" className="btn primary" disabled={busy || !cogaText.trim()}>
                {busy ? t('a11y.analisiInCorso') : t('a11y.semplificaBtn')}
              </button>
            </div>
            {cogaResult && (
              <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', padding: 12, borderRadius: 8, background: 'var(--bg-elevated)' }}>
                {JSON.stringify(cogaResult, null, 2)}
              </pre>
            )}
          </form>
        )}

        {tab === 'pdf' && (
          <div className="agent-card" style={{ display: 'grid', gap: 12 }}>
            <h2 style={{ marginTop: 0 }}>{t('a11y.tabPdf')}</h2>
            <p className="hint">{t('a11y.pdfDesc')}</p>
            <div>
              <label className="btn primary" style={{ cursor: 'pointer' }}>
                {t('a11y.caricaPdf')}
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  style={{ display: 'none' }}
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handlePdfUpload(f);
                  }}
                />
              </label>
            </div>
            {pdfMdResult && (
              <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', padding: 12, borderRadius: 8, background: 'var(--bg-elevated)' }}>
                {pdfMdResult}
              </pre>
            )}
          </div>
        )}

        {tab === 'reports' && (
          <div style={{ display: 'grid', gap: 12 }}>
            {reports.length === 0 ? (
              <p className="hint">{t('a11y.nessunReport')}</p>
            ) : (
              <ul className="agent-cards">
                {reports.map((r) => (
                  <li key={r.id}>
                    <article className="agent-card">
                      <div className="agent-card-head">
                        <h3>{r.title || r.url}</h3>
                        <span className="hint">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</span>
                      </div>
                      <p className="agent-detail">{r.url}</p>
                      <div className="agent-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {r.hasPdf && (
                          <a className="btn small-btn primary" href={api.accessibility.reportUrl(r.id, 'pdf', true)} target="_blank" rel="noopener noreferrer">
                            PDF
                          </a>
                        )}
                        {!r.onlyPdf && (
                          <>
                            <a className="btn small-btn" href={api.accessibility.reportUrl(r.id, 'html', false)} target="_blank" rel="noopener noreferrer">
                              HTML
                            </a>
                            <a className="btn small-btn" href={api.accessibility.reportUrl(r.id, 'md', true)} target="_blank" rel="noopener noreferrer">
                              Markdown (.md)
                            </a>
                          </>
                        )}
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
