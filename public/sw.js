const CACHE = 'vardaannifty-v5';
const ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(ASSETS))
    );
    self.skipWaiting();
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
    if (e.request.url.includes('/api/')) {
        e.respondWith(fetch(e.request).catch(() =>
            new Response('{"error":"offline"}', {
                headers: { 'Content-Type': 'application/json' }
            })
        ));
        return;
    }
    // ✅ Network first — always fresh HTML
    e.respondWith(
        fetch(e.request)
            .then(res => {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});
