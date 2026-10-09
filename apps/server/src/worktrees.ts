// Copie separate per i thread affidati dal capo: ogni thread lavora in un git worktree
// (<repo>/.agicloud/worktrees/<nome>, ramo agc/<nome>), cosi' due agenti non si pestano i piedi.
// Alla fine l'utente vede le modifiche e sceglie: unire nel progetto o scartare.

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './errors.js';
import { excludeFromGit } from './uploads.js';

const exec = promisify(execFile);

export interface WorktreeInfo {
  /** Radice del repo principale */
  root: string;
  /** Cartella della copia */
  path: string;
  branch: string;
  /** Commit da cui e' partita la copia: le modifiche si misurano da qui */
  base: string;
  state: 'open' | 'merged' | 'discarded';
}

export interface Changes {
  files: { path: string; added: number; removed: number }[];
  patch: string;
  truncated: boolean;
}

const MAX_PATCH = 400_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-c', 'user.name=AgiCloud', '-c', 'user.email=agicloud@localhost', ...args], {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error((e.stderr || e.message).trim());
  }
}

/** Radice del repo git che contiene la cartella, o null se non e' un repo */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return realpathSync((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

/**
 * Crea la copia per un thread. La cartella di lavoro del thread e' la stessa sottocartella
 * del progetto, dentro la copia. Le modifiche non salvate nel progetto NON passano nella copia.
 */
export async function createWorktree(projectCwd: string, slug: string): Promise<{ info: WorktreeInfo; cwd: string } | null> {
  const root = await repoRoot(projectCwd);
  if (!root) return null;
  let base: string;
  try {
    base = (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return null; // repo senza commit: niente da copiare
  }
  excludeFromGit(root);
  let name = slug;
  for (let i = 2; existsSync(join(root, '.agicloud', 'worktrees', name)); i++) name = `${slug}-${i}`;
  const path = join(root, '.agicloud', 'worktrees', name);
  const branch = `agc/${name}`;
  await git(root, ['worktree', 'add', '-b', branch, path, base]);
  // La sottocartella del progetto puo' non esserci nella copia (ignorata da git, es. data/workspaces
  // dentro il repo di AgiCloud): allora il thread lavora dalla radice della copia
  const sub = join(path, relative(root, realpathSync(projectCwd)));
  return { info: { root, path, branch, base, state: 'open' }, cwd: existsSync(sub) ? sub : path };
}

/** Tutto il lavoro della copia rispetto al punto di partenza (anche file nuovi e commit fatti dall'agente) */
export async function worktreeChanges(wt: WorktreeInfo): Promise<Changes> {
  if (wt.state !== 'open' || !existsSync(wt.path)) return { files: [], patch: '', truncated: false };
  await git(wt.path, ['add', '-A']);
  const numstat = await git(wt.path, ['diff', '--cached', '--numstat', wt.base]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split('\t');
      return { path: p.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 };
    });
  let patch = await git(wt.path, ['diff', '--cached', wt.base]);
  const truncated = patch.length > MAX_PATCH;
  if (truncated) patch = patch.slice(0, MAX_PATCH);
  return { files, patch, truncated };
}

/** Salva il lavoro della copia in un commit e lo unisce nel ramo attuale del progetto */
export async function mergeWorktree(wt: WorktreeInfo, title: string): Promise<string> {
  if (wt.state !== 'open') throw new HttpError(409, 'Copia gia\' chiusa');
  await git(wt.path, ['add', '-A']);
  const pending = (await git(wt.path, ['diff', '--cached', '--name-only'])).trim();
  if (pending) await git(wt.path, ['commit', '-q', '-m', `AgiCloud: ${title}`]);
  const ahead = (await git(wt.path, ['rev-list', '--count', `${wt.base}..HEAD`])).trim();
  if (ahead === '0') throw new HttpError(409, 'Nessuna modifica da unire');
  try {
    await git(wt.root, ['merge', '--no-ff', '-m', `Unisci il thread "${title}" (AgiCloud)`, wt.branch]);
  } catch (err) {
    // Conflitto o modifiche non salvate nel progetto: si torna com'era
    await git(wt.root, ['merge', '--abort']).catch(() => {});
    throw new HttpError(
      409,
      `Unione non riuscita: ${err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : err}. Il progetto non e' stato toccato.`,
    );
  }
  await removeWorktree(wt);
  wt.state = 'merged';
  return (await git(wt.root, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function discardWorktree(wt: WorktreeInfo): Promise<void> {
  if (wt.state !== 'open') return;
  await removeWorktree(wt);
  wt.state = 'discarded';
}

async function removeWorktree(wt: WorktreeInfo): Promise<void> {
  await git(wt.root, ['worktree', 'remove', '--force', wt.path]).catch(() => {});
  await git(wt.root, ['branch', '-D', wt.branch]).catch(() => {});
}
