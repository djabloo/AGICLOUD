// Plugin Browser: un Chromium vero sul server, condiviso tra l'utente e l'agente.
// - Il browser gira staccato dal server (setsid -f, come i terminali), con un profilo salvato
//   in data/browser-profile: login e schede restano anche dopo un riavvio di AgiCloud.
// - L'utente lo vede e lo usa da AgiCloud: schermo in diretta (CDP Page.startScreencast) e
//   clic/tasti/rotella inoltrati con Input.dispatch* (WebSocket /api/browser/ws).
// - Gli agenti lo pilotano con Playwright MCP collegato allo stesso browser (--cdp-endpoint):
//   stesse schede, stessi login.
// Il controllo remoto (CDP) ascolta solo su 127.0.0.1.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import type { PluginSpec } from './plugins.js';

const PORT = Number(process.env.BROWSER_CDP_PORT || 9333);
const CDP = `http://127.0.0.1:${PORT}`;
const PROFILE = join(config.threadsDir, '..', 'browser-profile');
/** File di Playwright (istantanee delle pagine, screenshot): fuori dai progetti */
const OUTPUT = join(config.threadsDir, '..', 'browser-output');
const CHROME = process.env.BROWSER_BIN || '/usr/local/bin/chromium';
/** Pagina iniziale delle schede nuove (servita da AgiCloud, senza dati: si apre anche senza token) */
const START_URL = `http://127.0.0.1:${config.port}/browser-start`;
const WIDTH = 1280;
const HEIGHT = 800;
/** Versione fissata del server MCP di Playwright usato dagli agenti */
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';
/** Senza "HeadlessChrome" nell'user agent: molti siti trattano diversamente i browser senza finestra */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** Con la vista dal telefono il browser si presenta come Chrome per Android: i siti mandano la versione mobile */
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';

interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function cdpJson<T>(path: string, method = 'GET'): Promise<T> {
  const r = await fetch(CDP + path, { method, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`CDP ${path}: ${r.status}`);
  return (await r.json()) as T;
}

async function running(): Promise<boolean> {
  try {
    await cdpJson('/json/version');
    return true;
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;

/** Accende il browser se non c'e' gia' (staccato dal server: sopravvive ai riavvii) */
export function ensureBrowser(): Promise<void> {
  starting ??= (async () => {
    if (await running()) return;
    if (!existsSync(CHROME)) throw new Error(`Chromium non trovato in ${CHROME}`);
    mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
    const child = spawn(
      'setsid',
      [
        '-f',
        CHROME,
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${PROFILE}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        `--user-agent=${USER_AGENT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        // Nel container dell'ambiente (sola lettura, senza permessi) il sandbox di Chromium non parte:
        // l'isolamento lo da' il container; /dev/shm e' piccola, la memoria condivisa va su file
        ...(process.env.BROWSER_IN_CONTAINER ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        '--lang=it-IT',
        START_URL,
      ],
      { stdio: 'ignore' },
    );
    child.unref();
    for (let i = 0; i < 40; i++) {
      if (await running()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Chromium non si e\' avviato');
  })().finally(() => (starting = null));
  return starting;
}

export async function stopBrowser(): Promise<void> {
  try {
    const v = await cdpJson<{ webSocketDebuggerUrl: string }>('/json/version');
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
      setTimeout(resolve, 3000).unref();
    });
  } catch {
    /* gia' spento */
  }
}

/** Ultima scheda guardata dall'utente: e' quella che finisce nello screenshot */
let lastViewed: string | null = null;

/** Screenshot PNG della scheda che si sta guardando (per allegarlo in chat) */
export async function browserScreenshot(): Promise<Buffer> {
  await ensureBrowser();
  const tabs = await pages();
  const t = tabs.find((p) => p.id === lastViewed) ?? tabs[0];
  if (!t?.webSocketDebuggerUrl) throw new Error('Nessuna scheda aperta nel browser');
  const link = new PageLink(t.webSocketDebuggerUrl, () => {});
  try {
    await link.ready();
    const r = await link.send('Page.captureScreenshot', { format: 'png' });
    if (!r?.data) throw new Error('Screenshot non riuscito');
    return Buffer.from(r.data, 'base64');
  } finally {
    link.close();
  }
}

async function pages(): Promise<Target[]> {
  return (await cdpJson<Target[]>('/json/list')).filter((t) => t.type === 'page');
}

/** Strumenti per gli agenti: Playwright MCP sullo stesso browser */
export function browserMcpServer(): acp.McpServer {
  return {
    name: 'browser',
    command: 'npx',
    args: ['-y', PLAYWRIGHT_MCP, '--cdp-endpoint', CDP, '--output-dir', OUTPUT, '--output-max-size', String(200 * 1024 * 1024)],
    env: [],
  };
}

export const browserPlugin: PluginSpec = {
  id: 'browser',
  name: 'Browser',
  version: '1.0.0',
  description:
    'Un vero Chromium sul server che usi in diretta da AgiCloud (anche in una finestra a parte) e che gli agenti pilotano con Playwright sulle stesse schede: navigate insieme, con gli stessi login. Il profilo resta salvato sul server.',
  section: { id: 'browser', label: 'Browser' },
  credits: { text: 'Agenti collegati con Playwright MCP (Apache 2.0)', url: 'https://github.com/microsoft/playwright-mcp' },
  requires: 'Chromium sul server (gia\' presente) e circa 300 MB di memoria quando e\' acceso',
  routes: ['/api/browser', '/browser-start'],
  source: 'builtin',
  health: async () =>
    (await running())
      ? { ok: true, detail: `Chromium acceso (controllo su 127.0.0.1:${PORT})` }
      : { ok: true, detail: 'spento: si accende quando apri il Browser o lo usa un agente' },
  install: async () => {
    await ensureBrowser();
  },
  uninstall: async () => {
    await stopBrowser();
    rmSync(PROFILE, { recursive: true, force: true }); // via anche cookie e login salvati
  },
};

// ── Vista in diretta ──────────────────────────────────────────────────────────

type ClientMsg = Record<string, any>;

/** Collegamento CDP a una scheda */
class PageLink {
  private nextId = 1;
  private readonly waiting = new Map<number, (r: any) => void>();
  readonly ws: WebSocket;

  constructor(
    url: string,
    private readonly onEvent: (method: string, params: any) => void,
  ) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.ws.on('message', (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.id && this.waiting.has(m.id)) {
        this.waiting.get(m.id)!(m.result ?? m.error);
        this.waiting.delete(m.id);
      } else if (m.method) this.onEvent(m.method, m.params);
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ id, method, params }));
      else resolve(null);
      setTimeout(() => this.waiting.delete(id) && resolve(null), 10_000).unref();
    });
  }

  close(): void {
    this.ws.close();
  }
}

const KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' },
  Backspace: { code: 8 },
  Tab: { code: 9 },
  Escape: { code: 27 },
  Delete: { code: 46 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
};

/** Una vista (un browser dell'utente collegato): segue una scheda e inoltra input e fotogrammi */
class Viewer {
  private link: PageLink | null = null;
  private targetId: string | null = null;
  private poll: NodeJS.Timeout | null = null;
  private knownTabs = new Set<string>();
  private closed = false;

  constructor(private readonly ws: WebSocket) {}

  async start(): Promise<void> {
    await ensureBrowser();
    const tabs = await pages();
    this.knownTabs = new Set(tabs.map((t) => t.id));
    await this.attach(tabs[0]?.id ?? (await cdpJson<Target>(`/json/new?${START_URL}`, 'PUT')).id);
    this.poll = setInterval(() => void this.refreshTabs(), 1500);
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async attach(targetId: string): Promise<void> {
    const t = (await pages()).find((p) => p.id === targetId);
    if (!t?.webSocketDebuggerUrl || this.closed) return;
    this.link?.close();
    this.mobileUa = false;
    this.targetId = targetId;
    lastViewed = targetId;
    const link = new PageLink(t.webSocketDebuggerUrl, (method, params) => {
      if (method === 'Page.screencastFrame') {
        this.send({ type: 'frame', data: params.data, meta: params.metadata });
        void link.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
        this.send({ type: 'nav', url: params.frame.url });
      }
    });
    this.link = link;
    await link.ready();
    await link.send('Page.enable');
    await link.send('Page.bringToFront');
    await this.applyViewport();
    await this.refreshTabs();
  }

  private async refreshTabs(): Promise<void> {
    if (this.closed) return;
    let tabs: Target[];
    try {
      tabs = await pages();
    } catch {
      this.send({ type: 'error', message: 'Il browser si e\' chiuso' });
      return;
    }
    // Una scheda nuova (es. aperta dall'agente): la vista la segue
    const fresh = tabs.find((t) => !this.knownTabs.has(t.id));
    this.knownTabs = new Set(tabs.map((t) => t.id));
    if (fresh && fresh.id !== this.targetId) return void this.attach(fresh.id);
    if (this.targetId && !tabs.some((t) => t.id === this.targetId) && tabs[0]) return void this.attach(tabs[0].id);
    this.send({ type: 'tabs', active: this.targetId, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) });
  }

  /** Misura della vista dell'utente (pixel CSS) e densita' dello schermo: la pagina prende quella misura */
  private viewport: { width: number; height: number; dpr: number; mobile: boolean } | null = null;
  /** User agent da telefono gia' impostato su questa scheda */
  private mobileUa = false;

  /**
   * La pagina si impagina alla misura della vista (sul telefono diventa una pagina da telefono)
   * e i fotogrammi arrivano a quella risoluzione: niente rimpicciolimento. Vale finche' la vista e'
   * collegata; chiusa la vista il browser torna alla sua misura normale.
   */
  private async applyViewport(): Promise<void> {
    const link = this.link;
    if (!link) return;
    const v = this.viewport;
    if (v) {
      await link.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.mobile });
    } else {
      await link.send('Emulation.clearDeviceMetricsOverride');
    }
    const mobile = v?.mobile === true;
    if (mobile !== this.mobileUa) {
      this.mobileUa = mobile;
      await link.send('Emulation.setUserAgentOverride', { userAgent: mobile ? MOBILE_USER_AGENT : USER_AGENT, acceptLanguage: 'it-IT,it' });
      await link.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
      // La versione giusta del sito arriva ricaricando (solo se e' gia' aperta una pagina vera)
      const nav = await link.send('Page.getNavigationHistory');
      const cur = nav?.entries?.[nav.currentIndex]?.url ?? '';
      if (/^https?:/.test(cur) && !cur.includes('/browser-start')) await link.send('Page.reload');
    }
    await link.send('Page.stopScreencast');
    await link.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: Math.round((v?.width ?? WIDTH) * (v?.dpr ?? 1)),
      maxHeight: Math.round((v?.height ?? HEIGHT) * (v?.dpr ?? 1)),
      everyNthFrame: 1,
    });
  }

  async handle(m: ClientMsg): Promise<void> {
    if (m.type === 'viewport') {
      const width = Math.round(Number(m.width));
      const height = Math.round(Number(m.height));
      if (!(width >= 200 && width <= 4000 && height >= 200 && height <= 4000)) return;
      this.viewport = { width, height, dpr: Math.min(2, Math.max(1, Number(m.dpr) || 1)), mobile: m.mobile === true };
      await this.applyViewport();
      return;
    }
    const link = this.link;
    if (!link) return;
    const mods = Number(m.modifiers) || 0;
    switch (m.type) {
      case 'mouse':
        await link.send('Input.dispatchMouseEvent', {
          type: m.event,
          x: Number(m.x),
          y: Number(m.y),
          button: m.button ?? 'left',
          buttons: m.event === 'mouseMoved' ? Number(m.buttons) || 0 : undefined,
          clickCount: Number(m.clickCount) || (m.event === 'mouseMoved' ? 0 : 1),
          modifiers: mods,
        });
        break;
      case 'wheel':
        await link.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(m.x), y: Number(m.y), deltaX: Number(m.dx) || 0, deltaY: Number(m.dy) || 0, modifiers: mods });
        break;
      case 'text':
        if (typeof m.text === 'string' && m.text) await link.send('Input.insertText', { text: m.text.slice(0, 10_000) });
        break;
      case 'key': {
        const k = KEYS[m.key as string];
        const ch = typeof m.key === 'string' && m.key.length === 1 ? m.key : null;
        if (!k && !ch) return;
        const code = k?.code ?? ch!.toUpperCase().charCodeAt(0);
        // Con Ctrl/Cmd (es. Ctrl+A) si manda il tasto senza testo, cosi' vale come scorciatoia
        const text = k ? k.text : mods & 6 ? undefined : ch!;
        await link.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: m.key, code: m.code, windowsVirtualKeyCode: code, text, modifiers: mods });
        await link.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: code, modifiers: mods });
        break;
      }
      case 'navigate': {
        let url = String(m.url ?? '').trim();
        if (!url) return;
        if (!/^[a-z]+:/i.test(url)) url = /\s/.test(url) || !url.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(url)}` : `https://${url}`;
        if (!/^https?:|^about:blank$/i.test(url)) return; // niente file:, chrome:, javascript:
        await link.send('Page.navigate', { url });
        break;
      }
      case 'reload':
        await link.send('Page.reload');
        break;
      case 'back':
      case 'forward': {
        const h = await link.send('Page.getNavigationHistory');
        const entry = h?.entries?.[h.currentIndex + (m.type === 'back' ? -1 : 1)];
        if (entry) await link.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        break;
      }
      case 'tab':
        if (typeof m.id === 'string') await this.attach(m.id);
        break;
      case 'newtab': {
        const t = await cdpJson<Target>(`/json/new?${START_URL}`, 'PUT');
        this.knownTabs.add(t.id);
        await this.attach(t.id);
        break;
      }
      case 'closetab':
        if (typeof m.id === 'string') {
          await cdpJson(`/json/close/${m.id}`).catch(() => {});
          if ((await pages()).length === 0) await cdpJson(`/json/new?${START_URL}`, 'PUT');
          await this.refreshTabs();
        }
        break;
    }
  }

  stop(): void {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    void this.link?.send('Page.stopScreencast').finally(() => this.link?.close());
  }
}

type Access = 'ok' | 'missing' | 'denied' | 'blocked';

/** WebSocket /api/browser/ws: token nel primo messaggio, Origin uguale all'host (come i terminali) */
export function browserUpgrade(
  checkAccess: (ip: string, token: string) => Access,
  clientIp: (req: IncomingMessage) => string,
  enabled: () => boolean,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  return (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/browser/ws') return false;
    const origin = req.headers.origin;
    let same = false;
    try {
      same = Boolean(origin) && new URL(origin!).host === req.headers.host;
    } catch {
      same = false;
    }
    if (!same || !enabled()) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let viewer: Viewer | null = null;
      const timer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
      ws.on('message', (raw) => {
        let m: ClientMsg;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!viewer) {
          if (m.type !== 'auth') return ws.close(4001, 'auth required');
          clearTimeout(timer);
          const access = checkAccess(clientIp(req), String(m.token ?? ''));
          if (access !== 'ok') return ws.close(4001, access === 'blocked' ? 'blocked' : 'denied');
          viewer = new Viewer(ws);
          viewer.start().catch((err) => {
            ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
            ws.close();
          });
          return;
        }
        void viewer.handle(m).catch(() => {});
      });
      ws.on('close', () => {
        clearTimeout(timer);
        viewer?.stop();
      });
    });
    return true;
  };
}

const QUICK_LINKS: [string, string][] = [
  ['Google', 'https://www.google.com'],
  ['DuckDuckGo', 'https://duckduckgo.com'],
  ['GitHub', 'https://github.com'],
  ['YouTube', 'https://www.youtube.com'],
  ['Wikipedia', 'https://it.wikipedia.org'],
  ['AgiCloud', 'https://agicloud.dev'],
];

const START_PAGE = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nuova scheda</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f8fb; --card:#fff; --text:#121620; --muted:#4a5263; --accent:#0b6bcb; --border:#d5dae3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f17; --card:#121826; --text:#e8ecf3; --muted:#a3adbf; --accent:#5cb1ff; --border:#2b3548; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:min(640px, 92vw); text-align:center; }
  h1 { margin:0 0 4px; font-size:2rem; letter-spacing:-.02em; }
  p { margin:0 0 24px; color:var(--muted); }
  form { display:flex; gap:8px; margin-bottom:28px; }
  input { flex:1; min-height:48px; padding:0 16px; border:1px solid var(--border); border-radius:999px; background:var(--card); color:var(--text); font:inherit; }
  input:focus { outline:3px solid var(--accent); outline-offset:1px; }
  button { min-height:48px; padding:0 20px; border:0; border-radius:999px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  ul { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); gap:10px; }
  a { display:block; padding:14px 10px; border:1px solid var(--border); border-radius:12px; background:var(--card); color:var(--text); text-decoration:none; font-weight:600; }
  a:hover, a:focus { border-color:var(--accent); }
</style></head>
<body><main>
  <h1>Browser condiviso</h1>
  <p>Lo vedi tu e lo usa l'agente: cerca qualcosa o apri un sito.</p>
  <form action="https://duckduckgo.com/" method="get" role="search">
    <label for="q" style="position:absolute;left:-9999px">Cerca sul web</label>
    <input id="q" name="q" placeholder="Cerca sul web" autofocus autocomplete="off">
    <button type="submit">Cerca</button>
  </form>
  <ul>${QUICK_LINKS.map(([n, u]) => `<li><a href="${u}">${n}</a></li>`).join('')}</ul>
</main></body></html>`;

/** Pagina iniziale delle schede nuove e screenshot della scheda guardata */
export function registerBrowserStart(app: Hono<any>): void {
  app.get('/api/browser/screenshot', async (c) => {
    c.header('Content-Type', 'image/png');
    return c.body(new Uint8Array(await browserScreenshot()));
  });
  app.get('/browser-start', (c) => {
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action https:; base-uri 'none'");
    return c.html(START_PAGE);
  });
}
