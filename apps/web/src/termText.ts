// Testo e link dal buffer di xterm.js. Il terminale e' un canvas: per copiare o aprire un link
// bisogna ricostruire il testo. Alcuni programmi a schermo intero (es. le interfacce di login)
// spezzano le righe lunghe con un a capo "vero", quindi una riga piena fino all'ultima colonna
// si considera continuata.

import type { Terminal } from '@xterm/xterm';

/** Righe logiche (con le righe spezzate ricucite) delle ultime `max` righe del buffer visibile */
export function terminalLines(term: Terminal, max = 500): string[] {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - max);
  const out: string[] = [];
  let prevFull = false;
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const raw = line.translateToString(false);
    const text = raw.replace(/\s+$/, '');
    const continues = out.length > 0 && (line.isWrapped || (prevFull && text.length > 0 && !/^\s/.test(text)));
    if (continues) out[out.length - 1] += text;
    else out.push(text);
    // Piena fino all'ultima colonna, senza spazi in fondo: probabilmente prosegue sotto
    prevFull = text.length >= term.cols && !/\s$/.test(raw);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

const URL_RE = /https?:\/\/[^\s"'<>`│┃|]+/g;

/** Link http(s) presenti nel testo, dal piu' recente, senza doppioni */
export function findUrls(lines: string[], limit = 3): string[] {
  const found: string[] = [];
  for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
    const matches = lines[i]!.match(URL_RE) ?? [];
    for (const m of matches.reverse()) {
      const url = m.replace(/[).,;:!?\]]+$/, '');
      if (url.length > 10 && !found.includes(url)) found.push(url);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/** Copia negli appunti; ripiego per browser senza Clipboard API */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
