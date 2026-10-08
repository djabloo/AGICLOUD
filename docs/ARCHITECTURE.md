# AgiCloud — architettura

Stato: bozza del 2026-10-06. Le decisioni marcate **[da decidere]** restano aperte.

## Idea

Un'interfaccia web generalista per **più agenti di coding**, organizzata a sezioni. Gli agenti non si integrano uno per uno: si parla con tutti tramite due protocolli aperti.

```
 Browser (sezioni: Chat, Terminale, File/Repo, ...)
    │  AG-UI  (eventi su HTTP/SSE)
    ▼
 Server AgiCloud  ── sessioni, utenti, workspace, permessi
    │  usa packages/bridge
    ▼
 Bridge  ── traduce ACP ⇄ AG-UI
    │  ACP  (JSON-RPC su stdio)
    ▼
 Agenti: OpenCode · Claude Code · Codex · Gemini CLI · Goose · ...
```

- **ACP** ([Agent Client Protocol](https://agentclientprotocol.com)): lo standard con cui un client parla con un agente di coding. Nativo in Gemini CLI, OpenCode, Goose e altri; Claude Code e Codex tramite adattatori ufficiali.
- **AG-UI** ([Agent-User Interaction](https://docs.ag-ui.com)): lo standard con cui un agente manda all'interfaccia testo in streaming, tool call, stato. Usato da CopilotKit/OpenDots: i loro componenti restano compatibili, senza dipendere da CopilotKit Intelligence.

## Pezzi

| Pezzo | Stato | Ruolo |
|---|---|---|
| `packages/bridge` | ✅ funzionante | Avvia un agente ACP, apre la sessione, traduce gli update in eventi AG-UI, gestisce permessi, cancel e login |
| `apps/server` | ✅ funzionante | HTTP (Hono): conversazioni, registro eventi AG-UI per conversazione, flusso SSE con ripresa, permessi, cancel, token di accesso |
| `apps/web` | ✅ Chat, Terminale, File, Impostazioni | React + Vite, PWA installabile con notifiche push; responsive e accessibile |

## Traduzione ACP → AG-UI (packages/bridge)

| ACP `session/update` | AG-UI |
|---|---|
| `agent_message_chunk` | `TEXT_MESSAGE_START` / `CONTENT` / `END` |
| `agent_thought_chunk` | `REASONING_MESSAGE_CHUNK` |
| `tool_call` | `TOOL_CALL_START` / `ARGS` / `END` + `CUSTOM agicloud.tool_call` (titolo, tipo, file, diff) |
| `tool_call_update` (completed/failed) | `TOOL_CALL_RESULT` + `CUSTOM agicloud.tool_call_update` |
| `plan` | `CUSTOM agicloud.plan` |
| `session/request_permission` | `CUSTOM agicloud.permission_request` → la UI risponde con `respondPermission()` |
| tutto il resto (usage, comandi, modalità...) | `CUSTOM agicloud.acp.<tipo>` |
| fine turno | `RUN_FINISHED` con `result.stopReason` |

Scelte:
- **Permessi come evento CUSTOM, non come interrupt AG-UI.** In ACP l'agente resta in attesa a metà turno; l'interrupt AG-UI invece chiude il run e ne richiede uno nuovo. Il CUSTOM tiene il turno vivo. Da rivedere se i componenti UI che adottiamo si aspettano gli interrupt.
- **Niente fs/terminale lato client** per ora: l'agente lavora direttamente nella sua cartella (isolata dal server). Si potrà attivare per vedere le modifiche in tempo reale nell'editor.
- **Login**: se l'agente chiede l'autenticazione, il bridge lancia `AuthRequiredError` con i metodi offerti; la UI fa scegliere e si riparte con `authMethod`.

## Agenti

| Agente | Avvio | Verificato |
|---|---|---|
| OpenCode | `opencode acp` | ✅ testo, tool call, file creato |
| Claude Code | `@agentclientprotocol/claude-agent-acp` | ✅ testo, permessi, modalità/modello/effort, comandi `/`, ripresa sessione dopo pausa e dopo riavvio del server |
| Cursor | `cursor-agent acp` (nativo, `authenticate` con `cursor_login`) | ✅ collegato (login da Impostazioni con `cursor-agent login`) |
| Demo | `packages/bridge/src/demo-agent.ts` | ✅ agente finto per prove (`AGICLOUD_DEMO_AGENT=1`): opzioni, comandi, permessi, ripresa |
| ~~Codex~~ | `@zed-industries/codex-acp` | tolto dalla chat (2026-10-07): sul server è collegato con la chiave API di n8n, costerebbe a consumo. Riattivabile con `AGICLOUD_CODEX=1` |
| agy | adattatore nostro `packages/bridge/src/agy-agent.ts`: un processo `agy --print` stream-json per messaggio, ripresa con `--conversation` (mappa in `~/.local/state/agicloud/agy-sessions.json`) | ✅ testo, strumenti, ripresa dopo pausa, modello/modalità/permessi. In headless agy non può chiedere permessi: comandi negati (segnalati in chat) salvo "Consenti tutto" |
| ~~Gemini CLI~~ | — | tolto (2026-10-07): con l'abbonamento Google non si può usare, solo a chiave API. Per la chat contano solo agenti ad abbonamento o piano gratuito |

## Sezioni (MVP → dopo)

1. **MVP**: Chat (multi-agente: scegli l'agente per conversazione), File/Repo, Terminale.
2. **Dopo**: Team di agenti (un leader che delega), Attività/Kanban, Spaces/Pagine (idea da OpenDots), Plugin, agy.

## Server ↔ interfaccia

Ogni conversazione ha un **registro di eventi AG-UI** (anche i messaggi dell'utente e i cambi di stato). L'interfaccia:
- invia comandi via REST (`POST /api/threads/:id/runs`, `.../cancel`, `.../permissions/:requestId`);
- segue gli eventi con `GET /api/threads/:id/events?after=N` (SSE): prima lo storico da N, poi in diretta. Se la connessione cade (telefono in standby) si ricollega dall'ultimo evento ricevuto e non perde nulla; l'agente intanto continua a lavorare.

Scelta: **niente `@ag-ui/client` né componenti CopilotKit** per ora. Il client SSE è di 50 righe e il modello a registro (comandi separati dal flusso) regge meglio la ripresa su mobile del modello "POST che risponde in streaming" di HttpAgent. Gli eventi restano AG-UI standard: si potrà aggiungere un endpoint compatibile HttpAgent se servirà.

## Conversazioni e ciclo di vita dell'agente

- Ogni conversazione è salvata in `data/threads/<id>.json` (agente, cartella, titolo, sessione ACP, scelte di modalità/modello) e `<id>.jsonl` (registro eventi AG-UI). Al riavvio del server si ricaricano tutte, con l'agente spento.
- L'agente si accende alla creazione della conversazione (così modalità, modello e comandi sono subito disponibili) e si spegne dopo `IDLE_MINUTES` (30) di inattività: la conversazione va "in pausa".
- Al messaggio successivo riparte con `session/resume` (o `session/load`) sulla stessa sessione ACP e riapplica le scelte salvate. Se la ripresa fallisce si apre una sessione nuova e la UI lo dice.
- Oltre `MAX_SESSIONS` agenti accesi si mette in pausa quello inattivo da più tempo.
- Stato "vivo" (opzioni, comandi slash, stato) viaggia come evento `agicloud.state` senza id SSE: non entra nel registro.
- Organizzazione: rinomina (il titolo scelto non viene più sostituito dal primo messaggio), fissa in cima, archivia (spegne l'agente; nascosta in "Archiviate"). Ricerca `GET /api/threads/search?q=` su titoli e testo dei messaggi, con estratto.
- Progetti: qualsiasi cartella dentro `PROJECT_ROOTS` (default `data/workspaces:/home/user:/opt:/var/www`), controllata con il percorso reale (niente symlink per uscire).

## Terminali

Ogni terminale è una sessione **tmux** su un socket dedicato (`tmux -L agicloud`, config `apps/server/tmux.conf`: niente barra, niente prefisso). Il server si collega con un pty "spettatore" (`tmux attach`) e inoltra l'output via WebSocket.
- Sopravvivono a: chiusura della pagina, rete che cade, **riavvio del server** (all'avvio si ritrovano le sessioni `agc-*` vive; metadati in `data/terminals.json`).
- Finiscono solo se: li chiudi dal cestino (`tmux kill-session`) o il programma dentro termina.
- La sessione nasce al primo collegamento del browser, con le sue misure (i programmi a schermo intero si disegnano subito giusti).
- Link e copia: il terminale è un canvas, quindi `termText.ts` ricostruisce il testo dal buffer (le righe piene fino all'ultima colonna si considerano spezzate da tmux) → barra "Link nel terminale" con Apri/Copia, riquadro "Testo" selezionabile anche su telefono con campo "Invia al terminale" (per i codici di login), link cliccabili su una riga (`addon-web-links`), Ctrl+Maiusc+C/V.
- Alla rilettura dell'output (riconnessione) le risposte automatiche di xterm alle domande di tmux vengono scartate, altrimenti finirebbero nella shell come input.
- Login di Claude: le shell partono con `apps/server/terminal.bashrc` (carica `.profile`/`.bashrc` e poi toglie `CLAUDE_CODE_OAUTH_TOKEN`), così `claude` nel terminale usa il login dell'account (claude.ai, Pro) come la chat. Il token resta in `~/.bashrc` perché serve al webhook-server (N8N-BUILDER).
- All'avvio il server toglie dal proprio ambiente e da quello globale di tmux le variabili di una sessione Claude Code "madre" (`CLAUDECODE`, `CLAUDE_CODE_*`…), ereditate se lo si avvia da dentro Claude Code.

## File

Sezione File (`apps/server/src/files.ts`): sfoglia, editor CodeMirror 6 (linguaggi caricati su richiesta), anteprima Markdown/HTML (iframe `sandbox` senza permessi), immagini/PDF/video/audio (scaricati come Blob col token), download, crea/rinomina/elimina/carica.
- Solo dentro `PROJECT_ROOTS`, sempre col percorso reale; il rinomina accetta solo un nome (niente `../`); non si eliminano radici né cartelle non vuote.
- Salvataggio con controllo di conflitto: se il file è cambiato dopo l'apertura (es. lo ha toccato un agente) si sceglie tra ricaricare e sovrascrivere.
- `/api/files/raw` ha una CSP propria e restrittiva (`sandbox`): un HTML aperto direttamente non esegue script.
- In chat, i file toccati dagli strumenti sono link alla sezione File.

## Notifiche e app

PWA (manifest, icone, `sw.js` solo per le push, niente cache offline). Web Push con chiavi VAPID in `data/vapid.json` e dispositivi in `data/push.json` (600). Notifica a fine turno (con l'inizio della risposta), in caso di errore e quando l'agente chiede un permesso; il tocco apre la conversazione; niente notifica se la stai già guardando. Su iPhone servono l'app installata e iOS 16.4+.

## Accessibilità e responsive

Obiettivo WCAG 2.2 AA. Verificato con axe-core (0 violazioni, tema chiaro e scuro, desktop e 390px) tramite `scripts/ui-check/run.sh`.
- Annunci per lettori di schermo solo nei momenti utili ("l'agente sta lavorando", "risposta completata", "permesso richiesto": assertivo), non il testo in streaming.
- Menu mobile: `aria-expanded`, focus dentro all'apertura, Esc chiude e riporta il focus, contenuto dietro `inert`; da chiuso il menu è fuori dall'ordine di tabulazione.
- Dialogo nativo `<dialog>`; bersagli da 44px; stato mai affidato solo al colore; `prefers-reduced-motion`, `forced-colors`, tema chiaro/scuro da sistema; composer sopra la tastiera virtuale (`100dvh`, safe-area).

## Da decidere

- **[da decidere]** Dove girano gli agenti: un container per workspace (come AgyCloud) dal primo giorno, o prima in locale.
- **[da decidere]** Registro su database (SQLite/Postgres) se i file JSONL diventano scomodi (ricerca, multi-utente).
