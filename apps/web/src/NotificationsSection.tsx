import { useEffect, useId, useState } from 'react';
import { api } from './api';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// L'evento "installa" arriva una volta sola, spesso prima che si apra questa pagina: lo si tiene da parte
let installEvent: BeforeInstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as BeforeInstallPromptEvent;
});

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /edg\//i.test(ua) ? 'Edge' : /firefox/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  const os = /android/i.test(ua) ? 'Android' : isIos ? 'iPhone/iPad' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` su ${os}` : ''}${standalone ? ' (app)' : ''}`;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function NotificationsSection() {
  const id = useId();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<{ endpoint: string; device: string }[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [canInstall, setCanInstall] = useState(Boolean(installEvent));

  useEffect(() => {
    api.push().then((p) => setDevices(p.devices)).catch(() => {});
    if (!supported) return setSubscribed(false);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(Boolean(sub)))
      .catch(() => setSubscribed(false));
    const t = setInterval(() => setCanInstall(Boolean(installEvent)), 1000);
    return () => clearInterval(t);
  }, []);

  const enable = async () => {
    setBusy(true);
    setMsg('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setMsg('Permesso negato: riattivalo dalle impostazioni del browser per questo sito.');
        return;
      }
      const { publicKey } = await api.push();
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      const res = await api.pushSubscribe(sub.toJSON(), deviceLabel());
      setDevices(res.devices);
      setSubscribed(true);
      setMsg('Notifiche attive su questo dispositivo.');
    } catch (err) {
      setMsg(`Non riuscito: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const res = await api.pushUnsubscribe(sub.endpoint);
        setDevices(res.devices);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setMsg('Notifiche disattivate su questo dispositivo.');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const { sent } = await api.pushTest();
    setMsg(sent ? `Notifica di prova inviata a ${sent} dispositivo/i.` : 'Nessun dispositivo iscritto.');
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    installEvent = null;
    setCanInstall(false);
    setMsg(outcome === 'accepted' ? 'App installata.' : '');
  };

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        Notifiche e app
      </h2>
      <p className="hint">
        Un avviso sul telefono quando un agente ha finito o ti chiede un permesso. Toccandolo si apre la conversazione.
        Se la stai gia' guardando, l'avviso non arriva.
      </p>

      {!supported ? (
        <p className="notice notice-error">
          {isIos && !standalone
            ? "Su iPhone le notifiche funzionano solo dall'app: in Safari tocca Condividi → Aggiungi alla schermata Home, poi apri AgiCloud da li' e torna qui."
            : 'Questo browser non supporta le notifiche push.'}
        </p>
      ) : (
        <div className="agent-actions">
          {subscribed ? (
            <>
              <button type="button" className="btn small-btn" onClick={() => void test()}>
                Invia una prova
              </button>
              <button type="button" className="btn small-btn" onClick={() => void disable()} disabled={busy}>
                Disattiva su questo dispositivo
              </button>
            </>
          ) : (
            <button type="button" className="btn primary" onClick={() => void enable()} disabled={busy || subscribed === null}>
              Attiva le notifiche su questo dispositivo
            </button>
          )}
          {canInstall && !standalone && (
            <button type="button" className="btn small-btn" onClick={() => void install()}>
              Installa l'app
            </button>
          )}
        </div>
      )}

      <p className="hint" aria-live="polite">
        {msg}
      </p>

      {devices.length > 0 && (
        <>
          <h3 className="mini-title" id={`${id}-dev`}>
            Dispositivi iscritti
          </h3>
          <ul className="device-list" aria-labelledby={`${id}-dev`}>
            {devices.map((d) => (
              <li key={d.endpoint}>
                <span>{d.device}</span>
                <button
                  type="button"
                  className="btn small-btn"
                  onClick={() => void api.pushUnsubscribe(d.endpoint).then((r) => setDevices(r.devices))}
                >
                  Togli<span className="visually-hidden"> {d.device}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
