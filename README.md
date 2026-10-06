# AgiCloud

Interfaccia web multi-agente per agenti di coding (OpenCode, Claude Code, Codex, Gemini CLI, ...), basata sugli standard aperti **ACP** e **AG-UI**.

Stato: primi pezzi. Architettura in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prova rapida

Richiede Node 22+ e almeno un agente installato e già loggato.

```bash
npm install
npm test
npm run probe -- opencode "Rispondi solo con: ciao"
npm run probe -- claude "Crea x.txt con dentro 'prova'" --allow
```

`probe` stampa gli eventi AG-UI prodotti dal bridge. Opzioni: `--cwd DIR` (cartella di lavoro, default una temporanea), `--allow` (approva i permessi, altrimenti li rifiuta), `--auth METODO` (login ACP, es. `oauth-personal`).
