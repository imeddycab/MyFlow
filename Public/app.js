let auth, firestore, googleProvider
let onAuthStateChanged, onIdTokenChanged, signInWithPopup, signInWithRedirect, signOut
let collection, doc, getDoc, getDocFromCache, getDocs, getDocsFromCache
let firebaseLoadError = null
try {
  const [firebase, authSDK, firestoreSDK] = await Promise.all([
    import("./firebase.js?v=20261119-offline1"),
    import("https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js")
  ])
  auth = firebase.auth
  firestore = firebase.firestore
  googleProvider = firebase.googleProvider
  ;({ onAuthStateChanged, onIdTokenChanged, signInWithPopup, signInWithRedirect, signOut } = authSDK)
  ;({ collection, doc, getDoc, getDocFromCache, getDocs, getDocsFromCache } = firestoreSDK)
} catch (error) {
  firebaseLoadError = error
}

const view = document.querySelector("#view")
const title = document.querySelector("#page-title")
const notice = document.querySelector("#notice")
const routineDialog = document.querySelector("#routine-dialog")
const exerciseDialog = document.querySelector("#exercise-dialog")
const routineForm = document.querySelector("#routine-form")
const exerciseForm = document.querySelector("#exercise-form")
const defaultExercises = [
  ["Press de banca", "Pecho", "Barra"], ["Sentadilla trasera", "Cuádriceps", "Barra"],
  ["Remo inclinado", "Espalda", "Barra"], ["Press militar", "Hombros", "Mancuernas"],
  ["Peso muerto rumano", "Isquiotibiales", "Barra"], ["Curl inclinado", "Bíceps", "Mancuernas"],
  ["Extensión en polea", "Tríceps", "Polea"], ["Elevación lateral", "Hombros", "Mancuernas"],
]
let routines = []
let sessions = []
let profile = null
let libraryExercises = defaultExercises.map(([name, muscle, equipment]) => ({ name, muscle, equipment, favorite: false }))
let favorites = new Set()
let plans = {}
let settings = {}
let personalNotes = ""
let page = "inicio", routineTab = "Todos", period = "3 meses", selectedDay = new Date(), monthCursor = new Date()
let activeSession = null, activeRoutine = null, lastCompleted = null, sets = [], sessionSeconds = 0, restSeconds = 0
let paused = false, workoutStartedAt = 0, timerHandle = null, restHandle = null, restTotal = 0, editingExercises = [], routineSaving = false
let libraryFilters = { search: "", muscle: "Todos", equipment: "Todo", favorites: false }
let currentUser = null
const Sync = window.MyFlowSync
const userPath = (...parts) => ["users", currentUser.uid, ...parts].join("/")
let pendingCount = 0, pendingPaths = new Set(), syncState = "synced", flushing = null, flushTimer = null, dataReady = false

// ── Estado de sincronización (barra lateral, chip del encabezado y distintivo del icono)
function updateSyncStatus() {
  const offline = !navigator.onLine || syncState === "offline"
  const changes = `${pendingCount} ${pendingCount === 1 ? "cambio" : "cambios"}`
  let state, text, short
  if (syncState === "auth" && pendingCount) { state = "auth"; text = `Vuelve a iniciar sesión para subir ${changes}`; short = `${pendingCount}` }
  else if (offline) { state = "offline"; text = pendingCount ? `Sin conexión · ${changes} guardados en este dispositivo` : "Sin conexión · puedes seguir usando MyFlow"; short = pendingCount ? `${pendingCount}` : "" }
  else if (syncState === "syncing" && pendingCount) { state = "syncing"; text = `Subiendo ${changes}…`; short = `${pendingCount}` }
  else if (pendingCount) { state = "pending"; text = `${changes} por subir`; short = `${pendingCount}` }
  else { state = "synced"; text = "Todo sincronizado"; short = "" }
  const status = document.querySelector("#sync-status")
  if (status) { status.textContent = text; status.dataset.state = state }
  const chip = document.querySelector("#sync-chip")
  if (chip) {
    chip.dataset.state = state
    chip.title = `${text}. Pulsa para sincronizar ahora.`
    chip.setAttribute("aria-label", chip.title)
    chip.querySelector(".sync-chip-count").textContent = short
    chip.querySelector(".sync-chip-text").textContent = state === "synced" ? "Sincronizado" : state === "offline" ? "Sin conexión" : state === "auth" ? "Reconectar" : "Pendiente"
  }
}

async function refreshPending() {
  if (!currentUser) return
  try {
    const items = await Sync.list(currentUser.uid)
    pendingCount = items.length
    pendingPaths = new Set(items.map((item) => item.path))
  } catch { pendingCount = 0; pendingPaths = new Set() }
  updateSyncStatus()
  Sync.updateBadge(pendingCount)
}
const isPending = (collectionName, id) => Boolean(currentUser) && pendingPaths.has(userPath(collectionName, id))

// Se agrupa y se retrasa un instante para guardar el estado ya actualizado por quien llamó.
function persistSnapshot() {
  clearTimeout(persistSnapshot.timer)
  persistSnapshot.timer = setTimeout(() => {
    if (!currentUser || !dataReady) return
    Sync.saveSnapshot(currentUser.uid, { routines, sessions, profile }).catch(() => {})
  }, 60)
}

// API de sincronización en segundo plano (Chrome, Edge, Android). Safari no la
// tiene: en ese caso la página reintenta al abrirse, al volver la conexión y cada pocos segundos.
async function requestBackgroundSync() {
  if (!navigator.serviceWorker) return false
  try {
    const registration = await navigator.serviceWorker.ready
    if (registration.sync?.register) { await registration.sync.register(Sync.SYNC_TAG); return true }
  } catch (error) { console.info("Sincronización en segundo plano no disponible.", error) }
  return false
}

// Sincronización periódica: el service worker actualiza la app y tus datos aunque no la abras.
async function registerPeriodicSync() {
  try {
    const registration = await navigator.serviceWorker?.ready
    if (!registration?.periodicSync) return
    const status = await navigator.permissions.query({ name: "periodic-background-sync" })
    if (status.state === "granted") await registration.periodicSync.register(Sync.PERIODIC_TAG, { minInterval: 12 * 60 * 60 * 1000 })
  } catch (error) { console.info("Sincronización periódica no disponible.", error) }
}

function scheduleFlush(delay = 0) {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushOutbox() }, delay)
}

async function flushOutbox({ manual = false } = {}) {
  if (!currentUser) return { remaining: 0 }
  if (flushing) return flushing
  flushing = (async () => {
    await refreshPending()
    if (!pendingCount) { syncState = "synced"; updateSyncStatus(); if (manual) showNotice("Todo está sincronizado."); return { remaining: 0 } }
    syncState = "syncing"; updateSyncStatus()
    const user = currentUser
    const result = await Sync.flush(user.uid, () => user.getIdToken())
    syncState = result.status === "busy" ? "syncing" : result.status
    await refreshPending()
    if (result.rejected?.length) showNotice(`Firestore rechazó ${result.rejected.length} cambio(s); se descartaron para no bloquear la cola.`)
    if (result.remaining) {
      // Reintento con espera creciente mientras la app esté visible.
      const delay = result.status === "busy" ? 3000 : Math.min(60000, 8000 * (flushOutbox.failures = (flushOutbox.failures || 0) + 1))
      if (document.visibilityState === "visible") scheduleFlush(delay)
      requestBackgroundSync()
      if (manual) showNotice(result.status === "auth" ? "Tu sesión caducó: vuelve a iniciar sesión para subir los cambios." : "Sin conexión. Tus cambios siguen guardados y se subirán solos.")
    } else {
      flushOutbox.failures = 0
      if (result.sent && manual) showNotice("Cambios subidos a tu cuenta.")
      else if (result.sent) showNotice(`${result.sent === 1 ? "1 cambio sincronizado" : `${result.sent} cambios sincronizados`} con tu cuenta.`)
    }
    if (result.sent) render()
    return result
  })().finally(() => { flushing = null })
  return flushing
}

// Guarda el cambio en la cola local y devuelve el control a la interfaz al instante.
async function queueWrite(kind, path, data) {
  try { await Sync.enqueue({ uid: currentUser.uid, kind, path, data }) }
  catch (error) { throw new Error(`No se pudo guardar en este dispositivo: ${error.message}`) }
  await refreshPending()
  persistSnapshot()
  if (navigator.onLine) scheduleFlush(300)
  requestBackgroundSync()
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Tiempo de espera agotado"), { code: "deadline-exceeded" })), ms) })]).finally(() => clearTimeout(timer))
}
// Lecturas: servidor con tiempo límite y, si falla, la caché local de Firestore.
async function readDocument(ref) {
  try { return await withTimeout(getDoc(ref), navigator.onLine ? 8000 : 1500) }
  catch (error) { try { return await getDocFromCache(ref) } catch { throw error } }
}
async function readCollection(ref) {
  try { return await withTimeout(getDocs(ref), navigator.onLine ? 8000 : 1500) }
  catch (error) { try { return await getDocsFromCache(ref) } catch { throw error } }
}

async function api(path, options = {}) {
  if (!currentUser) throw new Error("Inicia sesión para acceder a tus datos.")
  const method = options.method || "GET"
  const payload = options.body ? JSON.parse(options.body) : {}
  const parts = path.split("/").filter(Boolean)
  const collectionName = parts[0]
  const now = new Date().toISOString()

  if (path === "profile") {
    if (method === "GET") {
      const snapshot = await readDocument(doc(firestore, "users", currentUser.uid, "profile", "main"))
      return { profile: snapshot.exists() ? snapshot.data() : null }
    }
    if (method === "PUT") {
      const name = String(payload.name || "").trim()
      if (!name) throw new Error("Escribe tu nombre para continuar.")
      const profileData = { ...(profile || {}), name, hasCompletedIntro: payload.hasCompletedIntro ?? profile?.hasCompletedIntro === true, updatedAt: now }
      await queueWrite("merge", userPath("profile", "main"), profileData)
      return profileData
    }
  }

  if (collectionName === "routines") {
    if (parts.length === 1 && method === "GET") {
      const snapshots = await readCollection(collection(firestore, "users", currentUser.uid, "routines"))
      // Quita solo las cuatro rutinas de ejemplo sin tocar que creaban versiones antiguas.
      const sampleDescriptions = new Map([["Push Day", "Pecho · Hombros · Tríceps"], ["Pull Strength", "Espalda · Bíceps"], ["Leg Power", "Cuádriceps · Glúteos"], ["Upper Hypertrophy", "Torso completo"]])
      const isSample = (item) => sampleDescriptions.get(item.name) === item.description && !item.dayOfWeek && (!item.exercises || item.exercises.length === 0)
      const list = snapshots.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
      for (const item of list.filter(isSample)) await queueWrite("delete", userPath("routines", item.id))
      return list.filter((item) => !isSample(item))
    }
    if (parts.length === 1 && method === "POST") {
      const id = Sync.newId(), routine = { ...payload, updatedAt: now }
      await queueWrite("set", userPath("routines", id), routine)
      return { id, ...routine }
    }
    if (parts.length === 2 && method === "PUT") {
      const routine = { ...payload, updatedAt: now }
      await queueWrite("merge", userPath("routines", parts[1]), routine)
      return { ...(routines.find((item) => item.id === parts[1]) || {}), ...routine, id: parts[1] }
    }
    if (parts.length === 2 && method === "DELETE") {
      await queueWrite("delete", userPath("routines", parts[1]))
      return null
    }
  }

  if (collectionName === "sessions") {
    if (parts.length === 1 && method === "GET") {
      const snapshots = await readCollection(collection(firestore, "users", currentUser.uid, "sessions"))
      return snapshots.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
    }
    if (parts.length === 1 && method === "POST") {
      const id = Sync.newId(), session = { ...payload, startedAt: now, updatedAt: now, finishedAt: null }
      await queueWrite("set", userPath("sessions", id), session)
      return { id, ...session }
    }
    if (parts.length === 2 && method === "PUT") {
      const { id: _id, ...previous } = sessions.find((item) => item.id === parts[1]) || {}
      const session = { ...previous, ...payload, updatedAt: now }
      await queueWrite("merge", userPath("sessions", parts[1]), session)
      return { id: parts[1], ...session }
    }
    if (parts.length === 3 && parts[2] === "finish" && method === "POST") {
      const changes = { finishedAt: now, updatedAt: now }
      await queueWrite("merge", userPath("sessions", parts[1]), changes)
      return { ...(sessions.find((item) => item.id === parts[1]) || {}), ...changes, id: parts[1] }
    }
    if (parts.length === 2 && method === "DELETE") {
      await queueWrite("delete", userPath("sessions", parts[1]))
      return null
    }
  }

  throw new Error(`Operación no compatible: ${method} ${path}`)
}
function showNotice(message) {
  // Los diálogos modales viven en la capa superior: el aviso se mueve dentro del
  // diálogo abierto para que no quede oculto detrás del fondo.
  const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body
  if (notice.parentElement !== host) host.append(notice)
  notice.textContent = message; notice.hidden = false; clearTimeout(showNotice.timeout)
  showNotice.timeout = setTimeout(() => { notice.hidden = true }, 4200)
}
function fmtVolume(kg) { const value = settings.units === "lb" ? kg * 2.20462 : kg; return `${Math.round(value).toLocaleString("es-MX")} ${settings.units === "lb" ? "lb" : "kg"}` }
function estimateMinutes(routine) { return Math.max(20, exerciseData(routine).length * 12) }
function totalSetsOf(routine) { return exerciseData(routine).reduce((sum, item) => sum + Number(item.sets || 3), 0) }
function sessionMinutes(session) {
  if (session.durationSeconds) return Math.max(1, Math.round(session.durationSeconds / 60))
  const end = session.finishedAt ? new Date(session.finishedAt) : new Date()
  return Math.max(1, Math.round((end - new Date(session.startedAt)) / 60000))
}
const weekdayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
function esc(value = "") { return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]) }
function fmtDate(value, options = { dateStyle: "medium" }) { return new Date(value).toLocaleString("es-MX", options) }
function fmtTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` }
function fmtWeight(value) { return settings.units === "lb" ? `${(Number(value) * 2.20462).toFixed(1)} lb` : `${Number(value).toLocaleString("es-MX", { maximumFractionDigits: 1 })} kg` }
function toKg(value) { return settings.units === "lb" ? Number(value) / 2.20462 : Number(value) }
function saveLocal() {
  if(!currentUser)return
  const key=(name)=>`myflow-${currentUser.uid}-${name}`
  localStorage.setItem(key("exercises"), JSON.stringify(libraryExercises))
  localStorage.setItem(key("favorites"), JSON.stringify([...favorites]))
  localStorage.setItem(key("plans"), JSON.stringify(plans))
  localStorage.setItem(key("preferences"), JSON.stringify(settings))
  localStorage.setItem(key("notes"), personalNotes)
}
function loadLocal() {
  const key=(name)=>`myflow-${currentUser.uid}-${name}`
  try{libraryExercises=JSON.parse(localStorage.getItem(key("exercises"))||"null")||defaultExercises.map(([name,muscle,equipment])=>({name,muscle,equipment,favorite:false}))}catch{libraryExercises=defaultExercises.map(([name,muscle,equipment])=>({name,muscle,equipment,favorite:false}))}
  try{favorites=new Set(JSON.parse(localStorage.getItem(key("favorites"))||"[]"))}catch{favorites=new Set()}
  try{plans=JSON.parse(localStorage.getItem(key("plans"))||"{}")}catch{plans={}}
  try{settings=JSON.parse(localStorage.getItem(key("preferences"))||"{}")}catch{settings={}}
  personalNotes=localStorage.getItem(key("notes"))||""
  applyTheme()
}
const pageLabels = { inicio: "Inicio", rutinas: "Mis rutinas", entrenar: "Entrenamiento", biblioteca: "Biblioteca de ejercicios", progreso: "Progreso y estadísticas", historial: "Historial", calendario: "Calendario", perfil: "Perfil y preferencias", herramientas: "Herramientas", resumen: "Sesión completada" }
const morePages = ["biblioteca", "calendario", "perfil", "herramientas", "progreso"]
function pageFromHash() {
  const next = location.hash.slice(1)
  if (next === "resumen" && !lastCompleted) return "inicio"
  return pageLabels[next] ? next : null
}
// Cada sección tiene su propia URL (#rutinas, #historial…), así funcionan
// el botón Atrás del navegador, el gesto de volver en el móvil y los enlaces.
function navTitle(next, { fromHistory = false, replace = false } = {}) {
  if (!pageLabels[next]) next = "inicio"
  const changed = next !== page
  page = next; title.textContent = pageLabels[next]
  document.title = next === "inicio" ? "MyFlow · Entrenamiento" : `${pageLabels[next]} · MyFlow`
  if (!fromHistory && location.hash !== `#${next}`) history[replace ? "replaceState" : "pushState"]({ page: next }, "", `#${next}`)
  updateNavState()
  document.querySelector("#more-menu").hidden = true
  document.querySelector("#more-button").setAttribute("aria-expanded", "false")
  render()
  if (changed) window.scrollTo({ top: 0, behavior: fromHistory ? "auto" : "smooth" })
}
function updateNavState() {
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === page
    button.classList.toggle("active", active)
    if (button.closest("nav")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current")
  })
  const moreButton = document.querySelector("#more-button")
  moreButton?.classList.toggle("active", morePages.includes(page))
  const live = Boolean(activeSession && !activeSession.finishedAt)
  document.querySelectorAll('nav [data-page="entrenar"]').forEach((button) => {
    button.classList.toggle("has-live", live)
    button.title = live ? "Tienes una sesión en curso" : ""
  })
}
window.addEventListener("popstate", () => { if (currentUser) navTitle(pageFromHash() || "inicio", { fromHistory: true }) })
function exerciseData(routine) {
  return routine?.exercises || []
}
function routineCard(routine, index) {
  const ex = exerciseData(routine)
  return `<article class="routine-card"><header><div><h3>${esc(routine.name)}</h3><p>${esc(routine.description || "Rutina personalizada")}</p></div><span class="routine-tag">${routine.dayOfWeek ? esc(routine.dayOfWeek.toUpperCase()) : `0${(index % 9) + 1}`}</span></header>${isPending("routines", routine.id) ? pendingTag() : ""}<div class="routine-meta"><span>${plural(ex.length,"ejercicio")} · ${totalSetsOf(routine)} series</span><span>~${estimateMinutes(routine)} min</span></div><div class="routine-actions"><button class="button secondary" data-edit="${routine.id}">Editar</button><button class="button" data-start="${routine.id}">▶ Iniciar</button><button class="icon-button delete-routine" data-delete="${routine.id}" aria-label="Eliminar rutina">×</button></div></article>`
}
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}` }
function pendingTag() { return `<span class="pending-tag" title="Guardado en este dispositivo; se subirá a tu cuenta al recuperar la conexión">⟳ Sin subir</span>` }
function volumeOf(session) { return (session?.sets || []).filter((set) => set.completed).reduce((sum, set) => sum + Number(set.weight) * Number(set.reps), 0) }
function doneSessions() { return sessions.filter((session) => session.finishedAt) }
function todaysRoutine() {
  const today = weekdayNames[new Date().getDay()]
  return routines.find((routine) => routine.dayOfWeek === today) || routines[0]
}
function renderHome() {
  const routine = todaysRoutine(), completed = doneSessions(), volume = completed.reduce((sum, session) => sum + volumeOf(session), 0)
  const recent = [...sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 3)
  return `<section class="hero"><div class="hero-copy"><span class="eyebrow">ENTRENAMIENTO DE HOY</span><h2>${esc(routine?.name || "Tu primera rutina")}</h2><p>${esc(routine?.description || "Crea tu propia rutina para empezar.")}</p><div class="chips"><span class="chip">${routine?`${plural(exerciseData(routine).length,"ejercicio")}`:"Sin rutinas"}</span>${routine?`<span class="chip">${totalSetsOf(routine)} series</span><span class="chip">~${estimateMinutes(routine)} min</span>`:""}</div>${routine?`<button class="button" data-start="${routine.id}">▶ &nbsp;Comenzar entrenamiento</button>`:`<button class="button" data-create-routine>＋ &nbsp;Crear mi primera rutina</button>`}</div></section><div class="section-head"><div><span class="eyebrow">RESUMEN</span><h2>Tu semana en movimiento</h2></div><button class="text-button" data-page="progreso">Ver estadísticas →</button></div><div class="stats"><article class="stat"><small>Entrenamientos</small><strong>${completed.length}</strong><span>${sessions.length ? `${sessions.length} sesiones registradas` : "Empieza tu primera sesión"}</span></article><article class="stat"><small>Tiempo total</small><strong>${completed.reduce((a,s)=>a+sessionMinutes(s),0)} min</strong><span>Sesiones completadas</span></article><article class="stat"><small>Volumen acumulado</small><strong>${fmtVolume(volume)}</strong><span>Series registradas</span></article></div><div class="section-head"><div><span class="eyebrow">TUS PLANES</span><h2>Mis rutinas</h2></div><button class="text-button" data-page="rutinas">Ver todas →</button></div><div class="routine-grid">${routines.slice(0,3).map(routineCard).join("") || `<div class="empty">Todavía no tienes rutinas. Crea una para empezar.</div>`}</div><div class="section-head"><div><span class="eyebrow">ACTIVIDAD</span><h2>Últimos entrenamientos</h2></div><button class="text-button" data-page="historial">Ver historial</button></div><div class="history-list">${recent.map(sessionRow).join("") || `<div class="empty">Tus sesiones aparecerán aquí.</div>`}</div>`
}
function renderRoutines() {
  const tabs = ["Todos", "Con día asignado", "Sin día"]
  if (!tabs.includes(routineTab)) routineTab = "Todos"
  const visible = routines.filter((r) => routineTab === "Todos" || (routineTab === "Con día asignado" ? Boolean(r.dayOfWeek) : !r.dayOfWeek))
  const next = todaysRoutine()
  const scheduled = routines.filter((r) => r.dayOfWeek).length
  const weekPct = routines.length ? Math.round(scheduled / routines.length * 100) : 0
  const program = next ? `<section class="program"><div><span class="eyebrow">PRÓXIMO ENTRENAMIENTO</span><h2>${esc(next.name)}</h2><p>${next.dayOfWeek ? `Programada para ${esc(next.dayOfWeek.toLocaleLowerCase("es-MX"))}` : "Sin día asignado"} · ${plural(exerciseData(next).length,"ejercicio")} · ~${estimateMinutes(next)} min</p></div><strong>${scheduled}/${routines.length}<small>con día</small><span class="progress-track"><i style="width:${weekPct}%"></i></span></strong><button class="button" data-start="${next.id}">Entrenar ahora</button></section>` : ""
  return `${program}<div class="section-head${program ? "" : " page-section-head"}"><div><span class="eyebrow">PLANIFICACIÓN</span><h2>Mis rutinas</h2></div><button class="button" data-create-routine>＋ Crear rutina</button></div><div class="tabs">${tabs.map((x)=>`<button data-routine-tab="${x}" class="${routineTab===x?"active":""}">${x}</button>`).join("")}</div><div class="routine-grid">${visible.map(routineCard).join("") || `<div class="empty">No hay rutinas en esta categoría todavía.</div>`}<button class="create-card" data-create-routine><span>＋</span><b>Crear nueva rutina</b><small>Diseña tu próximo entrenamiento</small></button></div>`
}
function renderExerciseEditor() {
  return editingExercises.map((exercise, index) => `<article class="routine-exercise" data-exercise-row="${index}"><span class="drag-mark">⠿</span><div class="exercise-name"><b>${esc(exercise.name)}</b><small>${esc(exercise.muscle || "Fuerza")} · ${esc(exercise.equipment || "Equipo")}</small></div><label>Series<input type="number" min="1" max="20" value="${Number(exercise.sets||3)}" data-routine-field="sets" data-index="${index}"></label><label>Reps<input value="${esc(exercise.reps||"8–12")}" data-routine-field="reps" data-index="${index}"></label><label>Descanso (s)<input type="number" min="5" max="900" step="5" value="${Number(exercise.restSeconds||90)}" data-routine-field="restSeconds" data-index="${index}"></label><button type="button" class="icon-button" data-remove-routine-exercise="${index}" aria-label="Quitar ejercicio">×</button></article>`).join("")
}
function openRoutineEditor(routine) {
  routineForm.reset(); routineForm.elements.id.value = routine?.id || ""; routineForm.elements.name.value = routine?.name || ""; routineForm.elements.description.value = routine?.description || ""; routineForm.elements.day.value = routine?.dayOfWeek || ""
  editingExercises = routine ? structuredClone(exerciseData(routine)) : []
  document.querySelector("#dialog-title").textContent = routine ? "Editar rutina" : "Crear rutina"
  paintRoutineExercisePicker(); paintRoutineExercises(); routineDialog.showModal()
}
function paintRoutineExercisePicker() {
  const picker=document.querySelector("#routine-exercise-picker")
  picker.innerHTML=`<option value="">Elige un ejercicio…</option>${libraryExercises.map((exercise,index)=>`<option value="${index}">${esc(exercise.name)} · ${esc(exercise.muscle)}</option>`).join("")}`
  document.querySelector("#add-routine-exercise").disabled=true
}
function paintRoutineExercises() { document.querySelector("#routine-exercises").innerHTML = renderExerciseEditor() || `<p class="empty compact">Añade ejercicios para configurar esta rutina.</p>` }
function renderLibrary() {
  const { search, muscle, equipment, favorites: onlyFavorites } = libraryFilters
  const query = search.toLocaleLowerCase("es-MX")
  const list = libraryExercises.filter((exercise) => (!query || exercise.name.toLocaleLowerCase("es-MX").includes(query) || exercise.muscle.toLocaleLowerCase("es-MX").includes(query)) && (muscle === "Todos" || exercise.muscle === muscle) && (equipment === "Todo" || exercise.equipment === equipment) && (!onlyFavorites || favorites.has(exercise.name)))
  return `<div class="section-head page-section-head"><div><span class="eyebrow">CATÁLOGO</span><h2>Biblioteca de ejercicios</h2></div><button class="button" data-create-exercise>＋ Crear ejercicio</button></div><div class="filters"><label class="search-label">⌕<input id="exercise-search" type="search" placeholder="Buscar ejercicios…" aria-label="Buscar ejercicios" value="${esc(search)}"></label><select id="muscle-filter"><option>Todos</option>${[...new Set(libraryExercises.map((x)=>x.muscle))].map((x)=>`<option ${muscle===x?"selected":""}>${esc(x)}</option>`).join("")}</select><select id="equipment-filter"><option value="Todo">Todo el equipamiento</option>${[...new Set(libraryExercises.map((x)=>x.equipment))].map((x)=>`<option ${equipment===x?"selected":""}>${esc(x)}</option>`).join("")}</select><button id="favorites-filter" class="filter-button ${onlyFavorites?"active":""}" data-toggle-favorites aria-pressed="${onlyFavorites}">${onlyFavorites?"★":"☆"} Solo favoritos</button></div><div class="exercise-grid">${list.map((x)=>`<article class="exercise-card"><div class="exercise-symbol">${esc(x.muscle.slice(0,2).toUpperCase())}</div><div><small>${esc(x.muscle)}</small><h3>${esc(x.name)}</h3><p>${esc(x.equipment)} · Fuerza</p></div><button class="favorite-button ${favorites.has(x.name)?"active":""}" data-favorite="${esc(x.name)}" aria-label="Favorito">${favorites.has(x.name)?"★":"☆"}</button></article>`).join("") || `<div class="empty">No encontramos ejercicios con esos filtros.</div>`}</div>`
}
function renderProgress() {
  const days = period === "4 semanas" ? 28 : period === "1 año" ? 365 : 90
  const since = Date.now() - days * 86400000
  const recent = doneSessions().filter((s)=>new Date(s.startedAt).getTime()>=since)
  const volume = recent.reduce((sum,s)=>sum+volumeOf(s),0)
  const dailyVolumes = Array.from({length:7},(_,i)=>{ const day=new Date(); day.setDate(day.getDate()-6+i); return { day, value: recent.filter((s)=>new Date(s.startedAt).toDateString()===day.toDateString()).reduce((sum,s)=>sum+volumeOf(s),0) } })
  const maxDaily = Math.max(1, ...dailyVolumes.map((x)=>x.value))
  const weekVolume = dailyVolumes.reduce((sum,x)=>sum+x.value,0)
  const bars = dailyVolumes.map(({day,value})=>`<span title="${fmtVolume(value)}"><i style="height:${Math.max(4,value/maxDaily*100)}%"></i><small>${["D","L","M","M","J","V","S"][day.getDay()]}</small></span>`).join("")
  const groups = new Map(); recent.flatMap((s)=>s.sets||[]).filter((x)=>x.completed).forEach((x)=>{const exercise=libraryExercises.find((e)=>e.name===x.exercise); const key=exercise?.muscle||"Otros"; groups.set(key,(groups.get(key)||0)+1)})
  const muscles = [...groups.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
  return `<div class="section-head page-section-head"><div><span class="eyebrow">ANÁLISIS</span><h2>Progreso y estadísticas</h2></div><div class="segments">${["4 semanas","3 meses","1 año"].map((x)=>`<button data-period="${x}" class="${period===x?"active":""}">${x}</button>`).join("")}</div></div><div class="stats kpis"><article class="stat"><small>VOLUMEN TOTAL</small><strong>${fmtVolume(volume)}</strong><span>En el periodo seleccionado</span></article><article class="stat"><small>ENTRENAMIENTOS</small><strong>${recent.length}</strong><span>${recent.length ? (recent.length/days*7).toFixed(1) : "0"} por semana</span></article><article class="stat"><small>TIEMPO ACTIVO</small><strong>${recent.reduce((a,s)=>a+sessionMinutes(s),0)} min</strong><span>Sesiones terminadas</span></article><article class="stat"><small>SERIES</small><strong>${recent.flatMap((s)=>s.sets||[]).filter((x)=>x.completed).length}</strong><span>Series completadas</span></article></div><div class="analytics-grid"><article class="card chart-card"><span class="eyebrow">ÚLTIMOS 7 DÍAS</span><h3>Volumen de entrenamiento</h3><strong class="chart-total">${fmtVolume(weekVolume)}</strong><div class="bars">${bars}</div></article><article class="card"><span class="eyebrow">DISTRIBUCIÓN</span><h3>Grupos musculares</h3><div class="muscle-list">${muscles.map(([name,count])=>`<div><span>${esc(name)}</span><b>${count} series</b></div>`).join("") || `<p class="muted">Completa sesiones para ver tus grupos musculares.</p>`}</div></article></div><div class="section-head"><div><span class="eyebrow">MEJORES MARCAS</span><h2>Ejercicios con más carga</h2></div></div><div class="history-list">${[...new Set(doneSessions().flatMap((s)=>s.sets||[]).filter((x)=>x.completed).map((x)=>x.exercise))].map((name)=>({name,best:Math.max(...doneSessions().flatMap((s)=>s.sets||[]).filter((x)=>x.exercise===name&&x.completed).map((x)=>Number(x.weight)||0),0)})).sort((a,b)=>b.best-a.best).slice(0,4).map(({name,best})=>{return `<article class="session-row"><div><h3>${esc(name)}</h3><p>Mejor carga registrada</p></div><div class="session-volume">${fmtWeight(best)}</div></article>`}).join("") || `<div class="empty">Completa entrenamientos para registrar marcas.</div>`}</div>`
}
function sessionRow(session) {
  const volume = volumeOf(session), setsDone = (session.sets||[]).filter((x)=>x.completed).length
  const isActive = !session.finishedAt && activeSession?.id === session.id
  const action = session.finishedAt ? "" : `<button class="button secondary" ${isActive ? `data-page="entrenar">Continuar` : `data-resume="${session.id}">Reanudar`}</button>`
  return `<article class="session-row"><div><h3>${esc(session.routineName)}</h3><p>${fmtDate(session.startedAt,{dateStyle:"medium",timeStyle:"short"})} · ${sessionMinutes(session)} min · ${setsDone} series${session.finishedAt?"":" · En progreso"}</p>${isPending("sessions", session.id) ? pendingTag() : ""}</div><div class="session-volume">${fmtVolume(volume)}<small>volumen</small></div>${action}</article>`
}
function renderHistory() {
  const ordered=[...sessions].sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt))
  return `<div class="section-head page-section-head"><div><span class="eyebrow">REGISTRO</span><h2>Historial de entrenamientos</h2></div><button class="button secondary" data-export-csv>Exportar CSV</button></div><div class="history-list">${ordered.map(sessionRow).join("")||`<div class="empty">Tus entrenamientos aparecerán aquí.</div>`}</div>`
}
function renderCalendar() {
  const year=monthCursor.getFullYear(), month=monthCursor.getMonth(), first=new Date(year,month,1), offset=(first.getDay()+6)%7, days=new Date(year,month+1,0).getDate(), cells=[]
  for(let i=0;i<offset;i++) cells.push(`<span class="day-cell blank"></span>`)
  const today=new Date().toDateString()
  for(let day=1;day<=days;day++){const date=new Date(year,month,day), key=dayKey(date); const selected=selectedDay.toDateString()===date.toDateString(); const hasPlan=plannedRoutinesFor(date).length>0; cells.push(`<button class="day-cell ${selected?"selected":""} ${hasPlan?"has-plan":""} ${date.toDateString()===today?"today":""}" data-select-day="${key}" aria-pressed="${selected}" aria-label="${fmtDate(date,{weekday:"long",day:"numeric",month:"long"})}${hasPlan?" · con entrenamiento":""}"><b>${day}</b></button>`)}
  const selectedPlans=plannedRoutinesFor(selectedDay)
  return `<div class="section-head page-section-head"><div><span class="eyebrow">PLANIFICACIÓN</span><h2>Calendario</h2></div><button class="button" data-schedule>＋ Programar rutina</button></div><div class="calendar-layout"><section class="card calendar-card"><header><button class="icon-button" data-month="-1" aria-label="Mes anterior">‹</button><h3>${monthCursor.toLocaleDateString("es-MX",{month:"long",year:"numeric"})}</h3><button class="icon-button" data-month="1" aria-label="Mes siguiente">›</button></header><div class="calendar-grid weekday-row">${["LUN","MAR","MIÉ","JUE","VIE","SÁB","DOM"].map(x=>`<span>${x}</span>`).join("")}</div><div class="calendar-grid">${cells.join("")}</div></section><aside class="card day-card"><span class="eyebrow">${fmtDate(selectedDay,{weekday:"long",day:"numeric",month:"long"}).toUpperCase()}</span><h3>Plan del día</h3>${selectedPlans.map(({routine:r,recurring})=>`<article class="planned-routine"><div><b>${esc(r.name)}</b><small>${recurring?`Cada ${esc(r.dayOfWeek.toLocaleLowerCase("es-MX"))}`:esc(r.description||"Programada para este día")}</small></div><button class="button" data-start="${r.id}">Entrenar</button>${recurring?"":`<button class="icon-button" data-unschedule="${r.id}" aria-label="Quitar del calendario">×</button>`}</article>`).join("")||`<p class="muted">No tienes actividades programadas.</p>`}<button class="button secondary full-button" data-schedule>＋ Añadir actividad</button></aside></div>`
}
function plannedRoutinesFor(date) {
  const weekday=weekdayNames[date.getDay()], items=[]
  routines.filter((r)=>r.dayOfWeek===weekday).forEach((routine)=>items.push({routine,recurring:true}))
  ;(plans[dayKey(date)]||[]).forEach((id)=>{const routine=routines.find((r)=>r.id===id);if(routine&&!items.some((x)=>x.routine.id===id))items.push({routine,recurring:false})})
  return items
}
function openScheduleDialog() {
  if(!routines.length){showNotice("Crea una rutina antes de programarla.");return}
  const dialog=document.querySelector("#schedule-dialog"), form=document.querySelector("#schedule-form")
  form.elements.routine.innerHTML=routines.map((r)=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")
  form.elements.date.value=dayKey(selectedDay)
  dialog.showModal()
}
function dayKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`}
function renderProfile() {
  const displayName=profile?.name||"Atleta"
  const avatar=currentUser?.photoURL?`<img class="profile-photo" src="${esc(currentUser.photoURL)}" alt="Foto de ${esc(displayName)}">`:esc(initials(displayName))
  return `<div class="profile-grid"><article class="card profile-card"><div class="profile-large">${avatar}</div><h2>${esc(displayName)}</h2><p>${esc(currentUser?.email||"Cuenta de Google")}</p><div class="profile-metrics"><span><b>${doneSessions().length}</b><small>Entrenamientos</small></span><span><b>${routines.length}</b><small>Rutinas</small></span><span><b>Google</b><small>Cuenta vinculada</small></span></div><button class="button secondary full-button" data-signout>Cerrar sesión</button></article><section class="card preferences"><span class="eyebrow">AJUSTES</span><h3>Preferencias de entrenamiento</h3><label>Tu nombre<input id="profile-name-input" maxlength="60" value="${esc(displayName)}"></label><button class="button secondary full-button" data-save-profile>Guardar nombre</button><label>Unidades<select id="units-select"><option value="kg" ${settings.units!=="lb"?"selected":""}>Kilogramos (kg)</option><option value="lb" ${settings.units==="lb"?"selected":""}>Libras (lb)</option></select></label><label>Descanso predeterminado<select id="rest-select">${[30,60,90,120,180].map(x=>`<option value="${x}" ${Number(settings.rest||90)===x?"selected":""}>${x} segundos</option>`).join("")}</select></label><label class="switch-label">Iniciar descanso al completar una serie<input id="auto-rest" type="checkbox" ${settings.autoRest===false?"":"checked"}></label><label>Tema<select id="theme-select"><option value="system" ${themeSetting()==="system"?"selected":""}>Seguir el sistema</option><option value="light" ${settings.theme==="light"?"selected":""}>Claro</option><option value="dark" ${settings.theme==="dark"?"selected":""}>Oscuro</option></select></label></section><section class="card measurements"><span class="eyebrow">MEDIDAS CORPORALES</span><h3>Último registro</h3><div class="measure-grid"><span>Peso <b>—</b></span><span>Cintura <b>—</b></span><span>Brazo <b>—</b></span><span>Pecho <b>—</b></span></div></section></div>`
}
function renderTools() {
  return `<div class="tools-grid"><article class="card tool-card"><span class="eyebrow">CALCULADORA</span><h3>Discos para barra</h3><p>Calcula cuánto cargar en cada lado. Barra estándar: 20 kg.</p><label>Peso total (${settings.units||"kg"})<input id="bar-weight" type="number" min="20" value="100"></label><div class="plate-result" id="plate-result">40 kg por lado</div></article><article class="card tool-card"><span class="eyebrow">CALCULADORA</span><h3>Repetición máxima (1RM)</h3><p>Estimación con la fórmula de Epley.</p><div class="tool-input-row"><label>Peso<input id="rm-weight" type="number" value="90" min="1"></label><label>Reps<input id="rm-reps" type="number" value="8" min="1" max="30"></label></div><div class="plate-result" id="rm-result">114 kg estimados</div></article><article class="card tool-card"><span class="eyebrow">DATOS</span><h3>Respaldo y notas</h3><p>Exporta una copia de tus rutinas y entrenamientos.</p><button class="button secondary full-button" data-export-json>Exportar datos JSON</button><button class="button secondary full-button" data-export-csv>Exportar historial CSV</button><label>Notas personales<textarea id="personal-notes" rows="4" placeholder="Anota tus objetivos o recordatorios…">${esc(personalNotes)}</textarea></label></article></div>`
}
function renderSummary(session=lastCompleted) {
  if(!session) return `<div class="empty">No hay una sesión completada para mostrar.</div>`
  const completed=(session.sets||[]).filter((x)=>x.completed), volume=volumeOf(session), duration=session.durationSeconds??Math.max(0,Math.round((new Date(session.finishedAt||Date.now())-new Date(session.startedAt))/1000))
  const breakdown=[...new Set(completed.map((x)=>x.exercise))].map((name)=>{const rows=completed.filter((x)=>x.exercise===name);return `<article class="summary-exercise"><b>${esc(name)}</b><span>${rows.length} series</span><span>${rows.map((x)=>`${fmtWeight(x.weight)} × ${x.reps}`).join(" · ")}</span></article>`}).join("")
  return `<section class="summary-page"><div class="summary-icon">✓</div><span class="eyebrow">ENTRENAMIENTO COMPLETADO</span><h2>Gran sesión, ${esc(profile?.name||"atleta")}.</h2><p>Registraste ${completed.length} de ${(session.sets||[]).length} series.</p><div class="summary-stats"><article class="stat"><small>Duración</small><strong>${fmtTime(duration)}</strong></article><article class="stat"><small>Series</small><strong>${completed.length}</strong></article><article class="stat"><small>Volumen</small><strong>${fmtVolume(volume)}</strong></article><article class="stat"><small>Ejercicios</small><strong>${new Set(completed.map((x)=>x.exercise)).size}</strong></article></div><div class="card summary-detail"><div class="section-head"><div><span class="eyebrow">DETALLE</span><h3>${esc(session.routineName)}</h3></div><span class="sync">${fmtDate(session.finishedAt||Date.now())}</span></div>${breakdown||`<p class="muted">No registraste series completadas.</p>`}</div><div class="share-box"><button class="button share-result-button" id="share-workout-result">Compartir resultados (.txt)</button><span id="share-status" class="share-status" role="status" aria-live="polite"></span></div><button class="button secondary" data-page="inicio">Volver al inicio</button><p class="muted summary-saved">La sesión ya quedó guardada en tu historial.</p></section>`
}
function themeSetting() { return ["light","dark"].includes(settings.theme) ? settings.theme : "system" }
function applyTheme() {
  const prefersLight=window.matchMedia?.("(prefers-color-scheme: light)").matches||false
  const light=themeSetting()==="light"||(themeSetting()==="system"&&prefersLight)
  document.body.classList.toggle("light",light)
  document.documentElement.style.colorScheme=light?"light":"dark"
  const meta=document.querySelector('meta[name="theme-color"]')
  if(meta)meta.content=light?"#f3f3f3":"#111111"
  const themeButton=document.querySelector("#theme-button")
  if(themeButton){const label=themeSetting()==="system"?"Tema del sistema":light?"Tema claro":"Tema oscuro";themeButton.textContent=themeSetting()==="system"?"◐":light?"☀":"☾";themeButton.setAttribute("aria-label",`${label}. Pulsa para cambiar`);themeButton.title=label}
}
function render() {
  applyTheme()
  updateIdentity()
  updateNavState()
  const screens={inicio:renderHome,rutinas:renderRoutines,entrenar:renderWorkout,biblioteca:renderLibrary,progreso:renderProgress,historial:renderHistory,calendario:renderCalendar,perfil:renderProfile,herramientas:renderTools,resumen:()=>renderSummary()}
  const live=activeSession&&!activeSession.finishedAt&&page!=="entrenar"
  const liveBanner=live?`<button class="live-banner" data-page="entrenar"><span class="live-pulse" aria-hidden="true"></span><span><b>Sesión en curso</b><small>${esc(activeRoutine?.name||activeSession.routineName||"Entrenamiento")} · <span id="live-banner-time">${fmtTime(sessionSeconds)}</span>${paused?" · en pausa":""}</small></span><span class="live-banner-cta">Continuar →</span></button>`:""
  view.innerHTML=liveBanner+(screens[page]||renderHome)()
  if(page==="resumen") bindShareButton()
  if(page==="herramientas") updateCalculators()
}
function initials(name) { return String(name||"").trim().split(/\s+/).slice(0,2).map((part)=>part[0]?.toLocaleUpperCase("es-MX")||"").join("")||"MF" }
function updateIdentity() {
  const name=profile?.name||"Mi perfil"
  const nameNode=document.querySelector("#profile-name-text"), initialsNode=document.querySelector("#profile-initials")
  if(nameNode)nameNode.textContent=name
  if(initialsNode) {
    if(currentUser?.photoURL) initialsNode.innerHTML=`<img class="avatar-photo" src="${esc(currentUser.photoURL)}" alt="">`
    else initialsNode.textContent=initials(profile?.name)
  }
}
function newSet(exercise="Ejercicio libre",weight=40,reps=10) { return {exercise,weight,reps,completed:false} }
async function startWorkout(routine) {
  if(activeSession&&!activeSession.finishedAt){navTitle("entrenar");showNotice("Ya tienes una sesión en curso. Continúa esa sesión antes de iniciar otra.");return}
  activeRoutine=routine||{name:"Entrenamiento libre",exercises:[]}
  const config=exerciseData(activeRoutine)
  sets=config.flatMap((exercise)=>Array.from({length:Number(exercise.sets||3)},()=>newSet(exercise.name,60,Number.parseInt(exercise.reps,10)||8)))
  if(!sets.length) sets=[newSet()]
  sessionSeconds=0;restSeconds=0;paused=false
  activeSession=await api("sessions",{method:"POST",body:JSON.stringify({routineName:activeRoutine.name,sets,durationSeconds:0})})
  sessions=[activeSession,...sessions.filter((session)=>session.id!==activeSession.id)];persistSnapshot()
  workoutStartedAt=new Date(activeSession.startedAt).getTime()
  navTitle("entrenar");startClock()
}
function startClock() {
  clearInterval(timerHandle)
  timerHandle=setInterval(()=>{if(!paused){sessionSeconds++;const timer=document.querySelector("#timer-display");if(timer)timer.textContent=fmtTime(sessionSeconds);const bannerTime=document.querySelector("#live-banner-time");if(bannerTime)bannerTime.textContent=fmtTime(sessionSeconds)}},1000)
}
function workoutRest(duration=Number(settings.rest||90)) {
  restSeconds=Math.max(5,Math.min(900,duration)); restTotal=restSeconds; clearInterval(restHandle)
  restHandle=setInterval(()=>{
    if(paused)return
    restSeconds=Math.max(0,restSeconds-1)
    if(restSeconds===0){clearInterval(restHandle);restHandle=null;render();return}
    const el=document.querySelector("#rest-clock")
    if(el)el.textContent=fmtTime(restSeconds)
    const bar=document.querySelector("#rest-bar")
    if(bar)bar.style.width=`${Math.max(4,restSeconds/Math.max(restTotal,1)*100)}%`
  },1000)
  render()
}
function startRestModal() {
  const form = document.querySelector("#rest-form")
  const dialog = document.querySelector("#rest-dialog")
  form.elements.seconds.value = Math.max(5, Math.min(900, restSeconds || Number(settings.rest || 90)))
  paintTimerPresets()
  dialog.showModal()
}
function renderWorkout() {
  if(!activeSession){
    const weekday=new Intl.DateTimeFormat("es-MX",{weekday:"long"}).format(new Date())
    const normalize=(value)=>String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("es-MX")
    const suggestion=routines.find((routine)=>normalize(routine.dayOfWeek)===normalize(weekday))||routines[0]
    if(!suggestion)return `<section class="pre-workout"><span class="eyebrow">TU ENTRENAMIENTO DE HOY</span><h2>¿Empezamos?</h2><p>Aquí aparecerá la rutina sugerida para hoy. Crea tu primera rutina para organizar ejercicios, series y descansos.</p><button class="button" data-create-routine>＋ Crear rutina</button></section>`
    const exercises=exerciseData(suggestion), totalSets=exercises.reduce((sum,item)=>sum+Number(item.sets||3),0)
    return `<section class="pre-workout"><span class="eyebrow">SUGERENCIA PARA ${esc(weekday.toLocaleUpperCase("es-MX"))}</span><h2>${esc(suggestion.name)}</h2><p>${esc(suggestion.description||"Tu rutina planificada está lista cuando tú lo estés.")}</p><div class="pre-workout-stats"><span><b>${exercises.length}</b> ejercicios</span><span><b>${totalSets}</b> series</span><span><b>~${Math.max(20,exercises.length*12)}</b> min</span></div><div class="suggested-exercises">${exercises.map((item,index)=>`<div><i>${index+1}</i><span><b>${esc(item.name)}</b><small>${Number(item.sets||3)} series · ${esc(item.reps||"8–12")} reps · ${Number(item.restSeconds||settings.rest||90)} s descanso</small></span></div>`).join("")}</div><button class="button pre-workout-start" data-start="${esc(suggestion.id)}">▶ &nbsp; Iniciar entrenamiento de hoy</button><button class="text-button pre-workout-other" data-page="rutinas">Elegir otra rutina</button></section>`
  }
  const routineName=activeRoutine?.name||"Entrenamiento libre"
  const completeCount=sets.filter((x)=>x.completed).length
  const nextIndex=sets.findIndex((x)=>!x.completed)
  const nextSet=nextIndex>=0?sets[nextIndex]:null
  const currentExercise=nextSet?.exercise||sets.at(-1)?.exercise||"Ejercicio"
  const exerciseSets=sets.map((item,index)=>({item,index})).filter(({item})=>item.exercise===currentExercise)
  const currentOrdinal=exerciseSets.findIndex(({index})=>index===nextIndex)+1
  let focus
  if(restSeconds>0){
    focus=`<section class="training-focus rest-focus"><span class="eyebrow">DESCANSO ENTRE SERIES</span><div class="rest-ring"><strong id="rest-clock">${fmtTime(restSeconds)}</strong><small>RECUPERA</small></div><h2>Respira y prepárate</h2><p>Después sigue ${nextSet?`${esc(nextSet.exercise)} · Serie ${currentOrdinal} de ${exerciseSets.length}`:"terminar tu sesión"}.</p><div class="rest-progress"><i id="rest-bar" style="width:${Math.max(4,Math.min(100,restSeconds/Math.max(restTotal,1)*100))}%"></i></div><button class="button secondary skip-rest-button" data-rest-skip>Omitir descanso →</button></section>`
  }else if(nextSet){
    const displayWeight=settings.units==="lb"?Math.round(nextSet.weight*2.20462):nextSet.weight
    focus=`<section class="training-focus"><div class="exercise-step-top"><span class="eyebrow">${esc(routineName.toUpperCase())}</span><span class="step-count">EJERCICIO ${new Set(sets.slice(0,nextIndex+1).map((x)=>x.exercise)).size} · ${new Set(sets.map((x)=>x.exercise)).size}</span></div><h2>${esc(currentExercise)}</h2><p class="exercise-subtitle">${esc(libraryExercises.find((x)=>x.name===currentExercise)?.muscle||"Fuerza")} · ${esc(libraryExercises.find((x)=>x.name===currentExercise)?.equipment||"Equipo")}</p><div class="set-progress"><span>Serie ${currentOrdinal} <small>de ${exerciseSets.length}</small></span><span>${completeCount} de ${sets.length} completadas</span></div><div class="set-progress-track"><i style="width:${sets.length?completeCount/sets.length*100:0}%"></i></div><div class="set-inputs"><label>PESO <div><input type="number" min="0" step="0.5" value="${displayWeight}" data-current-weight><span>${settings.units||"kg"}</span></div></label><label>REPETICIONES <div><input type="number" min="1" value="${nextSet.reps}" data-current-reps><span>reps</span></div></label></div><div class="previous-card">${exerciseSets.filter(({item})=>item.completed).length?`Series anteriores: ${exerciseSets.filter(({item})=>item.completed).map(({item})=>`${fmtWeight(item.weight)} × ${item.reps}`).join(" · ")}`:"Primera serie de este ejercicio. Registra tu carga y repeticiones."}</div><button class="button complete-set-button" data-complete-current="${nextIndex}">✓ &nbsp;Completar serie</button><div class="exercise-dots">${sets.map((set,index)=>`<i class="${set.completed?"done":""} ${index===nextIndex?"current":""}" title="${esc(set.exercise)} · serie ${index+1}"></i>`).join("")}</div></section>`
  }else{
    focus=`<section class="training-focus workout-complete"><div class="summary-icon">✓</div><span class="eyebrow">TODOS LOS EJERCICIOS COMPLETADOS</span><h2>Buen trabajo.</h2><p>Revisa tus datos o finaliza para guardar los resultados.</p><div class="completion-stat"><strong>${completeCount}</strong><span>series completadas</span></div></section>`
  }
  const completedExercises=[...new Set(sets.filter((x)=>x.completed).map((x)=>x.exercise))]
  const upcoming=[...new Set(sets.filter((x,index)=>!x.completed&&index!==nextIndex).map((x)=>x.exercise))].slice(0,3)
  return `<div class="workout-session-heading"><div><span class="eyebrow">${activeSession?"SESIÓN ACTIVA":"PREPARANDO SESIÓN"}</span><h2>${esc(routineName)}</h2><p><span id="timer-display">${fmtTime(sessionSeconds)}</span> transcurridos · ${completeCount} de ${sets.length} series</p></div><div class="workout-heading-actions"><span class="live-dot">● ${paused?"En pausa":"En curso"}</span><button class="text-button" data-discard>Descartar sesión</button></div></div>${paused?`<div class="paused-banner">Entrenamiento en pausa. El cronómetro y el descanso se reanudarán juntos.</div>`:""}${focus}<section class="session-flow-summary"><div><span class="eyebrow">SECUENCIA</span><h3>Tu entrenamiento de hoy</h3></div><div class="flow-steps">${[...new Set(sets.map((x)=>x.exercise))].map((name,index)=>`<div class="flow-step ${completedExercises.includes(name)?"done":""} ${name===currentExercise?"current":""}"><i>${completedExercises.includes(name)?"✓":index+1}</i><span><b>${esc(name)}</b><small>${sets.filter((x)=>x.exercise===name).filter((x)=>x.completed).length} / ${sets.filter((x)=>x.exercise===name).length} series</small></span></div>`).join("")}</div></section><div class="workout-toolbar"><button class="toolbar-button" data-pause aria-label="${paused?"Reanudar":"Pausar"}"><span>${paused?"▶":"Ⅱ"}</span><b>${paused?"Reanudar":"Pausar"}</b></button><button class="toolbar-button" data-open-rest><span>⏱</span><b>Descanso</b></button><button class="toolbar-button finish-toolbar" data-finish><span>■</span><b>Finalizar</b></button></div>`
}
function saveRoutineEditor() {
  const rows=[...document.querySelectorAll("[data-exercise-row]")]
  editingExercises=rows.map((row,index)=>({...editingExercises[index],sets:Number(row.querySelector('[data-routine-field="sets"]').value)||3,reps:row.querySelector('[data-routine-field="reps"]').value,restSeconds:Number(row.querySelector('[data-routine-field="restSeconds"]').value)||90}))
}
function downloadFile(filename, content, type="text/plain") {
  const blob=new Blob([content],{type}), url=URL.createObjectURL(blob), link=document.createElement("a")
  link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)
}
function exportCSV() {
  const lines=[["Rutina","Fecha","Duración (min)","Volumen (kg)","Series completadas","Estado"],...sessions.map((s)=>[s.routineName,new Date(s.startedAt).toISOString(),s.finishedAt?Math.round((new Date(s.finishedAt)-new Date(s.startedAt))/60000):"",volumeOf(s),(s.sets||[]).filter(x=>x.completed).length,s.finishedAt?"Completado":"En progreso"])].map((row)=>row.map((v)=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n")
  downloadFile("myflow-historial.csv",lines,"text/csv;charset=utf-8")
}
function buildShareText(session) {
  const completed=(session.sets||[]).filter((x)=>x.completed), volume=volumeOf(session), elapsed=session.durationSeconds??Math.max(0,Math.round((new Date(session.finishedAt||Date.now())-new Date(session.startedAt))/1000))
  const lines=["MyFlow · Resumen del entrenamiento","",`Rutina: ${session.routineName}`,`Fecha: ${new Date(session.finishedAt||Date.now()).toLocaleString("es-MX")}`,`Duración: ${fmtTime(elapsed)}`,`Series completadas: ${completed.length} de ${(session.sets||[]).length}`,`Volumen total: ${Math.round(volume).toLocaleString("es-MX")} kg`,"","Detalle de series:"]
  for(const name of [...new Set(completed.map((x)=>x.exercise))]){lines.push(`\n${name}`);completed.filter((x)=>x.exercise===name).forEach((x,i)=>lines.push(`  Serie ${i+1}: ${fmtWeight(x.weight)} × ${x.reps}`))}
  if(profile?.name)lines.splice(2,0,`Atleta: ${profile.name}`)
  lines.push("","Entrena a tu ritmo. · MyFlow")
  return lines.join("\n")
}
function bindShareButton() {
  const button=document.querySelector("#share-workout-result"), status=document.querySelector("#share-status")
  button?.addEventListener("click",()=>{
    const date=new Date(lastCompleted?.finishedAt||Date.now()).toISOString().slice(0,10)
    shareResultFile(buildShareText(lastCompleted),`myflow-entrenamiento-${date}.txt`,"Resultado de entrenamiento · MyFlow",button,status)
  })
}
function downloadJSON() { downloadFile("myflow-respaldo.json",JSON.stringify({profile,routines,sessions,libraryExercises,plans,settings},null,2),"application/json") }
function updateCalculators() {
  const weight=document.querySelector("#bar-weight"), result=document.querySelector("#plate-result")
  if(weight&&result){const kg=toKg(Number(weight.value)||20);result.textContent=`${fmtWeight(Math.max(0,(kg-20)/2))} por lado`}
  const rmWeight=Number(document.querySelector("#rm-weight")?.value)||0, rmReps=Number(document.querySelector("#rm-reps")?.value)||1
  const rm=document.querySelector("#rm-result");if(rm)rm.textContent=`${fmtWeight(rmWeight*(1+Math.min(rmReps,30)/30))} estimados`
}
// Datos del servidor (o de la caché de Firestore) con los cambios pendientes aplicados encima.
async function refreshData() {
  const [serverRoutines, serverSessions, profileResponse] = await Promise.all([api("routines"), api("sessions"), api("profile")])
  const items = await Sync.list(currentUser.uid)
  applyData(Sync.overlay(currentUser.uid, { routines: serverRoutines, sessions: serverSessions, profile: profileResponse.profile }, items))
}
function applyData(data) {
  routines = data.routines || []
  sessions = [...(data.sessions || [])].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
  profile = data.profile || null
  // La sesión activa en memoria siempre es la versión más reciente.
  if (activeSession && !activeSession.finishedAt) {
    const index = sessions.findIndex((session) => session.id === activeSession.id)
    if (index >= 0) sessions[index] = activeSession
  }
}
function resumeUnfinished() {
  if (activeSession) return true
  const unfinished = sessions.find((session) => !session.finishedAt)
  if (!unfinished) return false
  activeSession = unfinished; activeRoutine = routines.find((r) => r.name === unfinished.routineName) || { name: unfinished.routineName }
  sets = unfinished.sets?.length ? unfinished.sets : [newSet()]; workoutStartedAt = new Date(unfinished.startedAt).getTime()
  sessionSeconds = unfinished.durationSeconds ?? Math.floor((Date.now() - workoutStartedAt) / 1000); startClock()
  return true
}
function showOnboardingIfNeeded() {
  if (!currentUser || document.querySelector("dialog[open]")) return
  const googleName = currentUser.displayName || currentUser.providerData?.find((provider) => provider.providerId === "google.com")?.displayName || ""
  if (!profile?.name) { document.querySelector("#welcome-form").elements.name.value = googleName; document.querySelector("#welcome-dialog").showModal() }
  else if (profile.hasCompletedIntro !== true && localStorage.getItem(`myflow-${currentUser.uid}-intro-completed`) !== "true") { document.querySelector("#intro-name").textContent = profile.name; document.querySelector("#intro-dialog").showModal() }
}
const userIsBusy = () => Boolean(document.querySelector("dialog[open]")) || (document.activeElement && view.contains(document.activeElement) && document.activeElement.matches("input,select,textarea"))
// Primero se muestra al instante la copia guardada en el dispositivo; después se
// actualiza con el servidor en segundo plano (si hay conexión).
async function load() {
  const uid = currentUser.uid
  loadLocal(); dataReady = false
  await refreshPending()
  let snapshot = null
  try { snapshot = await Sync.loadSnapshot(uid) } catch {}
  if (snapshot) {
    applyData(Sync.overlay(uid, snapshot, await Sync.list(uid).catch(() => [])))
    dataReady = true
    navTitle(resumeUnfinished() ? "entrenar" : (pageFromHash() || "inicio"), { replace: true })
    if (snapshot.profile?.name) showOnboardingIfNeeded()
  } else {
    view.innerHTML = `<div class="loading">Cargando tu cuenta…</div>`
  }
  try {
    await refreshData()
    if (currentUser?.uid !== uid) return
    const firstLoad = !dataReady
    dataReady = true
    persistSnapshot()
    if (firstLoad) navTitle(resumeUnfinished() ? "entrenar" : (pageFromHash() || "inicio"), { replace: true })
    else { resumeUnfinished(); if (!userIsBusy()) render() }
    showOnboardingIfNeeded()
  } catch (error) {
    if (snapshot) { syncState = "offline"; updateSyncStatus(); return }
    showNotice(`No se pudieron cargar tus datos: ${error.message}`)
    view.innerHTML = `<div class="empty">No se pudo cargar tu cuenta. Revisa tu conexión y vuelve a intentarlo.<br><br><button class="button" data-retry-load>Reintentar</button></div>`
  }
}

// Navigation and actions
view.addEventListener("click",async(event)=>{
  const button=event.target.closest("button");if(!button)return
  try {
    if(button.dataset.page){navTitle(button.dataset.page);return}
    if(button.hasAttribute("data-retry-load")){load();return}
    if(button.hasAttribute("data-signout")){
      await refreshPending()
      if(pendingCount&&!confirm(`Tienes ${pendingCount} ${pendingCount===1?"cambio":"cambios"} sin subir. Se quedarán guardados en este dispositivo y se subirán cuando vuelvas a iniciar sesión. ¿Cerrar sesión?`))return
      await signOut(auth);return
    }
    if(button.hasAttribute("data-create-routine")){openRoutineEditor();return}
    if(button.dataset.routineTab){routineTab=button.dataset.routineTab;render();return}
    if(button.hasAttribute("data-save-profile")){
      const name=document.querySelector("#profile-name-input").value.trim()
      profile=await api("profile",{method:"PUT",body:JSON.stringify({name})})
      render();showNotice("Tu nombre quedó guardado en tu perfil.");return
    }
    if(button.dataset.edit){openRoutineEditor(routines.find((r)=>r.id===button.dataset.edit));return}
    if(button.dataset.delete){const routine=routines.find((r)=>r.id===button.dataset.delete);if(confirm(`¿Eliminar la rutina "${routine?.name||"sin nombre"}"? Esta acción no se puede deshacer.`)){await api(`routines/${button.dataset.delete}`,{method:"DELETE"});routines=routines.filter((r)=>r.id!==button.dataset.delete);persistSnapshot();Object.keys(plans).forEach((key)=>{plans[key]=plans[key].filter((id)=>id!==button.dataset.delete);if(!plans[key].length)delete plans[key]});saveLocal();render();showNotice("Rutina eliminada.")}return}
    if(button.dataset.start!==undefined){const routine=routines.find((r)=>r.id===button.dataset.start);if(!routine){showNotice("Crea una rutina antes de comenzar.");navTitle("rutinas");return}await startWorkout(routine);return}
    if(button.hasAttribute("data-create-exercise")){openExerciseDialog(false);return}
    if(button.hasAttribute("data-toggle-favorites")){libraryFilters.favorites=!libraryFilters.favorites;render();return}
    if(button.hasAttribute("data-discard")){await discardWorkout();return}
    if(button.dataset.favorite){favorites.has(button.dataset.favorite)?favorites.delete(button.dataset.favorite):favorites.add(button.dataset.favorite);saveLocal();render();return}
    if(button.dataset.period){period=button.dataset.period;render();return}
    if(button.dataset.month){monthCursor=new Date(monthCursor.getFullYear(),monthCursor.getMonth()+Number(button.dataset.month),1);render();return}
    if(button.dataset.selectDay){selectedDay=new Date(`${button.dataset.selectDay}T12:00:00`);render();return}
    if(button.hasAttribute("data-schedule")){openScheduleDialog();return}
    if(button.dataset.unschedule){const key=dayKey(selectedDay);plans[key]=(plans[key]||[]).filter((id)=>id!==button.dataset.unschedule);if(!plans[key].length)delete plans[key];saveLocal();render();showNotice("Rutina quitada del calendario.");return}
    if(button.dataset.exportCsv!==undefined){exportCSV();return}
    if(button.dataset.exportJson!==undefined){downloadJSON();return}
    if(button.dataset.pause!==undefined){paused=!paused;if(activeSession)saveSession().catch(()=>{});render();return}
    if(button.dataset.openRest!==undefined){startRestModal();return}
    if(button.dataset.restSkip!==undefined){restSeconds=0;clearInterval(restHandle);restHandle=null;render();return}
    if(button.dataset.completeCurrent!==undefined){
      const index=Number(button.dataset.completeCurrent);const row=document.querySelector("[data-current-weight]");const reps=document.querySelector("[data-current-reps]")
      sets[index].weight=toKg(Number(row.value)||0);sets[index].reps=Math.max(1,Number(reps.value)||1);sets[index].completed=true
      button.disabled=true
      if(activeSession){try{await saveSession()}catch(error){render();throw error}}
      const hasNext=sets.some((x)=>!x.completed)
      if(hasNext&&settings.autoRest!==false){const exercise=exerciseData(activeRoutine).find((x)=>x.name===sets[index].exercise);workoutRest(Number(exercise?.restSeconds||settings.rest||90))}
      else render()
      return
    }
    if(button.dataset.finish!==undefined){await finishWorkout();return}
    if(button.dataset.resume){
      const session=sessions.find((x)=>x.id===button.dataset.resume)
      if(!session)return
      if(activeSession&&!activeSession.finishedAt&&activeSession.id!==session.id){showNotice("Ya tienes otra sesión en curso. Finalízala o descártala antes de reanudar esta.");navTitle("entrenar");return}
      activeSession=session;activeRoutine=routines.find((r)=>r.name===session.routineName)||{name:session.routineName};sets=session.sets?.length?session.sets:[newSet()];workoutStartedAt=new Date(session.startedAt).getTime();sessionSeconds=session.durationSeconds??Math.floor((Date.now()-workoutStartedAt)/1000);restSeconds=0;paused=false;navTitle("entrenar");startClock()
      return
    }
  }catch(error){showNotice(error.message)}
})
view.addEventListener("input",(event)=>{
  if(event.target.id==="exercise-search"){libraryFilters.search=event.target.value;const pos=event.target.selectionStart;render();const search=document.querySelector("#exercise-search");search.focus();search.setSelectionRange(pos,pos)}
  if(event.target.id==="bar-weight"||event.target.id==="rm-weight"||event.target.id==="rm-reps")updateCalculators()
})
view.addEventListener("change",async(event)=>{
  const target=event.target
  if(target.id==="muscle-filter"){libraryFilters.muscle=target.value;render();return}
  if(target.id==="equipment-filter"){libraryFilters.equipment=target.value;render();return}
  if(target.hasAttribute("data-current-weight")){const index=sets.findIndex((x)=>!x.completed);if(index>=0)sets[index].weight=toKg(Number(target.value)||0)}
  if(target.hasAttribute("data-current-reps")){const index=sets.findIndex((x)=>!x.completed);if(index>=0)sets[index].reps=Math.max(1,Number(target.value)||1)}
  if(target.id==="personal-notes"){personalNotes=target.value;saveLocal();showNotice("Notas guardadas en este dispositivo.")}
  if(target.id==="units-select"){settings.units=target.value;saveLocal();render();showNotice(`Unidades cambiadas a ${target.value==="lb"?"libras":"kilogramos"}.`);return}
  if(target.id==="rest-select"){settings.rest=Number(target.value);saveLocal();showNotice("Descanso predeterminado actualizado.");return}
  if(target.id==="auto-rest"){settings.autoRest=target.checked;saveLocal();showNotice(target.checked?"El descanso empezará al completar cada serie.":"El descanso ya no empezará automáticamente.");return}
  if(target.id==="theme-select"){settings.theme=target.value;saveLocal();render();return}
})
routineForm.addEventListener("input",(event)=>{if(event.target.matches("[data-routine-field]")){const index=Number(event.target.dataset.index);editingExercises[index][event.target.dataset.routineField]=event.target.value}})
routineForm.addEventListener("change",(event)=>{if(event.target.matches("[data-routine-field]")){const index=Number(event.target.dataset.index);editingExercises[index][event.target.dataset.routineField]=event.target.value}})
document.querySelector("#routine-exercise-picker").addEventListener("change",(event)=>{document.querySelector("#add-routine-exercise").disabled=!event.target.value})
routineForm.querySelector("#add-routine-exercise").addEventListener("click",()=>{
  const index=Number(document.querySelector("#routine-exercise-picker").value), exercise=libraryExercises[index]
  if(exercise){editingExercises.push({name:exercise.name,muscle:exercise.muscle,equipment:exercise.equipment,sets:3,reps:"8–12",restSeconds:Number(settings.rest||90)});paintRoutineExercises();paintRoutineExercisePicker()}
})
function openExerciseDialog(addToRoutine){
  exerciseForm.reset();exerciseForm.elements.name.setCustomValidity("")
  if(addToRoutine)exerciseForm.dataset.addToRoutine="true";else delete exerciseForm.dataset.addToRoutine
  exerciseDialog.showModal()
}
document.querySelector("#add-new-routine-exercise").addEventListener("click",()=>openExerciseDialog(true))
exerciseForm.elements.name.addEventListener("input",(event)=>event.target.setCustomValidity(""))
routineForm.addEventListener("click",(event)=>{const button=event.target.closest("[data-remove-routine-exercise]");if(button){editingExercises.splice(Number(button.dataset.removeRoutineExercise),1);paintRoutineExercises()}})
routineForm.addEventListener("submit",async(event)=>{
  event.preventDefault();saveRoutineEditor()
  const id=routineForm.elements.id.value
  const payload={name:routineForm.elements.name.value.trim(),description:routineForm.elements.description.value.trim(),dayOfWeek:routineForm.elements.day.value,exercises:editingExercises,color:"green"}
  const submitButton=routineForm.querySelector('[type="submit"]')
  if(routineSaving)return
  routineSaving=true;submitButton.disabled=true
  try{
    const saved=id?await api(`routines/${id}`,{method:"PUT",body:JSON.stringify(payload)}):await api("routines",{method:"POST",body:JSON.stringify(payload)})
    routines=id?routines.map((routine)=>routine.id===id?saved:routine):[...routines,saved]
    persistSnapshot();routineDialog.close();render()
    showNotice(navigator.onLine?"Rutina guardada.":"Rutina guardada en este dispositivo. Se subirá al recuperar la conexión.")
  }
  catch(error){showNotice(error.message)}
  finally{routineSaving=false;submitButton.disabled=false}
})


document.querySelector("#welcome-form").addEventListener("submit",async(event)=>{
  event.preventDefault()
  const name=event.currentTarget.elements.name.value.trim()
  if(!name)return
  const submit=event.currentTarget.querySelector("[type=submit]");submit.disabled=true
  try{profile=await api("profile",{method:"PUT",body:JSON.stringify({name})});document.querySelector("#welcome-dialog").close();document.querySelector("#intro-name").textContent=profile.name;document.querySelector("#intro-dialog").showModal()}
  catch(error){showNotice(error.message)}
  finally{submit.disabled=false}
})
document.querySelector("#accept-intro").addEventListener("click",async()=>{
  const button=document.querySelector("#accept-intro");button.disabled=true
  const name=profile?.name||currentUser?.displayName||"Atleta"
  profile={...profile,name,hasCompletedIntro:true}
  try{localStorage.setItem(`myflow-${currentUser.uid}-intro-completed`,"true")}catch{}
  document.querySelector("#intro-dialog").close();navTitle("inicio",{replace:true})
  try{profile=await api("profile",{method:"PUT",body:JSON.stringify({name,hasCompletedIntro:true})});render();showNotice(`¡Bienvenido a MyFlow, ${profile.name}!`)}
  catch(error){showNotice(`La bienvenida se cerró, pero no se pudo sincronizar este ajuste: ${error.message}`)}
  finally{button.disabled=false}
})
document.querySelector("#rest-form").addEventListener("submit",(event)=>{event.preventDefault();const seconds=Math.max(5,Math.min(900,Number(event.currentTarget.elements.seconds.value)||90));document.querySelector("#rest-dialog").close();workoutRest(seconds)})
document.querySelector("#rest-form").addEventListener("click",(event)=>{const preset=event.target.closest("[data-timer-preset]");if(!preset)return;event.currentTarget.elements.seconds.value=preset.dataset.timerPreset;paintTimerPresets()})
document.querySelector("#rest-form").elements.seconds.addEventListener("input",paintTimerPresets)
function paintTimerPresets(){const value=document.querySelector("#rest-form").elements.seconds.value;document.querySelectorAll("[data-timer-preset]").forEach((button)=>{const active=button.dataset.timerPreset===String(value);button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active))})}
exerciseForm.addEventListener("submit",(event)=>{event.preventDefault();const data=new FormData(exerciseForm);const name=String(data.get("name")).trim();if(!name){exerciseForm.elements.name.setCustomValidity("Escribe un nombre para el ejercicio.");exerciseForm.reportValidity();return}if(name){if(libraryExercises.some((item)=>item.name.toLocaleLowerCase("es-MX")===name.toLocaleLowerCase("es-MX"))){exerciseForm.elements.name.setCustomValidity("Ya existe un ejercicio con ese nombre.");exerciseForm.reportValidity();return}const exercise={name,muscle:String(data.get("muscle")),equipment:String(data.get("equipment")),favorite:false};libraryExercises.push(exercise);saveLocal();const addToRoutine=exerciseForm.dataset.addToRoutine==="true"&&routineDialog.open;delete exerciseForm.dataset.addToRoutine;if(addToRoutine){editingExercises.push({...exercise,sets:3,reps:"8–12",restSeconds:Number(settings.rest||90)});paintRoutineExercisePicker();paintRoutineExercises()}exerciseDialog.close();if(!routineDialog.open)render();showNotice(addToRoutine?"Ejercicio creado y añadido a la rutina.":"Ejercicio añadido a la biblioteca.")}})
document.addEventListener("click",(event)=>{
  const close=event.target.closest("[data-close]");if(close){document.getElementById(close.dataset.close).close();return}
})
// Cerrar con un clic en el fondo los diálogos que tienen botón de cancelar.
document.querySelectorAll("#routine-dialog,#rest-dialog,#exercise-dialog,#schedule-dialog").forEach((dialog)=>{
  dialog.addEventListener("mousedown",(event)=>{dialog.dataset.backdropDown=String(event.target===dialog)})
  dialog.addEventListener("click",(event)=>{if(event.target===dialog&&dialog.dataset.backdropDown==="true")dialog.close()})
})
// La bienvenida necesita un nombre: Esc no debe cerrarla. Cerrar la introducción equivale a aceptarla.
// Chrome puede ignorar preventDefault() en "cancel", así que también se vigila "close".
const welcomeDialog=document.querySelector("#welcome-dialog"), introDialog=document.querySelector("#intro-dialog")
welcomeDialog.addEventListener("cancel",(event)=>event.preventDefault())
welcomeDialog.addEventListener("close",()=>{if(currentUser&&!profile?.name)welcomeDialog.showModal()})
introDialog.addEventListener("cancel",(event)=>event.preventDefault())
introDialog.addEventListener("close",()=>{if(currentUser&&profile?.name&&profile.hasCompletedIntro!==true)document.querySelector("#accept-intro").click()})
document.querySelector("#schedule-form").addEventListener("submit",(event)=>{
  event.preventDefault()
  const form=event.currentTarget, routineId=form.elements.routine.value, key=form.elements.date.value
  if(!routineId||!key){form.reportValidity();return}
  const routine=routines.find((r)=>r.id===routineId), date=new Date(`${key}T12:00:00`)
  if(routine?.dayOfWeek===weekdayNames[date.getDay()]){showNotice(`${routine.name} ya está asignada a todos los ${routine.dayOfWeek.toLocaleLowerCase("es-MX")}.`);return}
  plans[key]=[...new Set([...(plans[key]||[]),routineId])];saveLocal()
  selectedDay=date;monthCursor=new Date(date.getFullYear(),date.getMonth(),1)
  document.querySelector("#schedule-dialog").close();render();showNotice("Rutina programada.")
})
document.querySelector("#mobile-navigation").addEventListener("click",(event)=>{const button=event.target.closest("[data-page]");if(button)navTitle(button.dataset.page)})
document.querySelector("#navigation").addEventListener("click",(event)=>{const button=event.target.closest("[data-page]");if(button)navTitle(button.dataset.page)})
async function saveSession(){if(activeSession){activeSession=await api(`sessions/${activeSession.id}`,{method:"PUT",body:JSON.stringify({routineName:activeRoutine?.name||activeSession.routineName,sets,durationSeconds:sessionSeconds})});sessions=sessions.map((session)=>session.id===activeSession.id?activeSession:session)}}
async function finishWorkout(){
  if(!activeSession){showNotice("Inicia la sesión antes de finalizarla.");return}
  const pending=sets.filter((x)=>!x.completed).length
  if(pending&&!confirm(`Te quedan ${pending} ${pending===1?"serie":"series"} sin completar. ¿Finalizar y guardar la sesión de todos modos?`))return
  await saveSession();lastCompleted=await api(`sessions/${activeSession.id}/finish`,{method:"POST"});sessions=sessions.map((session)=>session.id===lastCompleted.id?lastCompleted:session);persistSnapshot();clearInterval(timerHandle);clearInterval(restHandle);restSeconds=0;paused=false;activeSession=null;activeRoutine=null;sets=[];navTitle("resumen")
}
async function discardWorkout(){
  if(!activeSession)return
  if(!confirm("¿Descartar esta sesión? Se borrarán las series registradas y no aparecerá en tu historial."))return
  const id=activeSession.id
  clearInterval(timerHandle);clearInterval(restHandle);restSeconds=0;paused=false
  activeSession=null;activeRoutine=null;sets=[]
  sessions=sessions.filter((session)=>session.id!==id)
  await api(`sessions/${id}`,{method:"DELETE"});persistSnapshot()
  navTitle("entrenar");showNotice("Sesión descartada.")
}
document.querySelector("#theme-button").addEventListener("click",()=>{const order=["system","light","dark"];settings.theme=order[(order.indexOf(themeSetting())+1)%order.length];saveLocal();render();showNotice(settings.theme==="system"?"Tema: seguir el sistema.":settings.theme==="light"?"Tema claro activado.":"Tema oscuro activado.")})
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change",()=>{if(themeSetting()==="system")applyTheme()})
document.querySelector("#profile-initials").addEventListener("click",()=>navTitle("perfil"))
document.querySelector(".brand").addEventListener("click",(event)=>{event.preventDefault();navTitle("inicio")})
const moreButton=document.querySelector("#more-button")
const moreMenu=document.querySelector("#more-menu")
function setMoreMenu(open){moreMenu.hidden=!open;moreButton.setAttribute("aria-expanded",String(open))}
moreButton.addEventListener("click",(event)=>{event.stopPropagation();setMoreMenu(moreMenu.hidden)})
document.addEventListener("click",(event)=>{if(!moreMenu.hidden&&!moreMenu.contains(event.target)&&event.target!==moreButton)setMoreMenu(false)})
document.addEventListener("keydown",(event)=>{if(event.key==="Escape"&&!moreMenu.hidden){setMoreMenu(false);moreButton.focus()}})

const authGate=document.querySelector("#auth-gate")
const authMessage=document.querySelector("#auth-message")
const authError=document.querySelector("#auth-error")
const googleSignIn=document.querySelector("#google-sign-in")
const appShell=document.querySelector(".shell")
const mobileNavigation=document.querySelector("#mobile-navigation")
let loadedUid=null

if ("serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller)
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    // Busca nuevas versiones en segundo plano cada vez que vuelves a la app.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") registration.update().catch(() => {}) })
  }).catch((error) => console.warn("MyFlow no pudo registrar su service worker.", error))
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "MYFLOW_SYNC_PENDING_WRITES") {
      flushOutbox().then((result) => event.ports[0]?.postMessage({ ok: !result?.remaining }))
    }
    if (event.data?.type === "MYFLOW_SYNC_DONE") {
      refreshPending().then(() => { if (event.data.sent) { syncState = "synced"; updateSyncStatus(); showNotice(`${event.data.sent === 1 ? "1 cambio sincronizado" : `${event.data.sent} cambios sincronizados`} en segundo plano.`) } })
    }
    if (event.data?.type === "MYFLOW_DATA_REFRESHED" && currentUser && dataReady && !userIsBusy()) {
      Sync.loadSnapshot(currentUser.uid).then(async (snapshot) => { if (snapshot) { applyData(Sync.overlay(currentUser.uid, snapshot, await Sync.list(currentUser.uid))); render() } })
    }
  })
  // Cuando se activa una versión nueva de la app se ofrece recargar.
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) showUpdateBanner() })
}
function showUpdateBanner() {
  if (document.querySelector(".update-banner")) return
  const banner = document.createElement("div")
  banner.className = "update-banner"
  banner.setAttribute("role", "status")
  banner.innerHTML = `<span>Hay una versión nueva de MyFlow.</span><button class="button" type="button">Actualizar</button><button class="icon-button" type="button" aria-label="Cerrar">×</button>`
  banner.querySelector(".button").addEventListener("click", () => location.reload())
  banner.querySelector(".icon-button").addEventListener("click", () => banner.remove())
  document.body.append(banner)
}
window.addEventListener("online", () => { syncState = pendingCount ? "pending" : "synced"; flushOutbox.failures = 0; updateSyncStatus(); scheduleFlush(500) })
window.addEventListener("offline", () => { syncState = "offline"; updateSyncStatus() })
window.addEventListener("pageshow", () => { updateSyncStatus(); scheduleFlush(500) })
window.addEventListener("focus", () => { if (pendingCount) scheduleFlush(500) })
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { refreshPending(); scheduleFlush(300) }
})
document.querySelector("#sync-chip").addEventListener("click", () => { flushOutbox.failures = 0; flushOutbox({ manual: true }) })

googleSignIn.addEventListener("click",async()=>{
  googleSignIn.disabled=true
  authError.hidden=true
  authMessage.textContent="Conectando con Google…"
  try {
    await signInWithPopup(auth,googleProvider)
  } catch(error) {
    if(error.code==="auth/popup-blocked") {
      try { await signInWithRedirect(auth,googleProvider);return }
      catch(redirectError) { error=redirectError }
    }
    authError.textContent=error.code==="auth/unauthorized-domain"
      ? "Este dominio no está autorizado en Firebase Authentication."
      : `No se pudo iniciar sesión: ${error.message}`
    authError.hidden=false
    authMessage.textContent="Prueba de nuevo o revisa la configuración del proveedor Google en Firebase."
    googleSignIn.disabled=false
  }
})

if(firebaseLoadError) {
  appShell.hidden=true;mobileNavigation.hidden=true;authGate.hidden=false
  authMessage.textContent="MyFlow no pudo iniciar sus servicios de acceso."
  authError.textContent="No se pudo cargar Firebase. Recarga la página; si continúa, revisa la conexión o los permisos del navegador."
  authError.hidden=false
  googleSignIn.hidden=true
} else {
  onAuthStateChanged(auth,async(user)=>{
    currentUser=user
    authError.hidden=true
    if(!user) {
      loadedUid=null
      clearInterval(timerHandle);clearInterval(restHandle)
      document.querySelectorAll("dialog[open]").forEach((dialog)=>dialog.close())
      page="inicio";title.textContent="Inicio";libraryFilters={search:"",muscle:"Todos",equipment:"Todo",favorites:false};restSeconds=0;paused=false
      profile=null;routines=[];sessions=[];activeSession=null;activeRoutine=null;sets=[];libraryExercises=defaultExercises.map(([name,muscle,equipment])=>({name,muscle,equipment,favorite:false}));favorites=new Set();plans={};settings={};personalNotes=""
      appShell.hidden=true;mobileNavigation.hidden=true;authGate.hidden=false
      authMessage.textContent="Inicia sesión con Google para guardar tus rutinas y sesiones en tu cuenta."
      googleSignIn.hidden=false;googleSignIn.disabled=false
      return
    }
    authGate.hidden=true;appShell.hidden=false;mobileNavigation.hidden=false
    authMessage.textContent="Cargando tu cuenta…"
    if(loadedUid===user.uid)return
    loadedUid=user.uid
    await load()
    updateSyncStatus()
    scheduleFlush(800)
    registerPeriodicSync()
  })
  // Guarda un token de corta duración para que el service worker pueda subir la
  // cola aunque la app esté cerrada. Firebase lo renueva cada hora.
  onIdTokenChanged(auth,async(user)=>{
    if(!user){Sync.clearAuth().catch(()=>{});Sync.updateBadge(0);return}
    try{const result=await user.getIdTokenResult();await Sync.setAuth(user.uid,result.token,Date.parse(result.expirationTime))}catch{}
  })
}
