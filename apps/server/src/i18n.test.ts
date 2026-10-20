import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERRORS, NOTICES, PLUGIN_TEXTS } from './locales.js';
import { LANGS, parseAccept, tError, tNotice, tPlugin, translate } from './i18n.js';

const here = new URL('.', import.meta.url).pathname;
const ph = (s: string) => [...new Set([...s.matchAll(/\{(\d)\}/g)].map((m) => m[1]))].sort();

test('tabelle: tutte le lingue compilate, segnaposto uguali all\'italiano', () => {
  for (const table of [ERRORS, PLUGIN_TEXTS, NOTICES]) {
    for (const row of table) {
      assert.equal(row.length, LANGS.length);
      for (let i = 1; i < row.length; i++) {
        assert.ok(row[i]!.trim() !== '', `vuoto: ${row[0]} [${LANGS[i]}]`);
        assert.deepEqual(ph(row[i]!), ph(row[0]), `${LANGS[i]}: segnaposto diversi in "${row[0]}"`);
      }
    }
    assert.equal(new Set(table.map((r) => r[0])).size, table.length, 'messaggi italiani duplicati');
  }
});

test('ogni messaggio d\'errore del server rivolto all\'interfaccia ha la traduzione', () => {
  // Esclusi: file per gli strumenti degli agenti (lead.ts) e i messaggi interni
  const skip = new Set(['lead.ts', 'locales.ts']);
  const lit = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|` + '`(?:[^`\\\\]|\\\\.)*`)';
  const re = new RegExp(String.raw`HttpError\(\s*\d+\s*,\s*(${lit})`, 'g');
  const missing: string[] = [];
  for (const f of readdirSync(here).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && !skip.has(x))) {
    for (const m of readFileSync(join(here, f), 'utf8').matchAll(re)) {
      let msg = m[1]!.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
      if (/\$\{(?:err instanceof|PLAN_ERROR|[^}]*\? )/.test(msg)) continue; // messaggi composti da altri (nidificati)
      msg = msg.replace(/\$\{[^}]*\}/g, 'X');
      if (tError(msg, 'en') === msg && !/^[A-Za-z]+: X$/.test(msg)) missing.push(`${f}: ${msg}`);
    }
  }
  assert.deepEqual(missing, [], `senza traduzione:\n${missing.join('\n')}`);
});

test('traduzione: parti variabili, esatti, lingue sconosciute e Accept-Language', () => {
  assert.equal(tError('Non trovato: /a/b', 'de'), 'Nicht gefunden: /a/b');
  assert.equal(tError('Non trovato', 'ru'), 'Не найдено');
  assert.equal(tError('Terminale non trovato', 'it'), 'Terminale non trovato');
  assert.equal(tError('Messaggio che non esiste in tabella', 'cs'), 'Messaggio che non esiste in tabella');
  assert.equal(tError('Troppi terminali aperti (max 8): chiudine uno', 'en'), 'Too many terminals open (max 8): close one');
  assert.equal(tError('Design: non incluso nel tuo piano', 'de'), 'Design: nicht in deinem Tarif enthalten');
  assert.equal(tPlugin('una chiave OpenRouter nel portachiavi (OPENROUTER_API_KEY)', 'en'), 'an OpenRouter key in the key vault (OPENROUTER_API_KEY)');
  assert.equal(tNotice('Fatto · Il mio progetto', 'de'), 'Fertig · Il mio progetto');
  assert.equal(translate(ERRORS, 'Id non valido', 'cs'), 'Neplatné id');
  assert.equal(parseAccept('de-DE,de;q=0.9,en;q=0.8'), 'de');
  assert.equal(parseAccept('fr,ja'), null);
  assert.equal(parseAccept(undefined), null);
});
