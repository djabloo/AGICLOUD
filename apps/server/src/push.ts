// Notifiche push (Web Push): avvisano il telefono quando un agente ha finito o chiede un permesso.
// Chiavi VAPID generate al primo avvio in data/vapid.json (600); dispositivi iscritti in data/push.json.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { config } from './config.js';
import { HttpError } from './errors.js';

const VAPID_FILE = join(config.threadsDir, '..', 'vapid.json');
const SUBS_FILE = join(config.threadsDir, '..', 'push.json');
/** Identifica chi manda le notifiche al servizio push (Google, Apple, Mozilla) */
const SUBJECT = process.env.PUSH_SUBJECT || 'https://app.agicloud.dev';

interface StoredSub {
  subscription: PushSubscription;
  /** Descrizione del dispositivo (es. "Chrome su Android"), per riconoscerlo */
  device: string;
  createdAt: number;
}

export interface Notice {
  title: string;
  body: string;
  /** Dove portare l'utente al tocco (es. /#/t/<id>) */
  url: string;
  /** Notifiche con lo stesso tag si sostituiscono invece di accumularsi */
  tag?: string;
}

function writeSecret(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class Push {
  readonly publicKey: string;
  private subs: StoredSub[];

  constructor() {
    let keys: { publicKey: string; privateKey: string };
    if (existsSync(VAPID_FILE)) {
      keys = JSON.parse(readFileSync(VAPID_FILE, 'utf8'));
    } else {
      keys = webpush.generateVAPIDKeys();
      writeSecret(VAPID_FILE, keys);
    }
    webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
    try {
      this.subs = existsSync(SUBS_FILE) ? JSON.parse(readFileSync(SUBS_FILE, 'utf8')) : [];
    } catch {
      this.subs = [];
    }
  }

  devices() {
    return this.subs.map((s) => ({ endpoint: s.subscription.endpoint, device: s.device, createdAt: s.createdAt }));
  }

  subscribe(subscription: unknown, device: string): void {
    const sub = subscription as PushSubscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth || !/^https:\/\//.test(sub.endpoint)) {
      throw new HttpError(400, 'Iscrizione push non valida');
    }
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== sub.endpoint);
    this.subs.push({ subscription: sub, device: device.slice(0, 80) || 'dispositivo', createdAt: Date.now() });
    writeSecret(SUBS_FILE, this.subs);
  }

  unsubscribe(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== endpoint);
    writeSecret(SUBS_FILE, this.subs);
  }

  /** Invia a tutti i dispositivi; quelli non piu' validi (410/404) vengono tolti */
  async send(notice: Notice): Promise<number> {
    if (!this.subs.length) return 0;
    const payload = JSON.stringify(notice);
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      this.subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription, payload, { TTL: 60 * 60, urgency: 'high' });
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) gone.push(s.subscription.endpoint);
          else console.error('[push]', code ?? '', (err as Error).message);
        }
      }),
    );
    if (gone.length) {
      this.subs = this.subs.filter((s) => !gone.includes(s.subscription.endpoint));
      writeSecret(SUBS_FILE, this.subs);
    }
    return sent;
  }
}
