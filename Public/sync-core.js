/*
 * MyFlow · núcleo de sincronización sin conexión.
 *
 * Se carga en la página (<script>) y en el service worker (importScripts), así
 * los dos comparten la misma cola de cambios guardada en IndexedDB:
 *
 *   1. La interfaz guarda cada cambio en la cola ("outbox") y continúa al instante.
 *   2. La cola se envía a Firestore por su API REST cuando hay conexión:
 *      - desde la página (al abrirla, al volver a estar en línea, cada pocos segundos), o
 *      - desde el service worker con la API de sincronización en segundo plano
 *        (evento "sync") y la sincronización periódica ("periodicsync"), aunque la
 *        app esté cerrada. Safari/iOS no tiene esas API; ahí se usa la página.
 *
 * Las operaciones son idempotentes (documentos con id fijo), de modo que reenviar
 * un cambio no crea duplicados.
 */
;(function (global) {
  "use strict"
  const DB_NAME = "myflow-sync"
  const DB_VERSION = 1
  const config = {
    base: "https://firestore.googleapis.com/v1/projects/myflow-2ce70/databases/(default)/documents/",
    timeoutMs: 10000
  }
  let dbPromise = null

  function openDB() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true })
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv")
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => { dbPromise = null; reject(request.error) }
    })
    return dbPromise
  }

  // Ejecuta "work" dentro de una transacción usando solo callbacks de IndexedDB
  // (más fiable en Safari que encadenar promesas dentro de la transacción).
  function transaction(store, mode, work) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode)
      let result
      work(tx.objectStore(store), (value) => { result = value })
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error("Transacción cancelada"))
    }))
  }

  const kvGet = (key) => transaction("kv", "readonly", (store, done) => { store.get(key).onsuccess = (e) => done(e.target.result) })
  const kvSet = (key, value) => transaction("kv", "readwrite", (store) => { store.put(value, key) })
  const kvDelete = (key) => transaction("kv", "readwrite", (store) => { store.delete(key) })

  function readAll(store, done) {
    const items = []
    store.openCursor().onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) { items.push(cursor.value); cursor.continue() } else done(items)
    }
  }

  // Añade un cambio a la cola. Si ya hay uno pendiente para el mismo documento se
  // combinan, para no subir veinte versiones de la misma sesión de entrenamiento.
  function enqueue(op) {
    const entry = { uid: op.uid, path: op.path, kind: op.kind, data: op.data || null, rev: 0, createdAt: Date.now() }
    return transaction("outbox", "readwrite", (store, done) => {
      readAll(store, (items) => {
        const samePath = items.filter((item) => item.uid === entry.uid && item.path === entry.path)
        if (entry.kind === "delete") {
          samePath.forEach((item) => store.delete(item.seq))
          store.add(entry)
          return done()
        }
        const last = samePath.at(-1)
        if (last && last.kind !== "delete") {
          last.data = entry.kind === "set" ? entry.data : { ...(last.data || {}), ...entry.data }
          if (entry.kind === "set") last.kind = "set"
          last.rev += 1
          store.put(last)
        } else {
          store.add(entry)
        }
        done()
      })
    })
  }

  const list = (uid) => transaction("outbox", "readonly", (store, done) => readAll(store, (items) => done(items.filter((item) => item.uid === uid))))
  const count = (uid) => list(uid).then((items) => items.length)

  // Borra un cambio ya enviado, salvo que se haya modificado mientras se enviaba.
  function remove(seq, rev) {
    return transaction("outbox", "readwrite", (store) => {
      store.get(seq).onsuccess = (event) => {
        const item = event.target.result
        if (item && item.rev === rev) store.delete(seq)
      }
    })
  }

  // ── Conversión entre objetos JS y el formato de valores de la API REST de Firestore
  function toValue(value) {
    if (value === null || value === undefined) return { nullValue: null }
    if (typeof value === "boolean") return { booleanValue: value }
    if (typeof value === "number") return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
    if (typeof value === "string") return { stringValue: value }
    if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } }
    if (typeof value === "object") return { mapValue: { fields: toFields(value) } }
    return { stringValue: String(value) }
  }
  function toFields(object) {
    const fields = {}
    Object.entries(object || {}).forEach(([key, value]) => { if (value !== undefined) fields[key] = toValue(value) })
    return fields
  }
  function fromValue(value) {
    if (!value) return null
    if ("stringValue" in value) return value.stringValue
    if ("integerValue" in value) return Number(value.integerValue)
    if ("doubleValue" in value) return Number(value.doubleValue)
    if ("booleanValue" in value) return value.booleanValue
    if ("nullValue" in value) return null
    if ("timestampValue" in value) return value.timestampValue
    if ("arrayValue" in value) return (value.arrayValue.values || []).map(fromValue)
    if ("mapValue" in value) return fromFields(value.mapValue.fields)
    return null
  }
  function fromFields(fields) {
    const object = {}
    Object.entries(fields || {}).forEach(([key, value]) => { object[key] = fromValue(value) })
    return object
  }
  const fieldPath = (key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : "`" + key.replace(/[`\\]/g, "\\$&") + "`"
  const docUrl = (path) => config.base + path.split("/").map(encodeURIComponent).join("/")

  async function request(url, options) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try { return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" }) }
    finally { clearTimeout(timer) }
  }

  async function send(entry, token) {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    let response
    if (entry.kind === "delete") {
      response = await request(docUrl(entry.path), { method: "DELETE", headers })
    } else {
      const mask = entry.kind === "merge"
        ? "?" + Object.keys(entry.data || {}).filter((key) => entry.data[key] !== undefined).map((key) => `updateMask.fieldPaths=${encodeURIComponent(fieldPath(key))}`).join("&")
        : ""
      response = await request(docUrl(entry.path) + mask, { method: "PATCH", headers, body: JSON.stringify({ fields: toFields(entry.data) }) })
    }
    if (response.ok || (entry.kind === "delete" && response.status === 404)) return "ok"
    if (response.status === 401 || response.status === 403) return "auth"
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return "rejected"
    return "retry"
  }

  // Envía la cola en orden. Se detiene en el primer fallo de red para conservar el orden.
  async function flushUnlocked(uid, getToken) {
    const items = await list(uid)
    if (!items.length) return { sent: 0, remaining: 0, status: "synced" }
    let token
    // Sin red, renovar el token falla: se trata como "sin conexión" y se reintenta luego.
    try { token = await getToken() } catch { return { sent: 0, remaining: items.length, status: "offline" } }
    if (!token) return { sent: 0, remaining: items.length, status: "auth" }
    let sent = 0
    const rejected = []
    for (const item of items) {
      let outcome
      try { outcome = await send(item, token) } catch { outcome = "retry" }
      if (outcome === "ok") { await remove(item.seq, item.rev); sent++; continue }
      if (outcome === "rejected") { await remove(item.seq, item.rev); rejected.push(item); continue }
      return { sent, remaining: await count(uid), status: outcome === "auth" ? "auth" : "offline", rejected }
    }
    return { sent, remaining: await count(uid), status: "synced", rejected }
  }

  function flush(uid, getToken) {
    if (!uid) return Promise.resolve({ sent: 0, remaining: 0, status: "synced" })
    // Evita que la página y el service worker envíen la cola a la vez.
    if (global.navigator?.locks?.request) {
      return global.navigator.locks.request("myflow-outbox", { ifAvailable: true }, (lock) => lock
        ? flushUnlocked(uid, getToken)
        : count(uid).then((remaining) => ({ sent: 0, remaining, status: "busy" })))
    }
    return flushUnlocked(uid, getToken)
  }

  async function fetchCollection(path, token) {
    const documents = []
    let pageToken = ""
    do {
      const response = await request(`${docUrl(path)}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      ;(body.documents || []).forEach((document) => documents.push({ id: document.name.split("/").pop(), ...fromFields(document.fields) }))
      pageToken = body.nextPageToken || ""
    } while (pageToken)
    return documents
  }
  async function fetchDocument(path, token) {
    const response = await request(docUrl(path), { headers: { Authorization: `Bearer ${token}` } })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    return fromFields(body.fields)
  }

  // Aplica los cambios pendientes sobre datos leídos del servidor o de la caché,
  // para que la interfaz muestre siempre la versión más reciente del usuario.
  function overlay(uid, data, items) {
    const result = { routines: [...(data.routines || [])], sessions: [...(data.sessions || [])], profile: data.profile ? { ...data.profile } : null }
    for (const item of items) {
      const [, , collectionName, id] = item.path.split("/")
      if (collectionName === "profile") {
        if (item.kind === "delete") result.profile = null
        else result.profile = item.kind === "set" ? { ...item.data } : { ...(result.profile || {}), ...item.data }
        continue
      }
      const listName = collectionName === "routines" ? "routines" : collectionName === "sessions" ? "sessions" : null
      if (!listName) continue
      const index = result[listName].findIndex((entry) => entry.id === id)
      if (item.kind === "delete") { if (index >= 0) result[listName].splice(index, 1); continue }
      const next = item.kind === "set" ? { id, ...item.data } : { ...(index >= 0 ? result[listName][index] : { id }), ...item.data, id }
      if (index >= 0) result[listName][index] = next; else result[listName].push(next)
    }
    return result
  }

  // Credenciales de corta duración (ID token de Firebase, ~1 h) para que el service
  // worker pueda sincronizar sin la página abierta. Se borran al cerrar sesión.
  const setAuth = (uid, token, expiresAt) => Promise.all([kvSet("currentUid", uid), kvSet(`auth:${uid}`, { token, expiresAt })])
  async function clearAuth() {
    const uid = await kvGet("currentUid")
    await kvDelete("currentUid")
    if (uid) await kvDelete(`auth:${uid}`)
  }
  async function getStoredAuth() {
    const uid = await kvGet("currentUid")
    if (!uid) return null
    const auth = await kvGet(`auth:${uid}`)
    return { uid, token: auth && auth.expiresAt - Date.now() > 60000 ? auth.token : null }
  }

  const saveSnapshot = (uid, data) => kvSet(`snapshot:${uid}`, { ...data, savedAt: Date.now() })
  const loadSnapshot = (uid) => kvGet(`snapshot:${uid}`)

  function updateBadge(pending) {
    const nav = global.navigator
    try {
      if (pending > 0 && nav?.setAppBadge) nav.setAppBadge(pending).catch(() => {})
      else if (nav?.clearAppBadge) nav.clearAppBadge().catch(() => {})
    } catch { /* La API de distintivos es opcional. */ }
  }

  function newId() {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    const bytes = new Uint8Array(20)
    global.crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
  }

  global.MyFlowSync = {
    config, enqueue, list, count, flush, overlay, fetchCollection, fetchDocument,
    setAuth, clearAuth, getStoredAuth, saveSnapshot, loadSnapshot, updateBadge, newId,
    SYNC_TAG: "myflow-outbox", PERIODIC_TAG: "myflow-refresh"
  }
})(typeof self !== "undefined" ? self : window)
