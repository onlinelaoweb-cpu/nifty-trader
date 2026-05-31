// VardaanNifty Service Worker v9 — network-first, icons pre-cached, no stale-shell blocking
const CACHE = 'vardaannifty-v9';

self.addEventListener('install', e => {
    self.skipWaiting();
    // Pre-cache manifest + icons (NOT the HTML shell — pre-caching index.html
    // caused PWA to launch a stale version that couldn't reach /api/health).
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll([
            '/manifest.json',
            '/icons/icon-192.png',
            '/icons/icon-512.png',
            '/icons/apple-touch-icon.png',
        ]))
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = e.request.url;

    // API calls — always go to network, return JSON error stub if offline
    if (url.includes('/api/')) {
        e.respondWith(
            fetch(e.request).catch(() =>
                new Response('{"error":"offline","status":"waiting"}',
                    { headers: { 'Content-Type': 'application/json' } })
            )
        );
        return;
    }

    // HTML pages — always network-first, NO cache fallback for the shell.
    // This ensures the app always loads fresh and the splash can contact /api/health.
    if (e.request.destination === 'document' || url.endsWith('/')) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Static assets (fonts, icons, manifest) — network-first with cache fallback
    e.respondWith(
        fetch(e.request)
            .then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});