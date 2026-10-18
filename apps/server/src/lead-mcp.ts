// Server MCP (stdio) del "capo": Claude Code lo avvia insieme alla sessione e lo usa per
// affidare compiti ad altri agenti. Non fa nulla da solo: inoltra ad AgiCloud
// (/lead-api, con il token della conversazione capo) e restituisce le risposte.
// Protocollo MCP minimo scritto a mano: initialize, tools/list, tools/call, ping.

import { createInterface } from 'node:readline';
import { user } from './user.js';

const BASE = process.env.AGICLOUD_LEAD_URL ?? '';
const TOKEN = process.env.AGICLOUD_LEAD_TOKEN ?? '';

const TOOLS = [
  {
    name: 'delega',
    description:
      `Propone ${user.a} di affidare un compito a un altro agente, in un thread separato. ${user.Name} deve approvare: lo strumento aspetta la risposta. ` +
      'Se approva, il thread parte subito in una copia separata del progetto (git worktree) e tu ricevi l\'id; quando il thread finisce AgiCloud ti avvisa con un messaggio. ' +
      'Il compito deve essere autonomo e completo: l\'altro agente NON vede questa conversazione.',
    inputSchema: {
      type: 'object',
      properties: {
        agente: { type: 'string', description: 'Id dell\'agente (vedi le istruzioni del server: elenco agenti disponibili)' },
        titolo: { type: 'string', description: 'Titolo breve del thread (max 80 caratteri)' },
        compito: { type: 'string', description: 'Istruzioni complete per l\'agente: obiettivo, file coinvolti, vincoli, come verificare, cosa riportare alla fine' },
        motivo: { type: 'string', description: `Una frase per ${user.name}: perche' conviene affidarlo e perche' a quell'agente` },
      },
      required: ['agente', 'titolo', 'compito'],
    },
  },
  {
    name: 'stato_thread',
    description: `Elenco dei thread che hai affidato, con stato (in corso, aspetta ${user.name}, finito, errore) e modifiche ai file.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'leggi_thread',
    description: 'Risultato di un thread: ultima risposta dell\'agente, stato e file modificati nella sua copia (con il diff se richiesto).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id del thread' },
        diff: { type: 'boolean', description: 'Includi il diff completo delle modifiche (default no)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'scrivi_thread',
    description: 'Manda un messaggio a un thread affidato (correzioni, nuove istruzioni). Se l\'agente sta lavorando, il messaggio parte appena finisce.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, messaggio: { type: 'string' } },
      required: ['id', 'messaggio'],
    },
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
  if (msg.id === undefined || !msg.method) return; // notifiche (es. initialized): nulla da rispondere
  void handle(msg.method, msg.params ?? {}).then(
    (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
    (err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }),
  );
});

async function handle(method: string, params: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const info = (await call('GET', '/info').catch(() => null)) as { instructions?: string } | null;
      return {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agicloud', version: '0.1.0' },
        instructions: info?.instructions ?? 'Strumenti di AgiCloud per affidare compiti ad altri agenti.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      // Senza token (es. una sessione agy normale, che vede la configurazione globale) niente strumenti
      return { tools: TOKEN ? TOOLS : [] };
    case 'tools/call': {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await callTool(String(params.name), args);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
    default:
      throw new Error(`Metodo non supportato: ${method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const id = encodeURIComponent(String(args.id ?? ''));
  let res: { text: string };
  switch (name) {
    case 'delega': {
      // La proposta resta in attesa della decisione di l'utente: si controlla ogni 2 secondi
      // (una sola richiesta lunga verrebbe chiusa dal timeout di fetch dopo 5 minuti)
      const { id: pid } = (await call('POST', '/delegate', args)) as { id: string };
      for (;;) {
        const d = (await call('GET', `/delegations/${encodeURIComponent(pid)}`)) as { state: string; text: string };
        if (d.state !== 'pending') return d.text;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    case 'stato_thread':
      res = (await call('GET', '/threads')) as { text: string };
      break;
    case 'leggi_thread':
      res = (await call('GET', `/threads/${id}${args.diff ? '?diff=1' : ''}`)) as { text: string };
      break;
    case 'scrivi_thread':
      res = (await call('POST', `/threads/${id}/message`, { messaggio: args.messaggio })) as { text: string };
      break;
    default:
      throw new Error(`Strumento sconosciuto: ${name}`);
  }
  return res.text;
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-lead-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `AgiCloud ha risposto ${res.status}`);
  return data;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
