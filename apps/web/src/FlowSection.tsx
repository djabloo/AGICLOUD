// Plugin Google Flow: genera video (Veo) e immagini (Imagen/Nano) e sfoglia la galleria.
// Header con stato di connessione e crediti; se non autenticato, login agevolato con Google.
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { api, type FlowFile, type FlowModel, type FlowStatus } from './api';
import { useT } from './i18n';

type Kind = 'video' | 'image';

export function FlowSection() {
  const t = useT();
  const id = useId();
  const [status, setStatus] = useState<FlowStatus | null>(null);
  const [models, setModels] = useState<FlowModel[]>([]);
  const [files, setFiles] = useState<FlowFile[]>([]);
  const [kind, setKind] = useState<Kind>('video');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, m, g] = await Promise.all([api.flowStatus(), api.flowModels(), api.flowGallery()]);
      setStatus(s);
      setModels(m.models);
      setFiles(g.files);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const kindModels = models.filter((m) => m.kind === kind);
  const activeModel = model && kindModels.some((m) => m.id === model) ? model : (kindModels[0]?.id ?? '');

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.flowLogin(email.trim() || undefined);
      setMsg({
        kind: 'ok',
        text: r.linked ? t('flow.collegatoCome', { email: r.account ?? email.trim() }) : t('flow.apriLink', { url: r.url ?? 'https://labs.google/fx/flow' }),
      });
      setEmail('');
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
      const r = await api.flowGenerate({ prompt: prompt.trim(), kind, model: activeModel, aspect });
      setMsg({ kind: 'ok', text: t('flow.avviato', { job: r.job }) });
      setPrompt('');
      setTimeout(() => void refresh(), 5000);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

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
              ? t('flow.collegatoCome', { email: status.account ?? '' }) +
                (status.credits !== null ? ` · ${t('flow.crediti', { n: status.credits })}` : '')
              : t('flow.nonCollegato')}
        </p>
      </header>

      <div className="pii-body">
        <div aria-live="polite" className="pii-msg-wrap">
          {msg && <p className={`pii-msg pii-msg-${msg.kind}`}>{msg.text}</p>}
        </div>

        {status !== null && !status.linked && (
          <form className="pii-card" onSubmit={(e) => void login(e)} aria-labelledby={`${id}-login`}>
            <h2 id={`${id}-login`}>{t('flow.accediTitolo')}</h2>
            <p className="hint">{t('flow.accediTesto')}</p>
            <div className="pii-field">
              <label htmlFor={`${id}-email`}>{t('flow.email')}</label>
              <input id={`${id}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('flow.emailPlaceholder')} />
            </div>
            <div className="agent-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {t('flow.accedi')}
              </button>
            </div>
          </form>
        )}

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
            <select id={`${id}-aspect`} value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {['16:9', '9:16', '1:1'].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="agent-actions">
            <button type="submit" className="btn primary" disabled={busy || !status?.linked}>
              {busy ? t('flow.generazione') : t('flow.genera')}
            </button>
          </div>
        </form>

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
  const url = `/api/flow/raw?name=${encodeURIComponent(file.name)}`;
  return (
    <li className="flow-item">
      {file.kind === 'video' ? (
        <video src={url} controls preload="metadata" />
      ) : file.kind === 'image' ? (
        <img src={url} alt={file.name} loading="lazy" />
      ) : (
        <a href={url} target="_blank" rel="noreferrer">
          {file.name}
        </a>
      )}
      <span className="hint">{file.name}</span>
    </li>
  );
}
