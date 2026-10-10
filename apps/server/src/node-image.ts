// Costruzione dell'immagine "agicloud-node": una VPS Ubuntu temporanea su cui si installa AgiCloud
// e gli agenti (node/install.sh), poi se ne fa lo snapshot e la VPS temporanea viene eliminata.
// Tutto via API Hetzner + SSH con una coppia di chiavi usa e getta (mai quella personale di questo utente).
//
// Il registro dei passi resta in memoria (si vede da Impostazioni → Cloud mentre costruisce);
// un solo lavoro per volta.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { HttpError } from './errors.js';
import type { Settings } from './settings.js';

const exec = promisify(execFile);
const API = 'https://api.hetzner.cloud/v1';
const KEY_NAME = 'HETZNER_API_TOKEN';
const BUILD_TYPE = process.env.CLOUD_BUILD_TYPE || 'cax11'; // ARM, economica: ~0,01€ per la mezz'ora di build
const BUILD_LOCATION = process.env.CLOUD_BUILD_LOCATION || 'nbg1';
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SSH_TIMEOUT_MS = 15 * 60_000;
// known_hosts dedicato alla singola build: Hetzner riassegna gli IP delle VPS eliminate, quindi
// il known_hosts normale (condiviso) puo' gia' avere l'impronta di un'altra macchina su quell'IP
// e "accept-new" rifiuta comunque quando l'impronta e' cambiata, non solo quando manca.
const sshOpts = (dir: string) => [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
  '-o', 'ConnectTimeout=10',
  '-o', 'BatchMode=yes',
];

type Json = Record<string, any>;

async function hz(token: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(`Hetzner: ${data.error?.message ?? `HTTP ${res.status}`}`);
  return data;
}

export interface BuildJob {
  id: string;
  state: 'running' | 'done' | 'error';
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** Snapshot creato, a lavoro riuscito */
  imageId?: number;
  error?: string;
}

export class NodeImageBuilder {
  private job: BuildJob | null = null;

  current(): BuildJob | null {
    return this.job;
  }

  start(settings: Settings): BuildJob {
    if (this.job?.state === 'running') throw new HttpError(409, 'C\'e\' gia\' una costruzione in corso');
    const token = settings.vaultValue(KEY_NAME);
    if (!token) throw new HttpError(409, `Manca ${KEY_NAME} nel portachiavi`);
    const job: BuildJob = { id: Date.now().toString(36), state: 'running', log: [], startedAt: Date.now() };
    this.job = job;
    const say = (line: string) => {
      job.log.push(line);
      if (job.log.length > 500) job.log.shift();
    };
    void this.run(token, say)
      .then((imageId) => {
        job.imageId = imageId;
        job.state = 'done';
        settings.setNodeImage(imageId);
        say(`Fatto: immagine ${imageId} pronta e impostata come immagine dei nodi.`);
      })
      .catch((err) => {
        job.state = 'error';
        job.error = err instanceof Error ? err.message : String(err);
        say(`Errore: ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return job;
  }

  private async run(token: string, say: (l: string) => void): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), 'agicloud-node-'));
    const name = `agicloud-build-${Date.now().toString(36)}`;
    let serverId: number | undefined;
    try {
      say('Preparo una chiave SSH usa e getta per la VPS temporanea…');
      await exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', join(dir, 'key'), '-C', 'agicloud-build'], { timeout: 15_000 });
      const pub = (await exec('cat', [join(dir, 'key.pub')])).stdout.trim();

      say('Preparo il pacchetto di AgiCloud (codice + interfaccia compilata)…');
      const tarball = join(dir, 'agicloud.tar.gz');
      await exec(
        'tar',
        [
          'czf',
          tarball,
          '-C',
          REPO_ROOT,
          '--exclude=node_modules',
          '--exclude=data',
          '--exclude=.git',
          '--exclude=apps/web/node_modules',
          'package.json',
          'package-lock.json',
          'apps/server/package.json',
          'apps/server/src',
          'apps/server/terminal.bashrc',
          'apps/web/package.json',
          'apps/web/dist',
          'packages',
          'node/firstboot.sh',
          'node/agicloud.service',
        ],
        { timeout: 60_000, cwd: REPO_ROOT },
      );

      say(`Creo la VPS temporanea (${BUILD_TYPE}, ${BUILD_LOCATION})…`);
      const created = await hz(token, 'POST', '/servers', {
        name,
        server_type: BUILD_TYPE,
        location: BUILD_LOCATION,
        image: 'ubuntu-24.04',
        labels: { agicloud: 'build' },
        // chpasswd.expire:false, altrimenti l'immagine Ubuntu di Hetzner forza il cambio password
        // al primo accesso e blocca i comandi SSH senza terminale ("Password change required")
        user_data: `#cloud-config\nssh_authorized_keys:\n  - ${pub}\nchpasswd:\n  expire: false\n`,
      });
      serverId = created.server.id;
      const ip: string = created.server.public_net.ipv4.ip;
      say(`VPS ${serverId} creata (${ip}). Aspetto che risponda…`);

      await this.waitSsh(dir, ip, say);

      say('Carico il pacchetto sulla VPS…');
      await this.scp(dir, tarball, `root@${ip}:/root/agicloud.tar.gz`);
      await this.scp(dir, join(REPO_ROOT, 'node/install.sh'), `root@${ip}:/root/install.sh`);

      say('Installo AgiCloud e gli agenti (qualche minuto)…');
      await this.ssh(dir, ip, 'bash /root/install.sh', say);

      say('Spengo la VPS per uno snapshot pulito…');
      await hz(token, 'POST', `/servers/${serverId}/actions/shutdown`);
      await this.waitOff(token, serverId!, say);

      const description = `agicloud-node ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      say(`Creo lo snapshot "${description}"…`);
      const snap = await hz(token, 'POST', `/servers/${serverId}/actions/create_image`, {
        type: 'snapshot',
        description,
        labels: { agicloud: 'node-image' },
      });
      await this.waitAction(token, snap.action.id, say);

      return snap.image.id as number;
    } finally {
      if (serverId) {
        say('Elimino la VPS temporanea (lo snapshot resta)…');
        await hz(token, 'DELETE', `/servers/${serverId}`).catch((err) => say(`Non sono riuscito a eliminare la VPS temporanea: ${err.message}. Falla a mano da Cloud.`));
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async waitSsh(dir: string, ip: string, say: (l: string) => void): Promise<void> {
    const key = join(dir, 'key');
    for (let i = 0; i < 40; i++) {
      try {
        await exec('ssh', [...sshOpts(dir), '-i', key, `root@${ip}`, 'true'], { timeout: 8000 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw new Error('La VPS temporanea non ha mai risposto via SSH');
  }

  private async scp(dir: string, from: string, to: string): Promise<void> {
    await exec('scp', [...sshOpts(dir), '-i', join(dir, 'key'), from, to], { timeout: 120_000 });
  }

  private async ssh(dir: string, ip: string, cmd: string, say: (l: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('ssh', [...sshOpts(dir), '-i', join(dir, 'key'), `root@${ip}`, cmd], { timeout: SSH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
      // Ultime righe di stdout+stderr: se install.sh fallisce, e' quasi sempre li' il motivo
      let tail = '';
      const keepTail = (d: Buffer) => {
        tail = (tail + d.toString()).slice(-4000);
      };
      child.stdout?.on('data', (d: Buffer) => {
        keepTail(d);
        const lines = d.toString().split('\n').filter((l) => l.trim());
        for (const l of lines) if (l.startsWith('==>')) say(l);
      });
      child.stderr?.on('data', keepTail);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`install.sh ha fallito (uscita ${code}):\n${tail.trim().split('\n').slice(-15).join('\n')}`)),
      );
      child.on('error', reject);
    });
  }

  private async waitOff(token: string, id: number, say: (l: string) => void): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const s = await hz(token, 'GET', `/servers/${id}`);
      if (s.server.status === 'off') return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('La VPS non si e\' spenta in tempo');
  }

  private async waitAction(token: string, actionId: number, say: (l: string) => void): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const a = (await hz(token, 'GET', `/actions/${actionId}`)).action;
      if (a.status === 'success') return;
      if (a.status === 'error') throw new Error(`Snapshot non riuscito: ${a.error?.message ?? '?'}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('Lo snapshot sta impiegando troppo tempo');
  }
}

export function registerNodeImageBuild(app: Hono<any>, settings: Settings, builder: NodeImageBuilder): void {
  app.post('/api/cloud/build', (c) => c.json(builder.start(settings)));
  app.get('/api/cloud/build', (c) => {
    const job = builder.current();
    if (!job) return c.json(null);
    return c.json(job);
  });
}
