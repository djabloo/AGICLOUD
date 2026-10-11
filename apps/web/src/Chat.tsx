import { useEffect, useId, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, apiFetch, followEvents, type FileEntry, type ThreadSummary } from './api';
import { emptyTranscript, reduce, type ConfigOption, type Item, type SlashCommand } from './transcript';
import { Markdown } from './markdown';
import { Icon } from './icons';
import { fmtDateTime, fmtNumber, t, useT } from './i18n';
import { DiffStat, DiffView, diffStats } from './DiffView';
import { ChildPanel, DelegationView, LeadChildren } from './LeadViews';
import { SearchSelect } from './SearchSelect';
import { HandoverBar } from './HandoverBar';
import { DesignBar } from './DesignPreview';

interface Props {
  thread: ThreadSummary;
  /** Tutte le conversazioni: per i thread affidati dal capo e il loro stato */
  threads: ThreadSummary[];
  agentLabel: string;
  onDelete: () => void;
  onOpenTerminal: () => void;
}

function statusText(s: string): string {
  if (s === 'idle') return t('chat.statoInPausa');
  if (s === 'starting') return t('chat.statoAvvio');
  if (s === 'ready') return t('chat.statoPronto');
  if (s === 'running') return t('chat.statoLavoro');
  if (s === 'auth_required') return t('chat.statoLogin');
  if (s === 'error') return t('chat.statoErrore');
  if (s === 'closed') return t('chat.statoChiusa');
  return s;
}

type Action = { type: 'event'; event: Parameters<typeof reduce>[1] } | { type: 'reset' };

export function Chat({ thread, threads, agentLabel, onDelete, onOpenTerminal }: Props) {
  const t = useT();
  const [state, dispatch] = useReducer(
    (s: typeof emptyTranscript, a: Action) => (a.type === 'reset' ? emptyTranscript : reduce(s, a.event)),
    emptyTranscript,
  );
  const [connected, setConnected] = useState(true);
  const [announce, setAnnounce] = useState({ polite: '', assertive: '' });
  const [sendError, setSendError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [handoverOpen, setHandoverOpen] = useState(false);
  /** Lontano dal fondo: compare la freccia per tornarci */
  const [awayFromBottom, setAwayFromBottom] = useState(false);

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
    if (prevRunning.current && !state.running) setAnnounce((a) => ({ ...a, polite: t('chat.rispostaCompletata') }));
    if (!prevRunning.current && state.running) setAnnounce((a) => ({ ...a, polite: t('chat.agenteLavora') }));
    prevRunning.current = state.running;
    for (const it of state.items) {
      if (it.kind === 'permission' && it.resolved === undefined && !seenPermissions.current.has(it.id)) {
        seenPermissions.current.add(it.id);
        setAnnounce((a) => ({ ...a, assertive: t('chat.permessoRichiesto', { titolo: it.title }) }));
      }
      if (it.kind === 'delegation' && it.state === 'pending' && !seenPermissions.current.has(it.id)) {
        seenPermissions.current.add(it.id);
        setAnnounce((a) => ({ ...a, assertive: t('chat.delegaProposta', { titolo: it.title, agente: it.agentLabel }) }));
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
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAwayFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
  };

  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    stickToBottom.current = true;
    setAwayFromBottom(false);
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true });
  };

  const send = async (prompt: string, attachments: string[]) => {
    setSendError('');
    stickToBottom.current = true;
    try {
      await api.run(thread.id, prompt, attachments);
      return true;
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  // Ad agente in pausa si puo' scrivere: si riaccende e riprende la sessione
  // Thread affidato gia' unito o scartato: concluso, la sua copia non c'e' piu'
  const closed = Boolean(thread.worktree && thread.worktree.state !== 'open');
  const canSend = (state.status === 'ready' || state.status === 'idle' || state.status === 'error') && !state.running && !closed;

  return (
    <section className="chat" aria-labelledby="chat-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="chat-title">{thread.title}</h1>
          <p className="chat-meta">
            <span>
              {thread.lead && t('chat.capo')}
              {state.agentName ?? agentLabel}
            </span>
            <span aria-hidden="true"> · </span>
            <span title={thread.cwd}>
              <span className="visually-hidden">{t('chat.progetto')}</span>
              {thread.cwd}
            </span>
          </p>
        </div>
        <p className={`status status-${state.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusText(state.status)}
          {!connected && <span className="status-offline">{t('chat.riconnessione')}</span>}
        </p>
        <button type="button" className="btn icon-btn" aria-expanded={handoverOpen} onClick={() => setHandoverOpen((v) => !v)}>
          <Icon name="swap" />
          <span className="visually-hidden">{t('chat.passaLavoro')}</span>
        </button>
        <button type="button" className="btn icon-btn" onClick={onOpenTerminal}>
          <Icon name="terminal" />
          <span className="visually-hidden">{t('chat.apriTerminale')}</span>
        </button>
        <button
          type="button"
          className="btn icon-btn"
          onClick={() => {
            if (confirm(t('chat.chiudiConferma'))) onDelete();
          }}
        >
          <Icon name="trash" />
          <span className="visually-hidden">{t('chat.chiudiConversazione')}</span>
        </button>
      </header>

      <HandoverBar
        thread={thread}
        threads={threads}
        manual={handoverOpen}
        onManualClose={() => setHandoverOpen(false)}
        onMoved={(t) => {
          location.hash = `#/t/${t.id}`;
        }}
      />
      {thread.lead && <LeadChildren lead={thread} threads={threads} />}
      {thread.parentId && <ChildPanel thread={thread} threads={threads} running={state.running} />}
      {thread.design && <DesignBar thread={thread} running={state.running} />}

      <div className="transcript" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label={t('chat.messaggi')}>
        {state.items.length === 0 && state.status !== 'error' && state.status !== 'auth_required' && (
          <p className="empty">{state.status === 'starting' ? t('chat.statoAvvio') : t('chat.scriviPrimo')}</p>
        )}
        {state.status === 'idle' && state.items.length > 0 && (
          <p className="empty">{t('chat.agentePausa')}</p>
        )}
        {(state.status === 'error' || state.status === 'auth_required') && state.statusMessage && (
          <div className="notice notice-error" role="alert">
            <strong>{statusText(state.status)}</strong>
            <pre>{state.statusMessage}</pre>
          </div>
        )}
        <ol className="items">
          {state.items.map((it) => (
            <li key={it.id} className={`item item-${it.kind}${it.kind === 'message' ? ` from-${it.role}` : ''}`}>
              <ItemView item={it} threadId={thread.id} cwd={thread.cwd} threads={threads} />
            </li>
          ))}
        </ol>
        {state.running && (
          <p className="working" aria-hidden="true">
            <span className="dots" />
          </p>
        )}
        {awayFromBottom && (
          <button type="button" className="btn icon-btn jump-bottom" onClick={jumpToBottom}>
            <span aria-hidden="true">↓</span>
            <span className="visually-hidden">{t('chat.vaiAllaFine')}</span>
          </button>
        )}
      </div>

      {state.configOptions.length > 0 && (
        <ConfigBar threadId={thread.id} options={state.configOptions} disabled={state.status === 'starting'} />
      )}

      <Composer
        threadId={thread.id}
        cwd={thread.cwd}
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

function ItemView({ item, threadId, cwd, threads }: { item: Item; threadId: string; cwd: string; threads: ThreadSummary[] }) {
  const t = useT();
  switch (item.kind) {
    case 'message':
      if (item.auto) {
        return (
          <details className="auto-message">
            <summary>{t('chat.messaggioAutomatico')}</summary>
            <p className="user-text">{item.text}</p>
          </details>
        );
      }
      return (
        <article className="message" aria-label={item.role === 'user' ? t('chat.ruoloTu') : t('chat.ruoloAgente')}>
          {item.role === 'user' ? <p className="user-text">{item.text}</p> : <Markdown text={item.text} chat />}
        </article>
      );
    case 'delegation':
      return <DelegationView item={item} threadId={threadId} threads={threads} />;
    case 'notice':
      return (
        <p className="notice notice-info">
          {item.text}
          {item.childId && (
            <>
              {' '}
              <a href={`#/t/${item.childId}`}>{item.linkLabel ?? t('chat.apriThread')}</a>
            </>
          )}
        </p>
      );
    case 'reasoning':
      return (
        <details className="reasoning">
          <summary>{t('chat.ragionamento')}</summary>
          <p>{item.text}</p>
        </details>
      );
    case 'tool':
      return <ToolView item={item} cwd={cwd} />;
    case 'permission':
      return <PermissionView item={item} threadId={threadId} />;
    case 'plan':
      return (
        <div className="plan">
          <h2 className="plan-title">{t('chat.piano')}</h2>
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
    case 'attachments':
      return (
        <ul className="attach-list sent" aria-label={t('chat.fileAllegati')}>
          {item.files.map((f) => (
            <li key={f.path} className="attach-chip" title={f.path}>
              <Icon name="file" />
              <span className="attach-name">{f.name}</span>
              <span className="attach-size">{formatSize(f.size)}</span>
            </li>
          ))}
        </ul>
      );
  }
}

function ToolView({ item, cwd }: { item: Extract<Item, { kind: 'tool' }>; cwd: string }) {
  const t = useT();
  const statusLabel =
    item.status === 'completed' ? t('chat.strumentoCompletato') : item.status === 'failed' ? t('chat.strumentoFallito') : item.status === 'in_progress' ? t('chat.strumentoCorso') : t('chat.strumentoAttesa');
  const fileHref = (p: string) => `#/files/${encodeURIComponent(p.startsWith('/') ? p : `${cwd}/${p}`)}`;
  const stats = item.diffs ? diffStats(item.diffs) : null;
  return (
    <details className={`tool tool-${item.status}`} open={item.diffs ? true : undefined}>
      <summary>
        <Icon name="tool" />
        <span className="tool-title">{item.title}</span>
        {stats && <DiffStat added={stats.added} removed={stats.removed} />}
        <span className="tool-status">{statusLabel}</span>
      </summary>
      {item.diffs?.map((d, i) => <DiffView key={i} diff={d} href={fileHref(d.path)} />)}
      {!item.diffs && item.locations.length > 0 && (
        <ul className="tool-files">
          {item.locations.map((l, i) => (
            <li key={i}>
              {/* Apre il file nella sezione File */}
              <a href={fileHref(l.path)}>
                <code>
                  {l.path}
                  {l.line ? `:${l.line}` : ''}
                </code>
              </a>
            </li>
          ))}
        </ul>
      )}
      {item.result && !item.diffs && <pre className="tool-result">{item.result}</pre>}
    </details>
  );
}

function PermissionView({ item, threadId }: { item: Extract<Item, { kind: 'permission' }>; threadId: string }) {
  const t = useT();
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
          <span className="visually-hidden">{t('chat.permessoRichiestoLabel')}</span>
          {item.title}
        </span>
      </p>
      {resolved ? (
        <p className="permission-outcome">{chosen ? t('chat.scelta', { nome: chosen.name }) : t('chat.annullato')}</p>
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
  const t = useT();
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
  const [open, setOpen] = useState(false);
  const panelId = `${id}-panel`;
  // Riassunto in una riga: i valori scelti, senza i nomi delle opzioni
  const summary = options
    .map((o) => {
      if (o.type === 'boolean') return o.currentValue === true ? o.name : null;
      const flat = (o.options ?? []).flatMap((opt) => ('group' in opt ? opt.options : [opt]));
      return flat.find((x) => x.value === o.currentValue)?.name ?? String(o.currentValue);
    })
    .filter((v) => v && v !== 'Off' && v !== 'Default')
    .join(' · ');
  return (
    <div className={`config-bar${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="config-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="settings" />
        <span className="visually-hidden">{t('chat.impostazioniDuePunti')}</span>
        <span className="config-summary">{summary || t('chat.impostazioni')}</span>
        <span className="config-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      <div id={panelId} className="config-panel" role="group" aria-label={t('chat.impostazioniAgente')} hidden={!open}>
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
          <SearchSelect
            key={o.id}
            id={`${id}-${o.id}`}
            label={o.name}
            value={String(o.currentValue)}
            options={o.options ?? []}
            disabled={disabled}
            onChange={(v) => change(o.id, v)}
          />
        ),
      )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const MAX_SUGGESTIONS = 8;

interface PendingFile {
  key: string;
  name: string;
  size: number;
  preview?: string;
  status: 'uploading' | 'ready' | 'error';
  path?: string;
  error?: string;
}

function Composer({
  threadId,
  cwd,
  commands,
  disabled,
  running,
  error,
  usage,
  onSend,
  onStop,
}: {
  threadId: string;
  /** Cartella del progetto: da li' si allegano i documenti di pii-clean/ */
  cwd: string;
  commands: SlashCommand[];
  disabled: boolean;
  running: boolean;
  error: string;
  usage?: { used: number; size: number };
  onSend: (text: string, attachments: string[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const t = useT();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileMsg, setFileMsg] = useState('');

  const addFiles = async (list: FileList | File[]) => {
    const picked = [...list];
    if (!picked.length) return;
    const entries: PendingFile[] = picked.map((f) => ({
      key: `${Date.now()}-${Math.random()}`,
      name: f.name || 'immagine.png',
      size: f.size,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      status: 'uploading',
    }));
    setFiles((cur) => [...cur, ...entries]);
    setFileMsg(t('chat.caricamentoFile', { n: fmtNumber(picked.length) }));
    try {
      const saved = await api.upload(threadId, picked);
      setFiles((cur) =>
        cur.map((p) => {
          const i = entries.findIndex((e) => e.key === p.key);
          return i >= 0 ? { ...p, status: 'ready', path: saved[i]?.path } : p;
        }),
      );
      setFileMsg(t('chat.filePronti', { n: fmtNumber(picked.length) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFiles((cur) => cur.map((p) => (entries.some((e) => e.key === p.key) ? { ...p, status: 'error', error: msg } : p)));
      setFileMsg(t('chat.caricamentoFallito', { errore: msg }));
    }
  };

  // Documenti anonimizzati gia' nel progetto (pii-clean/): si allegano senza ricaricarli
  const addPiiFiles = (picked: FileEntry[]) => {
    const fresh = picked.filter((f) => !files.some((p) => p.path === `pii-clean/${f.name}`));
    setFiles((cur) => [
      ...cur,
      ...fresh.map((f) => ({ key: `pii-${f.name}`, name: f.name, size: f.size, status: 'ready' as const, path: `pii-clean/${f.name}` })),
    ]);
    if (fresh.length) setFileMsg(fresh.length === 1 ? t('chat.documentoPronto', { n: fmtNumber(fresh.length) }) : t('chat.documentiPronti', { n: fmtNumber(fresh.length) }));
    area.current?.focus();
  };
  const [attachMenu, setAttachMenu] = useState(false);
  /** Il plugin Browser e' attivo: si puo' allegare lo screenshot della pagina condivisa */
  const [browserOn, setBrowserOn] = useState(false);
  useEffect(() => {
    if (attachMenu) api.plugins().then((ps) => setBrowserOn(ps.some((p) => p.id === 'browser' && p.enabled))).catch(() => {});
  }, [attachMenu]);
  const canCapture = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

  /** Screenshot di una scheda, finestra o schermo scelti da te (il browser chiede il permesso) */
  const captureScreen = async () => {
    setAttachMenu(false);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // Un attimo perche' sparisca il riquadro di scelta del browser
      await new Promise((r) => setTimeout(r, 400));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error(t('chat.immagineVuota'));
      await addFiles([new File([blob], `screenshot-${stamp()}.png`, { type: 'image/png' })]);
    } catch (err) {
      // Annullato da te: nessun messaggio
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      setFileMsg(t('chat.screenshotFallito', { errore: err instanceof Error ? err.message : String(err) }));
    } finally {
      area.current?.focus();
    }
  };

  /** Screenshot della pagina aperta nel Browser condiviso */
  const captureBrowser = async () => {
    setAttachMenu(false);
    setFileMsg(t('chat.screenshotBrowser'));
    try {
      const blob = await (await apiFetch('/browser/screenshot')).blob();
      await addFiles([new File([blob], `browser-${stamp()}.png`, { type: 'image/png' })]);
    } catch (err) {
      setFileMsg(t('chat.screenshotBrowserFallito', { errore: err instanceof Error ? err.message : String(err) }));
    } finally {
      area.current?.focus();
    }
  };
  const [piiOpen, setPiiOpen] = useState(false);
  const attachBtn = useRef<HTMLButtonElement>(null);
  // Menu degli allegati: un clic fuori lo chiude
  useEffect(() => {
    if (!attachMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.attach-wrap')) setAttachMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [attachMenu]);

  const removeFile = (key: string) => {
    setFiles((cur) => {
      const f = cur.find((p) => p.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return cur.filter((p) => p.key !== key);
    });
    area.current?.focus();
  };

  const uploading = files.some((f) => f.status === 'uploading');
  const ready = files.filter((f) => f.status === 'ready' && f.path).map((f) => f.path!);
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
    if ((!value && !ready.length) || disabled || uploading) return;
    if (await onSend(value, ready)) {
      setText('');
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      setFiles([]);
      setFileMsg('');
    }
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
    <>
    <form
      className="composer"
      onSubmit={submit}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <ul className="attach-list pending" aria-label={t('chat.fileDaInviare')}>
          {files.map((f) => (
            <li key={f.key} className={`attach-chip is-${f.status}`}>
              {f.preview ? <img src={f.preview} alt="" className="attach-thumb" /> : <Icon name="file" />}
              <span className="attach-name">{f.name}</span>
              <span className="attach-size">
                {f.status === 'uploading' ? t('chat.caricamento') : f.status === 'error' ? t('chat.errore') : formatSize(f.size)}
              </span>
              <button type="button" className="attach-remove" onClick={() => removeFile(f.key)}>
                <Icon name="close" />
                <span className="visually-hidden">{t('chat.togli', { nome: f.name })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="attach-wrap">
        <button
          ref={attachBtn}
          type="button"
          className="btn icon-btn attach-btn"
          aria-expanded={attachMenu}
          aria-controls={`${id}-attach-menu`}
          onClick={() => setAttachMenu((v) => !v)}
        >
          <Icon name="clip" />
          <span className="visually-hidden">{t('chat.allegaFile')}</span>
        </button>
        {attachMenu && (
          <div
            id={`${id}-attach-menu`}
            className="thread-menu attach-menu"
            role="group"
            aria-label={t('chat.allega')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAttachMenu(false);
                attachBtn.current?.focus();
              }
            }}
          >
            <button
              type="button"
              autoFocus
              onClick={() => {
                setAttachMenu(false);
                fileInput.current?.click();
              }}
            >
              {t('chat.dalDispositivo')}
            </button>
            {canCapture && (
              <button type="button" onClick={() => void captureScreen()}>
                {t('chat.catturaSchermo')}
              </button>
            )}
            {browserOn && (
              <button type="button" onClick={() => void captureBrowser()}>
                {t('chat.screenshotCondiviso')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setAttachMenu(false);
                setPiiOpen(true);
              }}
            >
              {t('chat.documentiAnonimizzati')}
            </button>
          </div>
        )}
      </div>
      {open && (
        <ul id={listId} className="suggestions" role="listbox" aria-label={t('chat.comandi')}>
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
        {t('chat.messaggioAgente')}
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
        onPaste={(e) => {
          // Immagini incollate (screenshot): diventano allegati
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
          }
        }}
        placeholder={t('chat.scriviAgente')}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`}
      />
      {running ? (
        <button type="button" className="btn send-btn danger" onClick={onStop}>
          <Icon name="stop" />
          <span className="visually-hidden">{t('chat.interrompi')}</span>
        </button>
      ) : (
        <button type="submit" className="btn send-btn primary" disabled={disabled || uploading || (!text.trim() && !ready.length)}>
          <Icon name="send" />
          <span className="visually-hidden">{t('chat.invia')}</span>
        </button>
      )}
      <p id={`${id}-hint`} className="composer-hint">
        {t('chat.invioSuggerimento')}
        {commands.length > 0 && t('chat.slashComandi')}
        {usage && (
          <span className="usage">
            {' '}
            {t('chat.contesto', { perc: fmtNumber(Math.round((usage.used / usage.size) * 100)) })}
          </span>
        )}
      </p>
      <div className="visually-hidden" aria-live="polite">
        {open ? t('chat.comandiDisponibili', { n: suggestions.length }) : fileMsg}
      </div>
      {error && (
        <p id={`${id}-err`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
      <PiiPicker
        open={piiOpen}
        cwd={cwd}
        onClose={() => {
          setPiiOpen(false);
          attachBtn.current?.focus();
        }}
        onPick={addPiiFiles}
      />
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function planStatus(s: string): string {
  return s === 'completed' ? t('chat.pianoFatto') : s === 'in_progress' ? t('chat.pianoCorso') : t('chat.pianoDaFare');
}

/** Scelta dei documenti anonimizzati del progetto (pii-clean/) da allegare al messaggio */
function PiiPicker({ open, cwd, onClose, onPick }: { open: boolean; cwd: string; onClose: () => void; onPick: (files: FileEntry[]) => void }) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<FileEntry[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setChosen([]);
      setList(null);
      api
        .listFiles(`${cwd}/pii-clean`)
        .then((r) => setList(r.entries.filter((e) => e.type === 'file').sort((a, b) => b.mtime - a.mtime)))
        .catch(() => setList([]));
    }
    if (!open && d.open) d.close();
  }, [open, cwd]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-t`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onPick((list ?? []).filter((f) => chosen.includes(f.name)));
          onClose();
        }}
      >
        <h2 id={`${id}-t`}>{t('chat.documentiTitolo')}</h2>
        <p className="hint">
          {t('chat.daCodice')} <code>pii-clean/</code> {t('chat.documentiSpiegazione')}
        </p>
        {list === null ? (
          <p className="hint">{t('chat.caricamentoTrePunti')}</p>
        ) : list.length === 0 ? (
          <p>
            {t('chat.nessunDocumento')} <a href="#/pii">PII</a> {t('chat.eSalva', { cwd })}
          </p>
        ) : (
          <fieldset className="pii-pick">
            <legend className="visually-hidden">{t('chat.scegliDocumenti')}</legend>
            {list.map((f) => (
              <label key={f.name} className="choice">
                <input
                  type="checkbox"
                  checked={chosen.includes(f.name)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, f.name] : c.filter((x) => x !== f.name)))}
                />
                <span className="choice-text">
                  <span>{f.name}</span>
                  <span className="hint">
                    {formatSize(f.size)} · {fmtDateTime(f.mtime, { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('chat.annulla')}
          </button>
          <button type="submit" className="btn primary" disabled={!chosen.length}>
            {chosen.length ? t('chat.allegaConteggio', { n: `(${fmtNumber(chosen.length)})` }) : t('chat.allegaSenzaConteggio')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
