# Plugin esterni

Un plugin esterno e' una cartella **fuori da questa repo** con un `manifest.json`. AgiCloud lo trova in due modi:

- **Catalogo della macchina**: `AGICLOUD_PLUGINS_DIR=/percorso/a:/percorso/b`. Ogni sottocartella con un `manifest.json`
  compare in Impostazioni → Plugin, pronta da installare. La piattaforma ci monta il suo catalogo (in sola lettura).
- **Da link** (Impostazioni → Plugin → Installa da link): URL Git (`https://…`, `git@…`), scaricato in `DATA_DIR/plugins/`,
  oppure una cartella sul server. Reinstallare dallo stesso link lo aggiorna (`git pull`).

Come i plugin interni, si attiva e si spegne dalle Impostazioni e rispetta il piano (`AGICLOUD_FEATURES` deve contenere
l'id del plugin, oppure `all`). Il codice del plugin gira con gli stessi permessi di AgiCloud: si installano solo plugin fidati.

## manifest.json

```json
{
  "id": "esempio",
  "version": "1.0.0",
  "name": { "it": "Esempio", "en": "Example", "de": "Beispiel", "cs": "Příklad", "ru": "Пример" },
  "description": { "it": "…", "en": "…" },
  "requires": { "it": "Cosa serve sulla macchina", "en": "…" },
  "section": { "icon": "tool", "label": { "it": "Esempio", "en": "Example" } },
  "mcp": { "command": "node", "args": ["${PLUGIN_DIR}/mcp-server.mjs"], "env": {}, "autoAllow": true },
  "server": "server.mjs",
  "web": "web"
}
```

- `id`: minuscole, numeri, `-` e `_`. E' anche il nome del server MCP e la chiave del piano.
- Testi (`name`, `description`, `requires`, `section.label`): una stringa oppure un testo per lingua (it, en, de, cs, ru).
  Se manca la lingua scelta si usa l'italiano, poi l'inglese.
- `mcp` (facoltativo): server MCP stdio dato a tutti gli agenti finche' il plugin e' attivo. `${PLUGIN_DIR}` e
  `${PLUGIN_DATA}` vengono sostituiti; il processo riceve anche `AGICLOUD_PLUGIN_DIR` e `AGICLOUD_PLUGIN_DATA`
  (cartella dati del plugin, `DATA_DIR/plugin-data/<id>`). `autoAllow`: Claude usa gli strumenti senza chiedere.
- `server` (facoltativo): modulo ESM con `export async function register(app, ctx)`. `app` e' un'app Hono gia' montata
  su `/api/x/<id>` (col token di AgiCloud, come tutto `/api`); `ctx` = `{ id, pluginDir, dataDir, HttpError }`.
  Un errore con `status` (es. `new ctx.HttpError(404, 'Non trovato')`) diventa la risposta con quel codice.
- `web` (facoltativo): cartella statica servita su `/plugin-ui/<id>/`. Con `section` diventa una voce del menu: la pagina
  `index.html` si apre dentro l'app. Senza `web` il plugin non ha schermata (solo MCP e/o API).

`server` e `web` devono stare dentro la cartella del plugin, altrimenti vengono ignorati.

## La schermata: /plugin-kit.js

```html
<script src="/plugin-kit.js"></script>
<script>
  await AgiCloud.ready;
  const dati = await AgiCloud.plugin('GET', '/qualcosa');      // /api/x/<id>/qualcosa col token
  const agenti = await AgiCloud.api('GET', '/agents');          // qualsiasi API di AgiCloud
  AgiCloud.t({ it: 'Ciao', en: 'Hello' });                      // lingua dell'app
  AgiCloud.url('/x/esempio/file.pdf', { download: '1' });       // link col token
  AgiCloud.navigate('#/t/<id-thread>');                         // porta l'app altrove
  AgiCloud.threadsChanged();                                    // aggiorna l'elenco delle chat
</script>
```

Il kit copia gli stili e il tema dell'app nella pagina: le classi dell'interfaccia (`btn`, `btn primary`, `small-btn`,
`agent-card`, `hint`, `notice notice-error`, `field-label`, `settings` / `settings-body` / `chat-header`) hanno lo stesso
aspetto, in chiaro e in scuro. Esempio completo: il plugin Accessibilita' (repo privata `agicloud-plugin-accessibility`).
