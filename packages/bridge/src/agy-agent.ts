// Adattatore ACP per agy (Google Antigravity CLI), che non parla ACP.
// A ogni messaggio lancia `agy --print` in modalita' stream-json, riprendendo la stessa
// conversazione con --conversation, e traduce gli eventi di agy in session/update ACP.
//
// agy in modalita' headless non puo' chiedere permessi: i comandi vengono negati, a meno
// della scelta "Consenti tutto" (--dangerously-skip-permissions). Le azioni negate vengono
// segnalate in chat.
//
// Server MCP (es. gli strumenti del capo di AgiCloud): agy li configura in modo globale
// (`agy mcp add`), non per sessione. Si registrano una volta, senza segreti, e le variabili
// d'ambiente di ciascun server (es. il token del capo) si passano solo al processo agy di quella
// sessione: agy le eredita nei server che avvia. Senza token i server di AgiCloud non offrono strumenti.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const AGY = process.env.AGY_BIN || '/home/tino/.local/bin/agy';
const STATE_FILE = join(homedir(), '.local', 'state', 'agicloud', 'agy-sessions.json');

interface AgySession {
  cwd: string;
  /** Conversazione agy (nota dopo il primo messaggio) */
  conversationId: string | null;
  model: string;
  mode: string;
  permissions: string;
}

interface AgyResult {
  status?: string;
  error?: string;
  denied_actions?: { display_name?: string; action?: string }[];
}

const sessions = new Map<string, AgySession>(Object.entries(loadState()));
/** Variabili d'ambiente dei server MCP della sessione (solo in memoria: contengono token) */
const mcpEnv = new Map<string, Record<string, string>>();
/** Server gia' registrati in agy in questo processo */
const registered = new Set<string>();
/** Solo i server di AgiCloud che senza il loro token non fanno nulla (il Browser no: agy ha il suo) */
const MCP_FOR_AGY = new Set(['agicloud', 'verdict']);

/** Registra i server MCP in agy (configurazione globale, senza env) e ricorda l'env per la sessione */
async function useMcp(sessionId: string, servers: acp.McpServer[] | undefined): Promise<void> {
  const env: Record<string, string> = {};
  for (const srv of servers ?? []) {
    if (!('command' in srv) || !MCP_FOR_AGY.has(srv.name)) continue;
    for (const e of srv.env ?? []) env[e.name] = e.value;
    const key = `${srv.name} ${srv.command} ${srv.args.join(' ')}`;
    if (registered.has(key)) continue;
    await new Promise<void>((resolve) => {
      // Nome in agy: "agicloud" per il capo, "agicloud-<nome>" per gli altri (es. agicloud-verdict)
      const name = srv.name === 'agicloud' ? 'agicloud' : `agicloud-${srv.name}`;
      execFile(AGY, ['mcp', 'add', name, '--', srv.command, ...srv.args], { timeout: 20_000, cwd: homedir() }, () => resolve());
    });
    registered.add(key);
  }
  mcpEnv.set(sessionId, env);
}
const running = new Map<string, ChildProcess>();
let models: { value: string; name: string }[] = [];

function loadState(): Record<string, AgySession> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(sessions), null, 1), { mode: 0o600 });
}

/** Modelli disponibili per l'account (letti una volta da `agy models`) */
function loadModels(): Promise<void> {
  return new Promise((resolve) => {
    execFile(AGY, ['models'], { timeout: 30_000, cwd: homedir() }, (_err, stdout) => {
      models = String(stdout ?? '')
        .split('\n')
        .map((l) => l.split('\t'))
        .filter((p) => p.length >= 2 && p[0]!.trim())
        .map(([value, name]) => ({ value: value!.trim(), name: name!.trim() }));
      resolve();
    });
  });
}

function configOptions(s: AgySession): acp.SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Modello',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: [{ value: 'default', name: 'Predefinito di agy' }, ...models],
    },
    {
      id: 'mode',
      name: 'Modalita\'',
      category: 'mode',
      type: 'select',
      currentValue: s.mode,
      options: [
        { value: 'default', name: 'Normale' },
        { value: 'accept-edits', name: 'Accetta modifiche' },
        { value: 'plan', name: 'Piano' },
      ],
    },
    {
      id: 'permissions',
      name: 'Permessi',
      type: 'select',
      currentValue: s.permissions,
      options: [
        { value: 'standard', name: 'Standard (comandi bloccati)' },
        { value: 'all', name: 'Consenti tutto' },
      ],
    },
  ];
}

/** Tipo ACP della tool call a partire dal nome dello strumento di agy */
function toolKind(name: string): acp.ToolKind {
  if (/write|replace|edit|create|delete|move/i.test(name)) return 'edit';
  if (/run_command|command|shell|terminal/i.test(name)) return 'execute';
  if (/view|read|list_dir|open/i.test(name)) return 'read';
  if (/search|grep|find/i.test(name)) return 'search';
  if (/browser|fetch|url|web/i.test(name)) return 'fetch';
  return 'other';
}

function toolTitle(info: { name?: string; parameters?: Record<string, unknown> } | undefined, fallback: string): string {
  const p = info?.parameters ?? {};
  const detail = p.CommandLine ?? p.TargetFile ?? p.AbsolutePath ?? p.Url ?? p.Query ?? p.SearchPath ?? p.DirectoryPath;
  return detail ? `${info?.name ?? fallback}: ${String(detail)}` : (info?.name ?? fallback);
}

function locations(info: { parameters?: Record<string, unknown> } | undefined): acp.ToolCallLocation[] {
  const p = info?.parameters ?? {};
  const path = p.TargetFile ?? p.AbsolutePath ?? p.DirectoryPath;
  return typeof path === 'string' ? [{ path }] : [];
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: 'agicloud-agy' })
  .onRequest(acp.methods.agent.initialize, async () => {
    await loadModels();
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'agy', title: 'agy (Google Antigravity)', version: 'adapter-0.1' },
      agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
    };
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    const sessionId = randomUUID();
    const s: AgySession = { cwd: ctx.params.cwd, conversationId: null, model: 'default', mode: 'default', permissions: 'standard' };
    sessions.set(sessionId, s);
    saveState();
    await useMcp(sessionId, ctx.params.mcpServers);
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.resume, async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    s.cwd = ctx.params.cwd;
    await useMcp(ctx.params.sessionId, ctx.params.mcpServers);
    return { configOptions: configOptions(s) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const value = String(ctx.params.value);
    if (ctx.params.configId === 'model') s.model = value;
    else if (ctx.params.configId === 'mode') s.mode = value;
    else if (ctx.params.configId === 'permissions') s.permissions = value;
    else throw acp.RequestError.invalidParams({ configId: ctx.params.configId });
    saveState();
    return { configOptions: configOptions(s) };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    running.get(ctx.params.sessionId)?.kill('SIGINT');
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const s = sessions.get(sessionId);
    if (!s) throw acp.RequestError.resourceNotFound(sessionId);
    const text = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const say = (update: acp.SessionUpdate) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update });

    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (s.conversationId) args.push('--conversation', s.conversationId);
    if (s.model !== 'default') args.push('--model', s.model);
    if (s.mode !== 'default') args.push('--mode', s.mode);
    if (s.permissions === 'all') args.push('--dangerously-skip-permissions');
    args.push('-p=');

    const child = spawn(AGY, args, { cwd: s.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...mcpEnv.get(sessionId) } });
    running.set(sessionId, child);
    child.stdin.end(JSON.stringify({ event: 'user', message: { role: 'user', content: text } }) + '\n');

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));

    const toolIds = new Map<number, string>();
    const toolKinds = new Map<string, acp.ToolKind>();
    // Contenitore: assegnato dentro la callback, letto alla fine (TS non segue l'assegnazione nelle closure)
    const out: { result: AgyResult | null } = { result: null };
    let buffer = '';
    let chain = Promise.resolve();
    const handle = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.event === 'init' && ev.conversation_id && !s.conversationId) {
        s.conversationId = ev.conversation_id;
        saveState();
      } else if (ev.event === 'result') {
        out.result = ev.result ?? {};
      } else if (ev.event === 'step_update') {
        const u = ev.step_update ?? {};
        if (u.step_type === 'agent_response') {
          if (u.thinking_delta) chain = chain.then(() => say({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: u.thinking_delta } }));
          if (u.text_delta) chain = chain.then(() => say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: u.text_delta } }));
        } else if (u.step_type === 'tool') {
          const name = u.tool_name ?? u.tool_info?.name ?? 'tool';
          let id = toolIds.get(u.step_index);
          if (!id) {
            id = `agy-${u.step_index}-${randomUUID().slice(0, 8)}`;
            toolIds.set(u.step_index, id);
            toolKinds.set(id, toolKind(name));
            const callId = id;
            chain = chain.then(() =>
              say({
                sessionUpdate: 'tool_call',
                toolCallId: callId,
                title: toolTitle(u.tool_info, name),
                kind: toolKind(name),
                status: 'in_progress',
                locations: locations(u.tool_info),
                rawInput: u.tool_info?.parameters ?? {},
              }),
            );
          }
          if (u.state === 'DONE' || u.state === 'ERROR' || u.state === 'CANCELED') {
            const callId = id;
            const failed = u.state !== 'DONE';
            chain = chain.then(() =>
              say({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: failed ? 'failed' : 'completed' }),
            );
          }
        }
      }
    };
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on('close', (code, signal) => resolve({ code, signal })),
    );
    if (buffer.trim()) handle(buffer);
    running.delete(sessionId);
    await chain;

    if (exit.signal === 'SIGINT' || exit.signal === 'SIGTERM') return { stopReason: 'cancelled' as const };
    const r = out.result;
    if (r?.denied_actions?.length) {
      const what = r.denied_actions.map((a) => a.display_name ?? a.action).join(', ');
      // agy segna lo strumento come concluso anche se negato: in chat deve risultare fallito
      const deniedKinds = new Set<string>(r.denied_actions.map((a) => (a.action === 'command' ? 'execute' : a.action === 'browser' ? 'fetch' : 'edit')));
      for (const [callId, kind] of toolKinds) {
        if (deniedKinds.has(kind)) await say({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed' });
      }
      await say({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `\n\n> ⚠️ agy non ha potuto eseguire: **${what}**. In questa modalita' agy non puo' chiedere il permesso: per consentirlo scegli *Permessi → Consenti tutto* e ripeti la richiesta.`,
        },
      });
    }
    if (!r || r.status === 'ERROR') {
      throw new Error(r?.error || stderr.trim().split('\n').pop() || `agy terminato con codice ${exit.code}`);
    }
    return { stopReason: 'end_turn' as const };
  })
  .connect(stream);
