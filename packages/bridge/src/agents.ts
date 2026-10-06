import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Catalogo degli agenti che sappiamo avviare in modalita' ACP.
// Un agente nuovo = una voce qui, nient'altro (purche' parli ACP su stdio).

export interface AgentSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** true = l'agente parla ACP da solo; false = serve un adattatore (pacchetto npm) */
  native: boolean;
  /** Avviso da mostrare nella UI (requisiti, costi) */
  note?: string;
}

export const AGENTS: Record<string, AgentSpec> = {
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    native: true,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    // Adattatore ufficiale ACP sopra il Claude Agent SDK (usa il login di `claude`)
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.86.0'],
    native: false,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp@0.16.0'],
    native: false,
    note: 'Usa il login di codex (account ChatGPT o chiave API)',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    native: true,
    note: 'Richiede una chiave API Gemini (GEMINI_API_KEY): l\'abbonamento Google non basta',
  },
};

// Agente finto dell'SDK ACP (testo, tool call, richiesta di permesso): per prove e test UI
if (process.env.AGICLOUD_DEMO_AGENT === '1') {
  AGENTS.demo = {
    id: 'demo',
    label: 'Demo (agente finto)',
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.resolve('@agentclientprotocol/sdk'))), 'examples', 'agent.js')],
    native: true,
    note: 'Agente di prova: non usa modelli, risponde sempre con la stessa sequenza',
  };
}

export function getAgent(id: string): AgentSpec {
  const spec = AGENTS[id];
  if (!spec) throw new Error(`Agente sconosciuto: ${id} (disponibili: ${Object.keys(AGENTS).join(', ')})`);
  return spec;
}
