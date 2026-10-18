import { useEffect, useRef, useState } from 'react';
import { getToken, type PluginInfo } from './api';
import { getLang, useT } from './i18n';

/**
 * Schermata di un plugin esterno: la sua pagina (/plugin-ui/<id>/) in un iframe della stessa origine.
 * La pagina usa /plugin-kit.js, che copia stili e tema dell'app e chiede qui il token con un messaggio.
 * Messaggi accettati dalla pagina: agicloud:hello (risposta con token e lingua), agicloud:navigate, agicloud:threads.
 */
export function PluginFrame({
  plugin,
  onNavigate,
  onThreadsChanged,
}: {
  plugin: PluginInfo;
  onNavigate: (hash: string) => void;
  onThreadsChanged: () => void;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      // Solo la pagina di questo plugin, servita da questa stessa origine
      if (!win || e.source !== win || e.origin !== location.origin) return;
      const msg = e.data as { type?: string; hash?: unknown };
      if (msg?.type === 'agicloud:hello') {
        win.postMessage({ type: 'agicloud:hello', token: getToken(), lang: getLang() }, location.origin);
      } else if (msg?.type === 'agicloud:navigate' && typeof msg.hash === 'string' && msg.hash.startsWith('#/')) {
        onNavigate(msg.hash);
      } else if (msg?.type === 'agicloud:threads') {
        onThreadsChanged();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onNavigate, onThreadsChanged]);

  return (
    <section className="plugin-frame" aria-label={plugin.section?.label ?? plugin.name}>
      {!loaded && <p className="boot">{t('app.pluginCaricamento')}</p>}
      <iframe
        ref={frame}
        src={plugin.section!.ui}
        title={plugin.section?.label ?? plugin.name}
        onLoad={() => setLoaded(true)}
        hidden={!loaded}
      />
    </section>
  );
}
