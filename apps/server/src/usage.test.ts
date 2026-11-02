import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyUsage } from './usage.js';

test('agy /usage: righe a tab raggruppate per modello', () => {
  const groups = parseAgyUsage(
    [
      'Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-09T17:17:22Z',
      'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-02T22:17:22Z',
      'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t88%\t2026-11-08T12:20:45Z',
      'riga senza tab',
      '',
    ].join('\n'),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0].bars.map((b) => b.kind),
    ['week', 'fiveHour'],
  );
  assert.deepEqual(groups[1], {
    title: 'Gemini 4 Argon',
    bars: [{ label: 'Gemini 4 Argon Weekly Limit', percent: 88, mode: 'remaining', resetsAt: Date.parse('2026-11-08T12:20:45Z') }],
  });
});
