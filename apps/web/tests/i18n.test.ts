// Controlli sulle traduzioni: segnaposto coerenti, plurali validi, chiavi usate nel codice esistenti, lingue complete.
// Le lingue incomplete passano finche' non si imposta I18N_STRICT=1 (il rapporto dice cosa manca).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LANGS = ['it', 'en', 'de', 'cs', 'ru'];
type Msg = string | Record<string, string>;

async function load(lang: string): Promise<Record<string, Msg>> {
  const dir = join(here, '..', 'src', 'i18n', 'locales', lang);
  const out: Record<string, Msg> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const mod = (await import(join(dir, f))) as { default: Record<string, Msg> };
    for (const [k, v] of Object.entries(mod.default)) out[`${f.slice(0, -3)}.${k}`] = v;
  }
  return out;
}
const forms = (m: Msg): string[] => (typeof m === 'string' ? [m] : Object.values(m));
const placeholders = (m: Msg): string[] => [...new Set(forms(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])))].sort();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === 'locales' ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : [];
  });

test('lingue: segnaposto e plurali coerenti con l\'italiano', async () => {
  const it = await load('it');
  const PLURAL = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
  for (const [k, m] of Object.entries(it)) if (typeof m !== 'string') assert.ok('other' in m && Object.keys(m).every((x) => PLURAL.has(x)), `plurale non valido: it ${k}`);
  for (const lang of LANGS.filter((l) => l !== 'it')) {
    const d = await load(lang);
    for (const [k, m] of Object.entries(d)) {
      assert.ok(k in it, `${lang}: chiave sconosciuta ${k}`);
      assert.deepEqual(placeholders(m), placeholders(it[k]), `${lang} ${k}: segnaposto diversi dall'italiano`);
      if (typeof m !== 'string') assert.ok('other' in m, `${lang} ${k}: manca "other"`);
    }
  }
});

test('codice: ogni t("chiave") esiste in italiano', async () => {
  const it = await load('it');
  const used = new Set<string>();
  for (const file of walk(join(here, '..', 'src'))) for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !(k in it));
  assert.deepEqual(missing, [], `chiavi usate ma assenti in italiano: ${missing.join(', ')}`);
});

test('completezza delle lingue', async () => {
  const it = await load('it');
  const problems: string[] = [];
  for (const lang of LANGS.filter((l) => l !== 'it')) {
    const d = await load(lang);
    const missing = Object.keys(it).filter((k) => !(k in d));
    console.log(`# ${lang}: ${Object.keys(it).length - missing.length}/${Object.keys(it).length} testi tradotti`);
    if (missing.length) problems.push(`${lang}: mancano ${missing.length} (es. ${missing.slice(0, 3).join(', ')})`);
  }
  if (process.env.I18N_STRICT === '1') assert.deepEqual(problems, []);
});
