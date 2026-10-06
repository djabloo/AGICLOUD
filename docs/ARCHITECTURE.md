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
| `apps/server` | da fare | HTTP: crea sessioni, `POST /runs` → flusso SSE di eventi AG-UI, risposta ai permessi, cancel |
| `apps/web` | da fare | Interfaccia a sezioni |

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
| Gemini CLI | `gemini --acp` | ⚠️ ponte ok, ma su questo server Gemini non ha credenziali |
| Codex | `@zed-industries/codex-acp` | non provato (API a pagamento) |
| agy | — | più avanti, come plugin o via terminale |

## Sezioni (MVP → dopo)

1. **MVP**: Chat (multi-agente: scegli l'agente per conversazione), File/Repo, Terminale.
2. **Dopo**: Team di agenti (un leader che delega), Attività/Kanban, Spaces/Pagine (idea da OpenDots), Plugin, agy.

## Da decidere

- **[da decidere]** Frontend: React + Vite con `@ag-ui/client`, riusando dove serve i componenti CopilotKit (MIT) senza il loro backend.
- **[da decidere]** Dove girano gli agenti: un container per workspace (come AgyCloud) dal primo giorno, o prima in locale.
- **[da decidere]** Persistenza conversazioni: ACP `session/load` dove supportato + storico nostro in SQLite/Postgres.
