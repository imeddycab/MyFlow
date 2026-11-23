const CACHE = "myflow-shell-v13"
const SHELL = ["/", "/app.css?v=20261123-ui1", "/app.js?v=20261123-ui1", "/firebase.js?v=20261119-offline1", "/share-result.js", "/manifest.webmanifest", "/assets/favicon.png", "/favicon.ico", "/assets/favicon-16.png", "/assets/favicon-32.png", "/assets/apple-touch-icon.png", "/assets/icon.svg", "/assets/safari-pinned-tab.svg", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-maskable-512.png"]
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))))
  self.clients.claim()
})
self.addEventListener("sync", (event) => {
  if (event.tag !== "myflow-firestore-sync") return
  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    if (!openClients.length) return
    const results = await Promise.all(openClients.map((client) => new Promise((resolve) => {
      const channel = new MessageChannel()
      const timeout = setTimeout(() => resolve(false), 18000)
      channel.port1.onmessage = (message) => {
        clearTimeout(timeout)
        resolve(message.data?.ok === true)
      }
      client.postMessage({ type: "MYFLOW_SYNC_PENDING_WRITES" }, [channel.port2])
    })))
    if (results.some((synced) => !synced)) throw new Error("MyFlow todavía tiene cambios pendientes.")
  })())
})
self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  const firebaseModule = url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/13.3.0/")
  if (request.method !== "GET" || (url.origin !== location.origin && !firebaseModule) || url.pathname.startsWith("/api/")) return
  event.respondWith(fetch(request).then((response) => {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
    return response
  }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))))
})
