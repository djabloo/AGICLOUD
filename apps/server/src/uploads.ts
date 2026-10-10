// Allegati: salvati nella cartella del progetto, in .agicloud/uploads/, cosi' ogni agente li legge
// come file normali. Se il progetto e' un repo git, .agicloud/ va in .git/info/exclude
// (esclusione locale: non tocca il .gitignore del progetto).

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { HttpError } from './errors.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
const UPLOAD_DIR = join('.agicloud', 'uploads');

export interface Attachment {
  name: string;
  /** Percorso relativo alla cartella del progetto */
  path: string;
  size: number;
  mime: string;
}

export async function saveUploads(cwd: string, files: File[]): Promise<Attachment[]> {
  if (!files.length) throw new HttpError(400, 'Nessun file');
  if (files.length > MAX_FILES) throw new HttpError(400, `Massimo ${MAX_FILES} file per volta`);
  const dir = join(cwd, UPLOAD_DIR);
  mkdirSync(dir, { recursive: true });
  excludeFromGit(cwd);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out: Attachment[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new HttpError(400, `${f.name}: troppo grande (max 25 MB)`);
    const name = safeName(f.name);
    let target = join(dir, `${stamp}-${name}`);
    for (let i = 2; existsSync(target); i++) target = join(dir, `${stamp}-${i}-${name}`);
    writeFileSync(target, Buffer.from(await f.arrayBuffer()), { mode: 0o640 });
    out.push({ name: f.name, path: relative(cwd, target), size: f.size, mime: f.type || 'application/octet-stream' });
  }
  return out;
}

/** Cartelle da cui si puo' allegare: i file caricati e i documenti anonimizzati del plugin PII */
const ATTACH_DIRS = [UPLOAD_DIR, 'pii-clean'];

/** Controlla che un allegato indicato dal browser stia davvero in una delle cartelle consentite */
export function resolveAttachment(cwd: string, path: string): { abs: string; size: number } {
  let abs: string;
  try {
    abs = realpathSync(join(cwd, path));
  } catch {
    throw new HttpError(400, `Allegato non trovato: ${path}`);
  }
  const inside = ATTACH_DIRS.some((d) => {
    try {
      return abs.startsWith(realpathSync(join(cwd, d)) + sep);
    } catch {
      return false;
    }
  });
  if (!inside || !statSync(abs).isFile()) throw new HttpError(400, `Allegato non valido: ${path}`);
  return { abs, size: statSync(abs).size };
}

export function readAttachment(abs: string): Buffer {
  return readFileSync(abs);
}

function safeName(name: string): string {
  const ext = extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  const stem = basename(name, extname(name))
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || 'file'}${ext}`;
}

/** Repo git (anche in una cartella superiore): .agicloud/ (allegati, copie dei thread) nell'esclusione locale del repo */
export function excludeFromGit(cwd: string, entry = '.agicloud/', comment = 'allegati di AgiCloud'): void {
  let dir = cwd;
  for (;;) {
    const git = join(dir, '.git');
    if (existsSync(git) && statSync(git).isDirectory()) {
      const exclude = join(git, 'info', 'exclude');
      try {
        mkdirSync(dirname(exclude), { recursive: true });
        const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
        if (!current.split('\n').some((l) => l.trim() === entry)) {
          appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}# ${comment}\n${entry}\n`);
        }
      } catch {
        /* repo non scrivibile: pazienza, gli allegati restano comunque fuori dal codice */
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
