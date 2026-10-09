// Plugin Design nella chat: skill e design system della conversazione e anteprima dal vivo delle
// pagine che l'agente scrive in design/. Le pagine girano su /preview/<token>/ (sandbox, origine
// opaca): niente accesso al token di AgiCloud.

import { useEffect, useId, useState } from 'react';
import { api, ApiError, type DesignCatalog, type FileEntry, type ThreadSummary } from './api';
import { Icon } from './icons';

const OUTPUT_DIR = 'design';

let catalogPromise: Promise<DesignCatalog> | null = null;

/** Catalogo caricato una volta sola (serve anche al dialogo di nuova conversazione) */
export function loadDesignCatalog(): Promise<DesignCatalog> {
  catalogPromise ??= api.designCatalog().catch((err) => {
    catalogPromise = null;
    throw err;
  });
  return catalogPromise;
}

export function DesignBar({ thread, running }: { thread: ThreadSummary; running: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<{ skill?: string; system?: string }>({});
  const [pages, setPages] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [base, setBase] = useState('');
  const [error, setError] = useState('');
  const dir = `${thread.cwd}/${OUTPUT_DIR}`;
  const design = thread.design!;

  useEffect(() => {
    loadDesignCatalog()
      .then((c) => setNames({
        skill: c.skills.find((s) => s.id === design.skill)?.name,
        system: c.systems.find((s) => s.id === design.system)?.name,
      }))
      .catch(() => {});
  }, [design.skill, design.system]);

  // Pagine in design/: si ricontrolla spesso mentre l'agente lavora, cosi' l'anteprima segue le modifiche
  useEffect(() => {
    if (!open) return;
    let stop = false;
    const check = async () => {
      try {
        const list = await api.listFiles(dir);
        if (stop) return;
        const html = list.entries.filter((e) => e.type === 'file' && /\.html?$/i.test(e.name));
        setPages(html);
        setError('');
        setSelected((cur) => (html.some((p) => p.name === cur) ? cur : (html.find((p) => p.name === 'index.html') ?? html[0])?.name ?? ''));
        if (html.length && !base) {
          const { url } = await api.designPreview({ dir });
          if (!stop) setBase(url);
        }
      } catch (err) {
        if (stop) return;
        if (err instanceof ApiError && err.status === 404) setPages([]);
        else setError(err instanceof Error ? err.message : String(err));
      }
    };
    void check();
    const timer = setInterval(check, running ? 2000 : 6000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [open, running, dir, base]);

  const page = pages?.find((p) => p.name === selected);
  // mtime nell'indirizzo: quando l'agente riscrive il file l'iframe si ricarica da solo
  const src = page && base ? `${base}${encodeURIComponent(page.name)}?v=${Math.round(page.mtime)}` : '';
  const label = [names.skill ?? design.skill, names.system ?? design.system].filter(Boolean).join(' · ');

  return (
    <div className="design-bar">
      <button type="button" className="design-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((o) => !o)}>
        <Icon name="file" />
        <span>Anteprima design</span>
        <span className="hint">{label}</span>
      </button>
      {open && (
        <div id={`${id}-panel`} className="design-panel">
          {error && <p className="form-error" role="alert">{error}</p>}
          {pages === null ? (
            <p className="hint">Caricamento…</p>
          ) : pages.length === 0 ? (
            <p className="hint">Nessuna pagina ancora: l'agente le scrive nella cartella {OUTPUT_DIR}/ del progetto.</p>
          ) : (
            <>
              <div className="design-tools">
                <label>
                  <span className="visually-hidden">Pagina</span>
                  <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                    {pages.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {src && (
                  <a className="btn" href={src} target="_blank" rel="noopener noreferrer">
                    Apri in una nuova scheda
                  </a>
                )}
              </div>
              {src && (
                <iframe
                  className="design-frame"
                  title={`Anteprima di ${selected}`}
                  src={src}
                  sandbox="allow-scripts allow-popups allow-forms allow-modals"
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
