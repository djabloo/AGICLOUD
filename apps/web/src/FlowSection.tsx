// Plugin Google Flow: genera video (Veo) e immagini (Imagen/Nano) e sfoglia la galleria.
// Il primo accesso con Google si fa in una finestra con lo schermo virtuale del server (noVNC); poi il collegamento resta salvato.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, apiFetch, type FlowFile, type FlowJob, type FlowModel, type FlowStatus } from './api';
import { fmtDateTime, useT } from './i18n';

type Kind = 'video' | 'image';

export function FlowSection() {
  const t = useT();
  const id = useId();
  const [status, setStatus] = useState<FlowStatus | null>(null);
  const [models, setModels] = useState<FlowModel[]>([]);
  const [aspects, setAspects] = useState<Record<Kind, string[]>>({ video: ['16:9', '9:16'], image: ['16:9', '9:16', '1:1'] });
  const [files, setFiles] = useState<FlowFile[]>([]);
  const [jobs, setJobs] = useState<FlowJob[]>([]);
  const [kind, setKind] = useState<Kind>('video');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [aspect, setAspect] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const wasLinked = useRef<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, m, g] = await Promise.all([api.flowStatus(), api.flowModels(), api.flowGallery()]);
      setStatus(s);
      setModels(m.models);
      setAspects(m.aspects);
      setFiles(g.files);
      setJobs(g.jobs);
      if (wasLinked.current === false && s.linked) setMsg({ kind: 'ok', text: t('flow.collegatoOk') });
      wasLinked.current = s.linked;
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Controllo periodico mentre si attende l'accesso o c'e' una generazione in corso
  const waiting = Boolean(status?.login) || jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const kindModels = models.filter((m) => m.kind === kind);
  const activeModel = model && kindModels.some((m) => m.id === model) ? model : (kindModels[0]?.id ?? '');
  const activeAspect = aspects[kind].includes(aspect) ? aspect : (aspects[kind][0] ?? '');

  const login = async () => {
    setBusy(true);
    setMsg(null);
    // La finestra si apre subito (al clic) per non essere bloccata dal browser; l'indirizzo arriva dopo
    const win = window.open('', '_blank');
    try {
      const r = await api.flowLogin();
      if (win) win.location.href = r.url;
      else setMsg({ kind: 'err', text: t('flow.popupBloccato') });
      await refresh();
    } catch (err) {
      win?.close();
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const loginDone = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.flowLoginDone();
      setMsg({ kind: 'ok', text: t('flow.verifica') });
      await refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = async () => {
    await api.flowLoginCancel().catch(() => {});
    await refresh();
  };

  const refreshCredits = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.flowCredits();
      await refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      setMsg({ kind: 'err', text: t('flow.scriviPrompt') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.flowGenerate({ prompt: prompt.trim(), kind, model: activeModel, aspect: activeAspect });
      setMsg({ kind: 'ok', text: t('flow.avviato', { job: r.job }) });
      setPrompt('');
      await refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const jobState = (j: FlowJob) => (j.status === 'running' ? t('flow.lavoroInCorso') : j.status === 'done' ? t('flow.lavoroFatto') : t('flow.lavoroErrore'));

  return (
    <section className="pii" aria-labelledby={`${id}-title`}>
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>{t('flow.titolo')}</h1>
          <p className="chat-meta">{t('flow.sottotitolo')}</p>
        </div>
        <p className="chat-meta" role="status">
          {status === null
            ? t('flow.caricamento')
            : status.linked
              ? t('flow.collegatoCome', { email: status.account ?? '' }) + (status.credits !== null ? ` · ${t('flow.crediti', { n: status.credits })}` : '')
              : t('flow.nonCollegato')}
        </p>
      </header>

      <div className="pii-body">
        <div aria-live="polite" className="pii-msg-wrap">
          {msg && <p className={`pii-msg pii-msg-${msg.kind}`}>{msg.text}</p>}
        </div>

        {status !== null && !status.docker && (
          <section className="pii-card" aria-labelledby={`${id}-motore`}>
            <h2 id={`${id}-motore`}>{t('flow.motoreTitolo')}</h2>
            <p className="hint">{t('flow.motoreTesto')}</p>
            <p>
              <code>docker build -t agicloud-gflow:latest services/gflow</code>
            </p>
          </section>
        )}

        {status !== null && status.docker && !status.linked && (
          <section className="pii-card" aria-labelledby={`${id}-login`}>
            <h2 id={`${id}-login`}>{t('flow.accediTitolo')}</h2>
            <p className="hint">{t('flow.accediTesto')}</p>
            {status.login ? (
              <>
                <p role="status">{t('flow.accessoInCorso')}</p>
                <p className="hint">{t('flow.finitoHint')}</p>
                <div className="agent-actions">
                  <a className="btn" href={status.login.url} target="_blank" rel="noopener noreferrer">
                    {t('flow.riapri')}
                  </a>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void loginDone()}>
                    {t('flow.finito')}
                  </button>
                  <button type="button" className="btn" onClick={() => void cancelLogin()}>
                    {t('flow.annulla')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {status.loginProblem && (
                  <p className="pii-msg pii-msg-err" role="alert">
                    {t('flow.accessoFallito', { motivo: status.loginProblem })}
                  </p>
                )}
                <div className="agent-actions">
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void login()}>
                    {t('flow.accedi')}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {status?.linked && (
          <form className="pii-card" onSubmit={(e) => void generate(e)} aria-labelledby={`${id}-gen`}>
            <h2 id={`${id}-gen`}>{t('flow.generaTitolo')}</h2>
            <fieldset className="pii-mode">
              <legend>{t('flow.tipo')}</legend>
              <label className="choice">
                <input type="radio" name={`${id}-kind`} checked={kind === 'video'} onChange={() => setKind('video')} />
                <span className="choice-text">{t('flow.video')}</span>
              </label>
              <label className="choice">
                <input type="radio" name={`${id}-kind`} checked={kind === 'image'} onChange={() => setKind('image')} />
                <span className="choice-text">{t('flow.immagine')}</span>
              </label>
            </fieldset>
            <div className="pii-field">
              <label htmlFor={`${id}-prompt`}>{t('flow.prompt')}</label>
              <textarea id={`${id}-prompt`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('flow.promptPlaceholder')} rows={3} />
            </div>
            <div className="pii-field">
              <label htmlFor={`${id}-model`}>{t('flow.modello')}</label>
              <select id={`${id}-model`} value={activeModel} onChange={(e) => setModel(e.target.value)}>
                {kindModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="pii-field">
              <label htmlFor={`${id}-aspect`}>{t('flow.formato')}</label>
              <select id={`${id}-aspect`} value={activeAspect} onChange={(e) => setAspect(e.target.value)}>
                {aspects[kind].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="agent-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? t('flow.generazione') : t('flow.genera')}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void refreshCredits()}>
                {t('flow.aggiornaCrediti')}
              </button>
            </div>
          </form>
        )}

        {jobs.length > 0 && (
          <section className="pii-card" aria-labelledby={`${id}-jobs`}>
            <h2 id={`${id}-jobs`}>{t('flow.lavoriTitolo')}</h2>
            <ul className="flow-jobs">
              {jobs.map((j) => (
                <li key={j.job}>
                  <strong>{jobState(j)}</strong> · {j.kind === 'video' ? t('flow.video') : t('flow.immagine')} · {j.model} · {j.aspect} · {fmtDateTime(j.startedAt, { timeStyle: 'short', dateStyle: 'short' })}
                  <br />
                  <span className="hint">{j.prompt.length > 120 ? `${j.prompt.slice(0, 120)}…` : j.prompt}</span>
                  {j.status === 'error' && <span className="hint"> — {j.error === 'interrupted' ? t('flow.lavoroInterrotto') : j.error}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="pii-card" aria-labelledby={`${id}-gal`}>
          <div className="group-head">
            <h2 id={`${id}-gal`}>{t('flow.galleria')}</h2>
            <button type="button" className="btn small-btn" onClick={() => void refresh()}>
              {t('flow.aggiorna')}
            </button>
          </div>
          {files.length === 0 ? (
            <p className="hint">{t('flow.vuota')}</p>
          ) : (
            <ul className="flow-grid">
              {files.map((f) => (
                <GalleryItem key={f.name} file={f} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

function GalleryItem({ file }: { file: FlowFile }) {
  // Il file passa da /api: serve il token, quindi si scarica con fetch e si mostra come blob
  const [url, setUrl] = useState('');
  useEffect(() => {
    let revoked = '';
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(`/flow/raw?name=${encodeURIComponent(file.name)}`);
        const blob = await res.blob();
        if (!alive) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      } catch {
        /* resta senza anteprima */
      }
    })();
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [file.name]);
  return (
    <li className="flow-item">
      {file.kind === 'video' ? <video src={url || undefined} controls preload="metadata" /> : <img src={url || undefined} alt={file.name} loading="lazy" />}
      <span className="hint">{file.name}</span>
    </li>
  );
}
