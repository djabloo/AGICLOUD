// Traduzione ACP (session/update) -> eventi AG-UI.
// Funzione pura con un piccolo stato per run: niente I/O, cosi' si testa facilmente.

import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type * as acp from '@agentclientprotocol/sdk';

type AcpUpdate = acp.SessionUpdate;
type AcpToolContent = acp.ToolCallContent;

/** Prefisso dei nostri eventi CUSTOM: dati che AG-UI non modella (plan, diff, permessi...) */
export const CUSTOM_PREFIX = 'agicloud.';

export class AcpToAgui {
  private textMessageId: string | null = null;
  private acpMessageId: string | null = null;
  private reasoningMessageId: string | null = null;
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();

  translate(update: AcpUpdate): BaseEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.text(update.content, update.messageId ?? null);

      case 'agent_thought_chunk': {
        const delta = blockText(update.content);
        if (!delta) return [];
        this.reasoningMessageId ??= randomUUID();
        return [ev(EventType.REASONING_MESSAGE_CHUNK, { messageId: this.reasoningMessageId, delta })];
      }

      case 'tool_call':
        return [...this.closeText(), ...this.toolStart(update), ...this.toolMaybeDone(update)];

      case 'tool_call_update': {
        const out: BaseEvent[] = [];
        if (!this.startedTools.has(update.toolCallId)) {
          out.push(...this.closeText(), ...this.toolStart(update));
        }
        out.push(custom('tool_call_update', toolInfo(update)));
        out.push(...this.toolMaybeDone(update));
        return out;
      }

      case 'plan':
        return [custom('plan', { entries: update.entries })];

      // Messaggi dell'utente rispediti dall'agente (es. replay storia): la UI li ha gia'
      case 'user_message_chunk':
        return [];

      default:
        // usage, comandi disponibili, modalita', notice, subagent...: passano cosi' come sono
        return [custom(`acp.${update.sessionUpdate}`, update)];
    }
  }

  /** Da chiamare a fine turno: chiude cio' che e' rimasto aperto */
  finish(): BaseEvent[] {
    return this.closeText();
  }

  private text(block: acp.ContentBlock, acpMessageId: string | null): BaseEvent[] {
    const delta = blockText(block);
    if (!delta) return [];
    const out: BaseEvent[] = [];
    // L'agente ha cambiato messaggio: chiudiamo il precedente
    if (this.textMessageId && acpMessageId && this.acpMessageId && acpMessageId !== this.acpMessageId) {
      out.push(...this.closeText());
    }
    if (!this.textMessageId) {
      this.textMessageId = randomUUID();
      this.acpMessageId = acpMessageId;
      out.push(ev(EventType.TEXT_MESSAGE_START, { messageId: this.textMessageId, role: 'assistant' }));
    }
    out.push(ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: this.textMessageId, delta }));
    return out;
  }

  private closeText(): BaseEvent[] {
    if (!this.textMessageId) return [];
    const id = this.textMessageId;
    this.textMessageId = null;
    this.acpMessageId = null;
    return [ev(EventType.TEXT_MESSAGE_END, { messageId: id })];
  }

  private toolStart(call: acp.ToolCall | acp.ToolCallUpdate): BaseEvent[] {
    this.startedTools.add(call.toolCallId);
    const out: BaseEvent[] = [
      ev(EventType.TOOL_CALL_START, {
        toolCallId: call.toolCallId,
        toolCallName: call.name || call.kind || call.title || 'tool',
      }),
    ];
    if (call.rawInput !== undefined) {
      out.push(ev(EventType.TOOL_CALL_ARGS, { toolCallId: call.toolCallId, delta: JSON.stringify(call.rawInput) }));
    }
    out.push(ev(EventType.TOOL_CALL_END, { toolCallId: call.toolCallId }));
    out.push(custom('tool_call', toolInfo(call)));
    return out;
  }

  private toolMaybeDone(call: acp.ToolCall | acp.ToolCallUpdate): BaseEvent[] {
    if (call.status !== 'completed' && call.status !== 'failed') return [];
    if (this.finishedTools.has(call.toolCallId)) return [];
    this.finishedTools.add(call.toolCallId);
    return [
      ev(EventType.TOOL_CALL_RESULT, {
        messageId: randomUUID(),
        toolCallId: call.toolCallId,
        role: 'tool',
        content: toolResultText(call),
      }),
    ];
  }
}

export function ev(type: EventType, fields: Record<string, unknown>): BaseEvent {
  return { type, timestamp: Date.now(), ...fields } as BaseEvent;
}

export function custom(name: string, value: unknown): BaseEvent {
  return ev(EventType.CUSTOM, { name: CUSTOM_PREFIX + name, value });
}

function blockText(block: acp.ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
    default:
      return '';
  }
}

/** Dati utili alla UI (titolo, tipo, file toccati, diff) che AG-UI non prevede */
function toolInfo(call: acp.ToolCall | acp.ToolCallUpdate) {
  return {
    toolCallId: call.toolCallId,
    title: call.title ?? undefined,
    kind: call.kind ?? undefined,
    status: call.status ?? undefined,
    locations: call.locations ?? undefined,
    content: call.content ?? undefined,
    rawInput: call.rawInput,
  };
}

function toolResultText(call: acp.ToolCall | acp.ToolCallUpdate): string {
  const parts = (call.content ?? []).map(contentText).filter(Boolean);
  if (parts.length) return parts.join('\n');
  if (call.rawOutput !== undefined) {
    return typeof call.rawOutput === 'string' ? call.rawOutput : JSON.stringify(call.rawOutput);
  }
  return call.status === 'failed' ? 'failed' : '';
}

function contentText(c: AcpToolContent): string {
  switch (c.type) {
    case 'content':
      return blockText(c.content);
    case 'diff':
      return `diff ${c.path}`;
    case 'terminal':
      return `terminal ${c.terminalId}`;
  }
}
