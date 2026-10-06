import { useEffect, useId, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, followEvents, type ThreadSummary } from './api';
import { emptyTranscript, reduce, type Item } from './transcript';
import { Markdown } from './markdown';
import { Icon } from './icons';

interface Props {
  thread: ThreadSummary;
  agentLabel: string;
  onDelete: () => void;
}

const STATUS_TEXT: Record<string, string> = {
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

  const canSend = state.status === 'ready' && !state.running;

  return (
    <section className="chat" aria-labelledby="chat-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="chat-title">{thread.title}</h1>
          <p className="chat-meta">
            <span>{state.agentName ?? agentLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>
              <span className="visually-hidden">Workspace </span>
              {thread.workspace}
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

      <Composer
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

function Composer({
  disabled,
  running,
  error,
  usage,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  error: string;
  usage?: { used: number; size: number };
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    if (await onSend(value)) setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Invio invia, Maiusc+Invio va a capo (non durante la composizione IME)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor={`${id}-msg`} className="visually-hidden">
        Messaggio all'agente
      </label>
      <textarea
        id={`${id}-msg`}
        ref={area}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Scrivi all'agente…"
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
        {usage && (
          <span className="usage">
            {' '}
            · contesto {Math.round((usage.used / usage.size) * 100)}%
          </span>
        )}
      </p>
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
