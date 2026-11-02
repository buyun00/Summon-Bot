'use strict';
// Bump this version whenever the application shell changes.
const CACHE = 'relay-shell-20261102-cloud-icon';
const ICON_VERSION = '?v=relay-cloud-20261102';
const ASSETS = ['/', '/offline.html', '/style.css', '/group-chat.css', '/cache.js', '/app.js', '/avatars.js', '/motion.js', '/pwa.js', '/icons/user-avatar.jpg?v=owner-20261028', `/manifest.webmanifest${ICON_VERSION}`, ...['icon-192', 'icon-512', 'icon-maskable-192', 'icon-maskable-512', 'apple-touch-icon'].map(name => `/icons/${name}.png${ICON_VERSION}`)];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path => new Request(path, { cache: 'reload' })))));
  // Updates wait until the user chooses to reload; never interrupt a draft.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('relay-shell-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'RELAY_APPLY_UPDATE' && event.source?.type === 'window') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Chat, SSE, mutations and every unknown resource always use the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // Open the installed shell immediately, even while the network is stalled.
    // HTML and scripts stay on the same version until the user applies an update.
    event.respondWith((async () =>
      (await caches.match('/', { cacheName: CACHE })) ||
      fetch(request).catch(async () =>
        (await caches.match('/offline.html', { cacheName: CACHE })) || Response.error()))());
    return;
  }
  if (ASSETS.includes(url.pathname + url.search)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request)) || fetch(request)));
  }
});
