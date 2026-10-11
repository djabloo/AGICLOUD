// Traduzioni dell'interfaccia: italiano (lingua dei testi originali), inglese, tedesco, ceco, russo.
//
// - I testi stanno in i18n/locales/<lingua>/<spazio>.ts (un file per area: chat, files, ...). Ogni file esporta di default un
//   oggetto { chiave: testo } e la chiave completa e' "<spazio>.<chiave>" (es. la chiave "files.nuovaCartella").
// - Un testo puo' avere segnaposto {nome} e forme di plurale: { one: '{n} file', other: '{n} file' } (Intl.PluralRules della lingua).
// - Se manca una chiave si ripiega su inglese e poi italiano: una lingua incompleta non rompe l'interfaccia.
// - La lingua si sceglie in Impostazioni → Aspetto; la prima volta si segue quella del browser.
import { useSyncExternalStore } from 'react';

export type Lang = 'it' | 'en' | 'de' | 'cs' | 'ru';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'it', label: 'Italiano' },
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'cs', label: 'Čeština' },
  { id: 'ru', label: 'Русский' },
];

export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | Plural;
export type Dict = Record<string, Message>;
export type Params = Record<string, string | number>;

const KEY = 'agicloud.lang';

// Ogni file di lingua e' trovato da Vite (nessun elenco da tenere aggiornato a mano)
const modules = import.meta.glob<{ default: Dict }>('./locales/*/*.ts', { eager: true });

function dictOf(lang: Lang): Dict {
  const out: Dict = {};
  for (const [path, mod] of Object.entries(modules)) {
    const m = /^\.\/locales\/([a-z]+)\/([^/]+)\.ts$/.exec(path);
    if (!m || m[1] !== lang) continue;
    for (const [k, v] of Object.entries(mod.default)) out[`${m[2]}.${k}`] = v;
  }
  return out;
}

const dicts: Record<Lang, Dict> = { it: dictOf('it'), en: dictOf('en'), de: dictOf('de'), cs: dictOf('cs'), ru: dictOf('ru') };

export function detectLang(): Lang {
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.toLowerCase().split('-')[0];
    const hit = LANGS.find((x) => x.id === base);
    if (hit) return hit.id;
  }
  return 'en';
}

let current: Lang = (() => {
  const saved = localStorage.getItem(KEY) as Lang | null;
  return saved && LANGS.some((l) => l.id === saved) ? saved : detectLang();
})();
const listeners = new Set<() => void>();

export const getLang = (): Lang => current;

export function setLang(lang: Lang): void {
  current = lang;
  localStorage.setItem(KEY, lang);
  document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

/** true se l'utente ha scelto la lingua (altrimenti segue il browser) */
export const hasChosenLang = (): boolean => localStorage.getItem(KEY) !== null;

export function applyLang(): void {
  document.documentElement.lang = current;
}

function pick(msg: Message, lang: Lang, n: number | undefined): string {
  if (typeof msg === 'string') return msg;
  if (n === undefined) return msg.other;
  return msg[new Intl.PluralRules(lang).select(n)] ?? msg.other;
}

/** Traduce una chiave "<spazio>.<chiave>"; il numero {n} sceglie il plurale */
export function t(key: string, params?: Params): string {
  const lang = current;
  const msg = dicts[lang][key] ?? dicts.en[key] ?? dicts.it[key];
  if (msg === undefined) return key;
  const n = typeof params?.n === 'number' ? params.n : undefined;
  const text = pick(msg, dicts[lang][key] !== undefined ? lang : dicts.en[key] !== undefined ? 'en' : 'it', n);
  return params ? text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all)) : text;
}

/** Hook: ridisegna il componente quando cambia la lingua; restituisce t */
export function useT(): typeof t {
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current,
  );
  return t;
}

/** Formati di data e numero nella lingua scelta */
export const fmtDateTime = (ts: number | Date, opts?: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(current, opts ?? { dateStyle: 'medium', timeStyle: 'short' }).format(ts);
export const fmtDate = (ts: number | Date): string => new Intl.DateTimeFormat(current, { dateStyle: 'medium' }).format(ts);
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions): string => new Intl.NumberFormat(current, opts).format(n);
