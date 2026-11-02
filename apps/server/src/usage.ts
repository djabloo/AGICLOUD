// Utilizzo del piano degli agenti, come nelle loro app:
// - Claude Code: le barre di /usage (sessione di 5 ore e settimana), percentuale usata. Si legge con il token di
//   accesso gia' salvato da claude; non lo si rinnova qui (il rinnovo spetta a claude: ruotare il token da due
//   parti lo romperebbe) e il token non lascia mai il server.
// - agy: `agy -p "/usage"` e `agy -p "/credits"`, che rispondono una riga per voce separata da tab
//   (gruppo, limite, percentuale rimanente, azzeramento). Percentuale rimanente, come in Antigravity.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agyBin } from './settings.js';

export interface UsageBar {
  /** Voce nota, tradotta dall'interfaccia; altrimenti si mostra "label" cosi' com'e' */
  kind?: 'session' | 'week' | 'fiveHour';
  label?: string;
  /** 0-100: usata (Claude) o rimanente (agy), secondo "mode" */
  percent: number;
  mode: 'used' | 'remaining';
  /** Quando si azzera (ms epoch) */
  resetsAt: number | null;
}

export interface AgentUsage {
  agentId: string;
  /** ok: dati validi; unavailable: non si puo' leggere (motivo in "reason") */
  state: 'ok' | 'unavailable';
  reason?: 'no-login' | 'expired' | 'network';
  /** Gruppi di limiti (agy: "Gemini Models", "Claude and GPT models"...; Claude: uno solo, senza titolo) */
  groups: { title?: string; bars: UsageBar[] }[];
  /** Credito incluso di Claude (sessioni cloud), in dollari */
  credit?: { usedDollars: number; limitDollars: number };
  /** Crediti AI di Antigravity rimasti */
  aiCredits?: number;
  at: number;
}

const CACHE_MS = 60_000;
const cache = new Map<string, AgentUsage>();
const pending = new Map<string, Promise<AgentUsage>>();

const unavailable = (agentId: string, reason: AgentUsage['reason']): AgentUsage => ({ agentId, state: 'unavailable', reason, groups: [], at: Date.now() });
const clamp = (n: number) => Math.max(0, Math.min(100, n));

// ── Claude Code ──────────────────────────────────────────────────────────────

function claudeCredentials(): { accessToken: string; expiresAt?: number } | null {
  const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
  try {
    if (!existsSync(file)) return null;
    const o = JSON.parse(readFileSync(file, 'utf8'))?.claudeAiOauth;
    return o && typeof o.accessToken === 'string' ? o : null;
  } catch {
    return null;
  }
}

const claudeBar = (v: any, kind: UsageBar['kind']): UsageBar[] =>
  v && typeof v.utilization === 'number'
    ? [{ kind, percent: clamp(v.utilization), mode: 'used', resetsAt: v.resets_at ? Date.parse(v.resets_at) || null : null }]
    : [];

async function claudeUsage(): Promise<AgentUsage> {
  const cred = claudeCredentials();
  if (!cred) return unavailable('claude', 'no-login');
  if (cred.expiresAt && cred.expiresAt < Date.now()) return unavailable('claude', 'expired');
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return unavailable('claude', 'expired');
    if (!res.ok) return unavailable('claude', 'network');
    const d: any = await res.json();
    const credit = d.iguana_necktie as { used_dollars?: unknown; limit_dollars?: unknown } | null;
    return {
      agentId: 'claude',
      state: 'ok',
      groups: [{ bars: [...claudeBar(d.five_hour, 'session'), ...claudeBar(d.seven_day, 'week')] }],
      credit:
        credit && typeof credit.used_dollars === 'number' && typeof credit.limit_dollars === 'number'
          ? { usedDollars: credit.used_dollars, limitDollars: credit.limit_dollars }
          : undefined,
      at: Date.now(),
    };
  } catch {
    return unavailable('claude', 'network');
  }
}

// ── agy ──────────────────────────────────────────────────────────────────────

function agyPrint(command: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(agyBin(), ['-p', command], { timeout: 45_000, cwd: homedir() }, (err, stdout) => resolve(err ? null : stdout)),
  );
}

const AGY_KINDS: Record<string, UsageBar['kind']> = {
  'weekly limit remaining': 'week',
  'five hour limit remaining': 'fiveHour',
};

/** Righe "gruppo<TAB>limite<TAB>88%<TAB>2026-11-08T12:20:45Z" in gruppi di barre */
export function parseAgyUsage(text: string): AgentUsage['groups'] {
  const groups: AgentUsage['groups'] = [];
  for (const line of text.split('\n')) {
    const [title, label, perc, reset] = line.split('\t').map((s) => s?.trim());
    const percent = Number.parseFloat(perc ?? '');
    if (!title || !label || !Number.isFinite(percent)) continue;
    let group = groups.find((g) => g.title === title);
    if (!group) groups.push((group = { title, bars: [] }));
    const kind = AGY_KINDS[label.toLowerCase()];
    group.bars.push({ ...(kind ? { kind } : { label }), percent: clamp(percent), mode: 'remaining', resetsAt: (reset && Date.parse(reset)) || null });
  }
  return groups;
}

async function agyUsage(): Promise<AgentUsage> {
  const [usage, credits] = await Promise.all([agyPrint('/usage'), agyPrint('/credits')]);
  if (usage === null) return unavailable('agy', 'network');
  const groups = parseAgyUsage(usage);
  // Senza login agy non elenca limiti (risponde con un messaggio)
  if (groups.length === 0) return unavailable('agy', /login|sign in|authenticat/i.test(usage) ? 'no-login' : 'network');
  const remaining = credits?.match(/^remaining credits\t(\d+(?:\.\d+)?)/im);
  return { agentId: 'agy', state: 'ok', groups, aiCredits: remaining ? Number(remaining[1]) : undefined, at: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────

const READERS: Record<string, () => Promise<AgentUsage>> = { claude: claudeUsage, agy: agyUsage };

/** null: l'agente non mostra l'utilizzo. Dati tenuti un minuto; richieste contemporanee ne fanno una sola */
export async function agentUsage(agentId: string, force = false): Promise<AgentUsage | null> {
  const read = READERS[agentId];
  if (!read) return null;
  const hit = cache.get(agentId);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;
  let p = pending.get(agentId);
  if (!p) {
    p = read().finally(() => pending.delete(agentId));
    pending.set(agentId, p);
  }
  const result = await p;
  cache.set(agentId, result);
  return result;
}
