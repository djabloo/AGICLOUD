// Lingua dei testi del server (errori, descrizioni dei plugin, notifiche). L'interfaccia manda la lingua scelta in Accept-Language;
// senza intestazione (agenti, script) restano i testi italiani originali.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERRORS, NOTICES, PLUGIN_TEXTS } from './locales.js';

export const LANGS = ['it', 'en', 'de', 'cs', 'ru'] as const;
export type Lang = (typeof LANGS)[number];
type Table = ReadonlyArray<readonly [string, string, string, string, string]>;

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** Prima lingua riconosciuta di Accept-Language, null se non c'e' */
export function parseAccept(header: string | undefined | null): Lang | null {
  for (const part of (header ?? '').split(',')) {
    const base = part.trim().split(';')[0]!.toLowerCase().split('-')[0]!;
    if (isLang(base)) return base;
  }
  return null;
}

interface Entry {
  re: RegExp | null;
  row: readonly string[];
}
const compile = (table: Table): { exact: Map<string, readonly string[]>; patterns: Entry[] } => {
  const exact = new Map<string, readonly string[]>();
  const patterns: Entry[] = [];
  for (const row of table) {
    if (!/\{\d\}/.test(row[0])) exact.set(row[0], row);
    else patterns.push({ re: new RegExp('^' + row[0].replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\d\}/g, '(.+?)') + '$', 's'), row });
  }
  return { exact, patterns };
};
const compiled = new Map<Table, ReturnType<typeof compile>>();

/** Rende nella lingua scelta un messaggio italiano della tabella; se non c'e' resta com'e' */
export function translate(table: Table, message: string, lang: Lang): string {
  if (lang === 'it') return message;
  let c = compiled.get(table);
  if (!c) compiled.set(table, (c = compile(table)));
  const col = LANGS.indexOf(lang);
  const hit = c.exact.get(message);
  if (hit) return hit[col]!;
  for (const p of c.patterns) {
    const m = p.re!.exec(message);
    if (m) return p.row[col]!.replace(/\{(\d)\}/g, (_all, i: string) => m[Number(i)] ?? '');
  }
  return message;
}

export const tError = (m: string, lang: Lang): string => translate(ERRORS, m, lang);
export const tPlugin = (m: string, lang: Lang): string => translate(PLUGIN_TEXTS, m, lang);
export const tNotice = (m: string, lang: Lang): string => translate(NOTICES, m, lang);

// Ultima lingua usata dall'interfaccia: serve alle notifiche push, che nascono senza una richiesta del browser
let lastLang: Lang = 'it';
let lastFile = '';
export function initLastLang(dataDir: string): void {
  lastFile = join(dataDir, 'lang');
  try {
    const v = readFileSync(lastFile, 'utf8').trim();
    if (isLang(v)) lastLang = v;
  } catch {
    /* nessuna lingua salvata */
  }
}
export function rememberLang(lang: Lang): void {
  if (lang === lastLang) return;
  lastLang = lang;
  if (lastFile) {
    try {
      writeFileSync(lastFile, lang);
    } catch {
      /* non grave */
    }
  }
}
export const currentLang = (): Lang => lastLang;
