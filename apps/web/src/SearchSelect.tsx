// Menu a tendina con campo "Cerca" quando le scelte sono tante (es. i modelli di OpenCode).
// Scrivendo compare subito sotto l'elenco dei risultati (clic, oppure frecce + Invio);
// la tendina nativa resta per sfogliare tutto, comoda su telefono e accessibile.
import { useState, type KeyboardEvent } from 'react';
import { useT } from './i18n';
import type { ConfigOption } from './transcript';

/** Oltre questo numero di voci compare il campo di ricerca */
const SEARCH_FROM = 10;
const MAX_RESULTS = 50;

type Opts = NonNullable<ConfigOption['options']>;
interface Flat {
  value: string;
  name: string;
  group?: string;
}

export function SearchSelect({
  id,
  label,
  value,
  options,
  disabled,
  className = 'cfg',
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Opts;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const t = useT();
  const flat: Flat[] = options.flatMap((o) => ('group' in o ? o.options.map((g) => ({ ...g, group: o.name })) : [o]));
  const searchable = flat.length > SEARCH_FROM;
  // Ogni parola deve comparire nel nome, nel gruppo o nell'id (es. "zen pickle")
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length
    ? flat.filter((o) => {
        const hay = `${o.name} ${o.group ?? ''} ${o.value}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
    : [];
  const shown = results.slice(0, MAX_RESULTS);
  const open = words.length > 0;
  const listId = `${id}-results`;

  const choose = (v: string) => {
    onChange(v);
    setQuery('');
    setActive(0);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) choose(shown[active].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
    }
  };

  return (
    <div className={`${className}${searchable ? ' cfg-search' : ''}`}>
      <label className="cfg-name" htmlFor={id}>
        {label}
      </label>
      {searchable && (
        <div className="cfg-combo">
          <input
            type="search"
            className="cfg-filter"
            placeholder={t('searchselect.cerca')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            role="combobox"
            aria-label={t('searchselect.cercaIn', { label })}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            disabled={disabled}
          />
          {open && (
            <ul id={listId} className="cfg-results" role="listbox" aria-label={t('searchselect.risultatiPer', { label })}>
              {shown.length === 0 ? (
                <li className="cfg-noresult" role="presentation">
                  {t('searchselect.nessunRisultato')}
                </li>
              ) : (
                shown.map((o, i) => (
                  <li
                    key={o.value}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={o.value === value ? 'is-current' : undefined}
                    // mousedown: il campo non perde il focus prima della scelta
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(o.value);
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span>{o.name}</span>
                    {o.group && <span className="cfg-result-group">{o.group}</span>}
                  </li>
                ))
              )}
              {results.length > MAX_RESULTS && (
                <li className="cfg-noresult" role="presentation">
                  {t('searchselect.altri', { n: results.length - MAX_RESULTS })}
                </li>
              )}
            </ul>
          )}
          <span className="visually-hidden" aria-live="polite">
            {open ? (results.length ? t('searchselect.contaRisultati', { n: results.length }) : t('searchselect.nessunRisultato')) : ''}
          </span>
        </div>
      )}
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) =>
          'group' in opt ? (
            <optgroup key={opt.group} label={opt.name}>
              {opt.options.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.name}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={opt.value} value={opt.value}>
              {opt.name}
            </option>
          ),
        )}
      </select>
    </div>
  );
}
