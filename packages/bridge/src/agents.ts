// Catalogo degli agenti che sappiamo avviare in modalita' ACP.
// Un agente nuovo = una voce qui, nient'altro (purche' parli ACP su stdio).

export interface AgentSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** true = l'agente parla ACP da solo; false = serve un adattatore (pacchetto npm) */
  native: boolean;
}

export const AGENTS: Record<string, AgentSpec> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    native: true,
  },
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
  },
};

export function getAgent(id: string): AgentSpec {
  const spec = AGENTS[id];
  if (!spec) throw new Error(`Agente sconosciuto: ${id} (disponibili: ${Object.keys(AGENTS).join(', ')})`);
  return spec;
}
