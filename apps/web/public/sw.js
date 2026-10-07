// Service worker di AgiCloud: solo notifiche push (niente cache offline, cosi' gli aggiornamenti
// arrivano sempre subito).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'AgiCloud', body: event.data ? event.data.text() : '' };
  }
  const url = data.url || '/';
  event.waitUntil(
    (async () => {
      // Se stai gia' guardando quella conversazione, niente notifica
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const watching = windows.some((w) => w.focused && w.visibilityState === 'visible' && new URL(w.url).hash === new URL(url, self.location.origin).hash);
      if (watching) return;
      await self.registration.showNotification(data.title || 'AgiCloud', {
        body: data.body || '',
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          return w.navigate(url);
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
