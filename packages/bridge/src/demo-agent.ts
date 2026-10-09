// Agente ACP finto per prove e test dell'interfaccia: niente modelli, risposte prevedibili.
// Offre opzioni (modalita', modello), comandi slash, ripresa di sessione, tool call e permessi.
//   "crea ... file" nel messaggio -> tool call con richiesta di permesso (e scrive davvero demo.txt);
//   "delega" -> fa il finto capo con l'API di AgiCloud (se ha ricevuto il server MCP "agicloud");
//   altrimenti risponde in eco.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

interface DemoSession {
  mode: string;
  model: string;
  turns: number;
  abort: AbortController | null;
  cwd: string;
  /** API del capo (dal server MCP "agicloud" passato da AgiCloud) */
  lead?: { url: string; token: string };
}

function leadFrom(params: { mcpServers?: acp.McpServer[] }): DemoSession['lead'] {
  const srv = params.mcpServers?.find((m) => m.name === 'agicloud' && 'env' in m) as acp.McpServerStdio | undefined;
  const env = Object.fromEntries((srv?.env ?? []).map((e) => [e.name, e.value]));
  return env.AGICLOUD_LEAD_URL ? { url: env.AGICLOUD_LEAD_URL, token: env.AGICLOUD_LEAD_TOKEN ?? '' } : undefined;
}

async function leadCall(lead: NonNullable<DemoSession['lead']>, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(lead.url + path, {
    method,
    headers: { 'x-lead-token': lead.token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const sessions = new Map<string, DemoSession>();

function configOptions(s: DemoSession): acp.SessionConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Modalita\'',
      category: 'mode',
      type: 'select',
      currentValue: s.mode,
      options: [
        { value: 'default', name: 'Chiedi sempre' },
        { value: 'bypass', name: 'Accetta tutto' },
      ],
    },
    {
      id: 'model',
      name: 'Modello',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: [
        { value: 'lento', name: 'Lento' },
        { value: 'veloce', name: 'Veloce' },
      ],
    },
  ];
}

const commands: acp.AvailableCommand[] = [
  { name: 'aiuto', description: 'Mostra cosa sa fare l\'agente demo' },
  { name: 'piano', description: 'Mostra un piano di esempio' },
  { name: 'review', description: 'Finta revisione del codice', input: { hint: 'percorso' } },
];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('cancelled'))), { once: true });
  });

function open(sessionId: string, cwd = '.'): DemoSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { mode: 'default', model: 'veloce', turns: 0, abort: null, cwd };
    sessions.set(sessionId, s);
  }
  return s;
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: 'agicloud-demo' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: 'agicloud-demo', title: 'Demo', version: '1.0.0' },
    agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
  }))
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const sessionId = randomUUID();
    const s = open(sessionId, ctx.params.cwd);
    s.lead = leadFrom(ctx.params);
    setTimeout(() => {
      void ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
      });
    }, 20);
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.resume, (ctx) => {
    const s = open(ctx.params.sessionId, ctx.params.cwd);
    s.lead = leadFrom(ctx.params);
    setTimeout(() => {
      void ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
      });
    }, 20);
    return { configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const s = open(ctx.params.sessionId);
    const value = String(ctx.params.value);
    if (ctx.params.configId === 'mode') s.mode = value;
    else if (ctx.params.configId === 'model') s.model = value;
    else throw new Error(`Opzione sconosciuta: ${ctx.params.configId}`);
    return { configOptions: configOptions(s) };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    sessions.get(ctx.params.sessionId)?.abort?.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const s = open(sessionId);
    s.turns++;
    s.abort = new AbortController();
    const signal = s.abort.signal;
    const text = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    const say = (update: acp.SessionUpdate) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
    const write = async (t: string) => {
      for (const chunk of t.match(/.{1,12}/gs) ?? []) {
        await sleep(s.model === 'lento' ? 60 : 15, signal);
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
      }
    };
    try {
      if (/crea.*file/i.test(text)) {
        await write('Creo il file richiesto. ');
        await say({ sessionUpdate: 'tool_call', toolCallId: 'demo-1', title: 'Scrivi demo.txt', kind: 'edit', status: 'pending', locations: [{ path: 'demo.txt' }] });
        let allowed = s.mode === 'bypass';
        if (!allowed) {
          const res = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: 'demo-1', title: 'Scrivi demo.txt', kind: 'edit' },
            options: [
              { optionId: 'yes', name: 'Consenti', kind: 'allow_once' },
              { optionId: 'no', name: 'Rifiuta', kind: 'reject_once' },
            ],
          });
          allowed = res.outcome.outcome === 'selected' && res.outcome.optionId === 'yes';
        }
        if (allowed) writeFileSync(join(s.cwd, 'demo.txt'), 'riga uno\nriga DUE\nriga tre\nriga quattro\n');
        await say({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'demo-1',
          status: allowed ? 'completed' : 'failed',
          content: allowed
            ? [{ type: 'diff', path: 'demo.txt', oldText: 'riga uno\nriga due\nriga quattro\n', newText: 'riga uno\nriga DUE\nriga tre\nriga quattro\n' }]
            : [{ type: 'content', content: { type: 'text', text: 'rifiutato' } }],
        });
        await write(allowed ? 'Fatto.' : 'Ok, non lo creo.');
      } else if (s.lead && /^delega/i.test(text)) {
        const { id, error } = await leadCall(s.lead, 'POST', '/delegate', {
          agente: 'demo',
          titolo: 'Crea demo.txt',
          compito: 'crea il file demo.txt',
          motivo: 'prova del capo',
        });
        if (!id) {
          await write(`Delega non riuscita: ${error}`);
        } else {
          await write('Ho proposto la delega, aspetto la tua risposta. ');
          let d: { state: string; text: string };
          do {
            await sleep(500, signal);
            d = await leadCall(s.lead, 'GET', `/delegations/${id}`);
          } while (d.state === 'pending');
          await write(d.text);
        }
      } else if (s.lead && text.includes('[Messaggio automatico di AgiCloud]')) {
        const childId = text.match(/id ([0-9a-f-]{36})/)?.[1];
        const r = childId ? await leadCall(s.lead, 'GET', `/threads/${childId}`) : null;
        await write(`Riassunto per l'utente: ${r?.text?.split('\n')[0] ?? 'thread non trovato'}`);
      } else if (text.startsWith('/piano')) {
        await say({ sessionUpdate: 'plan', entries: [
          { content: 'Leggere il codice', status: 'completed', priority: 'high' },
          { content: 'Scrivere i test', status: 'in_progress', priority: 'medium' },
          { content: 'Rilasciare', status: 'pending', priority: 'low' },
        ] });
        await write('Ecco il piano.');
      } else {
        await write(`Hai scritto: **${text}**\n\nModello ${s.model}, modalita' ${s.mode}, turno ${s.turns} di questa sessione.`);
      }
      return { stopReason: 'end_turn' as const };
    } catch {
      return { stopReason: 'cancelled' as const };
    } finally {
      s.abort = null;
    }
  })
  .connect(stream);
