// Server MCP (stdio) del plugin Verdict: lo strumento "verdetto" per gli agenti.
// Inoltra ad AgiCloud (/verdict-api/decide, token proprio del plugin) e restituisce risposta e probabilita'.

import { createInterface } from 'node:readline';
import { user } from './user.js';

const URL_ = process.env.AGICLOUD_VERDICT_URL ?? '';
const TOKEN = process.env.AGICLOUD_VERDICT_TOKEN ?? '';

const TOOL = {
  name: 'verdetto',
  description:
    'Decisione veloce ed economica su un testo, con la probabilita\' di ogni opzione (un modello piccolo, meno di un secondo). ' +
    'Utile per classificare, smistare, filtrare o controllare: es. "questo ticket e\' urgente?", "a quale agente lo affido?". ' +
    `Se la risposta e' segnata come incerta, non fidarti: approfondisci o chiedi ${user.a}.`,
  inputSchema: {
    type: 'object',
    properties: {
      testo: { type: 'string', description: 'Il testo da valutare' },
      domanda: { type: 'string', description: 'La domanda, chiara e chiusa' },
      tipo: { type: 'string', enum: ['yesno', 'choice', 'score'], description: 'yesno = Si\'/No; choice = una tra le opzioni; score = voto da 1 a 5' },
      opzioni: { type: 'array', items: { type: 'string' }, description: 'Solo per choice: da 2 a 20 opzioni' },
      due_modelli: { type: 'boolean', description: 'Piu\' sicuro: media di due modelli e controllo del disaccordo' },
    },
    required: ['testo', 'domanda', 'tipo'],
  },
};

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
      return { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'verdict', version: '2.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOKEN ? [TOOL] : [] };
    case 'tools/call': {
      const a = (params.arguments ?? {}) as Record<string, any>;
      try {
        const res = await fetch(URL_, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-verdict-token': TOKEN },
          body: JSON.stringify({ text: a.testo, question: a.domanda, type: a.tipo, options: a.opzioni, mode: a.due_modelli ? 'double' : 'fast' }),
          signal: AbortSignal.timeout(60_000),
        });
        const d = (await res.json()) as any;
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        const probs = d.probabilities.map((p: any) => `${p.option}: ${Math.round(p.p * 100)}%`).join(', ');
        const text =
          `Risposta: ${d.answer} (${Math.round(d.confidence * 100)}%)${d.uncertain ? ` — INCERTA: ${d.note}` : ''}\n` +
          `Probabilita': ${probs}${d.expected !== undefined ? `\nVoto atteso: ${d.expected}` : ''}\nModelli: ${d.models.join(' + ')}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
    default:
      throw new Error(`Metodo non supportato: ${method}`);
  }
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
