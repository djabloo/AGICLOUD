import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, type SearchHit, type ThreadSummary } from './api';
import { Icon } from './icons';

/** Stato di un thread affidato dal capo */
export const CHILD_STATE_TEXT: Record<NonNullable<ThreadSummary['childState']>, string> = {
  running: 'in corso',
  waiting: 'aspetta te',
  done: 'finito',
  error: 'errore',
  idle: 'fermo',
};

interface Props {
  threads: ThreadSummary[];
  activeId: string | null;
  agentLabel: (id: string) => string;
  onSelect: (id: string) => void;
  onChanged: (t: ThreadSummary) => void;
  onDelete: (id: string) => void;
}

/** Lista conversazioni: ricerca (titoli + testo), fissate in cima, archiviate a parte */
export function ThreadList({ threads, activeId, agentLabel, onSelect, onChanged, onDelete }: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [announce, setAnnounce] = useState('');

  // Ricerca nel testo lato server, con un piccolo ritardo mentre si scrive
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchThreads(q)
        .then((h) => {
          setHits(h);
          setAnnounce(`${h.length} ${h.length === 1 ? 'conversazione trovata' : 'conversazioni trovate'}`);
        })
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const update = async (t: ThreadSummary, patch: { title?: string; pinned?: boolean; archived?: boolean }, message: string) => {
    try {
      onChanged(await api.updateThread(t.id, patch));
      setAnnounce(message);
    } catch (err) {
      setAnnounce(err instanceof Error ? err.message : String(err));
    }
  };

  // Thread affidati: annidati sotto il loro capo (se il capo c'e' ancora)
  const isNested = (t: ThreadSummary) => Boolean(t.parentId && threads.some((p) => p.id === t.parentId));
  const kidsOf = (t: ThreadSummary) => threads.filter((k) => k.parentId === t.id && !k.archived).sort((a, b) => a.createdAt - b.createdAt);

  const row = (t: ThreadSummary, snippet?: string, nested = true) => {
    const kids = nested && t.lead ? kidsOf(t) : [];
    return (
    <ThreadRow
      key={t.id}
      thread={t}
      active={t.id === activeId}
      meta={
        t.parentId && t.childState
          ? `${agentLabel(t.agentId)} · ${CHILD_STATE_TEXT[t.childState]}`
          : t.lead
            ? `Capo · ${agentLabel(t.agentId)}`
            : agentLabel(t.agentId)
      }
      nested={
        kids.length > 0 && (
          <ul className="threads child-threads" aria-label={`Thread affidati da ${t.title}`}>
            {kids.map((k) => row(k, undefined, false))}
          </ul>
        )
      }
      snippet={snippet}
      onSelect={() => onSelect(t.id)}
      onRename={(title) => update(t, { title }, 'Conversazione rinominata')}
      onPin={() => update(t, { pinned: !t.pinned }, t.pinned ? 'Tolta dalle fissate' : 'Fissata in cima')}
      onArchive={() => update(t, { archived: !t.archived }, t.archived ? 'Ripristinata' : 'Archiviata')}
      onDelete={() => {
        const extra = t.worktree?.state === 'open' ? ' Anche la sua copia separata, con le modifiche non unite.' : '';
        if (confirm(`Eliminare "${t.title}"? La conversazione verra' cancellata.${extra}`)) onDelete(t.id);
      }}
    />
    );
  };

  const searching = hits !== null;
  const pinned = threads.filter((t) => t.pinned && !t.archived && !isNested(t));
  const recent = threads.filter((t) => !t.pinned && !t.archived && !isNested(t));
  const archived = threads.filter((t) => t.archived);

  return (
    <div className="thread-list">
      <div className="thread-search">
        <label htmlFor={`${id}-q`} className="visually-hidden">
          Cerca nelle conversazioni
        </label>
        <input
          id={`${id}-q`}
          type="search"
          placeholder="Cerca…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          autoComplete="off"
        />
      </div>

      {searching ? (
        <>
          <h2 className="sidebar-title" id={`${id}-res`}>
            Risultati
          </h2>
          {hits.length === 0 ? (
            <p className="sidebar-empty">Nessun risultato</p>
          ) : (
            <ul className="threads" aria-labelledby={`${id}-res`}>
              {hits.map((h) => {
                const t = threads.find((x) => x.id === h.id);
                return t ? row(t, h.snippet, false) : null;
              })}
            </ul>
          )}
        </>
      ) : threads.length === 0 ? (
        <p className="sidebar-empty">Nessuna conversazione</p>
      ) : (
        <>
          {pinned.length > 0 && (
            <>
              <h2 className="sidebar-title" id={`${id}-pin`}>
                Fissate
              </h2>
              <ul className="threads" aria-labelledby={`${id}-pin`}>
                {pinned.map((t) => row(t))}
              </ul>
            </>
          )}
          <h2 className="sidebar-title" id={`${id}-rec`}>
            Conversazioni
          </h2>
          {recent.length === 0 ? (
            <p className="sidebar-empty">Nessuna conversazione recente</p>
          ) : (
            <ul className="threads" aria-labelledby={`${id}-rec`}>
              {recent.map((t) => row(t))}
            </ul>
          )}
          {archived.length > 0 && (
            <>
              <button
                type="button"
                className="archived-toggle"
                aria-expanded={showArchived}
                aria-controls={`${id}-arc`}
                onClick={() => setShowArchived((v) => !v)}
              >
                <span aria-hidden="true">{showArchived ? '▾' : '▸'}</span> Archiviate ({archived.length})
              </button>
              <ul className="threads" id={`${id}-arc`} hidden={!showArchived} aria-label="Conversazioni archiviate">
                {archived.map((t) => row(t, undefined, false))}
              </ul>
            </>
          )}
        </>
      )}

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function ThreadRow({
  thread: t,
  active,
  meta,
  snippet,
  onSelect,
  onRename,
  onPin,
  onArchive,
  onDelete,
  nested,
}: {
  nested?: ReactNode;
  thread: ThreadSummary;
  active: boolean;
  meta: string;
  snippet?: string;
  onSelect: () => void;
  onRename: (title: string) => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Menu: primo elemento a fuoco all'apertura; Esc o clic fuori lo chiudono
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && e.target !== menuBtn.current) setMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menu]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const closeMenu = (focusButton = true) => {
    setMenu(false);
    if (focusButton) menuBtn.current?.focus();
  };

  const act = (fn: () => void) => {
    closeMenu(false);
    fn();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = title.trim();
    if (v && v !== t.title) onRename(v);
    setEditing(false);
  };

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  };

  if (editing) {
    return (
      <li className="thread-row is-editing">
        <form onSubmit={submit} className="rename-form">
          <label htmlFor={`${id}-t`} className="visually-hidden">
            Nuovo titolo
          </label>
          <input
            id={`${id}-t`}
            ref={input}
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setTitle(t.title);
                setEditing(false);
                setTimeout(() => menuBtn.current?.focus());
              }
            }}
            onBlur={() => setEditing(false)}
          />
        </form>
      </li>
    );
  }

  return (
    <li className={`thread-row${nested ? ' has-children' : ''}${t.parentId ? ' is-child' : ''}`}>
      <button type="button" className="thread-btn" aria-current={active ? 'page' : undefined} onClick={onSelect}>
        <span className="thread-title">
          {t.pinned && (
            <span className="pin-mark" aria-hidden="true">
              📌{' '}
            </span>
          )}
          {t.title}
        </span>
        <span className="thread-meta">
          {meta} · {t.project}
          {t.status === 'running' && !t.parentId && <span className="thread-running"> · al lavoro</span>}
        </span>
        {snippet && <span className="thread-snippet">{snippet}</span>}
      </button>
      <button
        type="button"
        ref={menuBtn}
        className="thread-more"
        aria-expanded={menu}
        aria-controls={`${id}-menu`}
        onClick={() => setMenu((m) => !m)}
      >
        <span aria-hidden="true">⋯</span>
        <span className="visually-hidden">Azioni per {t.title}</span>
      </button>
      {menu && (
        <div id={`${id}-menu`} ref={menuRef} className="thread-menu" role="group" aria-label={`Azioni per ${t.title}`} onKeyDown={onMenuKey}>
          <button type="button" onClick={() => act(() => setEditing(true))}>
            Rinomina
          </button>
          {!t.archived && (
            <button type="button" onClick={() => act(onPin)}>
              {t.pinned ? 'Togli dalle fissate' : 'Fissa in cima'}
            </button>
          )}
          <button type="button" onClick={() => act(onArchive)}>
            {t.archived ? 'Ripristina' : 'Archivia'}
          </button>
          <button type="button" className="danger-text" onClick={() => act(onDelete)}>
            Elimina
          </button>
        </div>
      )}
      {nested}
    </li>
  );
}
