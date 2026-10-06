import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventType } from '@ag-ui/core';
import { AcpToAgui } from './translate.js';

const types = (events: { type: string }[]) => events.map((e) => e.type);

test('testo in streaming: START una volta, CONTENT per chunk, END a fine turno', () => {
  const t = new AcpToAgui();
  const a = t.translate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ci' } });
  const b = t.translate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ao' } });
  assert.deepEqual(types(a), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]);
  assert.deepEqual(types(b), [EventType.TEXT_MESSAGE_CONTENT]);
  assert.deepEqual(types(t.finish()), [EventType.TEXT_MESSAGE_END]);
  assert.deepEqual(t.finish(), []);
});

test('una tool call chiude il testo aperto e produce START/ARGS/END, poi RESULT una sola volta', () => {
  const t = new AcpToAgui();
  t.translate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'scrivo' } });
  const start = t.translate({
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'Write x.txt',
    kind: 'edit',
    status: 'pending',
    rawInput: { path: 'x.txt' },
  });
  assert.deepEqual(types(start), [
    EventType.TEXT_MESSAGE_END,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.CUSTOM,
  ]);
  const done = t.translate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  });
  const result = done.find((e) => e.type === EventType.TOOL_CALL_RESULT) as unknown as { content: string };
  assert.equal(result.content, 'ok');
  const again = t.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
  assert.ok(!again.some((e) => e.type === EventType.TOOL_CALL_RESULT));
});

test('update di una tool call mai vista: la apre comunque', () => {
  const t = new AcpToAgui();
  const out = t.translate({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress', title: 'read' });
  assert.equal(out[0]!.type, EventType.TOOL_CALL_START);
});

test('update sconosciuti passano come CUSTOM agicloud.acp.*', () => {
  const t = new AcpToAgui();
  const [e] = t.translate({ sessionUpdate: 'usage_update', used: 1, size: 10 } as never) as unknown as { name: string }[];
  assert.equal(e!.name, 'agicloud.acp.usage_update');
});
