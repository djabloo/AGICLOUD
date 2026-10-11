// Server MCP (stdio) del plugin Flow: gli strumenti di generazione per gli agenti.
// Inoltra ad AgiCloud (/flow-api/run, token proprio del plugin).

import { createInterface } from 'node:readline';

const URL_ = process.env.AGICLOUD_FLOW_URL ?? '';
const TOKEN = process.env.AGICLOUD_FLOW_TOKEN ?? '';

const TOOLS = [
  {
    name: 'gflow_video_t2v',
    description:
      'Genera un video con Google Veo (via Google Flow): dal testo al video. Restituisce il nome del lavoro; il file mp4 finisce nella galleria Flow.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Cosa si vede nel video (in inglese rende meglio)' },
        model: { type: 'string', description: 'omni_flash, veo_3_1_fast o veo_3_1_quality (default: veo_3_1_fast)' },
        aspect: { type: 'string', description: 'Rapporto: 16:9, 9:16 o 1:1 (default: 16:9)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gflow_image_t2i',
    description:
      'Genera un immagine con Imagen/Nano (via Google Flow): dal testo all\'immagine. Restituisce il nome del lavoro; il file png finisce nella galleria Flow.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Cosa si vede nell\'immagine (in inglese rende meglio)' },
        model: { type: 'string', description: 'nano2 o imagen4 (default: imagen4)' },
        aspect: { type: 'string', description: 'Rapporto: 16:9, 9:16 o 1:1 (default: 16:9)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gflow_credits',
    description: 'Saldo dei crediti Flow rimasti e stato del collegamento Google.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg: { id?: number | string; method?: string; params?: Record<string, any> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  void handle(msg.method, msg.params ?? {}).then(
    (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
    (err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
  );
});

async function handle(method: string, params: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flow', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOKEN ? TOOLS : [] };
    case 'tools/call': {
      const a = (params.arguments ?? {}) as Record<string, any>;
      const name = String(params.name ?? '');
      const body =
        name === 'gflow_credits'
          ? { action: 'credits' }
          : { action: 'generate', kind: name === 'gflow_image_t2i' ? 'image' : 'video', prompt: a.prompt, model: a.model, aspect: a.aspect };
      const res = await fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-flow-token': TOKEN },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const d = (await res.json()) as any;
      if (!res.ok) throw new Error(typeof d?.error === 'string' ? d.error : `Flow: errore ${res.status}`);
      return { content: [{ type: 'text', text: JSON.stringify(d) }] };
    }
    default:
      throw new Error(`Metodo sconosciuto: ${method}`);
  }
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
