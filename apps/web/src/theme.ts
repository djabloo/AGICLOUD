// Tema scelto su questo dispositivo: automatico (segue il sistema), chiaro o scuro.
// Si applica con data-theme su <html>; i colori stanno in styles.css.

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'agicloud.theme';
const BAR_COLOR = { light: '#f7f8fb', dark: '#0b0f17' };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function setTheme(choice: ThemeChoice): void {
  if (choice === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  applyTheme();
}

export function isDark(): boolean {
  const t = getTheme();
  return t === 'dark' || (t === 'system' && systemDark.matches);
}

export function applyTheme(): void {
  const t = getTheme();
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // Colore della barra del browser/app: con un tema scelto vale per entrambe le preferenze di sistema
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const forDark = meta.media.includes('dark');
    meta.content = t === 'system' ? BAR_COLOR[forDark ? 'dark' : 'light'] : BAR_COLOR[t];
  }
}
