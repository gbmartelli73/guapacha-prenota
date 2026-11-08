// Service worker: apre l'app anche con rete lenta; i dati (/api) arrivano sempre dal server.
const CACHE = 'prenota-v3.0.0';
// percorsi relativi: l'app funziona anche in una sottocartella (es. GitHub Pages)
const SHELL = ['./', 'style.css', 'app.js', 'config.js', 'vendor/supabase.js', 'vendor/qrcode.js', 'manifest.webmanifest', 'icons/icon-192.png', 'logo.svg'];
const HOME = new URL('./', self.location).href;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/segreteria/')) return;
  // rete prima, cache come riserva: gli aggiornamenti dell'app arrivano subito
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match(HOME))));
});

// notifiche push: promemoria, posti liberati, cambi d'orario
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Guapacha Studio', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || HOME },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || HOME, HOME).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(HOME) && 'focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
