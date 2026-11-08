// Service worker: apre l'app anche con rete lenta; i dati (/api) arrivano sempre dal server.
const CACHE = 'prenota-v2.5.0';
// percorsi relativi: l'app funziona anche in una sottocartella (es. GitHub Pages)
const SHELL = ['./', 'style.css', 'app.js', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest', 'icons/icon-192.png', 'logo.svg'];
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
