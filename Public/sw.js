/*
 * Service worker de MyFlow.
 * - Caché de la app para abrirla sin conexión y actualizarla en segundo plano.
 * - Sincronización en segundo plano ("sync"): sube la cola de cambios guardada en
 *   IndexedDB cuando vuelve la conexión, aunque la app esté cerrada.
 * - Sincronización periódica ("periodicsync"): actualiza la app y tus datos de vez en cuando.
 * Safari/iOS no implementa "sync" ni "periodicsync"; allí la página hace el mismo trabajo al abrirse.
 */
importScripts("/sync-core.js?v=20261123-sync1")

const CACHE = "myflow-shell-v14"
const SHELL = ["/", "/app.css?v=20261123-sync1", "/app.js?v=20261123-sync1", "/firebase.js?v=20261119-offline1", "/share-result.js", "/sync-core.js?v=20261123-sync1", "/manifest.webmanifest", "/assets/favicon.png", "/favicon.ico", "/assets/favicon-16.png", "/assets/favicon-32.png", "/assets/apple-touch-icon.png", "/assets/icon.svg", "/assets/safari-pinned-tab.svg", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-maskable-512.png"]
const FIREBASE_MODULES = ["app", "auth", "firestore"].map((name) => `https://www.gstatic.com/firebasejs/13.3.0/firebase-${name}.js`)
const LEGACY_SYNC_TAG = "myflow-firestore-sync"

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(SHELL)
    // Los módulos de Firebase son necesarios para abrir la app sin conexión; si fallan
    // ahora, se guardarán la próxima vez que se descarguen.
    await Promise.allSettled(FIREBASE_MODULES.map((url) => cache.add(url)))
  })())
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

// ── Caché
async function networkFirst(request, timeoutMs) {
  const cache = await caches.open(CACHE)
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
    ])
    if (response.ok) cache.put("/", response.clone())
    return response
  } catch {
    return (await cache.match("/")) || Response.error()
  }
}

// Responde con la copia guardada al instante y la actualiza en segundo plano.
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(event.request)
  const network = fetch(event.request).then((response) => {
    if (response.ok) cache.put(event.request, response.clone())
    return response
  })
  if (cached) {
    event.waitUntil(network.catch(() => {}))
    return cached
  }
  return network
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  const firebaseModule = url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/13.3.0/")
  if (request.method !== "GET" || (url.origin !== location.origin && !firebaseModule) || url.pathname.startsWith("/api/")) return
  if (request.mode === "navigate") {
    // Con mala cobertura no se espera más de 3,5 s: se abre la copia guardada.
    event.respondWith(networkFirst(request, 3500))
    return
  }
  event.respondWith(staleWhileRevalidate(event))
})

// ── Sincronización
async function broadcast(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  windows.forEach((client) => client.postMessage(message))
  return windows
}

// Si el token guardado caducó, se pide a una ventana abierta que suba la cola.
async function askWindowsToFlush() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  if (!windows.length) return false
  const results = await Promise.all(windows.map((client) => new Promise((resolve) => {
    const channel = new MessageChannel()
    const timeout = setTimeout(() => resolve(false), 20000)
    channel.port1.onmessage = (message) => { clearTimeout(timeout); resolve(message.data?.ok === true) }
    client.postMessage({ type: "MYFLOW_SYNC_PENDING_WRITES" }, [channel.port2])
  })))
  return results.some(Boolean)
}

async function syncOutbox() {
  const stored = await MyFlowSync.getStoredAuth()
  if (!stored) return
  let result = { sent: 0, remaining: await MyFlowSync.count(stored.uid), status: "auth" }
  if (!result.remaining) { MyFlowSync.updateBadge(0); return }
  if (stored.token) result = await MyFlowSync.flush(stored.uid, async () => stored.token)
  if (result.status === "auth" && await askWindowsToFlush()) result = { ...result, remaining: await MyFlowSync.count(stored.uid), status: "synced" }
  MyFlowSync.updateBadge(result.remaining)
  await broadcast({ type: "MYFLOW_SYNC_DONE", sent: result.sent, remaining: result.remaining })
  // Lanzar un error indica al navegador que vuelva a intentarlo más tarde.
  if (result.remaining && result.status === "offline") throw new Error("MyFlow todavía tiene cambios pendientes.")
}

self.addEventListener("sync", (event) => {
  if (event.tag === MyFlowSync.SYNC_TAG || event.tag === LEGACY_SYNC_TAG) event.waitUntil(syncOutbox())
})

// ── Actualización periódica en segundo plano
async function refreshShell() {
  const cache = await caches.open(CACHE)
  await Promise.allSettled(SHELL.map(async (url) => {
    const response = await fetch(url, { cache: "no-cache" })
    if (response.ok) await cache.put(url, response)
  }))
}

async function refreshUserData() {
  const stored = await MyFlowSync.getStoredAuth()
  if (!stored?.token) return
  const base = `users/${stored.uid}`
  const [routines, sessions, profile] = await Promise.all([
    MyFlowSync.fetchCollection(`${base}/routines`, stored.token),
    MyFlowSync.fetchCollection(`${base}/sessions`, stored.token),
    MyFlowSync.fetchDocument(`${base}/profile/main`, stored.token)
  ])
  await MyFlowSync.saveSnapshot(stored.uid, { routines, sessions, profile })
  await broadcast({ type: "MYFLOW_DATA_REFRESHED" })
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag !== MyFlowSync.PERIODIC_TAG) return
  event.waitUntil(Promise.allSettled([
    refreshShell(),
    // Primero se suben los cambios pendientes y después se descargan los datos.
    syncOutbox().catch(() => {}).then(refreshUserData)
  ]))
})
