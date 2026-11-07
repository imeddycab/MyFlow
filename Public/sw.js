const CACHE = "myflow-shell-v3"
const SHELL = ["/", "/app.css", "/app.js", "/share-result.js", "/manifest.webmanifest", "/assets/favicon.png"]
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))))
  self.clients.claim()
})
self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return
  event.respondWith(fetch(request).then((response) => {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
    return response
  }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))))
})
