// Sezione File: sfoglia, leggi, modifica, crea, rinomina, elimina — solo dentro PROJECT_ROOTS.
// Ogni percorso passa dal percorso reale (niente symlink o ".." per uscire dalle radici).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_ENTRIES = 3000;
const MAX_UPLOAD = 100 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.json': 'application/json',
  '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function inRoots(p: string): boolean {
  return config.projectRoots.some((r) => p === r || p.startsWith(r + sep));
}

/** Percorso reale di qualcosa che esiste, dentro le radici */
export function resolveExisting(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new HttpError(404, `Non trovato: ${path}`);
  }
  if (!inRoots(real)) throw new HttpError(400, `Fuori dalle cartelle consentite: ${real}`);
  return real;
}

/** Percorso per qualcosa di nuovo: la cartella che lo contiene deve esistere ed essere consentita */
function resolveNew(path: string): string {
  const name = basename(path);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new HttpError(400, 'Nome non valido');
  const parent = resolveExisting(dirname(path));
  if (!statSync(parent).isDirectory()) throw new HttpError(400, 'La cartella di destinazione non esiste');
  const target = join(parent, name);
  if (existsSync(target)) throw new HttpError(409, `Esiste gia': ${target}`);
  return target;
}

export interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
}

export function listDir(path: string): { path: string; parent: string | null; entries: Entry[]; truncated: boolean } {
  const dir = resolveExisting(path);
  if (!statSync(dir).isDirectory()) throw new HttpError(400, 'Non e\' una cartella');
  const names = readdirSync(dir);
  const entries: Entry[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const p = join(dir, name);
    try {
      const l = lstatSync(p);
      const s = l.isSymbolicLink() ? statSync(p) : l;
      entries.push({ name, path: p, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs });
    } catch {
      entries.push({ name, path: p, type: 'link', size: 0, mtime: 0 }); // link rotto
    }
  }
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  const parent = dirname(dir);
  return { path: dir, parent: parent !== dir && inRoots(parent) ? parent : null, entries, truncated: names.length > MAX_ENTRIES };
}

export function readText(path: string): { path: string; content: string | null; binary: boolean; tooLarge: boolean; size: number; mtime: number; mime: string } {
  const p = resolveExisting(path);
  const s = statSync(p);
  if (!s.isFile()) throw new HttpError(400, 'Non e\' un file');
  const base = { path: p, size: s.size, mtime: s.mtimeMs, mime: mimeOf(p) };
  if (s.size > MAX_TEXT) return { ...base, content: null, binary: false, tooLarge: true };
  const buf = readFileSync(p);
  // Un byte zero nei primi 8 KB = file binario (immagine, archivio...)
  if (buf.subarray(0, 8192).includes(0)) return { ...base, content: null, binary: true, tooLarge: false };
  return { ...base, content: buf.toString('utf8'), binary: false, tooLarge: false };
}

export function rawFile(path: string): { path: string; size: number; mime: string } {
  const p = resolveExisting(path);
  const s = statSync(p);
  if (!s.isFile()) throw new HttpError(400, 'Non e\' un file');
  return { path: p, size: s.size, mime: mimeOf(p) };
}

/** Salva; con expectedMtime rifiuta se il file e' cambiato dopo l'apertura (es. lo ha toccato un agente) */
export function writeText(path: string, content: string, expectedMtime?: number): { mtime: number } {
  const p = resolveExisting(path);
  const s = statSync(p);
  if (!s.isFile()) throw new HttpError(400, 'Non e\' un file');
  if (expectedMtime && Math.abs(s.mtimeMs - expectedMtime) > 1) {
    throw new HttpError(409, 'Il file e\' stato modificato da qualcun altro dopo che l\'hai aperto');
  }
  writeFileSync(p, content);
  return { mtime: statSync(p).mtimeMs };
}

export function createEntry(path: string, type: 'file' | 'dir'): Entry {
  const target = resolveNew(path);
  if (type === 'dir') mkdirSync(target);
  else writeFileSync(target, '', { flag: 'wx' });
  const s = statSync(target);
  return { name: basename(target), path: target, type, size: s.size, mtime: s.mtimeMs };
}

export function renameEntry(from: string, toName: string): string {
  // Solo un nome, non un percorso: "../x" sposterebbe il file altrove
  if (!toName || toName === '.' || toName === '..' || /[/\0]/.test(toName)) throw new HttpError(400, 'Nome non valido');
  const src = resolveExisting(from);
  if (config.projectRoots.includes(src)) throw new HttpError(400, 'Non si rinomina una cartella radice');
  const target = resolveNew(join(dirname(src), toName));
  renameSync(src, target);
  return target;
}

/** Elimina un file o una cartella VUOTA (niente cancellazioni ricorsive dall'interfaccia) */
export function deleteEntry(path: string): void {
  const p = resolveExisting(path);
  if (config.projectRoots.includes(p)) throw new HttpError(400, 'Non si elimina una cartella radice');
  const s = statSync(p);
  if (s.isDirectory()) {
    if (readdirSync(p).length) throw new HttpError(409, 'La cartella non e\' vuota');
    rmdirSync(p);
  } else {
    unlinkSync(p);
  }
}

export async function uploadInto(dir: string, files: File[]): Promise<Entry[]> {
  const target = resolveExisting(dir);
  if (!statSync(target).isDirectory()) throw new HttpError(400, 'Non e\' una cartella');
  const out: Entry[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD) throw new HttpError(400, `${f.name}: troppo grande (max 100 MB)`);
    const p = resolveNew(join(target, basename(f.name)));
    writeFileSync(p, Buffer.from(await f.arrayBuffer()), { flag: 'wx' });
    const s = statSync(p);
    out.push({ name: basename(p), path: p, type: 'file', size: s.size, mtime: s.mtimeMs });
  }
  return out;
}
