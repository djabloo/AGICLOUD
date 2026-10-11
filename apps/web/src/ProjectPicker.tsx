import { useEffect, useId, useState } from 'react';
import { api, type DirListing } from './api';
import { useT } from './i18n';

/** Cartella del progetto: campo libero + recenti + navigazione tra le cartelle consentite */
export function ProjectPicker({ active, cwd, onChange }: { active: boolean; cwd: string; onChange: (cwd: string) => void }) {
  const id = useId();
  const t = useT();
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
      <label htmlFor={`${id}-cwd`}>{t('projectpicker.cartella')}</label>
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
            {t('projectpicker.recenti')}
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
            {t('projectpicker.sfoglia')}
          </h3>
          <span className="browser-path" title={listing?.path ?? undefined}>
            {listing?.path ? shortPath(listing.path) : t('projectpicker.radici')}
          </span>
        </div>
        <ul className="dir-list" aria-labelledby={`${id}-browse`}>
          {listing?.path && (
            <li>
              <button type="button" className="dir-btn" onClick={() => void browse(listing.parent ?? undefined)}>
                <span aria-hidden="true">↑</span> {listing.parent ? t('projectpicker.superiore') : t('projectpicker.radici')}
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
          {listing && listing.dirs.length === 0 && <li className="hint">{t('projectpicker.nessunaSotto')}</li>}
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
