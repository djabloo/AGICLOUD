// Invio email. Con BREVO_API_KEY spedisce con le email transazionali di Brevo; senza chiave il messaggio
// va su console e in data/outbox.log (sviluppo e prove).

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

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Il testo e' semplice: gli URL diventano link, il resto resta com'e' */
function toHtml(text: string): string {
  const body = escapeHtml(text)
    .split('\n')
    .map((line) => line.replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#2563eb;word-break:break-all">$1</a>'))
    .join('<br>');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;line-height:1.5">${body}<p style="color:#64748b;font-size:13px;margin-top:32px">AgiCloud — se non hai richiesto tu questa email, ignorala.</p></div>`;
}

export function brevoMailer(apiKey: string, from: { email: string; name: string }): Mailer {
  return {
    async send(to, subject, text) {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: from, to: [{ email: to }], subject, htmlContent: toHtml(text), textContent: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Brevo: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
  };
}
