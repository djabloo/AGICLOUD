import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { copyText, findUrls, terminalLines } from './termText';
import '@xterm/xterm/css/xterm.css';
import { currentToken, type TerminalSummary } from './api';
import { Icon } from './icons';
import { t as translate, useT } from './i18n';

const SR_KEY = 'agicloud_term_sr';

function readSrMode(): boolean {
  try {
    return localStorage.getItem(SR_KEY) === '1';
  } catch {
    return false;
  }
}

/** Tasti che sulla tastiera del telefono mancano o sono scomodi */
function getKeys(t: typeof translate): { label: string; name: string; seq: string }[] {
  return [
    { label: t('terminale.tastoInvio'), name: t('terminale.tastoInvio'), seq: '\r' },
    { label: t('terminale.tastoEsc'), name: t('terminale.tastoEsc'), seq: '\x1b' },
    { label: t('terminale.tastoTab'), name: t('terminale.tastoTab'), seq: '\t' },
    { label: t('terminale.tastoSpazio'), name: t('terminale.tastoSpazio'), seq: ' ' },
    { label: '⌫', name: t('terminale.tastoCanc'), seq: '\x7f' },
    { label: '↑', name: t('terminale.tastoSu'), seq: '\x1b[A' },
    { label: '↓', name: t('terminale.tastoGiu'), seq: '\x1b[B' },
    { label: '←', name: t('terminale.tastoSinistra'), seq: '\x1b[D' },
    { label: '→', name: t('terminale.tastoDestra'), seq: '\x1b[C' },
    { label: t('terminale.tastoPagSuEtichetta'), name: t('terminale.tastoPagSu'), seq: '\x1b[5~' },
    { label: t('terminale.tastoPagGiuEtichetta'), name: t('terminale.tastoPagGiu'), seq: '\x1b[6~' },
    { label: '^C', name: t('terminale.tastoCtrlC'), seq: '\x03' },
    { label: '^D', name: t('terminale.tastoCtrlD'), seq: '\x04' },
    { label: '|', name: t('terminale.tastoBarraVerticale'), seq: '|' },
    { label: '~', name: t('terminale.tastoTilde'), seq: '~' },
    { label: '/', name: t('terminale.tastoBarra'), seq: '/' },
  ];
}

type Conn = 'connecting' | 'open' | 'closed' | 'exited';

export function TerminalView({ terminal, onClose }: { terminal: TerminalSummary; onClose: () => void }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [conn, setConn] = useState<Conn>('connecting');
  const [srMode, setSrMode] = useState(readSrMode);
  const [links, setLinks] = useState<string[]>([]);
  // Link tolti dalla barra (cestino): restano tolti per questo terminale, anche riaprendolo
  const dismissKey = `agicloud_term_links_${terminal.id}`;
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(dismissKey) ?? '[]');
    } catch {
      return [];
    }
  });
  const dismiss = (urls: string[]) => {
    const next = [...new Set([...dismissed, ...urls])].slice(-200);
    setDismissed(next);
    try {
      sessionStorage.setItem(dismissKey, JSON.stringify(next));
    } catch {
      /* solo una comodita' */
    }
    setAnnounce(t('terminale.linkTolto', { n: urls.length }));
    host.current?.querySelector<HTMLElement>('textarea')?.focus();
  };
  const shownLinks = links.filter((u) => !dismissed.includes(u));
  const [textOpen, setTextOpen] = useState(false);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, 'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
      fontSize: 14,
      scrollback: 5000,
      screenReaderMode: readSrMode(),
      theme: { background: '#0b0f17', foreground: '#e8ecf3', cursor: '#8cc8ff', selectionBackground: '#2b4a6f' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Link cliccabili (quando stanno su una riga); quelli spezzati li raccoglie la barra dei link
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    term.open(host.current!);
    termRef.current = term;
    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* contenitore non ancora visibile */
      }
    };
    safeFit();

    // F6 esce dal terminale verso la barra degli strumenti (il terminale si tiene Tab ed Esc).
    // Ctrl+Maiusc+C copia la selezione, Ctrl+Maiusc+V incolla (Ctrl+C nel terminale = interrompi).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'F6') {
        toolbar.current?.querySelector<HTMLElement>('button')?.focus();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) void copyText(sel).then((ok) => setAnnounce(ok ? t('terminale.selezioneCopiata') : t('terminale.copiaNonRiuscita')));
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        void navigator.clipboard?.readText().then((t) => t && sendRef.current(t)).catch(() => {});
        return false;
      }
      return true;
    });

    // Barra dei link: si rilegge il testo poco dopo ogni aggiornamento dello schermo
    let linkTimer: ReturnType<typeof setTimeout> | null = null;
    const parsed = term.onWriteParsed(() => {
      if (linkTimer) clearTimeout(linkTimer);
      linkTimer = setTimeout(() => {
        const next = findUrls(terminalLines(term, 300));
        setLinks((cur) => (cur.join('\n') === next.join('\n') ? cur : next));
      }, 300);
    });

    let ws: WebSocket | null = null;
    let stopped = false;
    let replaying = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const send = (msg: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    sendRef.current = (data) => send({ type: 'input', data });

    const connect = () => {
      setConn('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/terminals/${terminal.id}/ws`);
      ws.onopen = () => send({ type: 'auth', token: currentToken(), cols: term.cols, rows: term.rows });
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'replay') {
          term.reset();
          // L'output riletto contiene domande al terminale (es. un programma chiede che terminale sei):
          // le risposte automatiche di xterm non vanno spedite alla shell come se le avessi scritte tu
          replaying = true;
          term.write(msg.data, () => {
            replaying = false;
          });
          setConn(msg.exited ? 'exited' : 'open');
          delay = 1000;
        } else if (msg.type === 'data') {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[2m${t('terminale.processoTerminatoCodice', { code: msg.code })}\x1b[0m\r\n`);
          setConn('exited');
        }
      };
      ws.onclose = (ev) => {
        if (stopped) return;
        if (ev.code === 4001 || ev.code === 4004) {
          setConn('closed');
          return;
        }
        setConn((c) => (c === 'exited' ? c : 'closed'));
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
    };
    connect();

    const input = term.onData((data) => {
      if (replaying && data.startsWith('\x1b')) return;
      // Ctrl della barra tasti: la lettera successiva diventa un carattere di controllo
      if (ctrlRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        ctrlRef.current = false;
        setCtrl(false);
      }
      send({ type: 'input', data });
    });
    const resized = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(host.current!);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      resized.dispose();
      parsed.dispose();
      if (linkTimer) clearTimeout(linkTimer);
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [terminal.id]);

  const toggleSr = () => {
    const next = !srMode;
    setSrMode(next);
    if (termRef.current) termRef.current.options.screenReaderMode = next;
    try {
      localStorage.setItem(SR_KEY, next ? '1' : '0');
    } catch {
      /* solo una comodita' */
    }
  };

  const pressKey = (seq: string) => {
    sendRef.current(seq);
    termRef.current?.focus();
  };

  const toggleCtrl = () => {
    ctrlRef.current = !ctrlRef.current;
    setCtrl(ctrlRef.current);
    termRef.current?.focus();
  };

  const statusText =
    conn === 'open'
      ? t('terminale.collegato')
      : conn === 'connecting'
        ? t('terminale.connessione')
        : conn === 'exited'
          ? t('terminale.processoTerminato')
          : t('terminale.disconnesso');

  return (
    <section className="term" aria-labelledby="term-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="term-title">{terminal.title}</h1>
          <p className="chat-meta">
            <span title={terminal.cwd}>
              <span className="visually-hidden">{t('terminale.cartella')}</span>
              {terminal.cwd}
            </span>
          </p>
        </div>
        <p className={`status status-${conn === 'open' ? 'ready' : conn === 'exited' ? 'idle' : 'error'}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {statusText}
        </p>
        <div className="term-tools" ref={toolbar}>
          <button type="button" className="btn small-btn" onClick={() => setTextOpen(true)}>
            {t('terminale.testo')}
          </button>
          <button type="button" className="btn small-btn" aria-pressed={srMode} onClick={toggleSr}>
            {t('terminale.lettoreSchermo')}
          </button>
          <button
            type="button"
            className="btn icon-btn"
            onClick={() => {
              if (confirm(t('terminale.confermaChiusura'))) onClose();
            }}
          >
            <Icon name="trash" />
            <span className="visually-hidden">{t('terminale.chiudiTerminale')}</span>
          </button>
        </div>
      </header>

      {shownLinks.length > 0 && (
        <div className="term-links" role="region" aria-label={t('terminale.linkNelTerminale')}>
          {shownLinks.map((url) => (
            <div key={url} className="term-link">
              <span className="term-link-url" title={url}>
                {url}
              </span>
              <a className="btn small-btn" href={url} target="_blank" rel="noopener noreferrer">
                {t('terminale.apri')}
                <span className="visually-hidden">{t('terminale.ilLink')}</span>
              </a>
              <button
                type="button"
                className="btn small-btn"
                onClick={() => void copyText(url).then((ok) => setAnnounce(ok ? t('terminale.linkCopiato') : t('terminale.copiaNonRiuscita')))}
              >
                {t('terminale.copia')}
                <span className="visually-hidden">{t('terminale.ilLink')}</span>
              </button>
              <button type="button" className="btn small-btn icon-btn" onClick={() => dismiss([url])}>
                <Icon name="trash" />
                <span className="visually-hidden">{t('terminale.togliLink', { url })}</span>
              </button>
            </div>
          ))}
          {shownLinks.length > 1 && (
            <button type="button" className="term-links-clear" onClick={() => dismiss(shownLinks)}>
              {t('terminale.togliTuttiLink')}
            </button>
          )}
        </div>
      )}

      <div className="term-host" ref={host} />

      <div className="keybar" role="toolbar" aria-label={t('terminale.tastiSpeciali')}>
        <button type="button" className="key" aria-pressed={ctrl} onClick={toggleCtrl}>
          Ctrl
        </button>
        {getKeys(t).map((k) => (
          <button key={k.name} type="button" className="key" aria-label={k.name} onClick={() => pressKey(k.seq)}>
            {k.label}
          </button>
        ))}
      </div>
      <p className="term-hint">{t('terminale.suggerimento')}</p>
      <TextDialog
        open={textOpen}
        getText={() => (termRef.current ? terminalLines(termRef.current, 500).join('\n') : '')}
        onSend={(t) => sendRef.current(t)}
        onClose={() => {
          setTextOpen(false);
          termRef.current?.focus();
        }}
      />
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}

/** Testo del terminale selezionabile (anche su telefono) + campo per incollare e inviare testo */
function TextDialog({
  open,
  getText,
  onSend,
  onClose,
}: {
  open: boolean;
  getText: () => string;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [input, setInput] = useState('');
  const [enter, setEnter] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setText(getText());
      setMsg('');
      d.showModal();
      // In fondo: le righe piu' recenti
      requestAnimationFrame(() => {
        if (area.current) area.current.scrollTop = area.current.scrollHeight;
      });
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog term-text-dialog" aria-labelledby="term-text-title" onClose={onClose}>
      <div className="term-text-body">
        <h2 id="term-text-title">{t('terminale.testoTerminale')}</h2>
        <label htmlFor="term-text-area" className="hint">
          {t('terminale.selezionaCopia')}
        </label>
        <textarea id="term-text-area" ref={area} className="mono-input term-text-area" readOnly value={text} rows={14} />
        <div className="dialog-actions start">
          <button
            type="button"
            className="btn"
            onClick={() => void copyText(text).then((ok) => setMsg(ok ? t('terminale.testoCopiato') : t('terminale.copiaNonRiuscita')))}
          >
            {t('terminale.copiaTutto')}
          </button>
        </div>

        <form
          className="term-send"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input) return;
            onSend(enter ? `${input}\r` : input);
            setInput('');
            setMsg(t('terminale.inviato'));
          }}
        >
          <label htmlFor="term-send-input">{t('terminale.inviaAlTerminale')}</label>
          <div className="secret-row">
            <input
              id="term-send-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('terminale.segnapostoInvio')}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="submit" className="btn primary" disabled={!input}>
              {t('terminale.invia')}
            </button>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} />
            <span>{t('terminale.premiInvio')}</span>
          </label>
        </form>

        <p className="hint" aria-live="polite">
          {msg}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('terminale.chiudi')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
