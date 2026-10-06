// Dagli eventi AG-UI alla conversazione da mostrare. Funzione pura: stesso registro -> stessa vista.

import { EventType, type BaseEvent } from '@ag-ui/core';
import type { ThreadStatus } from './api';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface ToolLocation {
  path: string;
  line?: number | null;
}

export type Item =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      title: string;
      toolKind?: string;
      status: string;
      locations: ToolLocation[];
      result?: string;
    }
  | { kind: 'permission'; id: string; title: string; options: PermissionOption[]; resolved?: string | null }
  | { kind: 'plan'; id: string; entries: { content: string; status: string; priority?: string }[] }
  | { kind: 'error'; id: string; message: string };

export interface Transcript {
  items: Item[];
  status: ThreadStatus;
  statusMessage?: string;
  running: boolean;
  agentName?: string;
  /** Contesto usato / disponibile, se l'agente lo comunica */
  usage?: { used: number; size: number };
}

export const emptyTranscript: Transcript = { items: [], status: 'starting', running: false };

type Ev = BaseEvent & Record<string, any>;

export function reduce(state: Transcript, raw: BaseEvent): Transcript {
  const e = raw as Ev;
  const items = state.items;
  switch (e.type) {
    case EventType.TEXT_MESSAGE_START:
      return { ...state, items: [...items, { kind: 'message', id: e.messageId, role: e.role === 'user' ? 'user' : 'assistant', text: '' }] };

    case EventType.TEXT_MESSAGE_CONTENT:
      return { ...state, items: update(items, e.messageId, (it) => (it.kind === 'message' ? { ...it, text: it.text + e.delta } : it)) };

    case EventType.REASONING_MESSAGE_CHUNK: {
      const prefix = `r-${e.messageId ?? 'x'}-`;
      const last = items[items.length - 1];
      // I pensieri consecutivi restano in un unico blocco finche' non arriva altro
      if (last?.kind === 'reasoning' && last.id.startsWith(prefix)) {
        return { ...state, items: [...items.slice(0, -1), { ...last, text: last.text + (e.delta ?? '') }] };
      }
      return { ...state, items: [...items, { kind: 'reasoning', id: prefix + items.length, text: e.delta ?? '' }] };
    }

    case EventType.TOOL_CALL_START:
      return {
        ...state,
        items: [...items, { kind: 'tool', id: e.toolCallId, name: e.toolCallName, title: e.toolCallName, status: 'pending', locations: [] }],
      };

    case EventType.TOOL_CALL_RESULT:
      return { ...state, items: update(items, e.toolCallId, (it) => (it.kind === 'tool' ? { ...it, result: contentText(e.content) } : it)) };

    case EventType.RUN_STARTED:
      return { ...state, running: true };

    case EventType.RUN_FINISHED: {
      const stop = e.result?.stopReason;
      const note: Item[] =
        stop && stop !== 'end_turn'
          ? [{ kind: 'error', id: `stop-${items.length}`, message: stopReasonText(stop) }]
          : [];
      return { ...state, running: false, items: [...items, ...note] };
    }

    case EventType.RUN_ERROR:
      return { ...state, running: false, items: [...items, { kind: 'error', id: `err-${items.length}`, message: e.message }] };

    case EventType.CUSTOM:
      return reduceCustom(state, e.name, e.value);

    default:
      return state;
  }
}

function reduceCustom(state: Transcript, name: string, v: any): Transcript {
  const items = state.items;
  switch (name) {
    case 'agicloud.thread_status':
      return { ...state, status: v.status, statusMessage: v.message, running: v.status === 'running' };

    case 'agicloud.agent_info':
      return { ...state, agentName: v.agentInfo?.title ?? v.agentInfo?.name };

    case 'agicloud.tool_call':
    case 'agicloud.tool_call_update':
      return {
        ...state,
        items: update(items, v.toolCallId, (it) =>
          it.kind === 'tool'
            ? {
                ...it,
                title: v.title || it.title,
                toolKind: v.kind ?? it.toolKind,
                status: v.status ?? it.status,
                locations: v.locations?.length ? v.locations : it.locations,
              }
            : it,
        ),
      };

    case 'agicloud.permission_request':
      return {
        ...state,
        items: [
          ...items,
          { kind: 'permission', id: v.requestId, title: v.toolCall?.title ?? 'Azione dell\'agente', options: v.options ?? [] },
        ],
      };

    case 'agicloud.permission_resolved':
      return { ...state, items: update(items, v.requestId, (it) => (it.kind === 'permission' ? { ...it, resolved: v.optionId } : it)) };

    case 'agicloud.plan':
      return { ...state, items: [...items.filter((i) => i.kind !== 'plan'), { kind: 'plan', id: 'plan', entries: v.entries ?? [] }] };

    case 'agicloud.acp.usage_update':
      return typeof v.used === 'number' && typeof v.size === 'number' ? { ...state, usage: { used: v.used, size: v.size } } : state;

    default:
      return state;
  }
}

function update(items: Item[], id: string, fn: (it: Item) => Item): Item[] {
  // Si cerca dal fondo: l'elemento da aggiornare e' quasi sempre l'ultimo
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.id === id) {
      const copy = items.slice();
      copy[i] = fn(items[i]!);
      return copy;
    }
  }
  return items;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => p?.text ?? '').join('\n');
  return '';
}

function stopReasonText(reason: string): string {
  switch (reason) {
    case 'cancelled':
      return 'Interrotto.';
    case 'max_tokens':
      return 'Risposta troncata: raggiunto il limite di lunghezza.';
    case 'max_turn_requests':
      return 'L\'agente si e\' fermato: troppi passaggi in un solo turno.';
    case 'refusal':
      return 'L\'agente ha rifiutato la richiesta.';
    default:
      return `Turno terminato (${reason}).`;
  }
}
