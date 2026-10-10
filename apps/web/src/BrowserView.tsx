// Plugin Browser: lo schermo in diretta del Chromium condiviso sul server.
// Clic, rotella e tasti vanno alla pagina; l'agente lavora sulle stesse schede con Playwright.
// Si puo' aprire anche in una finestra a parte (#/browser/popup).
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { currentToken } from './api';

interface Tab {
  id: string;
  title: string;
  url: string;
}

interface FrameMeta {
  deviceWidth: number;
  deviceHeight: number;
}

/** Ctrl=2, Alt=1, Maiusc=8, Meta=4 (codici CDP) */
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const ZOOM_KEY = 'agicloud_browser_zoom';
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;

const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function BrowserView({ popup = false }: { popup?: boolean }) {
  const id = useId();
  const ws = useRef<WebSocket | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const meta = useRef<FrameMeta>({ deviceWidth: 1280, deviceHeight: 800 });
  const lastMove = useRef(0);
  const [conn, setConn] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [error, setError] = useState('');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  // Zoom: la pagina si impagina su una misura piu' piccola (zoom > 1) o piu' grande della vista
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem(ZOOM_KEY)) || 1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const lastViewport = useRef<Record<string, unknown> | null>(null);
  const changeZoom = (z: number) => {
    const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
    setZoom(next);
    localStorage.setItem(ZOOM_KEY, String(next));
  };

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/api/browser/ws`);
      ws.current = sock;
      setConn('connecting');
      sock.onopen = () => {
        sock.send(JSON.stringify({ type: 'auth', token: currentToken() }));
        if (lastViewport.current) sock.send(JSON.stringify(lastViewport.current));
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'frame') {
          meta.current = m.meta;
          if (img.current) img.current.src = `data:image/jpeg;base64,${m.data}`;
          setHasFrame(true);
          setConn('live');
        } else if (m.type === 'tabs') {
          setTabs(m.tabs);
          setActive(m.active);
          setConn('live');
        } else if (m.type === 'nav') {
          setUrl((u) => (editingUrlRef.current ? u : m.url.endsWith('/browser-start') ? '' : m.url));
        } else if (m.type === 'error') setError(m.message);
      };
      sock.onclose = () => {
        if (stopped) return;
        setConn('closed');
        retry = window.setTimeout(open, 2000);
      };
    };
    open();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  // La pagina prende la misura della vista (divisa per lo zoom): riempie lo spazio, e sul telefono
  // i siti si impaginano da telefono. Si rimanda quando cambia la finestra o lo zoom.
  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    let timer: number | undefined;
    const measure = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const w = el.clientWidth - 16;
        const h = el.clientHeight - 16;
        if (w < 100 || h < 100) return;
        const z = zoomRef.current;
        const msg = {
          type: 'viewport',
          width: Math.floor(w / z),
          height: Math.floor(h / z),
          dpr: Math.min(2, (window.devicePixelRatio || 1) * z),
          mobile: w < 700,
        };
        lastViewport.current = msg;
        if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
      }, 150);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [zoom]);

  // Ctrl + rotella = zoom (ascoltatore non passivo: deve impedire lo zoom di tutta la pagina)
  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    const onWheelZoom = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      changeZoom(zoomRef.current + (e.deltaY < 0 ? 0.1 : -0.1));
    };
    el.addEventListener('wheel', onWheelZoom, { passive: false });
    return () => el.removeEventListener('wheel', onWheelZoom);
  }, []);

  // L'indirizzo segue la scheda attiva, tranne mentre lo stai scrivendo
  const editingUrlRef = useRef(false);
  editingUrlRef.current = editingUrl;
  const activeTab = tabs.find((t) => t.id === active);
  useEffect(() => {
    if (!editingUrl && activeTab) setUrl(activeTab.url === 'about:blank' || activeTab.url.endsWith('/browser-start') ? '' : activeTab.url);
  }, [activeTab?.url, editingUrl]);

  const send = (m: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  };

  /** Coordinate nella pagina (pixel CSS del browser remoto) */
  const point = (e: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * meta.current.deviceWidth),
      y: Math.round(((e.clientY - r.top) / r.height) * meta.current.deviceHeight),
    };
  };

  // Dito: trascinare scorre la pagina, un tocco senza movimento e' un clic, due dita = zoom
  const touch = useRef<{ x: number; y: number; lastY: number; moved: boolean } | null>(null);
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number; scale: number } | null>(null);
  const distance = () => {
    const [a, b] = [...fingers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointer = (kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (e: PointerEvent<HTMLImageElement>) => {
    if (kind === 'mousePressed') (e.currentTarget.parentElement as HTMLElement).focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      if (kind === 'mousePressed') fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      else if (kind === 'mouseMoved' && fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.current.size >= 2) {
        // Pizzico: anteprima immediata con la scala dell'immagine, la pagina si reimpagina al rilascio
        touch.current = null;
        if (!pinch.current) pinch.current = { dist: distance(), zoom: zoomRef.current, scale: 1 };
        else if (kind === 'mouseMoved' && pinch.current.dist > 0) {
          pinch.current.scale = distance() / pinch.current.dist;
          if (img.current) img.current.style.transform = `scale(${pinch.current.scale})`;
        }
        if (kind === 'mouseReleased') {
          fingers.current.delete(e.pointerId);
          const p = pinch.current;
          pinch.current = null;
          if (img.current) img.current.style.transform = '';
          if (p) changeZoom(p.zoom * p.scale);
        }
        return;
      }
      if (kind === 'mouseReleased') fingers.current.delete(e.pointerId);
      if (pinch.current) {
        if (kind === 'mouseReleased') pinch.current = null;
        return;
      }
      if (kind === 'mousePressed') touch.current = { x: e.clientX, y: e.clientY, lastY: e.clientY, moved: false };
      else if (kind === 'mouseMoved' && touch.current) {
        const t = touch.current;
        if (Math.abs(e.clientY - t.y) > 8 || Math.abs(e.clientX - t.x) > 8) t.moved = true;
        if (t.moved) {
          const scale = meta.current.deviceHeight / img.current!.getBoundingClientRect().height;
          send({ type: 'wheel', ...point(e), dx: 0, dy: (t.lastY - e.clientY) * scale, modifiers: 0 });
          t.lastY = e.clientY;
        }
      } else if (kind === 'mouseReleased' && touch.current) {
        if (!touch.current.moved) {
          send({ type: 'mouse', event: 'mousePressed', ...point(e), button: 'left', clickCount: 1, modifiers: 0 });
          send({ type: 'mouse', event: 'mouseReleased', ...point(e), button: 'left', clickCount: 1, modifiers: 0 });
        }
        touch.current = null;
      }
      return;
    }
    if (kind === 'mouseMoved') {
      const now = performance.now();
      if (now - lastMove.current < 40) return;
      lastMove.current = now;
    }
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    send({ type: 'mouse', event: kind, ...point(e), button: kind === 'mouseMoved' ? (e.buttons ? 'left' : 'none') : button, buttons: e.buttons, clickCount: kind === 'mouseMoved' ? 0 : e.detail || 1, modifiers: modifiers(e) });
  };

  const onWheel = (e: WheelEvent<HTMLImageElement>) => {
    send({ type: 'wheel', ...point(e), dx: e.deltaX, dy: e.deltaY, modifiers: modifiers(e) });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // F6 / Ctrl+L restano al nostro browser: si esce dallo schermo e si va all'indirizzo
    if (e.key === 'F6' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // incolla: lo gestisce onPaste
    if (SPECIAL.has(e.key) || e.key.length === 1) {
      e.preventDefault();
      send({ type: 'key', key: e.key, code: e.code, modifiers: modifiers(e) });
    }
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    send({ type: 'navigate', url });
    setEditingUrl(false);
    (document.getElementById(`${id}-screen`) as HTMLElement | null)?.focus({ preventScroll: true });
  };

  const openPopup = () => {
    window.open(`${location.origin}/#/browser/popup`, 'agicloud-browser', 'popup,width=1320,height=900');
  };

  return (
    <section className={`browser${popup ? ' is-popup' : ''}`} aria-labelledby={`${id}-title`}>
      <header className="browser-bar">
        <h1 id={`${id}-title`} className="visually-hidden">
          Browser condiviso
        </h1>
        <div className="browser-nav" role="group" aria-label="Navigazione">
          <button type="button" className="btn icon-btn" onClick={() => send({ type: 'back' })}>
            <span aria-hidden="true">←</span>
            <span className="visually-hidden">Indietro</span>
          </button>
          <button type="button" className="btn icon-btn" onClick={() => send({ type: 'forward' })}>
            <span aria-hidden="true">→</span>
            <span className="visually-hidden">Avanti</span>
          </button>
          <button type="button" className="btn icon-btn" onClick={() => send({ type: 'reload' })}>
            <span aria-hidden="true">↻</span>
            <span className="visually-hidden">Ricarica</span>
          </button>
        </div>
        <div className="browser-zoom" role="group" aria-label="Zoom della pagina">
          <button type="button" className="btn icon-btn" onClick={() => changeZoom(zoom - 0.1)} disabled={zoom <= ZOOM_MIN}>
            <span aria-hidden="true">−</span>
            <span className="visually-hidden">Rimpicciolisci</span>
          </button>
          <button type="button" className="btn small-btn browser-zoom-pct" onClick={() => changeZoom(1)} title="Torna al 100%">
            {Math.round(zoom * 100)}%<span className="visually-hidden"> (torna al 100%)</span>
          </button>
          <button type="button" className="btn icon-btn" onClick={() => changeZoom(zoom + 0.1)} disabled={zoom >= ZOOM_MAX}>
            <span aria-hidden="true">+</span>
            <span className="visually-hidden">Ingrandisci</span>
          </button>
        </div>
        <form className="browser-url" onSubmit={submitUrl}>
          <label htmlFor={`${id}-url`} className="visually-hidden">
            Indirizzo o ricerca
          </label>
          <input
            id={`${id}-url`}
            className="mono-input"
            value={url}
            placeholder="Indirizzo o ricerca"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
            onFocus={() => setEditingUrl(true)}
            onBlur={() => setEditingUrl(false)}
            onChange={(e) => setUrl(e.target.value)}
          />
        </form>
        <p className={`status status-${conn === 'live' ? 'ready' : conn === 'closed' ? 'error' : 'starting'}`}>
          <span className="status-dot" aria-hidden="true" />
          {conn === 'live' ? 'In diretta' : conn === 'closed' ? 'Riconnessione…' : 'Collegamento…'}
        </p>
        {!popup && (
          <button type="button" className="btn small-btn browser-popup-btn" onClick={openPopup}>
            Apri in una finestra
          </button>
        )}
      </header>

      <nav className="browser-tabs" aria-label="Schede">
        <ul>
          {tabs.map((t) => (
            <li key={t.id} className={t.id === active ? 'is-active' : undefined}>
              <button type="button" className="browser-tab" aria-current={t.id === active ? 'page' : undefined} onClick={() => send({ type: 'tab', id: t.id })} title={t.url}>
                {t.title || t.url || 'Nuova scheda'}
              </button>
              <button type="button" className="browser-tab-close" onClick={() => send({ type: 'closetab', id: t.id })}>
                <span aria-hidden="true">×</span>
                <span className="visually-hidden">Chiudi la scheda {t.title || t.url}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="browser-tab browser-newtab" onClick={() => send({ type: 'newtab' })}>
              <span aria-hidden="true">+</span>
              <span className="visually-hidden">Nuova scheda</span>
            </button>
          </li>
        </ul>
      </nav>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div
        id={`${id}-screen`}
        ref={screen}
        className="browser-screen"
        tabIndex={0}
        role="application"
        aria-label="Schermo del browser: clic, rotella e tasti vanno alla pagina. F6 per uscire."
        onKeyDown={onKey}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (text) {
            e.preventDefault();
            send({ type: 'text', text });
          }
        }}
      >
        <img
          ref={img}
          alt=""
          draggable={false}
          hidden={!hasFrame}
          onPointerDown={onPointer('mousePressed')}
          onPointerUp={onPointer('mouseReleased')}
          onPointerMove={onPointer('mouseMoved')}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!hasFrame && <p className="browser-wait">{conn === 'closed' ? 'Browser non raggiungibile, riprovo…' : 'Avvio del browser…'}</p>}
      </div>

    </section>
  );
}
