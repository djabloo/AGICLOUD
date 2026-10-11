// Alcuni comandi di login (es. "NO_OPEN_BROWSER=1 cursor-agent login") usano la sintassi bash per
// mettere una variabile d'ambiente in testa al comando: cmd.exe (Windows) non la capisce. Qui si
// separano quei prefissi dal comando, cosi' su Windows si possono passare come ambiente del processo.
export function splitEnvPrefix(command: string): { command: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const words = command.split(' ');
  let i = 0;
  while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i]!)) {
    const eq = words[i]!.indexOf('=');
    env[words[i]!.slice(0, eq)] = words[i]!.slice(eq + 1);
    i++;
  }
  return { command: words.slice(i).join(' '), env };
}
