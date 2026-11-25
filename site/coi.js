// GitHub Pages can't send the COOP/COEP headers that unlock multi-threaded WebAssembly,
// so this tiny service worker adds them. Threads make Gus reply much faster on CPU.
// It registers itself on the first visit and reloads once; after that it's silent.
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    e.respondWith(fetch(r).then((res) => {
      if (res.status === 0 || new URL(r.url).origin !== self.location.origin) return res;
      const h = new Headers(res.headers);
      h.set('Cross-Origin-Embedder-Policy', 'credentialless');
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }).catch(() => fetch(r)));
  });
} else if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
    if (sessionStorage.getItem('coi-reloaded')) return;
    const go = () => { sessionStorage.setItem('coi-reloaded', '1'); location.reload(); };
    if (reg.active && !navigator.serviceWorker.controller) go();
    else (reg.installing || reg.waiting)?.addEventListener('statechange', (ev) => ev.target.state === 'activated' && go());
  });
}
