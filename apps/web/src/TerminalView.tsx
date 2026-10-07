import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { currentToken, type TerminalSummary } from './api';
import { Icon } from './icons';

const SR_KEY = 'agicloud_term_sr';

function readSrMode(): boolean {
  try {
    return localStorage.getItem(SR_KEY) === '1';
  } catch {
    return false;
  }
}

/** Tasti che sulla tastiera del telefono mancano o sono scomodi */
const KEYS: { label: string; name: string; seq: string }[] = [
  { label: 'Invio', name: 'Invio', seq: '\r' },
  { label: 'Esc', name: 'Esc', seq: '\x1b' },
  { label: 'Tab', name: 'Tab', seq: '\t' },
  { label: 'Spazio', name: 'Spazio', seq: ' ' },
  { label: '⌫', name: 'Cancella indietro', seq: '\x7f' },
  { label: '↑', name: 'Freccia su', seq: '\x1b[A' },
  { label: '↓', name: 'Freccia giu\'', seq: '\x1b[B' },
  { label: '←', name: 'Freccia sinistra', seq: '\x1b[D' },
  { label: '→', name: 'Freccia destra', seq: '\x1b[C' },
  { label: 'PgSu', name: 'Pagina su', seq: '\x1b[5~' },
  { label: 'PgGiù', name: 'Pagina giu\'', seq: '\x1b[6~' },
  { label: '^C', name: 'Control C', seq: '\x03' },
  { label: '^D', name: 'Control D', seq: '\x04' },
  { label: '|', name: 'Barra verticale', seq: '|' },
  { label: '~', name: 'Tilde', seq: '~' },
  { label: '/', name: 'Barra', seq: '/' },
];

type Conn = 'connecting' | 'open' | 'closed' | 'exited';

export function TerminalView({ terminal, onClose }: { terminal: TerminalSummary; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<(data: string) => void>(() => {});
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [conn, setConn] = useState<Conn>('connecting');
  const [srMode, setSrMode] = useState(readSrMode);

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

    // F6 esce dal terminale verso la barra degli strumenti (il terminale si tiene Tab ed Esc)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'F6') {
        toolbar.current?.querySelector<HTMLElement>('button')?.focus();
        return false;
      }
      return true;
    });

    let ws: WebSocket | null = null;
    let stopped = false;
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
          term.write(msg.data);
          setConn(msg.exited ? 'exited' : 'open');
          delay = 1000;
        } else if (msg.type === 'data') {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[2m[processo terminato, codice ${msg.code}]\x1b[0m\r\n`);
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
    conn === 'open' ? 'Collegato' : conn === 'connecting' ? 'Connessione…' : conn === 'exited' ? 'Processo terminato' : 'Disconnesso, riprovo…';

  return (
    <section className="term" aria-labelledby="term-title">
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id="term-title">{terminal.title}</h1>
          <p className="chat-meta">
            <span title={terminal.cwd}>
              <span className="visually-hidden">Cartella </span>
              {terminal.cwd}
            </span>
          </p>
        </div>
        <p className={`status status-${conn === 'open' ? 'ready' : conn === 'exited' ? 'idle' : 'error'}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {statusText}
        </p>
        <div className="term-tools" ref={toolbar}>
          <button type="button" className="btn small-btn" aria-pressed={srMode} onClick={toggleSr}>
            Lettore di schermo
          </button>
          <button
            type="button"
            className="btn icon-btn"
            onClick={() => {
              if (confirm('Chiudere il terminale? I processi in esecuzione verranno terminati.')) onClose();
            }}
          >
            <Icon name="trash" />
            <span className="visually-hidden">Chiudi terminale</span>
          </button>
        </div>
      </header>

      <div className="term-host" ref={host} />

      <div className="keybar" role="toolbar" aria-label="Tasti speciali">
        <button type="button" className="key" aria-pressed={ctrl} onClick={toggleCtrl}>
          Ctrl
        </button>
        {KEYS.map((k) => (
          <button key={k.name} type="button" className="key" aria-label={k.name} onClick={() => pressKey(k.seq)}>
            {k.label}
          </button>
        ))}
      </div>
      <p className="term-hint">F6 per uscire dal terminale con la tastiera.</p>
    </section>
  );
}
