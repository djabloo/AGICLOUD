// Container degli utenti. Questo e' l'unico modulo che parla con Docker: la piattaforma non ha mai accesso al socket.
// Impostazioni di sicurezza riprese da AgyCloud (dockerRunnerService.js): niente capability, niente privilegi,
// limiti di CPU/memoria/processi, rete dedicata senza comunicazione tra container, porta solo su 127.0.0.1.

import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Exec = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

export const dockerExec: Exec = async (args, env) => (await run('docker', args, { env: env ?? process.env })).stdout.trim();

export interface Limits {
  cpus: string;
  memory: string;
  pids: number;
}

export interface RunnerConfig {
  image: string;
  /** Porta su cui l'app ascolta dentro il container */
  internalPort: number;
  network: string;
  dataRoot: string;
  /** File JSON {host: porta} letto dal proxy di bordo (apps/edge); vuoto = nessun file */
  routesFile?: string;
  /** Dominio principale degli ambienti */
  rootDomain?: string;
  /** Utente con cui gira l'app nel container */
  user: string;
}

export interface RunnerInfo {
  id: string;
  status: string;
  port: number | null;
}

/** Id: lettere minuscole, numeri e trattini; diventa nome di container e di cartella, quindi mai altro */
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export const containerName = (id: string) => `agicloud-u-${id}`;

export function buildRunArgs(cfg: RunnerConfig, id: string, limits: Limits, envNames: string[], subdomain = ''): string[] {
  const name = containerName(id);
  return [
    'run', '-d',
    '--name', name,
    '--label', 'app=agicloud-runner',
    '--label', `runner_id=${id}`,
    '--label', `subdomain=${subdomain}`,
    '--user', cfg.user,
    '--cpus', limits.cpus,
    '--memory', limits.memory,
    '--memory-swap', limits.memory,
    '--pids-limit', String(limits.pids),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--read-only',
    '--tmpfs', '/tmp:size=128m,mode=1777',
    '--network', cfg.network,
    '--restart', 'unless-stopped',
    '-p', `127.0.0.1::${cfg.internalPort}`,
    '-v', `${join(cfg.dataRoot, id)}:/data:rw`,
    '-e', 'DATA_DIR=/data',
    '-e', `PORT=${cfg.internalPort}`,
    '-e', 'HOST=0.0.0.0',
    // Dei segreti passa solo il nome: il valore arriva dall'ambiente del processo e non compare in `ps`
    ...envNames.flatMap((n) => ['-e', n]),
    cfg.image,
  ];
}

export class Runners {
  constructor(
    private readonly cfg: RunnerConfig,
    private readonly exec: Exec = dockerExec,
  ) {}

  async ensureNetwork(): Promise<void> {
    try {
      await this.exec(['network', 'inspect', this.cfg.network]);
    } catch {
      await this.exec(['network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.enable_icc=false', this.cfg.network]);
    }
  }

  async start(id: string, limits: Limits, envVars: Record<string, string> = {}, subdomain = ''): Promise<RunnerInfo> {
    if (!ID_RE.test(id)) throw new Error('Id non valido');
    if (subdomain && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(subdomain)) throw new Error('Sottodominio non valido');
    await this.ensureNetwork();
    const name = containerName(id);
    const existing = await this.info(id);
    if (existing) {
      if (existing.status !== 'running') await this.exec(['start', name]);
      await this.writeRoutes();
      return (await this.info(id))!;
    }
    mkdirSync(join(this.cfg.dataRoot, id), { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    const names: string[] = [];
    for (const [k, v] of Object.entries(envVars)) {
      if (!ENV_NAME_RE.test(k)) throw new Error(`Nome di variabile non valido: ${k}`);
      env[k] = String(v);
      names.push(k);
    }
    await this.exec(buildRunArgs(this.cfg, id, limits, names, subdomain), env);
    await this.writeRoutes();
    return (await this.info(id))!;
  }

  async info(id: string): Promise<RunnerInfo | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const out = await this.exec(['inspect', '--format', '{{.State.Status}}|{{json .NetworkSettings.Ports}}', containerName(id)]);
      const [status, ports] = out.split('|');
      const host = JSON.parse(ports || '{}')[`${this.cfg.internalPort}/tcp`]?.[0]?.HostPort;
      return { id, status, port: host ? Number(host) : null };
    } catch {
      return null;
    }
  }

  async stop(id: string): Promise<void> {
    if (ID_RE.test(id)) await this.exec(['stop', '-t', '5', containerName(id)]).catch(() => {});
    await this.writeRoutes();
  }

  /** Elimina il container; i dati restano nella cartella salvo purge */
  async remove(id: string, purge = false): Promise<void> {
    if (!ID_RE.test(id)) return;
    await this.exec(['rm', '-f', containerName(id)]).catch(() => {});
    if (purge) {
      const { rmSync } = await import('node:fs');
      rmSync(join(this.cfg.dataRoot, id), { recursive: true, force: true });
    }
    await this.writeRoutes();
  }

  /** Aggiorna host → porta per gli ambienti in esecuzione (scrittura atomica: il proxy non legge mai un file a meta') */
  async writeRoutes(): Promise<void> {
    if (!this.cfg.routesFile) return;
    const out = await this.exec(['ps', '--filter', 'label=app=agicloud-runner', '--filter', 'status=running', '--format', '{{.Label "runner_id"}}|{{.Label "subdomain"}}']);
    const routes: Record<string, number> = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const [id, sub] = line.split('|');
      const port = sub ? (await this.info(id))?.port : null;
      if (sub && port) routes[`${sub}.${this.cfg.rootDomain ?? 'agicloud.dev'}`] = port;
    }
    const tmp = `${this.cfg.routesFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(routes), { mode: 0o644 });
    renameSync(tmp, this.cfg.routesFile);
  }

  async list(): Promise<RunnerInfo[]> {
    const out = await this.exec(['ps', '-a', '--filter', 'label=app=agicloud-runner', '--format', '{{.Label "runner_id"}}']);
    const infos = await Promise.all(out.split('\n').filter(Boolean).map((id) => this.info(id)));
    return infos.filter((i): i is RunnerInfo => i !== null);
  }
}
