// Aguacater: copia local para abrir la app sin cobertura
const CACHE = "aguacater-v3";
const CORE = ["./", "./index.html", "./sync.js", "./icon-180.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => fetch(u, {cache: "no-cache"}).then(r => c.put(u, r))))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return; // GitHub, SIGPAC y ortofotos van directas a la red
  // Red primero, saltándose la caché del navegador, para recibir siempre la última versión; sin cobertura, la copia guardada
  e.respondWith(fetch(e.request.url, {cache: "no-cache", credentials: "same-origin"}).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, {ignoreSearch: true}).then(r => r || caches.match("./index.html"))));
});
