import { useEffect, useId, useState } from 'react';
import { api, type DirListing } from './api';

/** Cartella del progetto: campo libero + recenti + navigazione tra le cartelle consentite */
export function ProjectPicker({ active, cwd, onChange }: { active: boolean; cwd: string; onChange: (cwd: string) => void }) {
  const id = useId();
  const [recent, setRecent] = useState<string[]>([]);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [browseError, setBrowseError] = useState('');

  const browse = async (path: string | undefined) => {
    setBrowseError('');
    try {
      setListing(await api.dirs(path));
      if (path) onChange(path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!active) return;
    api
      .projects()
      .then((p) => {
        setRecent(p.recent);
        if (!cwd && p.recent[0]) onChange(p.recent[0]);
      })
      .catch(() => {});
    void browse(undefined);
  }, [active]);

  return (
    <>
      <label htmlFor={`${id}-cwd`}>Cartella del progetto</label>
      <input
        id={`${id}-cwd`}
        value={cwd}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/opt/progetto"
        autoComplete="off"
        spellCheck={false}
        className="mono-input"
        required
      />

      {recent.length > 0 && (
        <div className="recent">
          <h3 className="mini-title" id={`${id}-recent`}>
            Recenti
          </h3>
          <ul className="chips" aria-labelledby={`${id}-recent`}>
            {recent.map((r) => (
              <li key={r}>
                <button type="button" className="chip" aria-pressed={cwd === r} onClick={() => onChange(r)} title={r}>
                  {r.split('/').filter(Boolean).pop() ?? r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="browser">
        <div className="browser-head">
          <h3 className="mini-title" id={`${id}-browse`}>
            Sfoglia
          </h3>
          <span className="browser-path" title={listing?.path ?? undefined}>
            {listing?.path ? shortPath(listing.path) : 'Radici consentite'}
          </span>
        </div>
        <ul className="dir-list" aria-labelledby={`${id}-browse`}>
          {listing?.path && (
            <li>
              <button type="button" className="dir-btn" onClick={() => void browse(listing.parent ?? undefined)}>
                <span aria-hidden="true">↑</span> {listing.parent ? 'Cartella superiore' : 'Radici consentite'}
              </button>
            </li>
          )}
          {listing?.dirs.map((d) => (
            <li key={d.path}>
              <button type="button" className="dir-btn" onClick={() => void browse(d.path)}>
                <span aria-hidden="true">📁</span> {d.name}
                {d.git && <span className="git-badge">git</span>}
              </button>
            </li>
          ))}
          {listing && listing.dirs.length === 0 && <li className="hint">Nessuna sottocartella</li>}
        </ul>
        {browseError && (
          <p className="form-error" role="alert">
            {browseError}
          </p>
        )}
      </div>
    </>
  );
}

/** Percorsi lunghi: si tiene la parte finale, la piu' utile */
function shortPath(p: string, max = 48): string {
  return p.length > max ? `…${p.slice(-(max - 1))}` : p;
}
