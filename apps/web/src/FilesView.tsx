import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, type FileContent, type FileEntry } from './api';
import { CodeEditor } from './CodeEditor';
import { Markdown } from './markdown';
import { Icon } from './icons';

interface Props {
  /** Cartella o file da aprire (dall'indirizzo #/files/...) */
  path: string | null;
  onNavigate: (path: string | null) => void;
}

type Listing = Awaited<ReturnType<typeof api.listFiles>>;

const HIDE_KEY = 'agicloud_files_hidden';
const PREVIEW_MIME = /^(image\/|video\/|audio\/|application\/pdf)/;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dirOf(path: string): string {
  return path.replace(/\/[^/]+$/, '') || '/';
}

async function download(path: string) {
  const blob = await api.fileBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() ?? 'file';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function FilesView({ path, onNavigate }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [roots, setRoots] = useState<{ roots: string[]; recent: string[] } | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [announce, setAnnounce] = useState('');
  /** Cambia solo quando il file viene (ri)letto dal disco: ricrea l'editor. Il salvataggio no. */
  const [loadNonce, setLoadNonce] = useState(0);
  const uploadInput = useRef<HTMLInputElement>(null);

  // Un percorso puo' essere una cartella o un file: si prova come cartella, altrimenti si apre il file
  const load = async (p: string | null) => {
    setError('');
    if (!p) {
      setListing(null);
      setFile(null);
      setRoots(await api.projects());
      return;
    }
    try {
      const l = await api.listFiles(p);
      setListing(l);
      setFile(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        try {
          const f = await api.readFile(p);
          setFile(f);
          setLoadNonce((n) => n + 1);
          if (!listing || listing.path !== dirOf(f.path)) setListing(await api.listFiles(dirOf(f.path)));
          return;
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : String(e2));
          return;
        }
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load(path);
  }, [path]);

  const refresh = async () => {
    if (listing) setListing(await api.listFiles(listing.path));
  };

  const toggleHidden = () => {
    setShowHidden((v) => {
      try {
        localStorage.setItem(HIDE_KEY, v ? '0' : '1');
      } catch {
        /* comodita' */
      }
      return !v;
    });
  };

  const create = async (type: 'file' | 'dir') => {
    if (!listing) return;
    const name = prompt(type === 'dir' ? 'Nome della nuova cartella' : 'Nome del nuovo file');
    if (!name) return;
    try {
      const e = await api.createFile(`${listing.path}/${name}`, type);
      await refresh();
      setAnnounce(`${name} creato`);
      if (type === 'file') onNavigate(e.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const upload = async (files: FileList) => {
    if (!listing || !files.length) return;
    try {
      await api.uploadFiles(listing.path, [...files]);
      await refresh();
      setAnnounce(`${files.length} file caricati`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rename = async (entry: FileEntry) => {
    const name = prompt('Nuovo nome', entry.name);
    if (!name || name === entry.name) return;
    try {
      const { path: p } = await api.renameFile(entry.path, name);
      await refresh();
      setAnnounce(`Rinominato in ${name}`);
      if (file?.path === entry.path) onNavigate(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (entry: FileEntry) => {
    if (!confirm(`Eliminare ${entry.name}? Non si puo' annullare.`)) return;
    try {
      await api.deleteFile(entry.path);
      await refresh();
      setAnnounce(`${entry.name} eliminato`);
      if (file?.path === entry.path) onNavigate(listing?.path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Scelta della cartella di partenza ──
  if (!path) {
    return (
      <section className="files" aria-labelledby="files-title">
        <header className="chat-header">
          <div className="chat-heading">
            <h1 id="files-title">File</h1>
            <p className="chat-meta">Scegli da dove partire</p>
          </div>
        </header>
        <div className="settings-body">
          {roots && (
            <div className="settings-group">
              {roots.recent.length > 0 && (
                <>
                  <h2 className="mini-title">Progetti recenti</h2>
                  <ul className="file-list">
                    {roots.recent.map((r) => (
                      <li key={r}>
                        <button type="button" className="file-row" onClick={() => onNavigate(r)}>
                          <Icon name="files" />
                          <span className="file-name">{r}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h2 className="mini-title">Cartelle consentite</h2>
              <ul className="file-list">
                {roots.roots.map((r) => (
                  <li key={r}>
                    <button type="button" className="file-row" onClick={() => onNavigate(r)}>
                      <Icon name="files" />
                      <span className="file-name">{r}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    );
  }

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'));
  const crumbs = listing ? listing.path.split('/').filter(Boolean) : [];

  return (
    <section className={`files${file ? ' has-file' : ''}`} aria-labelledby="files-title">
      <h1 id="files-title" className="visually-hidden">
        File
      </h1>
      <div className="files-pane files-browser">
        <nav className="crumbs" aria-label="Percorso">
          <ol>
            <li>
              <button type="button" className="crumb" onClick={() => onNavigate(null)}>
                Radici
              </button>
            </li>
            {crumbs.map((c, i) => {
              const p = '/' + crumbs.slice(0, i + 1).join('/');
              const current = i === crumbs.length - 1;
              return (
                <li key={p}>
                  <button type="button" className="crumb" aria-current={current && !file ? 'location' : undefined} onClick={() => onNavigate(p)}>
                    {c}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="files-toolbar" role="toolbar" aria-label="Azioni sulla cartella">
          <button type="button" className="btn small-btn" onClick={() => void create('file')}>
            + File
          </button>
          <button type="button" className="btn small-btn" onClick={() => void create('dir')}>
            + Cartella
          </button>
          <button type="button" className="btn small-btn" onClick={() => uploadInput.current?.click()}>
            Carica
          </button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = '';
            }}
          />
          <label className="check-row small">
            <input type="checkbox" checked={showHidden} onChange={toggleHidden} />
            <span>Nascosti</span>
          </label>
        </div>
        {listing?.parent && (
          <button type="button" className="file-row up" onClick={() => onNavigate(listing.parent)}>
            <span aria-hidden="true">↑</span>
            <span className="file-name">Cartella superiore</span>
          </button>
        )}
        <ul className="file-list" aria-label={`Contenuto di ${listing?.path ?? ''}`}>
          {entries.map((e) => (
            <FileRow key={e.path} entry={e} active={file?.path === e.path} onOpen={() => onNavigate(e.path)} onRename={() => void rename(e)} onDelete={() => void remove(e)} />
          ))}
          {listing && entries.length === 0 && <li className="hint pad">Cartella vuota</li>}
        </ul>
        {listing?.truncated && <p className="hint pad">Mostrati solo i primi 3000 elementi.</p>}
      </div>

      <div className="files-pane files-viewer">
        {file ? (
          <FileViewer
            key={`${file.path}:${loadNonce}`}
            file={file}
            onClose={() => onNavigate(listing?.path ?? dirOf(file.path))}
            onSaved={(mtime, content) => {
              setFile((f) => (f ? { ...f, mtime, content } : f));
              void refresh(); // dimensione e data aggiornate nell'elenco
            }}
            onReload={() => void load(file.path)}
          />
        ) : (
          <p className="empty pad">Scegli un file per aprirlo.</p>
        )}
      </div>

      {error && (
        <p className="files-error notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}

function FileRow({ entry, active, onOpen, onRename, onDelete }: { entry: FileEntry; active: boolean; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const id = useId();
  return (
    <li className={`file-item${active ? ' is-active' : ''}`}>
      <button type="button" className="file-row" aria-current={active ? 'true' : undefined} onClick={onOpen}>
        <Icon name={entry.type === 'dir' ? 'files' : 'file'} />
        <span className="file-name">{entry.name}</span>
        {entry.type === 'file' && <span className="file-size">{formatSize(entry.size)}</span>}
      </button>
      <button type="button" className="file-more" aria-expanded={menu} aria-controls={`${id}-m`} onClick={() => setMenu((m) => !m)}>
        <span aria-hidden="true">⋯</span>
        <span className="visually-hidden">Azioni su {entry.name}</span>
      </button>
      {menu && (
        <div id={`${id}-m`} className="file-menu">
          <button type="button" className="btn small-btn" onClick={() => (setMenu(false), onRename())}>
            Rinomina
          </button>
          {entry.type === 'file' && (
            <button type="button" className="btn small-btn" onClick={() => (setMenu(false), void download(entry.path))}>
              Scarica
            </button>
          )}
          <button type="button" className="btn small-btn danger-text" onClick={() => (setMenu(false), onDelete())}>
            Elimina
          </button>
        </div>
      )}
    </li>
  );
}

function FileViewer({
  file,
  onClose,
  onSaved,
  onReload,
}: {
  file: FileContent;
  onClose: () => void;
  onSaved: (mtime: number, content: string) => void;
  onReload: () => void;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  const text = file.content;
  const isMd = /\.(md|markdown)$/i.test(name);
  const isHtml = /\.html?$/i.test(name);
  const [draft, setDraft] = useState(text ?? '');
  // Markdown con contenuto: si apre in anteprima; vuoto (appena creato): in modifica
  const [mode, setMode] = useState<'edit' | 'preview'>(isMd && text ? 'preview' : 'edit');
  const [status, setStatus] = useState('');
  const [conflict, setConflict] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const dirty = text !== null && draft !== text;
  const mtimeRef = useRef(file.mtime);

  // Anteprime di immagini, PDF, video, audio: il file arriva come Blob con il token
  useEffect(() => {
    if (text !== null || !PREVIEW_MIME.test(file.mime)) return;
    let url: string | null = null;
    api
      .fileBlob(file.path)
      .then((b) => setBlobUrl((url = URL.createObjectURL(b))))
      .catch(() => setStatus('Anteprima non disponibile'));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.path]);

  // Avviso se si esce con modifiche non salvate
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async (force = false) => {
    if (text === null) return;
    setStatus('Salvataggio…');
    try {
      const saved = draft;
      const { mtime } = await api.writeFile(file.path, saved, force ? undefined : mtimeRef.current);
      mtimeRef.current = mtime;
      setConflict(false);
      setStatus('Salvato');
      onSaved(mtime, saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setStatus('');
      } else setStatus(`Non salvato: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const close = () => {
    if (dirty && !confirm('Ci sono modifiche non salvate. Chiudere comunque?')) return;
    onClose();
  };

  const canEdit = text !== null;
  const preview = isMd || isHtml;

  return (
    <div className="viewer">
      <header className="viewer-head">
        <button type="button" className="btn icon-btn viewer-back" onClick={close}>
          <Icon name="close" />
          <span className="visually-hidden">Chiudi il file</span>
        </button>
        <div className="viewer-title">
          <h2>
            {name}
            {dirty && <span className="dirty" aria-label="modificato, non salvato"> ●</span>}
          </h2>
          <p className="chat-meta" title={file.path}>
            {file.path}
          </p>
        </div>
        {preview && canEdit && (
          <div className="seg" role="group" aria-label="Vista">
            <button type="button" className="seg-btn" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
              Modifica
            </button>
            <button type="button" className="seg-btn" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              Anteprima
            </button>
          </div>
        )}
        {canEdit && (
          <button type="button" className="btn small-btn primary" disabled={!dirty} onClick={() => void save()}>
            Salva
          </button>
        )}
        <button type="button" className="btn icon-btn" onClick={() => void download(file.path)}>
          <Icon name="download" />
          <span className="visually-hidden">Scarica {name}</span>
        </button>
      </header>

      {conflict && (
        <div className="notice notice-error conflict" role="alert">
          <p>Il file e' cambiato dopo che l'hai aperto (forse lo ha modificato un agente).</p>
          <div className="agent-actions">
            <button type="button" className="btn small-btn" onClick={onReload}>
              Ricarica (perdi le tue modifiche)
            </button>
            <button type="button" className="btn small-btn" onClick={() => void save(true)}>
              Sovrascrivi con la tua versione
            </button>
          </div>
        </div>
      )}

      <div className="viewer-body">
        {canEdit && mode === 'edit' && (
          <CodeEditor docKey={file.path} filename={name} initial={text!} label={`Contenuto di ${name}`} onChange={setDraft} onSave={() => void save()} />
        )}
        {canEdit && mode === 'preview' && isMd && (
          <div className="md-preview">
            <Markdown text={draft} />
          </div>
        )}
        {canEdit && mode === 'preview' && isHtml && (
          // sandbox senza permessi: niente script, niente moduli, niente navigazione
          <iframe className="html-preview" title={`Anteprima di ${name}`} sandbox="" srcDoc={draft} />
        )}
        {!canEdit && blobUrl && file.mime.startsWith('image/') && <img className="media-preview" src={blobUrl} alt={name} />}
        {!canEdit && blobUrl && file.mime.startsWith('video/') && <video className="media-preview" src={blobUrl} controls />}
        {!canEdit && blobUrl && file.mime.startsWith('audio/') && <audio src={blobUrl} controls />}
        {!canEdit && blobUrl && file.mime === 'application/pdf' && <iframe className="pdf-preview" title={`PDF ${name}`} src={blobUrl} />}
        {!canEdit && !PREVIEW_MIME.test(file.mime) && (
          <p className="empty pad">
            {file.tooLarge ? 'File troppo grande per l\'editor' : 'File binario'} ({formatSize(file.size)}). Puoi scaricarlo.
          </p>
        )}
      </div>
      <p className="viewer-status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
