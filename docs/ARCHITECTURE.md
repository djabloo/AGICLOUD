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
| `packages/design` | ✅ plugin Design | Skill, design system e regole craft da Open Design; kit copiato nel progetto |
| `apps/web` | ✅ Chat, Terminale, File, Design, Impostazioni | React + Vite, PWA installabile con notifiche push; responsive e accessibile |

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
2. **Dopo**: Attività/Kanban, Spaces/Pagine (idea da OpenDots), altri plugin.

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

Ogni terminale ha un **custode** (`apps/server/src/term-host.ts`): un processo staccato dal server (`setsid -f`, quindi PM2 non lo chiude) che tiene la shell in un pty e ne conserva l'output (400k caratteri). Il server ci parla su un socket Unix (`data/terminals/<id>.sock`, 600, cartella 700) con righe JSON e inoltra al browser via WebSocket.
- Niente multiplexer in mezzo (fino al 2026-10-08 era tmux): xterm riceve l'output originale, quindi scorrimento all'indietro, selezione e link funzionano in modo naturale.
- Configurazione del custode via stdin, non da riga di comando: le chiavi del portachiavi finirebbero in `/proc/<pid>/cmdline`.
- Sopravvivono a: chiusura della pagina, rete che cade, **riavvio del server** (all'avvio si ricollega ai socket dei terminali in `data/terminals.json`; al collegamento il custode rimanda tutto l'output).
- Finiscono solo se: li chiudi dal cestino (messaggio `kill` al custode) o il programma dentro termina (il custode resta un'ora per mostrare l'uscita, poi se ne va).
- La shell nasce al primo collegamento del browser, con le sue misure (i programmi a schermo intero si disegnano subito giusti).
- Link e copia: il terminale è un canvas, quindi `termText.ts` ricostruisce il testo dal buffer (le righe piene fino all'ultima colonna si considerano continuate: alcuni programmi a schermo intero spezzano con un a capo vero) → barra "Link nel terminale" con Apri/Copia, riquadro "Testo" selezionabile anche su telefono con campo "Invia al terminale" (per i codici di login), link cliccabili su una riga (`addon-web-links`), Ctrl+Maiusc+C/V.
- Alla rilettura dell'output (riconnessione) le risposte automatiche di xterm alle domande dei programmi ("che terminale sei?") vengono scartate, altrimenti finirebbero nella shell come input.
- Login di Claude: le shell partono con `apps/server/terminal.bashrc` (carica `.profile`/`.bashrc` e poi toglie `CLAUDE_CODE_OAUTH_TOKEN`), così `claude` nel terminale usa il login dell'account (claude.ai, Pro) come la chat. Il token resta in `~/.bashrc` perché serve al webhook-server (N8N-BUILDER).
- All'avvio il server toglie dal proprio ambiente (ereditato da custodi e shell) le variabili di una sessione Claude Code "madre" (`CLAUDECODE`, `CLAUDE_CODE_*`…), ereditate se lo si avvia da dentro Claude Code.

## Plugin

Funzioni facoltative (`apps/server/src/plugins.ts`): Impostazioni → Plugin con Installa, interruttore Attivo/Spento, Disinstalla. Stato in `data/plugins.json`.
- Ogni plugin ha un manifest (nome, versione, descrizione, sezione del menu, crediti, cosa serve sul server, prefissi delle route) e ganci facoltativi `install`/`uninstall`/`health`.
- A plugin spento le sue route rispondono 404, la sezione sparisce dal menu e le sue opzioni dai dialoghi.
- Oggi il codice dei plugin sta nella repo (`source: 'builtin'`); in SaaS il catalogo dira' da dove scaricarli, il resto non cambia.
- Plugin: **Design** (gia' in uso, resta attivo), **PII**, **Browser**, **Verdict**.
- **Verdict** (`apps/server/src/verdict.ts`, `verdict-mcp.ts`, `apps/web/src/VerdictView.tsx`): domanda su un testo → risposta (Si'/No, una tra, voto 1-5) con la probabilita' di ogni opzione dai logprobs di un solo token (lettera), su OpenRouter con `OPENROUTER_API_KEY` dal portachiavi (`Settings.vaultValue`, mai al browser). Modelli scelti con un banco di 36 domande con risposta nota (2026-10-10): DeepSeek V4 Flash (reasoning spento) predefinito, taratura migliore (Brier 0,10); "Due modelli" = media con Mistral Nemo e avviso se non sono d'accordo (quando sbagliava la coppia era al 51-66%). Scartati: Gemma 4 (sicura al 100% anche sugli errori), Qwen 3.7 Flash e altri che dichiarano i logprobs ma non li restituiscono. Ripiego: catena DeepSeek → Nemo → Llama 3.1, poi voto a 7 campioni. "Incerto" se primo < 60%, margine < 20%, copertura < 50% o disaccordo. Usi: sezione Verdict, `POST /api/verdict/decide` col token di AgiCloud (n8n), strumento `verdetto` per gli agenti (MCP con token proprio in memoria, preautorizzato per Claude).
- **Browser** (`apps/server/src/browser.ts`, `apps/web/src/BrowserView.tsx`): un Chromium headless staccato dal server (`setsid -f`, profilo in `data/browser-profile`, CDP solo su `127.0.0.1:9333`, user agent senza "Headless"). Vista in diretta via WebSocket `/api/browser/ws` (token nel primo messaggio, Origin = host): `Page.startScreencast` → fotogrammi JPEG; clic/rotella/tasti/testo → `Input.dispatch*`/`insertText`; schede da `/json/list`, la vista segue le schede nuove (es. aperte dall'agente). Dito: trascinare = scorrere, tocco = clic. Finestra a parte: `#/browser/popup`. A plugin attivo ogni agente riceve il server MCP `browser` = `@playwright/mcp@0.0.83 --cdp-endpoint` sullo stesso Chromium (file di output in `data/browser-output`, non nei progetti); le azioni dell'agente seguono i permessi normali. Disinstallare cancella anche il profilo (login).
  - **Chat del Browser** (`apps/web/src/BrowserSection.tsx`): accanto al browser (su telefono si alterna "Browser"/"Chat") una conversazione con `browser: true`, che non compare in Chat. Al primo messaggio l'agente riceve istruzioni nascoste (stesse schede di l'utente, guarda prima la scheda attiva, chiedi prima di invii/acquisti/account). Per Claude gli strumenti `mcp__browser` sono preautorizzati solo in queste chat; nelle altre chiede il permesso.
  - Pagina iniziale delle schede nuove: `/browser-start` (ricerca DuckDuckGo e collegamenti rapidi; CSP propria, nessun dato).
- **PII** (`apps/server/src/pii.ts`, `apps/web/src/PiiView.tsx`): motore Rizzo-PII locale (`RIZZO_PII_URL`, default `127.0.0.1:5005`, container `rizzo-pii`). `/api/pii/engine/*` passa al motore solo gli endpoint in elenco (analyze, pdf, pdf/preview, pagine, file; niente impostazioni globali). Testo o documento (PDF/TXT/MD), categorie da lasciare in chiaro, PDF redatto con anteprima delle pagine, dizionario reversibile solo nel browser (`localStorage`), decodifica, "Salva per l'agente" in `<progetto>/pii-clean/` (il testo viene rianalizzato sul server senza dizionario; il PDF e' quello gia' redatto dal motore). Installare = controllare che il motore risponda.

## Capo e thread affidati

Una conversazione **capo** (Claude Code, spunta "Conversazione capo" nel dialogo) puo' affidare compiti ad altri agenti. Scelte di l'utente (2026-10-09): il capo **chiede prima** ogni delega, ogni thread lavora in una **copia separata**, a fine thread **il capo riassume**.
- Strumenti: `apps/server/src/lead-mcp.ts`, server MCP stdio passato all'agente in `session/new` (`mcpServers`): `delega`, `stato_thread`, `leggi_thread`, `scrivi_thread`. Parla con `/lead-api/*` (fuori da `/api`) con un token per conversazione capo, tenuto solo in memoria. Le istruzioni (regole, agenti disponibili, progetto) arrivano nel campo `instructions` dell'MCP.
- Per Claude gli strumenti sono preautorizzati (`_meta.claudeCode.options.allowedTools`): l'unica conferma e' la scheda di AgiCloud.
- `delega` crea una proposta (evento `agicloud.delegation`, notifica push) e l'MCP controlla ogni 2 s finche' l'utente decide (`POST /api/threads/:id/delegations/:did`); scade dopo 30 minuti o al riavvio del server.
- Approvata: `apps/server/src/worktrees.ts` crea `<repo>/.agicloud/worktrees/<nome>` sul ramo `agc/<nome>` dall'ultimo commit (le modifiche non salvate del progetto non ci sono); il thread figlio (`parentId`) parte con il compito. Se il progetto non e' un repo git con commit, lavora nella stessa cartella.
- Fine turno del figlio: il capo riceve un messaggio automatico (`agicloud.auto_message`, mostrato chiuso in chat) e riassume. I messaggi al capo mentre lavora vanno in coda (`Thread.enqueue`).
- Modifiche: `GET /api/threads/:id/changes` (tutto rispetto al punto di partenza, anche file nuovi), **Unisci** (`merge`: commit nella copia + `git merge --no-ff` nel ramo attuale; se fallisce `merge --abort`, progetto intatto) o **Scarta**. In entrambi i casi la copia e il ramo vengono rimossi.
- UI: thread figli annidati sotto il capo nella lista, barra dei thread con stato nella chat del capo, nel figlio provenienza + modifiche (`apps/web/src/LeadViews.tsx`).
- Prova: l'agente demo fa da finto capo ("delega") usando la stessa API; `scripts/ui-check` copre proposta, approvazione, permesso del figlio, diff, unione e riassunto.

## Plugin Design (da Open Design)

Contenuti di [open-design](https://github.com/nexu-io/open-design) (Apache 2.0) in `packages/design/content/`: 60 design system generici, 52 skill, 11 regole craft. Scelte di l'utente (2026-10-09): integrazione nativa (non l'MCP `od`, che vuole il loro demone), contenuti nella repo, **solo stili generici** (niente design system "ispirati a" marchi: AgiCloud diventera' un SaaS).
- Aggiornamento: `npm run import -w @agicloud/design -- /percorso/open-design` riscrive `content/` dagli elenchi in `scripts/import.ts` e rigenera `catalog.json` e `NOTICE.md` (commit di origine).
- Nuova conversazione → "Conversazione di design": skill e/o design system (`meta.design`). Alla **prima richiesta** il kit va in `<progetto>/.agicloud/design/` (skill completa, `DESIGN.md`, `tokens.css`, componenti, regole craft richieste) e davanti al messaggio dell'agente vanno poche righe che dicono cosa leggere e di scrivere pagine HTML in `design/`. In chat resta solo la richiesta di l'utente. Funziona con qualsiasi agente che legge file, senza MCP.
- Le skill di Open Design chiedono blocchi `<artifact>` in chat (li estrae il loro demone): le istruzioni del kit dicono di scrivere file.
- Anteprima dal vivo (`apps/web/src/DesignPreview.tsx`): barra "Anteprima design" nella chat, elenca gli HTML in `design/` e ricarica l'iframe quando cambia l'mtime (ogni 2 s mentre l'agente lavora).
- `/preview/<token>/...` (`apps/server/src/design.ts`): token casuale per una sola cartella (progetto, design system o skill del catalogo), sola lettura, scade dopo 6 ore. CSP `sandbox allow-scripts` senza `allow-same-origin`: gli script della pagina (anche da CDN) girano in un'origine opaca e non vedono il token di AgiCloud (verificato: `localStorage` → `SecurityError`).
- Sezione Design (`#/design`): catalogo con "Prova", che apre il dialogo con la scelta gia' fatta.

## Impostazioni

Divise in voci (`#/settings/<voce>`): Agenti, Chiavi, Notifiche e app, Aspetto, Cartelle e pausa, Accesso. Su telefono prima l'elenco, poi la voce con "‹ Tutte le impostazioni"; da 900px elenco e voce affiancati. Al cambio di voce il focus va al titolo.
- Aspetto: tema Automatico/Chiaro/Scuro per dispositivo (`localStorage`, `data-theme` su `<html>`, `apps/web/src/theme.ts`), applicato prima del primo disegno; aggiorna anche `theme-color` e l'editor dei file.

## Login degli agenti

Dalle Impostazioni, senza terminale (`apps/server/src/logins.ts`, `apps/web/src/AgentLogin.tsx`): il comando di login gira in un pty nascosto largo 1000 colonne (il link esce su una riga), dall'output si prendono il link e la richiesta del codice. L'interfaccia mostra "Apri la pagina di accesso", "Copia link" e, se serve, il campo per il codice; lo stato si aggiorna ogni secondo.
- Claude Code: `claude auth login --claudeai` (sempre abbonamento) → link + codice. Codice sbagliato: claude scrive "Invalid code" e aspetta un altro codice.
- Cursor: `NO_OPEN_BROWSER=1 cursor-agent login` → solo link, finisce da solo.
- OpenCode e agy hanno menu interattivi: login dal terminale (resta anche come ripiego per tutti).
- Ambiente come per l'agente: senza `ANTHROPIC_API_KEY` e senza il `CLAUDE_CODE_OAUTH_TOKEN` di `~/.bashrc`. Scade dopo 10 minuti.
- Prova: `scripts/ui-check` usa un finto `claude` (`scripts/ui-check/fake-bin/claude`) per link, codice sbagliato e codice giusto.

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
