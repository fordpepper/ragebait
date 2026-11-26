// A tiny service worker with two jobs:
// 1. GitHub Pages can't send the COOP/COEP headers that unlock multi-threaded WebAssembly, so it adds them.
//    Threads make Gus reply much faster on CPU. The page reloads once, the first time, to switch them on.
// 2. It keeps a copy of the page's own files so Gus opens offline. (The model itself is cached by
//    transformers.js in its own cache, so it is not copied twice.)
const SHELL = 'gus-shell-v3';

if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('gus-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })()));

  const isolate = (res) => {
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  };

  self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.method !== 'GET' || r.headers.has('range')) return;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    const url = new URL(r.url);
    const same = url.origin === self.location.origin;
    const keep = (same && !url.pathname.includes('/models/')) || url.hostname === 'cdn.jsdelivr.net';
    e.respondWith((async () => {
      try {
        let res = await fetch(r);
        if (same && res.status !== 0) res = isolate(res);
        if (keep && res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(SHELL).then((c) => c.put(r, copy)).catch(() => {}));
        }
        return res;
      } catch (err) {
        const hit = keep && await caches.match(r, { ignoreSearch: true, cacheName: SHELL });
        if (hit) return hit;
        throw err;
      }
    })());
  });
} else if (window.isSecureContext && 'serviceWorker' in navigator) {
  const reg = navigator.serviceWorker.register(document.currentScript.src);
  // Reload once when the worker first takes control. If a controlled page still isn't isolated,
  // the browser doesn't support it and Gus just runs single-threaded (no reload loop).
  if (!window.crossOriginIsolated && !navigator.serviceWorker.controller) {
    window.__coiReload = reg.then((r) => new Promise((resolve) => {
      const sw = r.installing || r.waiting || r.active;
      if (!sw) return resolve();
      const go = () => location.reload();   // the page goes away; the promise never needs to resolve
      if (sw.state === 'activated') go();
      else sw.addEventListener('statechange', () => sw.state === 'activated' && go());
    }), () => {});
  }
}
