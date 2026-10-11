import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerBase, failureReason, flowUpgrade, gflowArgs } from './flow.js';

test('gflow: argomenti dei comandi e motivo dell\'errore', () => {
  assert.deepEqual(gflowArgs('video', 'veo-fast', '16:9', 'a fox'), ['video', 't2v', '--model', 'veo-fast', '--aspect', '16:9', '--out-dir', '/out', '--json', 'a fox']);
  assert.deepEqual(gflowArgs('image', 'nano2', '1:1', 'a fox'), ['image', 't2i', '--model', 'nano2', '--aspect', '1:1', '--out', '/out', '--json', 'a fox']);
  const out = '{"event": "x"}\n{\n  "status": "fail",\n  "error": {\n    "title": "Profile was written by a newer Chromium",\n    "detail": "Profile at \\"/p\\" is newer",\n    "exit_code": 11\n  }\n}\n';
  assert.equal(failureReason(out), 'Profile was written by a newer Chromium: Profile at "/p" is newer');
  assert.equal(failureReason('riga uno\nCredenziali scadute\n'), 'Credenziali scadute');
});

test('docker: niente privilegi, utente non root, risorse limitate, mai 0.0.0.0', () => {
  const a = dockerBase(['--name', 'x', 'img', 'login'], { detach: true }).join(' ');
  for (const must of ['run -d --rm', '--cap-drop ALL', 'no-new-privileges:true', '--memory 2g', '--pids-limit 512', '-v ']) assert.ok(a.includes(must), must);
  assert.ok(!a.includes('--privileged') && !a.includes('0.0.0.0') && !a.includes('docker.sock'));
  assert.match(a, /--user \d+:\d+/);
  assert.equal(typeof flowUpgrade(() => true), 'function');
});
