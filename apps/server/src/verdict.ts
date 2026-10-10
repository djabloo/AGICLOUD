// Plugin Verdict: decisioni tipizzate (Si'/No, una tra, voto 1-5) con la probabilita' di ogni opzione.
// Un solo token di risposta (lettera A, B, C...) e le probabilita' dai logprobs del modello, su OpenRouter
// con la chiave del portachiavi (OPENROUTER_API_KEY). Costo: frazioni di centesimo per decisione.
//
// Modelli scelti con un banco di prova (36 domande con risposta nota, 2026-10-10): DeepSeek V4 Flash
// ha la taratura migliore (Brier 0,10); la coppia DeepSeek + Mistral Nemo, quando sbaglia, e' incerta
// (51-66%), quindi l'avviso "Incerto" scatta quando serve. Gemma 4 era precisa ma sicura al 100%
// anche sugli errori: scartata. Alcuni provider dichiarano i logprobs ma non li restituiscono:
// per questo c'e' una catena di ripiego e, in ultimo, il voto a campioni.
//
// Usi: sezione Verdict, POST /api/verdict/decide (anche dai workflow n8n, col token di AgiCloud),
// e lo strumento "verdetto" per gli agenti (server MCP verdict-mcp.ts, token proprio in memoria).

import { randomBytes } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { PluginSpec } from './plugins.js';
import type { Settings } from './settings.js';

const API = 'https://openrouter.ai/api/v1/chat/completions';
const KEY_NAME = 'OPENROUTER_API_KEY';
const LETTERS = 'ABCDEFGHIJKLMNOPQRST';
const TIMEOUT_MS = 20_000;
const MAX_TEXT = 40_000;

interface ModelSpec {
  id: string;
  label: string;
  extra?: Record<string, unknown>;
}

const DEEPSEEK: ModelSpec = { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', extra: { reasoning: { enabled: false } } };
const NEMO: ModelSpec = { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo' };
const LLAMA: ModelSpec = { id: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' };
/** Ordine di ripiego quando un modello non restituisce le probabilita' */
const CHAIN = [DEEPSEEK, NEMO, LLAMA];

export type VerdictType = 'yesno' | 'choice' | 'score';

export interface VerdictRequest {
  text: string;
  question: string;
  type: VerdictType;
  /** Solo per "choice" */
  options?: string[];
  /** "double" = due modelli, media e controllo del disaccordo */
  mode?: 'fast' | 'double';
  /** Una spiegazione breve della risposta (una chiamata in piu') */
  explain?: boolean;
}

export interface VerdictResult {
  answer: string;
  confidence: number;
  probabilities: { option: string; p: number }[];
  uncertain: boolean;
  /** Perche' e' incerto, in parole */
  note: string | null;
  method: 'logprobs' | 'campioni';
  models: string[];
  /** Voto atteso (solo per "score") */
  expected?: number;
  explanation?: string;
  ms: number;
  cost: number;
}

class NoLogprobs extends Error {}

function optionsFor(r: VerdictRequest): string[] {
  if (r.type === 'yesno') return ['Sì', 'No'];
  if (r.type === 'score') return ['1', '2', '3', '4', '5'];
  const opts = (r.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (opts.length < 2) throw new HttpError(400, 'Servono almeno due opzioni');
  if (opts.length > LETTERS.length) throw new HttpError(400, `Al massimo ${LETTERS.length} opzioni`);
  return opts;
}

function messages(r: VerdictRequest, opts: string[]) {
  const listing = opts.map((o, i) => `${LETTERS[i]}) ${o}`).join('\n');
  return [
    { role: 'system', content: 'Sei un classificatore. Rispondi con una sola lettera maiuscola, senza altro testo.' },
    { role: 'user', content: `Testo:\n"""\n${r.text}\n"""\n\nDomanda: ${r.question}\n\nOpzioni:\n${listing}\n\nRisposta (solo la lettera):` },
  ];
}

async function call(key: string, model: ModelSpec, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'AgiCloud Verdict' },
    body: JSON.stringify({ model: model.id, ...model.extra, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok || !data || data.error) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    // Chiave non valida o credito finito: inutile provare altri modelli
    if (res.status === 401 || res.status === 402) throw new HttpError(409, `OpenRouter: ${msg}`);
    throw new Error(msg);
  }
  return data;
}

/** Probabilita' delle opzioni da un solo token (logprobs) */
async function scoreOnce(key: string, model: ModelSpec, r: VerdictRequest, opts: string[]) {
  const data = await call(key, model, {
    messages: messages(r, opts),
    max_tokens: 1,
    temperature: 0,
    logprobs: true,
    top_logprobs: 20,
    provider: { require_parameters: true },
  });
  const top = data.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs as { token: string; logprob: number }[] | undefined;
  if (!top?.length) throw new NoLogprobs(`${model.label}: niente probabilita'`);
  const mass = new Array(opts.length).fill(0);
  for (const t of top) {
    const tok = String(t.token ?? '').trim().replace(/[).:\]]+$/, '').toUpperCase();
    const i = LETTERS.indexOf(tok);
    if (tok.length === 1 && i >= 0 && i < opts.length) mass[i] += Math.exp(t.logprob);
  }
  const coverage = mass.reduce((a, b) => a + b, 0);
  if (coverage === 0) throw new NoLogprobs(`${model.label}: risposta fuori dalle opzioni`);
  return { probs: mass.map((m) => m / coverage), coverage, cost: Number(data.usage?.cost ?? 0), model };
}

/** Primo modello della catena (a partire da `from`) che restituisce davvero le probabilita' */
async function scoreWithFallback(key: string, r: VerdictRequest, opts: string[], from = 0) {
  const errors: string[] = [];
  for (const m of CHAIN.slice(from)) {
    try {
      return await scoreOnce(key, m, r, opts);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new NoLogprobs(errors.join('; '));
}

/** Ripiego senza logprobs: 7 risposte a temperatura 1 e si contano i voti */
async function sample(key: string, r: VerdictRequest, opts: string[]) {
  const runs = await Promise.allSettled(
    Array.from({ length: 7 }, () => call(key, DEEPSEEK, { messages: messages(r, opts), max_tokens: 1, temperature: 1 })),
  );
  const votes = new Array(opts.length).fill(0);
  let cost = 0;
  for (const run of runs) {
    if (run.status !== 'fulfilled') continue;
    cost += Number(run.value.usage?.cost ?? 0);
    const i = LETTERS.indexOf(String(run.value.choices?.[0]?.message?.content ?? '').trim().charAt(0).toUpperCase());
    if (i >= 0 && i < opts.length) votes[i]++;
  }
  const total = votes.reduce((a, b) => a + b, 0);
  if (!total) throw new HttpError(409, 'Nessun modello ha risposto: riprova tra poco');
  return { probs: votes.map((v) => v / total), cost };
}

export async function decide(key: string, r: VerdictRequest): Promise<VerdictResult> {
  const t0 = Date.now();
  const text = String(r.text ?? '').slice(0, MAX_TEXT);
  const question = String(r.question ?? '').trim();
  if (!text.trim() || !question) throw new HttpError(400, 'Servono il testo e la domanda');
  const req: VerdictRequest = { ...r, text, question, type: r.type === 'choice' || r.type === 'score' ? r.type : 'yesno' };
  const opts = optionsFor(req);

  let probs: number[];
  let cost = 0;
  let method: VerdictResult['method'] = 'logprobs';
  const models: string[] = [];
  let note: string | null = null;
  let disagree = false;
  let lowCoverage = false;
  try {
    const first = await scoreWithFallback(key, req, opts);
    probs = first.probs;
    cost += first.cost;
    models.push(first.model.label);
    lowCoverage = first.coverage < 0.5;
    if (req.mode === 'double') {
      // Secondo parere da un modello diverso dal primo
      const second = await scoreWithFallback(key, req, opts, CHAIN.indexOf(first.model) + 1).catch(() => null);
      if (second) {
        const argmax = (p: number[]) => p.indexOf(Math.max(...p));
        disagree = argmax(first.probs) !== argmax(second.probs);
        probs = first.probs.map((p, i) => (p + second.probs[i]!) / 2);
        cost += second.cost;
        models.push(second.model.label);
      }
    }
  } catch (err) {
    if (!(err instanceof NoLogprobs)) throw err;
    const s = await sample(key, req, opts);
    probs = s.probs;
    cost += s.cost;
    method = 'campioni';
    models.push(`${DEEPSEEK.label} (7 campioni)`);
  }

  const ranked = probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p);
  const best = ranked[0]!;
  const margin = best.p - (ranked[1]?.p ?? 0);
  if (disagree) note = 'I due modelli non sono d\'accordo';
  else if (lowCoverage) note = 'Il modello voleva rispondere altro: la domanda o le opzioni forse non bastano';
  else if (best.p < 0.6 || margin < 0.2) note = 'Le opzioni sono vicine';
  const result: VerdictResult = {
    answer: opts[best.i]!,
    confidence: round(best.p),
    probabilities: opts.map((option, i) => ({ option, p: round(probs[i]!) })),
    uncertain: note !== null,
    note,
    method,
    models,
    ms: 0,
    cost,
  };
  if (req.type === 'score') result.expected = round(opts.reduce((s, o, i) => s + Number(o) * probs[i]!, 0), 2);
  if (req.explain) {
    try {
      const data = await call(key, DEEPSEEK, {
        messages: [
          { role: 'system', content: 'Rispondi in italiano, in una o due frasi brevi.' },
          { role: 'user', content: `Testo:\n"""\n${text}\n"""\n\nDomanda: ${question}\nRisposta scelta: ${result.answer}\n\nSpiega brevemente perche'.` },
        ],
        max_tokens: 150,
        temperature: 0,
      });
      result.explanation = String(data.choices?.[0]?.message?.content ?? '').trim();
      result.cost += Number(data.usage?.cost ?? 0);
    } catch {
      result.explanation = 'Spiegazione non disponibile.';
    }
  }
  result.ms = Date.now() - t0;
  return result;
}

function round(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function parseRequest(body: Record<string, unknown>): VerdictRequest {
  return {
    text: String(body.text ?? ''),
    question: String(body.question ?? ''),
    type: body.type as VerdictType,
    options: Array.isArray(body.options) ? body.options.map(String) : undefined,
    mode: body.mode === 'double' ? 'double' : 'fast',
    explain: body.explain === true,
  };
}

// ── Plugin, API e strumento per gli agenti ───────────────────────────────────

/** Token per lo strumento degli agenti: in memoria, cambia a ogni avvio del server */
const AGENT_TOKEN = randomBytes(24).toString('hex');
const MCP_SCRIPT = new URL('./verdict-mcp.ts', import.meta.url).pathname;
const TSX = import.meta.resolve('tsx');

export function verdictMcpServer(): acp.McpServer {
  return {
    name: 'verdict',
    command: process.execPath,
    args: ['--import', TSX, MCP_SCRIPT],
    env: [
      { name: 'AGICLOUD_VERDICT_URL', value: `http://127.0.0.1:${config.port}/verdict-api/decide` },
      { name: 'AGICLOUD_VERDICT_TOKEN', value: AGENT_TOKEN },
    ],
  };
}

export function verdictPlugin(settings: Settings): PluginSpec {
  const health = async () =>
    settings.vaultValue(KEY_NAME)
      ? { ok: true, detail: `chiave ${KEY_NAME} nel portachiavi` }
      : { ok: false, detail: `manca ${KEY_NAME} nel portachiavi (Impostazioni → Chiavi)` };
  return {
    id: 'verdict',
    name: 'Verdict',
    version: '2.0.0',
    description:
      'Fai una domanda su un testo e ottieni la risposta con quanto e\' sicura: Si\'/No, una tra piu\' opzioni o un voto da 1 a 5, con la probabilita\' di ogni opzione e un avviso quando e\' incerta. Pochi decimi di secondo, frazioni di centesimo. Si usa anche dai workflow n8n e dagli agenti.',
    section: { id: 'verdict', label: 'Verdict' },
    requires: `una chiave OpenRouter nel portachiavi (${KEY_NAME})`,
    routes: ['/api/verdict', '/verdict-api'],
    source: 'builtin',
    health,
    install: async () => {
      const h = await health();
      if (!h.ok) throw new Error(h.detail);
    },
  };
}

export function registerVerdict(app: Hono<any>, settings: Settings): void {
  const key = () => {
    const k = settings.vaultValue(KEY_NAME);
    if (!k) throw new HttpError(409, `Manca ${KEY_NAME} nel portachiavi (Impostazioni → Chiavi)`);
    return k;
  };

  // Dall'interfaccia e dai workflow (Authorization: Bearer <token di AgiCloud>)
  app.post('/api/verdict/decide', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(await decide(key(), parseRequest(body)));
  });

  // Dallo strumento degli agenti (token proprio, mai il token di AgiCloud)
  app.post('/verdict-api/decide', async (c) => {
    if (c.req.header('x-verdict-token') !== AGENT_TOKEN) return c.json({ error: 'Token non valido' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(await decide(key(), parseRequest(body)));
  });
}
