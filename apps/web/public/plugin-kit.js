// Kit per le schermate dei plugin esterni di AgiCloud (/plugin-ui/<id>/, mostrate in un iframe dell'app).
// Uso: <script src="/plugin-kit.js"></script>, poi `await AgiCloud.ready`.
// - copia fogli di stile, tema (data-theme) e lingua dell'app: classi come .btn, .agent-card, .hint funzionano uguali
// - AgiCloud.api(method, path, body): chiama /api<path> col token dell'app (errore = Error col messaggio del server)
// - AgiCloud.plugin(method, path, body): come api, sulle route del plugin (/api/x/<id><path>)
// - AgiCloud.url(path, params): link a /api<path> col token (download, PDF da aprire in una scheda)
// - AgiCloud.t({ it, en, de, cs, ru }): testo nella lingua dell'app
// - AgiCloud.navigate('#/t/<id>'): porta l'app a un'altra sezione; AgiCloud.threadsChanged(): aggiorna l'elenco chat
(() => {
  const host = window.parent !== window ? window.parent : null;
  const pluginId = (location.pathname.match(/^\/plugin-ui\/([a-z0-9_-]+)\//) || [])[1] || '';
  let token = '';
  let lang = 'it';

  /** Stili e tema dell'app (stessa origine): la pagina del plugin ha lo stesso aspetto, anche quando cambia il tema */
  function mirror() {
    let doc;
    try {
      doc = host && host.document;
    } catch {
      doc = null;
    }
    if (!doc) return;
    for (const el of doc.querySelectorAll('link[rel="stylesheet"], style')) {
      const copy = el.cloneNode(true);
      copy.setAttribute('data-agicloud', '');
      document.head.prepend(copy);
    }
    const sync = () => {
      const theme = doc.documentElement.getAttribute('data-theme');
      if (theme) document.documentElement.setAttribute('data-theme', theme);
      else document.documentElement.removeAttribute('data-theme');
      if (doc.documentElement.lang) document.documentElement.lang = doc.documentElement.lang;
    };
    sync();
    new MutationObserver(sync).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
  }

  const ready = new Promise((resolve) => {
    if (!host) {
      // Pagina aperta da sola (sviluppo): token salvato dall'app, se c'e'
      try {
        token = localStorage.getItem('agicloud_token') || '';
        lang = localStorage.getItem('agicloud.lang') || document.documentElement.lang || 'it';
      } catch {}
      resolve();
      return;
    }
    const onMessage = (e) => {
      if (e.source !== host || e.origin !== location.origin || e.data?.type !== 'agicloud:hello') return;
      window.removeEventListener('message', onMessage);
      token = e.data.token || '';
      lang = e.data.lang || 'it';
      document.documentElement.lang = lang;
      resolve();
    };
    window.addEventListener('message', onMessage);
    host.postMessage({ type: 'agicloud:hello' }, location.origin);
  });

  async function api(method, path, body) {
    await ready;
    const headers = { 'Accept-Language': lang };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  function url(path, params = {}) {
    const q = new URLSearchParams(params);
    if (token) q.set('token', token);
    const qs = q.toString();
    return `/api${path}${qs ? `?${qs}` : ''}`;
  }

  window.AgiCloud = {
    pluginId,
    ready,
    get lang() {
      return lang;
    },
    api,
    plugin: (method, path, body) => api(method, `/x/${pluginId}${path}`, body),
    url,
    t: (texts) => (texts && (texts[lang] ?? texts.it ?? texts.en)) || '',
    navigate: (hash) => host?.postMessage({ type: 'agicloud:navigate', hash }, location.origin),
    threadsChanged: () => host?.postMessage({ type: 'agicloud:threads' }, location.origin),
  };

  if (document.head) mirror();
  else document.addEventListener('DOMContentLoaded', mirror, { once: true });
})();
