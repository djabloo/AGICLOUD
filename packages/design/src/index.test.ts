import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalog, craftFor, installKit, kitPrompt, KIT_DIR, normalizeChoice } from './index.js';

test('il catalogo ha solo contenuti presenti su disco', () => {
  const c = catalog();
  assert.ok(c.systems.length > 20 && c.skills.length > 20);
  for (const s of c.systems) assert.ok(existsSync(join(import.meta.dirname, '..', 'content', 'systems', s.id, 'DESIGN.md')), s.id);
  for (const s of c.skills) assert.ok(existsSync(join(import.meta.dirname, '..', 'content', 'skills', s.id, 'SKILL.md')), s.id);
});

test('scelta: vuota → null, id sconosciuti rifiutati', () => {
  assert.equal(normalizeChoice(undefined), null);
  assert.equal(normalizeChoice({ skill: '', system: '' }), null);
  assert.deepEqual(normalizeChoice({ skill: 'frontend-design', system: 'clean', extra: 1 }), { skill: 'frontend-design', system: 'clean' });
  assert.throws(() => normalizeChoice({ skill: '../../etc' }), /sconosciuta/);
  assert.throws(() => normalizeChoice({ system: 'airbnb' }), /sconosciuto/);
});

test('kit copiato nel progetto e istruzioni che lo indicano', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agc-design-'));
  try {
    // Un kit precedente viene sostituito
    mkdirSync(join(dir, KIT_DIR, 'skill'), { recursive: true });
    writeFileSync(join(dir, KIT_DIR, 'skill', 'vecchio.md'), 'x');
    const choice = { skill: 'frontend-design', system: 'clean' };
    installKit(dir, choice);
    const kit = join(dir, KIT_DIR);
    assert.ok(existsSync(join(kit, 'skill', 'SKILL.md')));
    assert.ok(!existsSync(join(kit, 'skill', 'vecchio.md')));
    assert.ok(readFileSync(join(kit, 'system', 'tokens.css'), 'utf8').includes(':root'));
    assert.ok(!existsSync(join(kit, 'system', 'preview')));
    const craft = craftFor(choice);
    assert.ok(craft.includes('typography') && craft.includes('accessibility-baseline'));
    for (const c of craft) assert.ok(existsSync(join(kit, 'craft', `${c}.md`)), c);

    const prompt = kitPrompt(choice);
    assert.match(prompt, /\.agicloud\/design\/skill\/SKILL\.md/);
    assert.match(prompt, /tokens\.css/);
    assert.match(prompt, /craft\/typography\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('solo design system: niente riga della skill', () => {
  const prompt = kitPrompt({ system: 'brutalism' });
  assert.doesNotMatch(prompt, /SKILL\.md/);
  assert.match(prompt, /Brutalism/);
});
