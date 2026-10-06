// Prova a riga di comando del ponte ACP -> AG-UI.
//   npm run probe -- <agente> "<prompt>" [--cwd DIR] [--auth METODO] [--allow]
// Stampa gli eventi AG-UI in forma compatta. Senza --allow i permessi vengono rifiutati.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { AgentSession, getAgent, type PermissionRequest } from './index.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const allow = args.includes('--allow');
if (allow) args.splice(args.indexOf('--allow'), 1);
const cwd = resolve(flag('--cwd') ?? mkdtempSync(join(tmpdir(), 'agicloud-probe-')));
const authMethod = flag('--auth');
const [agentId, prompt] = args;
if (!agentId || !prompt) {
  console.error('Uso: npm run probe -- <agente> "<prompt>" [--cwd DIR] [--auth METODO] [--allow]');
  process.exit(2);
}

const session = new AgentSession(getAgent(agentId), { cwd, authMethod });
console.error(`▶ ${agentId} in ${cwd}`);
const t0 = Date.now();
let init;
try {
  init = await session.start();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  await session.close();
  process.exit(1);
}
console.error(`✓ inizializzato in ${Date.now() - t0}ms — ${init.agentInfo?.name ?? '?'} ${init.agentInfo?.version ?? ''}`);

let exit = 0;
for await (const e of session.run(prompt)) {
  print(e);
  if (e.type === EventType.CUSTOM && (e as any).name === 'agicloud.permission_request') {
    const req = (e as any).value as PermissionRequest;
    const choice = allow ? req.options.find((o) => o.kind.startsWith('allow')) : req.options.find((o) => o.kind.startsWith('reject'));
    console.error(`  ↳ permesso "${req.toolCall.title}": ${choice?.name ?? 'annullato'}`);
    session.respondPermission(req.requestId, choice?.optionId ?? null);
  }
  if (e.type === EventType.RUN_ERROR) exit = 1;
}
await session.close();
process.exit(exit);

function print(e: BaseEvent & Record<string, any>) {
  const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);
  switch (e.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK:
      console.log(`${e.type} ${JSON.stringify(short(e.delta ?? '', 80))}`);
      break;
    case EventType.CUSTOM:
      console.log(`CUSTOM ${e.name} ${short(JSON.stringify(e.value))}`);
      break;
    default: {
      const { type, timestamp, ...rest } = e;
      console.log(`${type} ${short(JSON.stringify(rest))}`);
    }
  }
}
