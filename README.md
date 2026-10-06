# AgiCloud

Interfaccia web multi-agente per agenti di coding (OpenCode, Claude Code, Codex, Gemini CLI, ...), basata sugli standard aperti **ACP** e **AG-UI**.

Stato: primi pezzi. Architettura in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Avvio

```bash
npm install
npm run build          # compila l'interfaccia web
npm start              # http://127.0.0.1:3095
```

Variabili: `PORT` (3095), `HOST` (127.0.0.1), `AUTH_TOKEN` (obbligatorio se HOST non è locale), `WORKSPACES_ROOT` (`data/workspaces`), `MAX_SESSIONS` (6), `AGICLOUD_DEMO_AGENT=1` (aggiunge l'agente finto per le prove), `TRUST_PROXY=1` (dietro reverse proxy).

Sviluppo dell'interfaccia: `npm start` in un terminale e `npm run dev -w @agicloud/web` nell'altro (Vite fa da proxy verso `/api`).

## Prova rapida del bridge

Richiede Node 22+ e almeno un agente installato e già loggato.

```bash
npm install
npm test
npm run probe -- opencode "Rispondi solo con: ciao"
npm run probe -- claude "Crea x.txt con dentro 'prova'" --allow
```

Prova dell'interfaccia (screenshot + axe, con l'agente demo): `scripts/ui-check/run.sh` (`--dark` per il tema scuro).

`probe` stampa gli eventi AG-UI prodotti dal bridge. Opzioni: `--cwd DIR` (cartella di lavoro, default una temporanea), `--allow` (approva i permessi, altrimenti li rifiuta), `--auth METODO` (login ACP, es. `oauth-personal`).
