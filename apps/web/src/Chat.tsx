import { useEffect, useId, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, followEvents, type ThreadSummary } from './api';
import { emptyTranscript, reduce, type ConfigOption, type Item, type SlashCommand } from './transcript';
import { Markdown } from './markdown';
import { Icon } from './icons';

interface Props {
  thread: ThreadSummary;
  agentLabel: string;
  onDelete: () => void;
}

const STATUS_TEXT: Record<string, string> = {
  idle: 'In pausa',
  starting: 'Avvio dell\'agente…',
  ready: 'Pronto',
  running: 'Sta lavorando…',
  auth_required: 'Login richiesto',
  error: 'Errore',
  closed: 'Chiusa',
};

type Action = { type: 'event'; event: Parameters<typeof reduce>[1] } | { type: 'reset' };

export function Chat({ thread, agentLabel, onDelete }: Props) {
  const [state, dispatch] = useReducer(
    (s: typeof emptyTranscript, a: Action) => (a.type === 'reset' ? emptyTranscript : reduce(s, a.event)),
    emptyTranscript,
  );
  const [connected, setConnected] = useState(true);
  const [announce, setAnnounce] = useState({ polite: '', assertive: '' });
  const [sendError, setSendError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    dispatch({ type: 'reset' });
    stickToBottom.current = true;
    return followEvents(thread.id, (event) => dispatch({ type: 'event', event }), setConnected);
  }, [thread.id]);

  // Annunci per lettori di schermo: niente lettura del testo in streaming, solo i momenti importanti
  const prevRunning = useRef(false);
  const seenPermissions = useRef(new Set<string>());
  const seenErrors = useRef(new Set<string>());
  useEffect(() => {
    if (prevRunning.current && !state.running) setAnnounce((a) => ({ ...a, polite: 'Risposta completata' }));
    if (!prevRunning.current && state.running) setAnnounce((a) => ({ ...a, polite: 'L\'agente sta lavorando' }));
    prevRunning.current = state.running;
    for (const it of state.items) {
      if (it.kind === 'permission' && it.resolved === undefined && !seenPermissions.current.has(it.id)) {
        seenPermissions.current.add(it.id);
        setAnnounce((a) => ({ ...a, assertive: `Permesso richiesto: ${it.title}` }));
      }
      if (it.kind === 'error' && !seenErrors.current.has(it.id)) {
        seenErrors.current.add(it.id);
        setAnnounce((a) => ({ ...a, assertive: it.message }));
      }
    }
  }, [state]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.items]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async (prompt: string) => {
    setSendError('');
    stickToBottom.current = true;
    try {
      await api.run(thread.id, prompt);
      return true;
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  // Ad agente in pausa si puo' scrivere: si riaccende e riprende la sessione
  const canSend = (state.status === 'ready' || state.status === 'idle' || state.status === 'error') && !state.running;

  return (
    <section className="chat" aria-labelledby="chat-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="chat-title">{thread.title}</h1>
          <p className="chat-meta">
            <span>{state.agentName ?? agentLabel}</span>
            <span aria-hidden="true"> · </span>
            <span title={thread.cwd}>
              <span className="visually-hidden">Progetto </span>
              {thread.cwd}
            </span>
          </p>
        </div>
        <p className={`status status-${state.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {STATUS_TEXT[state.status] ?? state.status}
          {!connected && <span className="status-offline"> — riconnessione…</span>}
        </p>
        <button
          type="button"
          className="btn icon-btn"
          onClick={() => {
            if (confirm('Chiudere questa conversazione? L\'agente verra\' fermato.')) onDelete();
          }}
        >
          <Icon name="trash" />
          <span className="visually-hidden">Chiudi conversazione</span>
        </button>
      </header>

      <div className="transcript" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Messaggi">
        {state.items.length === 0 && state.status !== 'error' && state.status !== 'auth_required' && (
          <p className="empty">{state.status === 'starting' ? 'Avvio dell\'agente…' : 'Scrivi il primo messaggio.'}</p>
        )}
        {state.status === 'idle' && state.items.length > 0 && (
          <p className="empty">Agente in pausa: si riattiva da solo al prossimo messaggio, con la stessa sessione.</p>
        )}
        {(state.status === 'error' || state.status === 'auth_required') && state.statusMessage && (
          <div className="notice notice-error" role="alert">
            <strong>{STATUS_TEXT[state.status]}</strong>
            <pre>{state.statusMessage}</pre>
          </div>
        )}
        <ol className="items">
          {state.items.map((it) => (
            <li key={it.id} className={`item item-${it.kind}${it.kind === 'message' ? ` from-${it.role}` : ''}`}>
              <ItemView item={it} threadId={thread.id} />
            </li>
          ))}
        </ol>
        {state.running && (
          <p className="working" aria-hidden="true">
            <span className="dots" />
          </p>
        )}
      </div>

      {state.configOptions.length > 0 && (
        <ConfigBar threadId={thread.id} options={state.configOptions} disabled={state.status === 'starting'} />
      )}

      <Composer
        commands={state.commands}
        disabled={!canSend}
        running={state.running}
        error={sendError}
        usage={state.usage}
        onSend={send}
        onStop={() => api.cancel(thread.id).catch(() => {})}
      />

      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announce.polite}
      </div>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {announce.assertive}
      </div>
    </section>
  );
}

function ItemView({ item, threadId }: { item: Item; threadId: string }) {
  switch (item.kind) {
    case 'message':
      return (
        <article className="message" aria-label={item.role === 'user' ? 'Tu' : 'Agente'}>
          {item.role === 'user' ? <p className="user-text">{item.text}</p> : <Markdown text={item.text} />}
        </article>
      );
    case 'reasoning':
      return (
        <details className="reasoning">
          <summary>Ragionamento</summary>
          <p>{item.text}</p>
        </details>
      );
    case 'tool':
      return <ToolView item={item} />;
    case 'permission':
      return <PermissionView item={item} threadId={threadId} />;
    case 'plan':
      return (
        <div className="plan">
          <h2 className="plan-title">Piano</h2>
          <ol>
            {item.entries.map((e, i) => (
              <li key={i} className={`plan-${e.status}`}>
                <span className="visually-hidden">{planStatus(e.status)}: </span>
                {e.content}
              </li>
            ))}
          </ol>
        </div>
      );
    case 'error':
      return <p className="notice notice-error">{item.message}</p>;
  }
}

function ToolView({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const statusLabel =
    item.status === 'completed' ? 'completato' : item.status === 'failed' ? 'fallito' : item.status === 'in_progress' ? 'in corso' : 'in attesa';
  return (
    <details className={`tool tool-${item.status}`}>
      <summary>
        <Icon name="tool" />
        <span className="tool-title">{item.title}</span>
        <span className="tool-status">{statusLabel}</span>
      </summary>
      {item.locations.length > 0 && (
        <ul className="tool-files">
          {item.locations.map((l, i) => (
            <li key={i}>
              <code>
                {l.path}
                {l.line ? `:${l.line}` : ''}
              </code>
            </li>
          ))}
        </ul>
      )}
      {item.result && <pre className="tool-result">{item.result}</pre>}
    </details>
  );
}

function PermissionView({ item, threadId }: { item: Extract<Item, { kind: 'permission' }>; threadId: string }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const answer = async (optionId: string | null) => {
    setBusy(true);
    try {
      await api.respondPermission(threadId, item.id, optionId);
    } catch {
      setBusy(false);
    }
  };
  const resolved = item.resolved !== undefined;
  const chosen = item.options.find((o) => o.optionId === item.resolved);
  return (
    <div className={`permission${resolved ? ' is-resolved' : ''}`} role="group" aria-labelledby={`${id}-t`}>
      <p id={`${id}-t`} className="permission-title">
        <Icon name="shield" />
        <span>
          <span className="visually-hidden">Permesso richiesto: </span>
          {item.title}
        </span>
      </p>
      {resolved ? (
        <p className="permission-outcome">{chosen ? `Scelta: ${chosen.name}` : 'Annullato'}</p>
      ) : (
        <div className="permission-actions">
          {item.options.map((o) => (
            <button
              key={o.optionId}
              type="button"
              className={`btn ${o.kind.startsWith('allow') ? 'primary' : ''}`}
              disabled={busy}
              onClick={() => answer(o.optionId)}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigBar({ threadId, options, disabled }: { threadId: string; options: ConfigOption[]; disabled: boolean }) {
  const id = useId();
  const [error, setError] = useState('');
  const change = async (configId: string, value: string | boolean) => {
    setError('');
    try {
      await api.setConfig(threadId, configId, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="config-bar" role="group" aria-label="Impostazioni dell'agente">
      {options.map((o) =>
        o.type === 'boolean' ? (
          <label key={o.id} className="cfg cfg-bool" title={o.description ?? undefined}>
            <input
              type="checkbox"
              checked={o.currentValue === true}
              disabled={disabled}
              onChange={(e) => change(o.id, e.target.checked)}
            />
            <span>{o.name}</span>
          </label>
        ) : (
          <label key={o.id} className="cfg" htmlFor={`${id}-${o.id}`}>
            <span className="cfg-name">{o.name}</span>
            <select
              id={`${id}-${o.id}`}
              value={String(o.currentValue)}
              disabled={disabled}
              onChange={(e) => change(o.id, e.target.value)}
            >
              {(o.options ?? []).map((opt) =>
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
          </label>
        ),
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const MAX_SUGGESTIONS = 8;

function Composer({
  commands,
  disabled,
  running,
  error,
  usage,
  onSend,
  onStop,
}: {
  commands: SlashCommand[];
  disabled: boolean;
  running: boolean;
  error: string;
  usage?: { used: number; size: number };
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Suggerimenti dei comandi slash: solo mentre si scrive la prima parola che inizia con "/"
  const query = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  const suggestions =
    query === undefined || dismissed
      ? []
      : commands
          .filter((c) => c.name.toLowerCase().includes(query))
          .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
          .slice(0, MAX_SUGGESTIONS);
  const open = suggestions.length > 0;
  const activeIndex = Math.min(active, suggestions.length - 1);

  const pick = (c: SlashCommand) => {
    setText(`/${c.name} `);
    setActive(0);
    area.current?.focus();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    if (await onSend(value)) setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestions.length;
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[activeIndex]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // Invio invia, Maiusc+Invio va a capo (non durante la composizione IME)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const listId = `${id}-cmds`;
  return (
    <form className="composer" onSubmit={submit}>
      {open && (
        <ul id={listId} className="suggestions" role="listbox" aria-label="Comandi">
          {suggestions.map((c, i) => (
            <li
              key={c.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className="suggestion"
              onMouseDown={(e) => {
                e.preventDefault(); // il focus resta nel campo di testo
                pick(c);
              }}
            >
              <span className="suggestion-name">/{c.name}</span>
              <span className="suggestion-desc">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={`${id}-msg`} className="visually-hidden">
        Messaggio all'agente
      </label>
      <textarea
        id={`${id}-msg`}
        ref={area}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDismissed(false);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={commands.length ? 'Scrivi all\'agente… ( / per i comandi)' : 'Scrivi all\'agente…'}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`}
      />
      {running ? (
        <button type="button" className="btn send-btn danger" onClick={onStop}>
          <Icon name="stop" />
          <span className="visually-hidden">Interrompi</span>
        </button>
      ) : (
        <button type="submit" className="btn send-btn primary" disabled={disabled || !text.trim()}>
          <Icon name="send" />
          <span className="visually-hidden">Invia</span>
        </button>
      )}
      <p id={`${id}-hint`} className="composer-hint">
        Invio per inviare, Maiusc+Invio per andare a capo
        {commands.length > 0 && ', / per i comandi'}
        {usage && (
          <span className="usage">
            {' '}
            · contesto {Math.round((usage.used / usage.size) * 100)}%
          </span>
        )}
      </p>
      <div className="visually-hidden" aria-live="polite">
        {open ? `${suggestions.length} comandi disponibili, frecce per scegliere` : ''}
      </div>
      {error && (
        <p id={`${id}-err`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function planStatus(s: string): string {
  return s === 'completed' ? 'fatto' : s === 'in_progress' ? 'in corso' : 'da fare';
}
