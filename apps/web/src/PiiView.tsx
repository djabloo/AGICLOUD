// Plugin PII: anonimizza testi e documenti con il motore Rizzo-PII (in locale sul server).
// Il dizionario reversibile (segnaposto -> valore) resta solo in questo browser:
// "Salva per l'agente" scrive sempre e solo la versione anonimizzata.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type PiiPdf, type PiiResult, type PiiTag } from './api';
import { ProjectPicker } from './ProjectPicker';
import { copyText } from './termText';
import { useT } from './i18n';

const MAP_KEY = 'agicloud_pii_map';
const MAPPING_KEY = 'agicloud_pii_mapping_on';
const FILE_TYPES = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';

type View = 'anon' | 'marked' | 'entities' | 'pdf';

function storedMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MAP_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function PiiView() {
  const t = useT();
  const id = useId();
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState<PiiTag[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [mapping, setMapping] = useState(() => localStorage.getItem(MAPPING_KEY) !== '0');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [result, setResult] = useState<PiiResult | null>(null);
  const [pdf, setPdf] = useState<PiiPdf | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [view, setView] = useState<View>('anon');
  const [project, setProject] = useState('');
  const [saved, setSaved] = useState<{ path: string; abs: string } | null>(null);
  const [decIn, setDecIn] = useState('');

  useEffect(() => {
    api
      .piiTags()
      .then(setTags)
      .catch((err) => setMsg({ kind: 'err', text: t('pii.engineDown', { err: err instanceof Error ? err.message : String(err) }) }));
  }, [t]);

  // Le immagini delle pagine sono blob locali: si liberano quando cambiano
  useEffect(() => () => pages.forEach((u) => URL.revokeObjectURL(u)), [pages]);

  const isPdf = mode === 'file' && Boolean(file?.name.toLowerCase().endsWith('.pdf'));

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'text' ? !text.trim() : !file) {
      setMsg({ kind: 'warn', text: mode === 'text' ? t('pii.pasteFirst') : t('pii.chooseDocFirst') });
      return;
    }
    setMsg(null);
    setSaved(null);
    setPdf(null);
    setPages([]);
    setBusy(t('pii.analyzing'));
    try {
      const r = await api.piiAnalyze(mode === 'text' ? { text } : { file: file! }, excluded, mapping);
      setResult(r);
      if (mapping && r.mapping) localStorage.setItem(MAP_KEY, JSON.stringify({ ...storedMap(), ...r.mapping }));
      let note = '';
      let residual = false;
      if (isPdf) {
        setBusy(t('pii.preparingPdf'));
        const d = await api.piiPdfPreview(file!, excluded);
        setPdf(d);
        const urls: string[] = [];
        for (let i = 0; i < (d.n_pages || 1); i++) urls.push(URL.createObjectURL(await api.piiPage(d.doc_id, i)));
        setPages(urls);
        setView('pdf');
        note = ` ${t(d.n_pages === 1 ? 'pii.pdfNoteOne' : 'pii.pdfNoteOther', { n: d.redactions, p: d.n_pages })}`;
        if (d.residual) {
          residual = true;
          note += ` ${t('pii.residual', { n: d.residual })}`;
        }
      } else setView('anon');
      setMsg(
        r.n_entities
          ? { kind: residual ? 'warn' : 'ok', text: t('pii.foundResult', { n: r.n_entities, u: r.n_unique, note }) }
          : { kind: 'warn', text: t('pii.noneFound', { note }) },
      );
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!project.trim()) {
      setMsg({ kind: 'warn', text: t('pii.chooseProject') });
      return;
    }
    setBusy(t('pii.saving'));
    try {
      const name = mode === 'file' && file ? file.name : `testo-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      const r = await api.piiSave(
        pdf ? { project, name, exclude_tags: excluded, doc_id: pdf.doc_id } : { project, name, exclude_tags: excluded, text: result?.anonymized_text ?? '' },
      );
      setSaved(r);
      setMsg({ kind: 'ok', text: t('pii.savedIn', { path: r.path }) });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy('');
    }
  };

  const downloadPdf = async () => {
    if (!pdf) return;
    const url = URL.createObjectURL(await api.piiDocFile(pdf.doc_id));
    const a = document.createElement('a');
    a.href = url;
    a.download = pdf.filename || 'documento_anonimizzato.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const map = storedMap();
  const decoded = decode(decIn, map);
  const tagName = (tg: string) => tags.find((x) => x.tag === tg)?.it ?? tg;
  const viewLabel = (v: View) =>
    v === 'anon' ? t('pii.viewAnon') : v === 'marked' ? t('pii.viewMarked') : v === 'pdf' ? t('pii.viewPdf') : t('pii.viewFound', { n: result?.n_unique ?? 0 });
  const saveHintParts = t('pii.saveHint', { dir: 'pii-clean/' }).split('pii-clean/');

  return (
    <section className="pii" aria-labelledby={`${id}-title`}>
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>PII</h1>
          <p className="chat-meta">{t('pii.subtitle')}</p>
        </div>
      </header>

      <div className="pii-body">
        <form className="pii-card" onSubmit={(e) => void run(e)}>
          <fieldset className="pii-mode">
            <legend>{t('pii.whatToAnon')}</legend>
            <label className="choice">
              <input type="radio" name={`${id}-mode`} checked={mode === 'text'} onChange={() => setMode('text')} />
              <span>{t('pii.aText')}</span>
            </label>
            <label className="choice">
              <input type="radio" name={`${id}-mode`} checked={mode === 'file'} onChange={() => setMode('file')} />
              <span>{t('pii.aDoc')}</span>
            </label>
          </fieldset>

          {mode === 'text' ? (
            <div className="pii-field">
              <label htmlFor={`${id}-text`}>{t('pii.textLabel')}</label>
              <textarea id={`${id}-text`} rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('pii.textPh')} />
            </div>
          ) : (
            <div className="pii-field">
              <label htmlFor={`${id}-file`}>{t('pii.docLabel')}</label>
              <input id={`${id}-file`} type="file" accept={FILE_TYPES} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
          )}

          <details className="pii-tags">
            <summary>
              {t('pii.leaveClear')}{excluded.length ? ` ${t('pii.excludedSuffix', { n: excluded.length })}` : ''}
            </summary>
            <div className="pii-tag-grid">
              {tags.map((tg) => (
                <label key={tg.tag} className="pii-tag" title={t('pii.exampleTitle', { ex: tg.example })}>
                  <input
                    type="checkbox"
                    checked={excluded.includes(tg.tag)}
                    onChange={(e) => setExcluded((x) => (e.target.checked ? [...x, tg.tag] : x.filter((y) => y !== tg.tag)))}
                  />
                  <span>{tg.it}</span>
                </label>
              ))}
            </div>
          </details>

          <label className="choice">
            <input
              type="checkbox"
              checked={mapping}
              onChange={(e) => {
                setMapping(e.target.checked);
                localStorage.setItem(MAPPING_KEY, e.target.checked ? '1' : '0');
              }}
              aria-describedby={`${id}-map-hint`}
            />
            <span className="choice-text">
              <span>{t('pii.dictTitle')}</span>
              <span className="hint" id={`${id}-map-hint`}>
                {t('pii.dictHint')}
              </span>
            </span>
          </label>

          <div className="agent-actions">
            <button type="submit" className="btn primary" disabled={Boolean(busy)}>
              {busy || t('pii.anonimize')}
            </button>
          </div>
        </form>

        <div aria-live="polite" className="pii-msg-wrap">
          {msg && <p className={`pii-msg pii-msg-${msg.kind}`}>{msg.text}</p>}
        </div>

        {result && (
          <section className="pii-card" aria-labelledby={`${id}-res`}>
            <h2 id={`${id}-res`}>{t('pii.result')}</h2>
            <div className="pii-views" role="group" aria-label={t('pii.viewsLabel')}>
              {(['anon', 'marked', 'entities', ...(pdf ? ['pdf'] : [])] as View[]).map((v) => (
                <button key={v} type="button" className="btn small-btn" aria-pressed={view === v} onClick={() => setView(v)}>
                  {viewLabel(v)}
                </button>
              ))}
            </div>

            {view === 'anon' && (
              <>
                <pre className="pii-out">{result.anonymized_text}</pre>
                <button type="button" className="btn small-btn" onClick={() => void copyText(result.anonymized_text).then((ok) => setMsg(ok ? { kind: 'ok', text: t('pii.copiedOk') } : { kind: 'err', text: t('pii.copyFail') }))}>
                  {t('pii.copy')}
                </button>
              </>
            )}
            {view === 'marked' && (
              <p className="pii-out pii-marked">
                {result.segments.map((s, i) =>
                  s.label ? (
                    <mark key={i} title={`${tagName(s.label)} → ${s.ph}`}>
                      {s.t}
                      <span className="visually-hidden"> ({tagName(s.label)})</span>
                    </mark>
                  ) : (
                    <span key={i}>{s.t}</span>
                  ),
                )}
              </p>
            )}
            {view === 'entities' && (
              <table className="pii-table">
                <caption className="visually-hidden">{t('pii.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('pii.thCategory')}</th>
                    <th scope="col">{t('pii.thPlaceholder')}</th>
                    <th scope="col">{t('pii.thValue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {uniqueEntities(result).map((e) => (
                    <tr key={e.ph}>
                      <td>{tagName(e.label)}</td>
                      <td>
                        <code>{e.ph}</code>
                      </td>
                      <td>{e.t}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view === 'pdf' && pdf && (
              <>
                <button type="button" className="btn small-btn primary" onClick={() => void downloadPdf()}>
                  {t('pii.downloadPdf')}
                </button>
                <div className="pii-pages">
                  {pages.map((u, i) => (
                    <img key={u} src={u} alt={t('pii.pageAlt', { n: i + 1 })} />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {result && (
          <section className="pii-card" aria-labelledby={`${id}-save`}>
            <h2 id={`${id}-save`}>{t('pii.saveForAgent')}</h2>
            <p className="hint">{saveHintParts.length === 2 ? <>{saveHintParts[0]}<code>pii-clean/</code>{saveHintParts[1]}</> : t('pii.saveHint', { dir: 'pii-clean/' })}</p>
            <ProjectPicker active cwd={project} onChange={setProject} />
            <div className="agent-actions">
              <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={() => void save()}>
                {t('pii.saveIn')}
              </button>
              {saved && <a href={`#/files/${encodeURIComponent(saved.abs)}`}>{t('pii.openFile')}</a>}
            </div>
          </section>
        )}

        <details className="pii-card pii-decode">
          <summary>{t('pii.decodeTitle')}</summary>
          <div className="pii-field">
            <label htmlFor={`${id}-dec`}>{t('pii.decodeLabel')}</label>
            <textarea id={`${id}-dec`} rows={5} value={decIn} onChange={(e) => setDecIn(e.target.value)} />
          </div>
          {decIn.trim() && (
            <p className="pii-out" aria-live="polite">
              {Object.keys(map).length ? decoded : t('pii.noDict')}
            </p>
          )}
          <button
            type="button"
            className="btn small-btn"
            onClick={() => {
              localStorage.removeItem(MAP_KEY);
              setDecIn((v) => v + '');
              setMsg({ kind: 'ok', text: t('pii.dictCleared') });
            }}
          >
            {t('pii.clearDict', { n: Object.keys(map).length })}
          </button>
        </details>

        <p className="hint pii-credit">
          Motore{' '}
          <a href="https://github.com/Rizzo-AI-Academy/rizzo-pii" target="_blank" rel="noopener noreferrer">
            Rizzo-PII
          </a>{' '}
          di Rizzo AI Academy
        </p>
      </div>
    </section>
  );
}

function uniqueEntities(r: PiiResult): { label: string; ph: string; t: string }[] {
  const seen = new Map<string, { label: string; ph: string; t: string }>();
  for (const s of r.segments) if (s.label && s.ph && !seen.has(s.ph)) seen.set(s.ph, { label: s.label, ph: s.ph, t: s.t });
  return [...seen.values()];
}

/** Sostituisce i segnaposto con i valori del dizionario ([X_10] prima di [X_1]) */
function decode(text: string, map: Record<string, string>): string {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (!keys.length || !text) return text;
  const re = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.replace(re, (m) => map[m] ?? m);
}
