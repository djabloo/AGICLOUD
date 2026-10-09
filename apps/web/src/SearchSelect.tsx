// Menu a tendina con campo "Cerca" quando le scelte sono tante (es. i modelli di OpenCode):
// il filtro riduce le voci della tendina nativa, che resta comoda su telefono e accessibile.
import { useState } from 'react';
import type { ConfigOption } from './transcript';

/** Oltre questo numero di voci compare il campo di ricerca */
const SEARCH_FROM = 10;

type Opts = NonNullable<ConfigOption['options']>;

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
  const total = options.reduce((n, o) => n + ('group' in o ? o.options.length : 1), 0);
  const searchable = total > SEARCH_FROM;
  const q = query.trim().toLowerCase();
  // La voce scelta resta sempre nella tendina, anche se non corrisponde al filtro
  const keep = (o: { value: string; name: string }) => !q || o.value === value || `${o.name} ${o.value}`.toLowerCase().includes(q);
  const shown: Opts = options.flatMap((o): Opts => {
    if ('group' in o) {
      const sub = o.options.filter(keep);
      return sub.length ? [{ ...o, options: sub }] : [];
    }
    return keep(o) ? [o] : [];
  });
  const count = shown.reduce((n, o) => n + ('group' in o ? o.options.length : 1), 0);

  return (
    <div className={`${className}${searchable ? ' cfg-search' : ''}`}>
      <label className="cfg-name" htmlFor={id}>
        {label}
      </label>
      {searchable && (
        <input
          type="search"
          className="cfg-filter"
          placeholder="Cerca…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Cerca in ${label}`}
          aria-controls={id}
          aria-describedby={`${id}-count`}
          disabled={disabled}
        />
      )}
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {shown.map((opt) =>
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
      {searchable && (
        <span id={`${id}-count`} className="visually-hidden" aria-live="polite">
          {q ? `${count} ${count === 1 ? 'voce' : 'voci'}` : ''}
        </span>
      )}
    </div>
  );
}
