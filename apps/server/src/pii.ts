// Plugin PII: anonimizzazione di testi e documenti con il motore Rizzo-PII
// (https://github.com/Rizzo-AI-Academy/rizzo-pii), un container locale sul server (127.0.0.1:5005):
// i documenti non escono dalla macchina.
// - /api/pii/engine/*: passaggio verso il motore, solo gli endpoint in elenco (le impostazioni
//   globali del motore restano fuori: le opzioni viaggiano con ogni richiesta).
// - /api/pii/save: salva la versione anonimizzata nel progetto, in pii-clean/, per l'agente.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Hono } from 'hono';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';
import { excludeFromGit } from './uploads.js';
import type { PluginSpec } from './plugins.js';

const ENGINE = process.env.RIZZO_PII_URL || 'http://127.0.0.1:5005';
const TIMEOUT_MS = 10 * 60_000;
const MAX_BYTES = 30 * 1024 * 1024;

const ENGINE_ROUTES: { method: string; re: RegExp }[] = [
  { method: 'GET', re: /^health$/ },
  { method: 'GET', re: /^settings$/ },
  { method: 'POST', re: /^analyze$/ },
  { method: 'POST', re: /^pdf$/ },
  { method: 'POST', re: /^pdf\/preview$/ },
  { method: 'GET', re: /^doc\/[A-Za-z0-9_-]+\/page\/\d+\.png$/ },
  { method: 'GET', re: /^doc\/[A-Za-z0-9_-]+\/file\.pdf$/ },
];
const PASS_HEADERS = ['content-type', 'content-disposition', 'x-pii-redactions', 'x-pii-residual', 'x-pii-skipped', 'x-pii-notfound'];

async function health(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(4000) });
    const d = (await r.json().catch(() => ({}))) as { model?: string; model_loaded?: boolean; device?: string };
    if (!r.ok || d.model_loaded === false) return { ok: false, detail: 'motore acceso ma modello non caricato' };
    return { ok: true, detail: `${d.model ?? 'Rizzo-PII'} (${d.device ?? 'cpu'})` };
  } catch {
    return { ok: false, detail: `motore Rizzo-PII non raggiungibile su ${ENGINE}` };
  }
}

export const piiPlugin: PluginSpec = {
  id: 'pii',
  name: 'PII',
  version: '1.0.0',
  description:
    'Anonimizza testi e documenti prima di darli all\'agente: nomi, codici fiscali, IBAN, email, indirizzi e gli altri dati personali diventano segnaposto. PDF redatto davvero, dizionario reversibile solo nel tuo browser, salvataggio in pii-clean/ per l\'agente.',
  section: { id: 'pii', label: 'PII' },
  credits: { text: 'Motore Rizzo-PII di Rizzo AI Academy', url: 'https://github.com/Rizzo-AI-Academy/rizzo-pii' },
  requires: 'il motore Rizzo-PII in locale sul server (container rizzo-pii, porta 5005)',
  routes: ['/api/pii'],
  source: 'builtin',
  health,
  install: async () => {
    const h = await health();
    if (!h.ok) throw new Error(`${h.detail}. Avvia il container rizzo-pii e riprova`);
  },
};

export function registerPii(app: Hono<any>): void {
  app.all('/api/pii/engine/*', async (c) => {
    const sub = c.req.path.slice('/api/pii/engine/'.length);
    if (!ENGINE_ROUTES.some((r) => r.method === c.req.method && r.re.test(sub))) {
      throw new HttpError(400, 'Funzione del motore PII non consentita');
    }
    const headers: Record<string, string> = {};
    let body: ArrayBuffer | undefined;
    if (c.req.method === 'POST') {
      body = await c.req.arrayBuffer();
      if (body.byteLength > MAX_BYTES) throw new HttpError(400, 'File troppo grande (max 30 MB)');
      const ct = c.req.header('content-type');
      if (ct) headers['content-type'] = ct;
    }
    let up: Response;
    try {
      up = await fetch(`${ENGINE}/${sub}`, { method: c.req.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return c.json({ error: 'Motore PII non raggiungibile' }, 503);
    }
    for (const h of PASS_HEADERS) {
      const v = up.headers.get(h);
      if (v) c.header(h, v);
    }
    return c.body(await up.arrayBuffer(), up.status as 200);
  });

  /**
   * Salva per l'agente: testo -> rianalizzato qui (senza dizionario) e salvato come .txt;
   * PDF -> il file gia' redatto dal motore (doc_id dell'anteprima). Mai l'originale.
   */
  app.post('/api/pii/save', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const project = resolveProject(String(b.project ?? ''));
    const excl = Array.isArray(b.exclude_tags) ? b.exclude_tags.filter((t): t is string => typeof t === 'string') : [];
    let data: Buffer;
    let name: string;
    if (typeof b.doc_id === 'string' && /^[A-Za-z0-9_-]+$/.test(b.doc_id)) {
      const r = await fetch(`${ENGINE}/doc/${b.doc_id}/file.pdf`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
      if (!r?.ok) throw new HttpError(409, 'PDF anonimizzato non piu\' disponibile: rifai l\'anteprima');
      data = Buffer.from(await r.arrayBuffer());
      name = `${safeStem(String(b.name ?? 'documento'))}.anonimizzato.pdf`;
    } else if (typeof b.text === 'string' && b.text.trim()) {
      const r = await fetch(`${ENGINE}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: b.text, exclude_tags: excl, include_mapping: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => null);
      if (!r?.ok) throw new HttpError(409, 'Motore PII non raggiungibile');
      const j = (await r.json()) as { anonymized_text?: string };
      data = Buffer.from(j.anonymized_text ?? '', 'utf8');
      name = `${safeStem(String(b.name ?? `testo-${stamp()}`))}.anonimizzato.txt`;
    } else {
      throw new HttpError(400, 'Niente da salvare: serve un testo o un PDF analizzato');
    }
    const dir = join(project, 'pii-clean');
    mkdirSync(dir, { recursive: true });
    // I documenti (anche anonimizzati) non devono finire nei commit del progetto
    excludeFromGit(project, 'pii-clean/', 'documenti anonimizzati del plugin PII');
    writeFileSync(join(dir, name), data, { mode: 0o640 });
    return c.json({ path: `pii-clean/${name}`, abs: join(dir, name), size: data.length });
  });
}

function safeStem(name: string): string {
  return (
    basename(name)
      .replace(/\.[^.]+$/, '')
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'documento'
  );
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
}
