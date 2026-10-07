import { useMemo } from 'react';
import { diffLines } from 'diff';

export interface FileDiff {
  path: string;
  /** null = file nuovo */
  oldText: string | null;
  newText: string;
}

type Line = { kind: 'add' | 'del' | 'same'; text: string } | { kind: 'gap'; count: number };

/** Righe di contesto mostrate attorno alle modifiche */
const CONTEXT = 3;
/** Oltre questo numero di righe il diff si tronca (file enormi) */
const MAX_LINES = 400;

/** Righe aggiunte/tolte, con poche righe di contesto e i tratti uguali compressi */
function buildLines(oldText: string, newText: string): { lines: Line[]; added: number; removed: number } {
  const all: { kind: 'add' | 'del' | 'same'; text: string }[] = [];
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    const rows = part.value.replace(/\n$/, '').split('\n');
    const kind = part.added ? 'add' : part.removed ? 'del' : 'same';
    if (kind === 'add') added += rows.length;
    if (kind === 'del') removed += rows.length;
    for (const text of rows) all.push({ kind, text });
  }
  // Si tengono le righe cambiate e il loro intorno; il resto diventa "N righe uguali"
  const keep = all.map((l, i) => l.kind !== 'same' || all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== 'same'));
  const lines: Line[] = [];
  let gap = 0;
  all.forEach((l, i) => {
    if (keep[i]) {
      if (gap) lines.push({ kind: 'gap', count: gap });
      gap = 0;
      lines.push(l);
    } else {
      gap++;
    }
  });
  if (gap) lines.push({ kind: 'gap', count: gap });
  return { lines, added, removed };
}

export function diffStats(diffs: FileDiff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    const s = buildLines(d.oldText ?? '', d.newText);
    added += s.added;
    removed += s.removed;
  }
  return { added, removed };
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-stat">
      <span className="visually-hidden">
        {added} {added === 1 ? 'riga aggiunta' : 'righe aggiunte'}, {removed} {removed === 1 ? 'riga rimossa' : 'righe rimosse'}
      </span>
      <span aria-hidden="true">
        <span className="diff-plus">+{added}</span> <span className="diff-minus">−{removed}</span>
      </span>
    </span>
  );
}

export function DiffView({ diff, href }: { diff: FileDiff; href?: string }) {
  const { lines } = useMemo(() => buildLines(diff.oldText ?? '', diff.newText), [diff.oldText, diff.newText]);
  const shown = lines.slice(0, MAX_LINES);
  return (
    <figure className="diff">
      <figcaption className="diff-head">
        {href ? (
          <a href={href}>
            <code>{diff.path}</code>
          </a>
        ) : (
          <code>{diff.path}</code>
        )}
        {diff.oldText === null && <span className="diff-new">nuovo file</span>}
      </figcaption>
      <div className="diff-body" role="group" aria-label={`Modifiche a ${diff.path}`}>
        {shown.map((l, i) =>
          l.kind === 'gap' ? (
            <div key={i} className="dl dl-gap">
              … {l.count} {l.count === 1 ? 'riga uguale' : 'righe uguali'}
            </div>
          ) : l.kind === 'add' ? (
            <ins key={i} className="dl dl-add">
              <span className="dl-sign" aria-hidden="true">+</span>
              <span className="visually-hidden">aggiunta: </span>
              {l.text || ' '}
            </ins>
          ) : l.kind === 'del' ? (
            <del key={i} className="dl dl-del">
              <span className="dl-sign" aria-hidden="true">−</span>
              <span className="visually-hidden">rimossa: </span>
              {l.text || ' '}
            </del>
          ) : (
            <div key={i} className="dl">
              <span className="dl-sign" aria-hidden="true"> </span>
              {l.text || ' '}
            </div>
          ),
        )}
        {lines.length > MAX_LINES && <div className="dl dl-gap">… diff troncato ({lines.length - MAX_LINES} righe non mostrate)</div>}
      </div>
    </figure>
  );
}
