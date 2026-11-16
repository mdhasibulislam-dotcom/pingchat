/* OneSignal web push (v16) shares this worker: the OneSignal worker code
 * is loaded into PingChat's own PWA service worker so push and the PWA
 * keep one worker at the /pingchat/ scope. Guarded: if the OneSignal CDN
 * is unreachable the PWA must keep working, so a failed import only
 * disables push. The SDK is told to use this file via serviceWorkerPath
 * in js/push.js. */
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
} catch (e) {
  /* Push unavailable; the PWA offline shell below still works. */
}

/* PingChat v2 — service worker: offline app-shell cache.
 *
 * Cache-first for the app shell (HTML/CSS/JS/icons/manifest), network-only
 * for everything else — Supabase API calls are NEVER cached, so chats, calls
 * and auth always go to the live server. If the network is down, navigation
 * falls back to the cached login page.
 *
 * A broken fetch handler can brick the app, so every branch is guarded and
 * any failure degrades to a plain network fetch. Bump CACHE on each release
 * so old caches are dropped on activate.
 */
const CACHE = 'pingchat-v10';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/auth.js',
  'js/chats.js',
  'js/calls.js',
  'js/call-config.js',
  'js/friends.js',
  'js/people.js',
  'js/profile.js',
  'js/settings.js',
  'js/install.js',
  'js/ui.js',
  'assets/icons/logo.svg',
  'assets/icons/favicon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => { /* partial cache is fine; fetch handler fills in */ })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT/DELETE pass through untouched
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  // Only handle same-origin requests. Supabase (auth, database, realtime,
  // storage) lives on another origin and always goes to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE)
            .then((cache) => cache.put(req, copy))
            .catch(() => {});
        }
        return res;
      }).catch(() => caches.match('index.html'));
    }).catch(() => caches.match('index.html'))
  );
});
