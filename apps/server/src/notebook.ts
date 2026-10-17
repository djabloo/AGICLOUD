// Plugin Notebook: notebook di ricerca con il motore "agy" (Google Antigravity).
//
// Le "fonti" sono file dentro il workspace stesso (<workspace>/.agy-notebook/<id>/sources/),
// e domande/generazioni passano da agy in modalita' non interattiva ("print mode"), lo stesso
// meccanismo gia' usato dalla Chat strutturata: agy -p=<prompt> --output-format stream-json
// --dangerously-skip-permissions. Funziona identico in self-hosted e in SaaS: e' lo stesso agy
// gia' autenticato per l'utente, non serve nessun bridge o servizio esterno.
//
// Le fonti restano dentro il workspace: agy le legge con i suoi stessi strumenti. Per lo Studio,
// invece di fidarsi di un output strutturato in stdout, si chiede ad agy di SCRIVERE il risultato
// in un file preciso — e poi lo si rilegge: piu' robusto che fare il parse di JSON da un LLM.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { resolveProject } from './projects.js';
import { AGY_BIN, type Settings } from './settings.js';
import { excludeFromGit, readAttachment, resolveAttachment } from './uploads.js';
import type { PluginSpec } from './plugins.js';

const NOTEBOOK_DIRNAME = '.agy-notebook';
const AGY_TIMEOUT_MS = parseInt(process.env.NOTEBOOK_AGY_TIMEOUT_MS || '600000', 10); // 10 min
const PYTHON_TIMEOUT_MS = 600_000;
const NOTEBOOK_SCRIPTS = new URL('./notebook-scripts/', import.meta.url).pathname;
const TTS_EXTRA_PATHS = [join(homedir(), '.local', 'bin'), '/opt/video-tools/bin'];

const ELEVEN_MODELS = ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_v3'];
const VOICE_ID_RE = /^[a-zA-Z0-9]{10,40}$/;

// ── percorso del progetto: sempre dal client (che lo legge dai progetti), mai da
// una env var — il progetto "attivo" cambia, il plugin no.
function projectOf(raw: unknown): string {
  const p = typeof raw === 'string' && raw.trim() ? raw.trim() : config.projectRoots[0];
  if (!p) throw new HttpError(400, 'Ambiente/workspace non valido o non specificato');
  return resolveProject(p);
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || '')) throw new HttpError(400, 'Id notebook non valido');
  return id;
}

function notebookDir(project: string, id: string): string {
  return join(project, NOTEBOOK_DIRNAME, id);
}

function safeFileName(name: unknown, fallback = 'file'): string {
  const base = basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
  return base || fallback;
}

function tsStamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// ── ambiente: gli script python trovano edge_tts e ffmpeg/ffprobe; agy trova i
// suoi binari. Stessa logica del plugin originale, con AGY_BIN di AgiCloud.
function ttsPath(): string {
  return [...TTS_EXTRA_PATHS, process.env.PATH || ''].filter(Boolean).join(delimiter);
}

function pythonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: ttsPath(), ...extra };
}

function agyEnv(): NodeJS.ProcessEnv {
  const p = [join(homedir(), '.local', 'bin'), join(homedir(), '.gemini', 'antigravity-cli', 'bin'), process.env.PATH || '']
    .filter(Boolean)
    .join(delimiter);
  return { ...process.env, PATH: p, NO_COLOR: '1', TERM: 'dumb' };
}

/** Esegue un comando breve; risolve con stdout o lancia */
function execFileAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 8000): Promise<string> {
  return new Promise((resolveP, reject) => {
    execFile(cmd, args, { env, timeout }, (err, stdout) => {
      if (err) return reject(err);
      resolveP(String(stdout || ''));
    });
  });
}

// ── invocazione non interattiva di agy ───────────────────────────────────────
interface AgyResult {
  response?: string;
  conversationId?: string | null;
  error?: string;
}

function runAgy(prompt: string, { cwd, conversationId }: { cwd: string; conversationId?: string | null }): Promise<AgyResult> {
  return new Promise((resolveP) => {
    const args = ['-p=' + prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (conversationId) args.push('--conversation', conversationId);

    let child: ChildProcess;
    try {
      child = spawn(AGY_BIN, args, { cwd, env: agyEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolveP({ error: `Impossibile avviare ${AGY_BIN}: ${err instanceof Error ? err.message : String(err)}` });
    }

    let response = '';
    let newConversationId: string | null = conversationId || null;
    let status: string | null = null;
    let stderrBuf = '';
    let gotResult = false;

    const timer = setTimeout(() => {
      stderrBuf += `\nTimeout dopo ${Math.round(AGY_TIMEOUT_MS / 1000)}s.`;
      try { child.kill('SIGTERM'); } catch { /* gia' morto */ }
    }, AGY_TIMEOUT_MS);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev: Record<string, any>;
      try { ev = JSON.parse(line); } catch { return; }

      if (ev.event === 'init' && ev.conversation_id) {
        newConversationId = ev.conversation_id;
      } else if (ev.event === 'step_update' && ev.step_update && ev.step_update.step_type === 'agent_response') {
        if (ev.step_update.text_delta) response += ev.step_update.text_delta;
      } else if (ev.event === 'result' && ev.result) {
        gotResult = true;
        if (ev.result.conversation_id) newConversationId = ev.result.conversation_id;
        if (!response.trim() && ev.result.response) response = ev.result.response;
        if (ev.result.status && ev.result.status !== 'SUCCESS') status = ev.result.status;
      }
    });

    child.stderr!.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!gotResult && !response.trim()) {
        return resolveP({ error: (stderrBuf.trim() || `agy terminato con codice ${code}`).split('\n').slice(0, 6).join(' ') });
      }
      if (status) return resolveP({ error: 'Stato: ' + status, response, conversationId: newConversationId });
      resolveP({ response: response.trim(), conversationId: newConversationId });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ error: err.message });
    });
  });
}

function runPython(scriptPath: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = PYTHON_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn('python3', [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout durante la generazione audio (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolveP({ stdout, stderr });
      if (code === 2 && stderr.trim()) return reject(new Error(stderr.trim().split('\n').pop()));
      reject(new Error(stderr || stdout || `Processo python terminato con codice ${code}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── impostazioni voci (Edge gratuito / ElevenLabs con la chiave dell'utente) ──
// Fuori dal workspace: il workspace puo' finire in git o essere condiviso, la chiave no.
// In AgiCloud il file sta accanto a settings.json (threads/..) con permessi 0600.
const SETTINGS_PATH = join(config.threadsDir, '..', 'notebook-settings.json');

interface NotebookEleven {
  apiKey: string;
  model: string;
  voiceA: string;
  voiceB: string;
  voiceAName: string;
  voiceBName: string;
}
interface NotebookSettingsFile {
  provider: 'edge' | 'elevenlabs' | null;
  elevenlabs: NotebookEleven;
}

function readSettings(): NotebookSettingsFile {
  let s: Record<string, any> = {};
  try { s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); } catch { /* prima volta */ }
  const el = s.elevenlabs || {};
  return {
    provider: s.provider === 'elevenlabs' || s.provider === 'edge' ? s.provider : null,
    elevenlabs: {
      apiKey: typeof el.apiKey === 'string' ? el.apiKey : '',
      model: ELEVEN_MODELS.includes(el.model) ? el.model : 'eleven_multilingual_v2',
      voiceA: typeof el.voiceA === 'string' ? el.voiceA : '',
      voiceB: typeof el.voiceB === 'string' ? el.voiceB : '',
      voiceAName: typeof el.voiceAName === 'string' ? el.voiceAName : '',
      voiceBName: typeof el.voiceBName === 'string' ? el.voiceBName : '',
    },
  };
}

async function writeSettings(s: NotebookSettingsFile): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(SETTINGS_PATH, 0o600).catch(() => { /* permessi best-effort */ });
}

// Chiave effettiva: quella salvata dall'utente, altrimenti il Portachiavi di AgiCloud
// (ELEVENLABS_API_KEY), altrimenti l'ambiente del processo.
function elevenKey(s: NotebookSettingsFile, vault: Settings): { key: string; source: 'settings' | 'vault' | 'env' | null } {
  if (s.elevenlabs.apiKey) return { key: s.elevenlabs.apiKey, source: 'settings' };
  const fromVault = vault.vaultValue('ELEVENLABS_API_KEY');
  if (fromVault) return { key: fromVault, source: 'vault' };
  if (process.env.ELEVENLABS_API_KEY) return { key: process.env.ELEVENLABS_API_KEY, source: 'env' };
  return { key: '', source: null };
}

function effectiveProvider(s: NotebookSettingsFile, vault: Settings): 'edge' | 'elevenlabs' {
  if (s.provider) return s.provider;
  return elevenKey(s, vault).key ? 'elevenlabs' : 'edge';
}

function publicSettings(s: NotebookSettingsFile, vault: Settings) {
  const { key, source } = elevenKey(s, vault);
  return {
    provider: effectiveProvider(s, vault),
    providerChosen: !!s.provider,
    elevenlabs: {
      hasKey: !!key,
      keySource: source,
      keyHint: key ? '…' + key.slice(-4) : '',
      model: s.elevenlabs.model,
      models: ELEVEN_MODELS,
      voiceA: s.elevenlabs.voiceA,
      voiceB: s.elevenlabs.voiceB,
      voiceAName: s.elevenlabs.voiceAName,
      voiceBName: s.elevenlabs.voiceBName,
    },
  };
}

async function elevenFetch(key: string, apiPath: string): Promise<any> {
  const r = await fetch('https://api.elevenlabs.io' + apiPath, {
    headers: { 'xi-api-key': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) {
    const d = data && data.detail;
    const msg = (d && (d.message || (typeof d === 'string' ? d : ''))) || 'HTTP ' + r.status;
    const code = d && typeof d === 'object' ? d.status : '';
    const err = new HttpError(
      r.status === 502 ? 502 : 400,
      code === 'missing_permissions'
        ? 'La chiave ElevenLabs non ha il permesso per questa operazione (' + msg + ')'
        : r.status === 401 ? 'Chiave ElevenLabs non valida' : 'ElevenLabs: ' + msg,
    );
    (err as any).code = code;
    throw err;
  }
  return data;
}

// Ambiente del processo python per la sintesi: provider scelto + chiave/voci.
function ttsEnv(vault: Settings, requested?: unknown): NodeJS.ProcessEnv {
  const s = readSettings();
  const provider = requested === 'elevenlabs' || requested === 'edge' ? requested : effectiveProvider(s, vault);
  const env = pythonEnv({ NOTEBOOK_TTS_PROVIDER: provider });
  if (provider === 'elevenlabs') {
    const { key } = elevenKey(s, vault);
    if (!key) throw new HttpError(400, 'Per le voci ElevenLabs inserisci prima la tua chiave in Studio → Voci.');
    env.ELEVENLABS_API_KEY = key;
    env.ELEVENLABS_MODEL = s.elevenlabs.model;
    if (s.elevenlabs.voiceA) env.ELEVENLABS_VOICE_A = s.elevenlabs.voiceA;
    if (s.elevenlabs.voiceB) env.ELEVENLABS_VOICE_B = s.elevenlabs.voiceB;
  }
  return env;
}

// ── estrazione testo da URL ──────────────────────────────────────────────────
// YouTube: pagine SPA lato-client, il fetch+strip-tag recupera solo il guscio.
// Si delega ad agy (navigazione web reale) il compito di aprire il video e riassumerlo.
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/i;

async function fetchYoutubeAsText(url: string, project: string): Promise<{ title: string; text: string }> {
  const prompt =
    `Usa le tue capacità di navigazione web per aprire questo video YouTube: ${url}\n` +
    `Scrivi in italiano, in questo ordine: il titolo del video, il canale, poi un riassunto dettagliato ` +
    `del contenuto (usa la trascrizione/i sottotitoli se riesci a recuperarli, altrimenti la descrizione ` +
    `e le informazioni disponibili sulla pagina). Rispondi SOLO con questo testo, senza premesse, ` +
    `commenti aggiuntivi o markdown decorativo.`;
  const result = await runAgy(prompt, { cwd: project });
  if (result.error) throw new HttpError(502, result.error);
  const text = (result.response || '').trim();
  if (!text) throw new HttpError(502, 'agy non è riuscito a recuperare il contenuto del video');
  const title = text.split('\n')[0].replace(/^#+\s*/, '').replace(/^titolo:\s*/i, '').trim().slice(0, 90) || 'Video YouTube';
  return { title, text: `Fonte (video YouTube): ${url}\n\n${text}` };
}

async function fetchUrlAsText(url: string, project: string): Promise<{ title: string; text: string }> {
  if (YOUTUBE_RE.test(url)) return fetchYoutubeAsText(url, project);

  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new HttpError(502, `HTTP ${res.status} su ${url}`);
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return { title, text: `Fonte: ${url}\n\n${text}` };
}

// ── template Studio: si chiede ad agy di SCRIVERE il file, non di rispondere in chat ──
interface StudioType {
  ext: 'html' | 'md';
  json?: boolean;
  jsonKey?: string;
  script?: string;
  prompt: (srcRel: string, outRel: string) => string;
}

const STUDIO_TYPES: Record<string, StudioType> = {
  audio_overview: {
    ext: 'html',
    json: true,
    jsonKey: 'dialogue',
    script: 'generate_audio_overview.py',
    prompt: (srcRel, jsonAbs) => `Leggi attentamente tutti i file dentro "${srcRel}". Genera un copione per un episodio podcast "Audio Overview" a 2 voci (Diego ed Elsa) in italiano, brillante, approfondito e colloquiale, che discuta i punti chiave, i concetti e le implicazioni emersi ESCLUSIVAMENTE da quelle fonti.
Scrivi ESATTAMENTE e SOLO un file JSON valido nel percorso assoluto "${jsonAbs}" con questa identica struttura:
{
  "title": "Titolo accattivante dell'episodio",
  "subtitle": "Breve sintesi dei temi trattati",
  "takeaways": [
    "Punto chiave 1 estratto dai documenti",
    "Punto chiave 2 estratto dai documenti",
    "Punto chiave 3 estratto dai documenti",
    "Punto chiave 4 estratto dai documenti"
  ],
  "dialogue": [
    {"speaker": "Diego", "text": "Benvenuti a questo episodio! Oggi analizziamo..."},
    {"speaker": "Elsa", "text": "Ciao Diego! Esatto, i documenti evidenziano..."},
    {"speaker": "Diego", "text": "..."},
    {"speaker": "Elsa", "text": "..."}
  ]
}
Il dialogo deve essere un confronto fluido, intelligente ed esaustivo, con 10-14 battute alternate tra Diego ed Elsa (in italiano naturale e chiaro).
Salva il JSON ESATTAMENTE nel file "${jsonAbs}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  report: {
    ext: 'md',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro la cartella "${srcRel}" (ignora eventuali sottocartelle non pertinenti). Scrivi un report professionale in italiano, formato Markdown, che riassuma i temi principali, i punti chiave e le conclusioni rilevabili SOLO da quei file (non aggiungere conoscenza esterna). Usa titoli, sezioni e un elenco puntato dove utile. Salva il risultato ESATTAMENTE nel file "${outRel}" (sovrascrivilo se esiste già). Non modificare nessun altro file. Al termine rispondi solo "Fatto."`,
  },
  infographic: {
    ext: 'html',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro "${srcRel}". Genera un'infografica esecutiva, visiva e professionale basata ESCLUSIVAMENTE su quel contenuto.
Il formato deve essere un singolo file HTML5 completo e autonomo, con CSS moderno incorporato in un tag <style> (nessuna dipendenza esterna obbligatoria) e layout responsive.
L'infografica deve includere:
1. Header accattivante con Titolo, Sottotitolo e badge tematico.
2. Griglia di 3-4 KPI o metriche chiave in evidenza (valori grandi, percentuali o numeri rilevanti estratti dalle fonti).
3. Sezione concettuale a card o comparativa (es. Problema vs Soluzione, oppure i Pilastri Chiave con icone SVG inline).
4. Pipeline o Flusso a step (sequenza logica/operativa a blocchi con frecce o numerazione).
5. Sezione "Takeaways / Sintesi Strategica" (card riassuntive).
6. Stile CSS curato: palette scura elegante o neutra pulita, tipografia leggibile, card con bordi sottili e contrasti marcati, e regole @media print per una stampa/salvataggio PDF perfetta.
Salva il file ESATTAMENTE in "${outRel}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  presentation: {
    ext: 'html',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro "${srcRel}". Genera una presentazione professionale di diapositive (slide deck di 7-10 slide) basata ESCLUSIVAMENTE su quel contenuto.
Il formato deve essere un singolo file HTML5 completo e autonomo, con CSS e JavaScript vanilla incorporati (nessuna dipendenza esterna obbligatoria).
La presentazione deve includere:
1. Struttura delle slide:
   - Slide 1: Copertina con Titolo, Sottotitolo e contesto.
   - Slide 2: Agenda dei temi principali.
   - Slide 3-7: Slide di contenuto tematiche (es. Il Problema, La Soluzione, Dati & Metriche con card numeriche, Architettura/Processo a step, Casi studio).
   - Slide 8: Conclusioni e Key Takeaways strategici.
   - Slide 9: Slide di chiusura / Q&A.
2. Controlli e navigazione slide:
   - Navigazione con frecce da tastiera (Freccia destra/spazio = avanti, freccia sinistra = indietro).
   - Pulsanti visivi a schermo "← Precedente" e "Successiva →", contatore slide (es. "Slide 3 / 9") e barra di avanzamento.
   - Tasto "F" per attivare o disattivare la modalità schermo intero (fullscreen).
3. Stile visivo:
   - Formato 16:9 con centratura fluida, tema scuro moderno ed elegante (#0D1219, contrasti elevati, accenti ciano/ambra/viola), card ben spaziate.
   - Regole @media print per stampare o salvare tutte le slide in un unico PDF (una slide per pagina, page-break-after: always; break-after: page).
Salva il file ESATTAMENTE in "${outRel}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  video_presentation: {
    ext: 'html',
    json: true,
    jsonKey: 'slides',
    script: 'generate_video_presentation.py',
    prompt: (srcRel, jsonAbs) => `Leggi attentamente tutti i file dentro "${srcRel}". Prepara un video narrato di 7-9 slide in italiano che spieghi in modo chiaro e coinvolgente i contenuti di quelle fonti, ESCLUSIVAMENTE sulla base di esse.
Per ogni slide scrivi il testo visibile (breve, da slide) e il parlato del narratore (frasi naturali da ascoltare, 50-90 parole, che spiegano e collegano i punti invece di leggerli; niente elenchi, niente markdown, niente emoji, numeri scritti in modo pronunciabile).
Scrivi ESATTAMENTE e SOLO un file JSON valido nel percorso assoluto "${jsonAbs}" con questa struttura:
{
  "title": "Titolo del video",
  "subtitle": "Sottotitolo breve",
  "slides": [
    {"layout": "cover", "title": "...", "subtitle": "...", "narration": "..."},
    {"layout": "bullets", "title": "...", "bullets": ["max 5 punti brevi"], "narration": "..."},
    {"layout": "kpis", "title": "...", "kpis": [{"value": "42%", "label": "cosa misura"}], "narration": "..."},
    {"layout": "steps", "title": "...", "steps": ["passo 1", "passo 2", "passo 3"], "narration": "..."},
    {"layout": "quote", "title": "...", "quote": "frase chiave dalle fonti", "narration": "..."},
    {"layout": "closing", "title": "In sintesi", "bullets": ["..."], "narration": "..."}
  ]
}
Layout disponibili: cover (solo la prima), bullets, kpis (2-4 valori numerici REALI presi dalle fonti; se non ci sono numeri non usarlo), steps (3-5 passi), quote, closing (solo l'ultima). Varia i layout in base al contenuto.
Salva il JSON ESATTAMENTE nel file "${jsonAbs}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  quiz: {
    ext: 'md',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro "${srcRel}". Genera un quiz di 8 domande a risposta multipla (4 opzioni ciascuna, una sola corretta) basato ESCLUSIVAMENTE sul contenuto di quei file. Formato Markdown: per ogni domanda numerata, le 4 opzioni come elenco puntato (a, b, c, d), poi una riga "**Risposta corretta:** lettera" e una breve spiegazione. Scrivi il risultato ESATTAMENTE nel file "${outRel}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  flashcards: {
    ext: 'md',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro "${srcRel}". Genera 12 flashcard (domanda/risposta breve) sui concetti chiave, basate ESCLUSIVAMENTE su quel contenuto. Formato Markdown: per ognuna, "**Fronte:** ..." seguito da "**Retro:** ...", separate da una riga vuota. Scrivi il risultato ESATTAMENTE nel file "${outRel}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  mindmap: {
    ext: 'md',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro "${srcRel}". Costruisci una mappa mentale dei concetti principali e delle loro relazioni, basata ESCLUSIVAMENTE su quel contenuto, in sintassi Mermaid "mindmap" (radice = argomento centrale, rami = temi, foglie = dettagli; usa indentazione a 2 spazi come richiede Mermaid). Scrivi ESATTAMENTE questo, niente altro testo, nel file "${outRel}" (sovrascrivilo se esiste):\n\`\`\`mermaid\nmindmap\n  root((Argomento))\n    ...\n\`\`\`\nNon modificare altri file. Al termine rispondi solo "Fatto."`,
  },
  datatable: {
    ext: 'md',
    prompt: (srcRel, outRel) => `Leggi tutti i file dentro "${srcRel}". Organizza le informazioni chiave (fatti, dati, cifre, nomi, date — qualunque cosa sia strutturabile) in una tabella Markdown con colonne sensate basate ESCLUSIVAMENTE su quel contenuto. Se non ci sono dati chiaramente tabellari, estrai comunque i concetti principali in righe con colonne "Argomento" e "Dettaglio". Scrivi il risultato ESATTAMENTE nel file "${outRel}" (sovrascrivilo se esiste). Non modificare altri file. Al termine rispondi solo "Fatto."`,
  },
};

// ── Plugin spec ──────────────────────────────────────────────────────────────
async function health(): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await execFileAsync(AGY_BIN, ['--version'], agyEnv(), 5000);
    const ver = out.trim().split('\n')[0] || '';
    return { ok: true, detail: 'motore agy attivo (' + ver + ')' };
  } catch {
    return { ok: false, detail: 'agy non trovato in ' + AGY_BIN };
  }
}

export function notebookPlugin(_settings: Settings): PluginSpec {
  return {
    id: 'notebook',
    name: 'Notebook',
    version: '1.3.0',
    description:
      'Notebook di ricerca: raccogli fonti (testo, pagine web, YouTube, file), fai domande vincolate alle fonti e genera Overview Audio, Video narrato, Presentazione, Report, Infografica, Quiz, Flashcard, Mappa mentale e Tabella dati con voci Edge ed ElevenLabs. Motore: agy con il tuo account Google.',
    section: { id: 'notebook', label: 'Notebook' },
    requires: 'agy (Antigravity) collegato con il tuo account Google, Python 3 con edge-tts e ffmpeg per audio/video',
    routes: ['/api/notebook'],
    source: 'builtin',
    health,
    install: async () => {
      const h = await health();
      if (!h.ok) throw new Error(`${h.detail}. Collega agy con il tuo account Google e riprova`);
      try {
        await execFileAsync('ffmpeg', ['-version'], pythonEnv(), 5000);
      } catch {
        throw new Error('ffmpeg non trovato sul server: serve per Overview Audio e Video narrato');
      }
    },
  };
}

// ── Route ────────────────────────────────────────────────────────────────────
export function registerNotebook(app: Hono<any>, settings: Settings): void {
  const base = '/api/notebook';

  app.get(`${base}/health`, async (c) => {
    const h = await health();
    const m = h.detail.match(/\(([^)]*)\)/);
    return c.json({ available: h.ok, detail: h.detail, version: h.ok && m ? m[1] : null });
  });

  // GET /settings — impostazioni voci (la chiave non esce mai: solo le ultime 4 cifre)
  app.get(`${base}/settings`, (c) => c.json(publicSettings(readSettings(), settings)));

  // POST /settings — provider?, elevenlabsKey?, model?, voiceA?, voiceB?, voiceAName?, voiceBName?
  // elevenlabsKey: stringa nuova = salva (dopo verifica), "" = rimuovi, assente = invariata.
  app.post(`${base}/settings`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const s = readSettings();
    if (body.provider === 'edge' || body.provider === 'elevenlabs') s.provider = body.provider;
    if (typeof body.elevenlabsKey === 'string') {
      const k = body.elevenlabsKey.trim();
      if (k) {
        if (!/^[A-Za-z0-9_-]{20,128}$/.test(k)) throw new HttpError(400, 'Formato chiave ElevenLabs non valido');
        // Verifica subito: una chiave con permessi ristretti (solo sintesi) e' valida lo stesso.
        try { await elevenFetch(k, '/v1/voices'); } catch (e) {
          if ((e as any).code !== 'missing_permissions') throw e;
        }
      }
      s.elevenlabs.apiKey = k;
    }
    if (typeof body.model === 'string' && ELEVEN_MODELS.includes(body.model)) s.elevenlabs.model = body.model;
    for (const slot of ['voiceA', 'voiceB'] as const) {
      if (typeof body[slot] === 'string') {
        const v = (body[slot] as string).trim();
        if (v && !VOICE_ID_RE.test(v)) throw new HttpError(400, 'Id voce non valido');
        s.elevenlabs[slot] = v;
        const nameKey = slot + 'Name' as 'voiceAName' | 'voiceBName';
        s.elevenlabs[nameKey] = v ? String(body[nameKey] || '').slice(0, 80) : '';
      }
    }
    if (s.provider === 'elevenlabs' && !elevenKey(s, settings).key) {
      throw new HttpError(400, 'Inserisci la chiave ElevenLabs prima di sceglierlo come motore');
    }
    await writeSettings(s);
    return c.json(publicSettings(s, settings));
  });

  // GET /elevenlabs/voices — libreria voci dell'account + caratteri residui del mese
  app.get(`${base}/elevenlabs/voices`, async (c) => {
    const { key } = elevenKey(readSettings(), settings);
    if (!key) throw new HttpError(400, 'Chiave ElevenLabs non impostata');
    try {
      const data = await elevenFetch(key, '/v1/voices');
      const voices = (data.voices || [])
        .map((v: any) => ({ id: v.voice_id, name: v.name, category: v.category || '', labels: v.labels || {}, preview: v.preview_url || '' }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      let quota: { used: number; limit: number; tier: string; resetAt: number } | null = null;
      // Serve il permesso user_read: se manca, niente contatore.
      try {
        const sub = await elevenFetch(key, '/v1/user/subscription');
        quota = { used: sub.character_count, limit: sub.character_limit, tier: sub.tier, resetAt: sub.next_character_count_reset_unix };
      } catch { /* facoltativo */ }
      return c.json({ voices, quota });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  const baseDir = (project: string) => join(project, NOTEBOOK_DIRNAME);

  async function ensureBase(project: string): Promise<string> {
    const dir = baseDir(project);
    await mkdir(dir, { recursive: true });
    excludeFromGit(project, NOTEBOOK_DIRNAME + '/', 'notebook di ricerca del plugin Notebook');
    return dir;
  }

  // GET /notebooks
  app.get(`${base}/notebooks`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const dir = await ensureBase(project);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const list: any[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        list.push(JSON.parse(await readFile(join(dir, e.name, 'meta.json'), 'utf8')));
      } catch { /* cartella orfana senza meta.json: ignorata */ }
    }
    list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return c.json(list);
  });

  // POST /notebooks { title }
  app.post(`${base}/notebooks`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { wspath?: string; title?: string };
    const project = projectOf(body.wspath);
    await ensureBase(project);
    const title = (body.title || '').trim();
    if (!title) throw new HttpError(400, 'Titolo obbligatorio');
    const id = randomBytes(6).toString('hex');
    const dir = notebookDir(project, id);
    await mkdir(join(dir, 'sources'), { recursive: true });
    await mkdir(join(dir, 'studio'), { recursive: true });
    const meta = { id, title, createdAt: new Date().toISOString(), conversationId: null };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return c.json(meta);
  });

  // GET /notebooks/:id/chat
  app.get(`${base}/notebooks/:id/chat`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const dir = notebookDir(project, safeId(c.req.param('id')));
    const chatPath = join(dir, 'chat.json');
    const log = existsSync(chatPath) ? JSON.parse(await readFile(chatPath, 'utf8')) : [];
    return c.json(log);
  });

  // /notebooks/:id/... (delete, sources, query, studio)
  const ensureNotebook = async (project: string, id: string) => {
    const dir = notebookDir(project, safeId(id));
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) throw new HttpError(404, 'Notebook non trovato');
    return { dir, metaPath };
  };

  app.use(`${base}/notebooks/:id/*`, async (c, next) => {
    const id = c.req.param('id');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || '')) throw new HttpError(400, 'Id notebook non valido');
    await next();
  });

  // DELETE /notebooks/:id
  app.delete(`${base}/notebooks/:id`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    await rm(dir, { recursive: true, force: true });
    return c.json({ success: true });
  });

  // GET /notebooks/:id/sources
  app.get(`${base}/notebooks/:id/sources`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const sourcesDir = join(dir, 'sources');
    const entries = await readdir(sourcesDir, { withFileTypes: true }).catch(() => []);
    const list = await Promise.all(
      entries.filter((e) => e.isFile()).map(async (e) => {
        const st = await stat(join(sourcesDir, e.name));
        return { name: e.name, size: st.size, mtime: st.mtimeMs };
      }),
    );
    list.sort((a, b) => a.mtime - b.mtime);
    return c.json(list);
  });

  // POST /notebooks/:id/sources { wspath, url } | { wspath, text, title } | { wspath, fileName, fileData } | { wspath, piiFile }
  app.post(`${base}/notebooks/:id/sources`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const project = projectOf(body.wspath);
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const sourcesDir = join(dir, 'sources');
    try {
      if (typeof body.url === 'string' && body.url) {
        const { title, text } = await fetchUrlAsText(body.url, project);
        const name = safeFileName(title, 'pagina-web') + '-' + randomBytes(3).toString('hex') + '.txt';
        await writeFile(join(sourcesDir, name), text, 'utf8');
        return c.json({ name });
      }
      if (typeof body.text === 'string' && body.text) {
        const name = safeFileName(body.title || 'nota', 'nota') + '-' + randomBytes(3).toString('hex') + '.txt';
        await writeFile(join(sourcesDir, name), body.text, 'utf8');
        return c.json({ name });
      }
      if (typeof body.piiFile === 'string' && body.piiFile) {
        const cleanName = basename(body.piiFile);
        const { abs } = resolveAttachment(project, join('pii-clean', cleanName));
        const name = randomBytes(3).toString('hex') + '-' + safeFileName(cleanName);
        await writeFile(join(sourcesDir, name), readAttachment(abs));
        return c.json({ name });
      }
      if (typeof body.fileName === 'string' && typeof body.fileData === 'string' && body.fileData) {
        const name = randomBytes(3).toString('hex') + '-' + safeFileName(body.fileName);
        await writeFile(join(sourcesDir, name), Buffer.from(body.fileData, 'base64'));
        return c.json({ name });
      }
      throw new HttpError(400, 'Serve url, text o un file');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
  });

  // GET /notebooks/:id/sources/:name/content
  app.get(`${base}/notebooks/:id/sources/:name/content`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const name = safeFileName(c.req.param('name'));
    const filePath = join(dir, 'sources', name);
    if (!existsSync(filePath)) throw new HttpError(404, 'File non trovato');
    const content = await readFile(filePath, 'utf8');
    return c.json({ name, content });
  });

  // DELETE /notebooks/:id/sources/:name
  app.delete(`${base}/notebooks/:id/sources/:name`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const name = safeFileName(c.req.param('name'));
    await unlink(join(dir, 'sources', name)).catch(() => { /* gia' assente */ });
    return c.json({ success: true });
  });

  // POST /notebooks/:id/query { wspath, question }
  app.post(`${base}/notebooks/:id/query`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { wspath?: string; question?: string };
    const project = projectOf(body.wspath);
    const { dir, metaPath } = await ensureNotebook(project, c.req.param('id'));
    const question = (body.question || '').trim();
    if (!question) throw new HttpError(400, 'Domanda obbligatoria');

    const sourcesDir = join(dir, 'sources');
    const sourceFiles = await readdir(sourcesDir).catch(() => []);
    if (!sourceFiles.length) throw new HttpError(400, 'Aggiungi almeno una fonte prima di fare domande');

    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    const isFirst = !meta.conversationId;
    // Percorso ASSOLUTO: durante una conversazione lunga agy puo' perdere l'ancoraggio
    // alla cartella di lavoro iniziale. Un percorso assoluto non dipende da quello stato.
    const prompt = isFirst
      ? `Da questo momento sei l'assistente di ricerca di un notebook. Rispondi SEMPRE usando esclusivamente il contenuto dei file nella cartella "${sourcesDir}" (fonti: ${sourceFiles.join(', ')}), mai conoscenza esterna, a meno che le fonti stesse non ci rimandino esplicitamente. Se l'informazione richiesta non è nelle fonti, dillo chiaramente invece di inventare. Rispondi in italiano, in modo diretto, senza premesse superflue.\n\nDomanda: ${question}`
      : question;

    const result = await runAgy(prompt, { cwd: project, conversationId: meta.conversationId });
    if (result.error && !result.response) throw new HttpError(502, result.error);

    if (result.conversationId && result.conversationId !== meta.conversationId) {
      meta.conversationId = result.conversationId;
      await writeFile(metaPath, JSON.stringify(meta, null, 2));
    }

    const chatPath = join(dir, 'chat.json');
    const log = existsSync(chatPath) ? JSON.parse(await readFile(chatPath, 'utf8')) : [];
    log.push({ role: 'q', text: question, ts: Date.now() });
    log.push({ role: 'a', text: result.response, ts: Date.now() });
    await writeFile(chatPath, JSON.stringify(log.slice(-200), null, 2));

    return c.json({ answer: result.response });
  });

  // GET /notebooks/:id/studio
  app.get(`${base}/notebooks/:id/studio`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const studioDir = join(dir, 'studio');
    const entries = await readdir(studioDir, { withFileTypes: true }).catch(() => []);
    const list = await Promise.all(
      entries.filter((e) => e.isFile()).map(async (e) => {
        const st = await stat(join(studioDir, e.name));
        return { name: e.name, kind: e.name.split('-')[0], size: st.size, mtime: st.mtimeMs };
      }),
    );
    list.sort((a, b) => b.mtime - a.mtime);
    return c.json(list);
  });

  // POST /notebooks/:id/studio { wspath, kind, provider? }
  app.post(`${base}/notebooks/:id/studio`, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { wspath?: string; kind?: string; provider?: string };
    const project = projectOf(body.wspath);
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const kind = body.kind || '';
    const type = STUDIO_TYPES[kind];
    if (!type) throw new HttpError(400, 'Tipo non valido');

    const sourcesDir = join(dir, 'sources');
    const studioDir = join(dir, 'studio');
    const sourceFiles = await readdir(sourcesDir).catch(() => []);
    if (!sourceFiles.length) throw new HttpError(400, 'Aggiungi almeno una fonte prima di generare contenuti');

    const outName = `${kind}-${tsStamp()}.${type.ext}`;
    const outAbs = join(studioDir, outName);

    // Tipi con voce (Overview Audio, Video narrato): agy scrive un JSON, poi lo
    // script python sintetizza le voci e impagina l'HTML finale.
    if (type.json && type.script) {
      // Motore vocale verificato PRIMA di far lavorare agy per minuti.
      const env = ttsEnv(settings, body.provider);

      const jsonPath = join(studioDir, `.temp-${kind}-${tsStamp()}.json`);
      const prompt = type.prompt(sourcesDir, jsonPath);
      const result = await runAgy(prompt, { cwd: project });

      let jsonData: any = null;
      if (existsSync(jsonPath)) {
        try { jsonData = JSON.parse(await readFile(jsonPath, 'utf8')); }
        catch (e) { console.error('Errore lettura JSON copione:', e); }
      }
      // Se agy ha restituito il JSON nella risposta invece che nel file
      if (!jsonData && result.response) {
        const m = result.response.match(new RegExp('\\{[\\s\\S]*"' + type.jsonKey + '"[\\s\\S]*\\}'));
        if (m) {
          try {
            jsonData = JSON.parse(m[0]);
            await writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
          } catch { /* ignora */ }
        }
      }
      if (!jsonData || !Array.isArray(jsonData[type.jsonKey!]) || !jsonData[type.jsonKey!].length) {
        await unlink(jsonPath).catch(() => { /* gia' assente */ });
        throw new HttpError(502, result.error || 'agy non ha generato il copione');
      }

      const scriptPath = join(NOTEBOOK_SCRIPTS, type.script);
      try {
        await runPython(scriptPath, [jsonPath, outAbs], env);
      } catch (pyErr) {
        await unlink(jsonPath).catch(() => { /* gia' assente */ });
        throw new HttpError(500, `Errore durante la sintesi audio: ${pyErr instanceof Error ? pyErr.message : String(pyErr)}`);
      }
      await unlink(jsonPath).catch(() => { /* gia' assente */ });
      if (!existsSync(outAbs)) throw new HttpError(502, 'Sintesi completata ma il file finale non è presente');

      return c.json({ name: outName, provider: env.NOTEBOOK_TTS_PROVIDER });
    }

    const prompt = type.prompt(sourcesDir, outAbs);
    const result = await runAgy(prompt, { cwd: project });
    if (result.error && !existsSync(outAbs)) throw new HttpError(502, result.error);
    if (!existsSync(outAbs)) throw new HttpError(502, 'agy non ha scritto il file atteso');
    return c.json({ name: outName });
  });

  // GET /notebooks/:id/studio/:name/content
  app.get(`${base}/notebooks/:id/studio/:name/content`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const name = safeFileName(c.req.param('name'));
    const filePath = join(dir, 'studio', name);
    if (!existsSync(filePath)) throw new HttpError(404, 'File non trovato');
    const content = await readFile(filePath, 'utf8');
    return c.json({ name, content });
  });

  // DELETE /notebooks/:id/studio/:name
  app.delete(`${base}/notebooks/:id/studio/:name`, async (c) => {
    const project = projectOf(c.req.query('wspath'));
    const { dir } = await ensureNotebook(project, c.req.param('id'));
    const name = safeFileName(c.req.param('name'));
    await unlink(join(dir, 'studio', name)).catch(() => { /* gia' assente */ });
    return c.json({ success: true });
  });
}
