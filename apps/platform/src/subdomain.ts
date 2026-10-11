// Sottodomini degli ambienti utente: <nome>.agicloud.dev

import { randomBytes } from 'node:crypto';

const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2', 'status', 'docs', 'blog', 'dashboard',
  'login', 'register', 'platform', 'orchestrator', 'support', 'help', 'root', 'localhost', 'cloud', 'agicloud', 'static', 'cdn',
]);

const FORMAT = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** Messaggio d'errore se il nome non si puo' usare, altrimenti null */
export function subdomainProblem(name: string): string | null {
  if (!FORMAT.test(name)) return 'Nome: da 3 a 30 caratteri, lettere minuscole, numeri e trattini (non all\'inizio o alla fine)';
  if (name.includes('--')) return 'Nome: niente doppi trattini';
  if (RESERVED.has(name) || name.startsWith('admin') || name.startsWith('xn-')) return 'Questo nome e\' riservato';
  return null;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomSubdomain(): string {
  const bytes = randomBytes(9);
  return 'ac-' + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
