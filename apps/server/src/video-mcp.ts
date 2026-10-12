// Server MCP (stdio) del plugin Video: 4 strumenti per montare video dai progetti JSON.
import { createInterface } from 'node:readline';

const URL_ = process.env.AGICLOUD_VIDEO_URL ?? '';
const TOKEN = process.env.AGICLOUD_VIDEO_TOKEN ?? '';
const H = { 'content-type': 'application/json', 'x-video-token': TOKEN };

const TOOLS = [
  { name: 'video_list_projects', description: 'Elenca i progetti video (.video.json)', inputSchema: { type: 'object', properties: {} } },
  { name: 'video_get_project', description: 'Legge il JSON di un progetto video', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'video_save_project', description: 'Salva/aggiorna il JSON di un progetto video', inputSchema: { type: 'object', properties: { name: { type: 'string' }, project: { type: 'object' } }, required: ['name', 'project'] } },
  { name: 'video_render_project', description: 'Renderizza un progetto video in MP4 (MoviePy/ffmpeg)', inputSchema: { type: 'object', properties: { name: { type: 'string' }, project: { type: 'object' } }, required: [] } },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg: { id?: number | string; method?: string; params?: Record<string, any> };
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  void handle(msg.method, msg.params ?? {}).then(
    (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
    (err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
  );
});

async function call(path: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`${URL_}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((d as any).error ?? `HTTP ${res.status}`);
  return d;
}

async function handle(method: string, params: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'video', version: '1.0.0' } };
    case 'ping': return {};
    case 'tools/list': return { tools: TOKEN ? TOOLS : [] };
    case 'tools/call': {
      const a = (params.arguments ?? {}) as Record<string, any>;
      try {
        let d: any;
        switch (params.name) {
          case 'video_list_projects': d = await call('/projects'); break;
          case 'video_get_project': d = await call(`/projects/${encodeURIComponent(a.name)}`); break;
          case 'video_save_project': d = await call(`/projects/${encodeURIComponent(a.name)}`, 'PUT', a.project); break;
          case 'video_render_project':
            d = a.name ? await call('/render', 'POST', { name: a.name }) : await call('/render', 'POST', { project: a.project });
            break;
          default: throw new Error(`Strumento sconosciuto: ${params.name}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
    default: throw new Error(`Metodo non supportato: ${method}`);
  }
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
