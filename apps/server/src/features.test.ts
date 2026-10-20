// Piano (AGICLOUD_FEATURES): quali route restano aperte e quali rispondono 403.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseFeatures, sectionOf } from './features.js';

describe('features', () => {
  it('senza variabile tutto e\' consentito', () => {
    assert.equal(parseFeatures(undefined), null);
    assert.equal(parseFeatures(''), null);
    assert.equal(parseFeatures('all'), null);
    assert.equal(parseFeatures('ALL'), null);
    assert.ok(isAllowed(null, 'terminal'));
    assert.ok(isAllowed(null, 'pii'));
  });

  it('elenco separato da virgole', () => {
    const f = parseFeatures('chat,pii');
    assert.ok(f instanceof Set);
    assert.ok(isAllowed(f, 'chat'));
    assert.ok(isAllowed(f, 'pii'));
    assert.ok(!isAllowed(f, 'terminal'));
    assert.ok(!isAllowed(f, 'files'));
  });

  it('spazi e maiuscole non contano', () => {
    const f = parseFeatures(' Chat , PII ');
    assert.ok(isAllowed(f, 'chat'));
    assert.ok(isAllowed(f, 'pii'));
  });

  it('le route delle sezioni portano alla sezione giusta', () => {
    assert.equal(sectionOf('/api/terminals'), 'terminal');
    assert.equal(sectionOf('/api/terminals/abc/ws'), 'terminal');
    assert.equal(sectionOf('/api/files/list'), 'files');
    assert.equal(sectionOf('/api/files/raw'), 'files');
    assert.equal(sectionOf('/api/design/catalog'), 'design');
    assert.equal(sectionOf('/preview/xyz/index.html'), 'design');
    assert.equal(sectionOf('/api/browser/screenshot'), 'browser');
    assert.equal(sectionOf('/api/browser/ws'), 'browser');
    assert.equal(sectionOf('/browser-start'), 'browser');
    assert.equal(sectionOf('/api/pii/engine/analyze'), 'pii');
    assert.equal(sectionOf('/api/verdict/decide'), 'verdict');
    assert.equal(sectionOf('/verdict-api/decide'), 'verdict');
  });

  it('chat, impostazioni e resto non sono limitabili', () => {
    assert.equal(sectionOf('/api/threads'), null);
    assert.equal(sectionOf('/api/session'), null);
    assert.equal(sectionOf('/api/settings/vault'), null);
    assert.equal(sectionOf('/api/plugins'), null);
  });
});
