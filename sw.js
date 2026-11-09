// Service worker: apre l'app anche con rete lenta; i dati (/api) arrivano sempre dal server.
const VERSION = '3.9.0'; // uguale a version.js
const CACHE = 'prenota-v' + VERSION;
// configurazione Supabase (stesso file dell'app) per segnalare la ricezione delle notifiche
try { self.window = self; importScripts('config.js'); } catch { /* facoltativo */ }
// percorsi relativi: l'app funziona anche in una sottocartella (es. GitHub Pages)
const SHELL = ['./', 'style.css', 'app.js', 'config.js', 'version.js', 'vendor/supabase.js', 'vendor/qrcode.js', 'manifest.webmanifest', 'icons/icon-192.png', 'logo.svg', 'thinkdifferent.svg'];
const HOME = new URL('./', self.location).href;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/segreteria/')) return;
  // rete prima, cache come riserva: gli aggiornamenti dell'app arrivano subito
  // no-cache: chiede sempre al server se il file è cambiato (GitHub Pages lo farebbe tenere in cache 10 minuti)
  e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match(HOME))));
});

// notifiche push: promemoria, posti liberati, cambi d'orario
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Guapacha Studio';
  const opts = { body: d.body || '', icon: 'icons/icon-192.png', data: { url: d.url || HOME } };
  if (d.tag) opts.tag = d.tag;
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, opts),
    // l'app aperta mostra anche un avviso interno (su iPhone il banner può non comparire ad app in primo piano)
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: 'push', title, body: d.body || '' }))),
    ack(),
  ]));
});
async function ack() {
  try {
    const C = self.SCUOLA_CONFIG; const sub = await self.registration.pushManager.getSubscription();
    if (!C || !sub) return;
    await fetch(`${C.supabaseUrl}/rest/v1/rpc/push_received`, { method: 'POST',
      headers: { apikey: C.supabaseAnonKey, Authorization: `Bearer ${C.supabaseAnonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_endpoint: sub.endpoint }) });
  } catch { /* solo diagnostica */ }
}
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || HOME, HOME).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(HOME) && 'focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
