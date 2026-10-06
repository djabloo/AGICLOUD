// Cartelle di progetto: si possono aprire solo dentro le radici consentite (PROJECT_ROOTS).

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';

const MAX_DIRS = 500;

function insideRoots(p: string): boolean {
  return config.projectRoots.some((root) => p === root || p.startsWith(root + sep));
}

/** Percorso canonico di una cartella consentita, altrimenti errore 400 */
export function resolveProject(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new HttpError(400, `Cartella inesistente: ${path}`);
  }
  if (!insideRoots(real)) throw new HttpError(400, `Cartella fuori dalle radici consentite: ${real}`);
  if (!statSync(real).isDirectory()) throw new HttpError(400, `Non e' una cartella: ${real}`);
  return real;
}

export interface DirEntry {
  name: string;
  path: string;
  git: boolean;
}

/** Sottocartelle (senza quelle nascoste e node_modules); senza path: le radici */
export function listDirs(path?: string): { path: string | null; parent: string | null; dirs: DirEntry[] } {
  if (!path) {
    return {
      path: null,
      parent: null,
      dirs: config.projectRoots.map((p) => ({ name: p, path: p, git: existsSync(join(p, '.git')) })),
    };
  }
  const real = resolveProject(path);
  let names: string[] = [];
  try {
    names = readdirSync(real, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_DIRS);
  } catch {
    throw new HttpError(400, `Cartella non leggibile: ${real}`);
  }
  const parent = dirname(real);
  return {
    path: real,
    parent: real !== parent && insideRoots(parent) ? parent : null,
    dirs: names.map((name) => {
      const p = join(real, name);
      return { name, path: p, git: existsSync(join(p, '.git')) };
    }),
  };
}
