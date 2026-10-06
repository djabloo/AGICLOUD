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
| `apps/web` | ✅ sezione Chat | React + Vite: chat multi-agente, strumenti, permessi, piano; responsive e accessibile |

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
| Claude Code | `@agentclientprotocol/claude-agent-acp` | ✅ testo, permesso negato e concesso |
| Gemini CLI | `gemini --acp` | ⚠️ ponte ok; serve una chiave API Gemini (l'abbonamento Google non la include) |
| Demo | esempio dell'SDK ACP | ✅ agente finto per prove (`AGICLOUD_DEMO_AGENT=1`) |
| Codex | `@zed-industries/codex-acp` | non provato (API a pagamento) |
| agy | — | più avanti, come plugin o via terminale |

## Sezioni (MVP → dopo)

1. **MVP**: Chat (multi-agente: scegli l'agente per conversazione), File/Repo, Terminale.
2. **Dopo**: Team di agenti (un leader che delega), Attività/Kanban, Spaces/Pagine (idea da OpenDots), Plugin, agy.

## Server ↔ interfaccia

Ogni conversazione ha un **registro di eventi AG-UI** (anche i messaggi dell'utente e i cambi di stato). L'interfaccia:
- invia comandi via REST (`POST /api/threads/:id/runs`, `.../cancel`, `.../permissions/:requestId`);
- segue gli eventi con `GET /api/threads/:id/events?after=N` (SSE): prima lo storico da N, poi in diretta. Se la connessione cade (telefono in standby) si ricollega dall'ultimo evento ricevuto e non perde nulla; l'agente intanto continua a lavorare.

Scelta: **niente `@ag-ui/client` né componenti CopilotKit** per ora. Il client SSE è di 50 righe e il modello a registro (comandi separati dal flusso) regge meglio la ripresa su mobile del modello "POST che risponde in streaming" di HttpAgent. Gli eventi restano AG-UI standard: si potrà aggiungere un endpoint compatibile HttpAgent se servirà.

## Accessibilità e responsive

Obiettivo WCAG 2.2 AA. Verificato con axe-core (0 violazioni, tema chiaro e scuro, desktop e 390px) tramite `scripts/ui-check/run.sh`.
- Annunci per lettori di schermo solo nei momenti utili ("l'agente sta lavorando", "risposta completata", "permesso richiesto": assertivo), non il testo in streaming.
- Menu mobile: `aria-expanded`, focus dentro all'apertura, Esc chiude e riporta il focus, contenuto dietro `inert`; da chiuso il menu è fuori dall'ordine di tabulazione.
- Dialogo nativo `<dialog>`; bersagli da 44px; stato mai affidato solo al colore; `prefers-reduced-motion`, `forced-colors`, tema chiaro/scuro da sistema; composer sopra la tastiera virtuale (`100dvh`, safe-area).

## Da decidere

- **[da decidere]** Dove girano gli agenti: un container per workspace (come AgyCloud) dal primo giorno, o prima in locale.
- **[da decidere]** Persistenza conversazioni: oggi il registro è in memoria (si perde al riavvio del server). Poi: ACP `session/load` dove supportato + registro su SQLite/Postgres.
- **[da decidere]** Processi agente inattivi: oggi restano accesi (limite `MAX_SESSIONS`). Poi: spegnerli dopo un'inattività e riprenderli con `session/load`.
