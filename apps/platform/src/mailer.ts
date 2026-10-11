// Invio email. Finche' non c'e' un fornitore (Resend, SMTP, ...) il messaggio va su console e in data/outbox.log.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function consoleMailer(outboxFile: string): Mailer {
  return {
    async send(to, subject, text) {
      mkdirSync(dirname(outboxFile), { recursive: true });
      appendFileSync(outboxFile, `--- ${new Date().toISOString()} a ${to}: ${subject}\n${text}\n`);
      console.log(`[email] a ${to}: ${subject}\n${text}`);
    },
  };
}
