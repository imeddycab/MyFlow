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
let libraryExercises = JSON.parse(localStorage.getItem("myflow-exercises") || "null") || defaultExercises.map(([name, muscle, equipment]) => ({ name, muscle, equipment, favorite: false }))
let favorites = new Set(JSON.parse(localStorage.getItem("myflow-favorites") || "[]"))
let plans = JSON.parse(localStorage.getItem("myflow-plans") || "{}")
let settings = JSON.parse(localStorage.getItem("myflow-preferences") || "{}")
let page = "inicio", routineTab = "Todos", period = "3 meses", selectedDay = new Date(), monthCursor = new Date()
let activeSession = null, activeRoutine = null, lastCompleted = null, sets = [], sessionSeconds = 0, restSeconds = 0
let paused = false, workoutStartedAt = 0, timerHandle = null, restHandle = null, editingExercises = [], routineSaving = false

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options })
  if (!response.ok) {
    let message = `Error ${response.status}`
    try { message = (await response.json()).reason || message } catch {}
    throw new Error(message)
  }
  return response.status === 204 ? null : response.json()
}
function showNotice(message) {
  notice.textContent = message; notice.hidden = false; clearTimeout(showNotice.timeout)
  showNotice.timeout = setTimeout(() => { notice.hidden = true }, 4200)
}
function esc(value = "") { return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]) }
function fmtDate(value, options = { dateStyle: "medium" }) { return new Date(value).toLocaleString("es-MX", options) }
function fmtTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` }
function fmtWeight(value) { return settings.units === "lb" ? `${(Number(value) * 2.20462).toFixed(1)} lb` : `${Number(value).toLocaleString("es-MX", { maximumFractionDigits: 1 })} kg` }
function toKg(value) { return settings.units === "lb" ? Number(value) / 2.20462 : Number(value) }
function saveLocal() {
  localStorage.setItem("myflow-exercises", JSON.stringify(libraryExercises))
  localStorage.setItem("myflow-favorites", JSON.stringify([...favorites]))
  localStorage.setItem("myflow-plans", JSON.stringify(plans))
  localStorage.setItem("myflow-preferences", JSON.stringify(settings))
}
function navTitle(next) {
  const labels = { inicio: "Inicio", rutinas: "Mis rutinas", entrenar: "Entrenamiento", biblioteca: "Biblioteca de ejercicios", progreso: "Progreso y estadísticas", historial: "Historial", calendario: "Calendario", perfil: "Perfil y preferencias", herramientas: "Herramientas", resumen: "Sesión completada" }
  page = next; title.textContent = labels[next] || "MyFlow"
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page))
  document.querySelector("#more-menu").hidden = true
  document.querySelector("#more-button").setAttribute("aria-expanded", "false")
  render(); window.scrollTo({ top: 0, behavior: "smooth" })
}
function exerciseData(routine) {
  return routine?.exercises?.length ? routine.exercises : defaultExercises.slice(0, 4).map(([name, muscle, equipment]) => ({ name, muscle, equipment, sets: 3, reps: "8–12", restSeconds: 90 }))
}
function routineCard(routine, index) {
  const ex = exerciseData(routine)
  return `<article class="routine-card"><header><div><h3>${esc(routine.name)}</h3><p>${esc(routine.description || "Rutina personalizada")}</p></div><span class="routine-tag">${routine.dayOfWeek ? esc(routine.dayOfWeek.toUpperCase()) : `0${(index % 9) + 1}`}</span></header><div class="routine-meta"><span>${ex.length} ejercicios · ${ex.reduce((a, x) => a + Number(x.sets || 3), 0)} series</span><span>~${Math.max(20, ex.length * 12)} min</span></div><div class="routine-actions"><button class="button secondary" data-edit="${routine.id}">Editar</button><button class="button" data-start="${routine.id}">▶ Iniciar</button><button class="icon-button delete-routine" data-delete="${routine.id}" aria-label="Eliminar rutina">×</button></div></article>`
}
function volumeOf(session) { return (session?.sets || []).filter((set) => set.completed).reduce((sum, set) => sum + Number(set.weight) * Number(set.reps), 0) }
function doneSessions() { return sessions.filter((session) => session.finishedAt) }
function renderHome() {
  const routine = routines[0], completed = doneSessions(), volume = completed.reduce((sum, session) => sum + volumeOf(session), 0)
  const recent = [...sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 3)
  return `<section class="hero"><div class="hero-copy"><span class="eyebrow">ENTRENAMIENTO DE HOY</span><h2>${esc(routine?.name || "Tu primera rutina")}</h2><p>${esc(routine?.description || "Crea una rutina y empieza a entrenar.")}</p><div class="chips"><span class="chip">${exerciseData(routine).length} ejercicios</span><span class="chip">${exerciseData(routine).reduce((a,x)=>a+Number(x.sets||3),0)} series</span><span class="chip">~${exerciseData(routine).length*12} min</span></div><button class="button" data-start="${routine?.id || ""}">▶ &nbsp;Comenzar entrenamiento</button></div></section><div class="section-head"><div><span class="eyebrow">RESUMEN</span><h2>Tu semana en movimiento</h2></div><button class="text-button" data-page="progreso">Ver estadísticas →</button></div><div class="stats"><article class="stat"><small>Entrenamientos</small><strong>${completed.length}</strong><span>${sessions.length ? `${sessions.length} sesiones registradas` : "Empieza tu primera sesión"}</span></article><article class="stat"><small>Tiempo total</small><strong>${Math.round(completed.reduce((a,s)=>a+(new Date(s.finishedAt)-new Date(s.startedAt))/60000,0))} min</strong><span>Sesiones completadas</span></article><article class="stat"><small>Volumen acumulado</small><strong>${Math.round(volume).toLocaleString("es-MX")} kg</strong><span>Series registradas</span></article></div><div class="section-head"><div><span class="eyebrow">TUS PLANES</span><h2>Mis rutinas</h2></div><button class="text-button" data-page="rutinas">Ver todas →</button></div><div class="routine-grid">${routines.slice(0,3).map(routineCard).join("") || `<div class="empty">Todavía no tienes rutinas. Crea una para empezar.</div>`}</div><div class="section-head"><div><span class="eyebrow">ACTIVIDAD</span><h2>Últimos entrenamientos</h2></div><button class="text-button" data-page="historial">Ver historial</button></div><div class="history-list">${recent.map(sessionRow).join("") || `<div class="empty">Tus sesiones aparecerán aquí.</div>`}</div>`
}
function renderRoutines() {
  const visible = routines.filter((r) => routineTab === "Todos" || (routineTab === "Push Pull Legs" ? /push|pull|leg/i.test(r.name) : routineTab === "Upper / Lower" ? /upper|lower|leg/i.test(r.name) : r.exercises?.length > 0))
  return `<section class="program"><div><span class="eyebrow">PROGRAMA ACTIVO</span><h2>Push Pull Legs · 6 semanas</h2><p>Semana 4 de 6 · Próximo: ${esc(routines[0]?.name || "Crea una rutina")}</p></div><strong>67%<span class="progress-track"><i></i></span></strong><button class="button" data-start="${routines[0]?.id || ""}">Entrenar ahora</button></section><div class="section-head"><div><span class="eyebrow">PLANIFICACIÓN</span><h2>Mis rutinas</h2></div><button class="button" data-create-routine>＋ Crear rutina</button></div><div class="tabs">${["Todos","Push Pull Legs","Upper / Lower","Plantillas"].map((x)=>`<button data-routine-tab="${x}" class="${routineTab===x?"active":""}">${x}</button>`).join("")}</div><div class="routine-grid">${visible.map(routineCard).join("") || `<div class="empty">No hay rutinas en esta categoría todavía.</div>`}<button class="create-card" data-create-routine><span>＋</span><b>Crear nueva rutina</b><small>Diseña tu próximo entrenamiento</small></button></div>`
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
  const search = document.querySelector("#exercise-search")?.value?.toLowerCase() || ""
  const muscle = document.querySelector("#muscle-filter")?.value || "Todos"
  const equipment = document.querySelector("#equipment-filter")?.value || "Todo"
  const onlyFavorites = document.querySelector("#favorites-filter")?.classList.contains("active") || false
  const list = libraryExercises.filter((exercise) => (!search || exercise.name.toLowerCase().includes(search) || exercise.muscle.toLowerCase().includes(search)) && (muscle === "Todos" || exercise.muscle === muscle) && (equipment === "Todo" || exercise.equipment === equipment) && (!onlyFavorites || favorites.has(exercise.name)))
  return `<div class="section-head page-section-head"><div><span class="eyebrow">CATÁLOGO</span><h2>Biblioteca de ejercicios</h2></div><button class="button" data-create-exercise>＋ Crear ejercicio</button></div><div class="filters"><label class="search-label">⌕<input id="exercise-search" placeholder="Buscar ejercicios…" value="${esc(search)}"></label><select id="muscle-filter"><option>Todos</option>${[...new Set(libraryExercises.map((x)=>x.muscle))].map((x)=>`<option ${muscle===x?"selected":""}>${esc(x)}</option>`).join("")}</select><select id="equipment-filter"><option value="Todo">Todo el equipamiento</option>${[...new Set(libraryExercises.map((x)=>x.equipment))].map((x)=>`<option ${equipment===x?"selected":""}>${esc(x)}</option>`).join("")}</select><button id="favorites-filter" class="filter-button ${onlyFavorites?"active":""}">☆ Solo favoritos</button></div><div class="exercise-grid">${list.map((x)=>`<article class="exercise-card"><div class="exercise-symbol">${esc(x.muscle.slice(0,2).toUpperCase())}</div><div><small>${esc(x.muscle)}</small><h3>${esc(x.name)}</h3><p>${esc(x.equipment)} · Fuerza</p></div><button class="favorite-button ${favorites.has(x.name)?"active":""}" data-favorite="${esc(x.name)}" aria-label="Favorito">${favorites.has(x.name)?"★":"☆"}</button></article>`).join("") || `<div class="empty">No encontramos ejercicios con esos filtros.</div>`}</div>`
}
function renderProgress() {
  const days = period === "4 semanas" ? 28 : period === "1 año" ? 365 : 90
  const since = Date.now() - days * 86400000
  const recent = doneSessions().filter((s)=>new Date(s.startedAt).getTime()>=since)
  const volume = recent.reduce((sum,s)=>sum+volumeOf(s),0)
  const bars = Array.from({length:7},(_,i)=>{ const day=new Date(); day.setDate(day.getDate()-6+i); const val=recent.filter((s)=>new Date(s.startedAt).toDateString()===day.toDateString()).reduce((sum,s)=>sum+volumeOf(s),0); return `<span title="${Math.round(val)} kg"><i style="height:${Math.min(100,Math.max(5,val/Math.max(volume/7,1)*30))}%"></i><small>${["D","L","M","M","J","V","S"][day.getDay()]}</small></span>` }).join("")
  const groups = new Map(); recent.flatMap((s)=>s.sets||[]).filter((x)=>x.completed).forEach((x)=>{const exercise=libraryExercises.find((e)=>e.name===x.exercise); const key=exercise?.muscle||"Otros"; groups.set(key,(groups.get(key)||0)+1)})
  const muscles = [...groups.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
  return `<div class="section-head page-section-head"><div><span class="eyebrow">ANÁLISIS</span><h2>Progreso y estadísticas</h2></div><div class="segments">${["4 semanas","3 meses","1 año"].map((x)=>`<button data-period="${x}" class="${period===x?"active":""}">${x}</button>`).join("")}</div></div><div class="stats kpis"><article class="stat"><small>VOLUMEN TOTAL</small><strong>${(volume/1000).toFixed(1)}k kg</strong><span>En el periodo seleccionado</span></article><article class="stat"><small>ENTRENAMIENTOS</small><strong>${recent.length}</strong><span>${recent.length ? (recent.length/days*7).toFixed(1) : "0"} por semana</span></article><article class="stat"><small>TIEMPO ACTIVO</small><strong>${Math.round(recent.reduce((a,s)=>a+(new Date(s.finishedAt)-new Date(s.startedAt))/60000,0))} min</strong><span>Sesiones terminadas</span></article><article class="stat"><small>RÉCORDS</small><strong>${recent.flatMap((s)=>s.sets||[]).filter((x)=>x.completed).length}</strong><span>Series registradas</span></article></div><div class="analytics-grid"><article class="card chart-card"><span class="eyebrow">ACTIVIDAD SEMANAL</span><h3>Volumen de entrenamiento</h3><strong class="chart-total">${Math.round(volume).toLocaleString("es-MX")} kg</strong><div class="bars">${bars}</div></article><article class="card"><span class="eyebrow">DISTRIBUCIÓN</span><h3>Grupos musculares</h3><div class="muscle-list">${muscles.map(([name,count])=>`<div><span>${esc(name)}</span><b>${count} series</b></div>`).join("") || `<p class="muted">Completa sesiones para ver tus grupos musculares.</p>`}</div></article></div><div class="section-head"><div><span class="eyebrow">MEJORES MARCAS</span><h2>Ejercicios con más carga</h2></div></div><div class="history-list">${[...new Set(sessions.flatMap((s)=>s.sets||[]).map((x)=>x.exercise))].slice(0,4).map((name)=>{const best=Math.max(...sessions.flatMap((s)=>s.sets||[]).filter((x)=>x.exercise===name&&x.completed).map((x)=>x.weight),0);return `<article class="session-row"><div><h3>${esc(name)}</h3><p>Mejor carga registrada</p></div><div class="session-volume">${fmtWeight(best)}</div></article>`}).join("") || `<div class="empty">Completa entrenamientos para registrar marcas.</div>`}</div>`
}
function sessionRow(session) {
  const volume = volumeOf(session), setsDone = (session.sets||[]).filter((x)=>x.completed).length
  const duration = session.durationSeconds ? Math.max(1,Math.round(session.durationSeconds/60)) : session.finishedAt ? Math.max(1,Math.round((new Date(session.finishedAt)-new Date(session.startedAt))/60000)) : Math.max(1,Math.round((Date.now()-new Date(session.startedAt))/60000))
  return `<article class="session-row"><div><h3>${esc(session.routineName)}</h3><p>${fmtDate(session.startedAt,{dateStyle:"medium",timeStyle:"short"})} · ${duration} min · ${setsDone} series${session.finishedAt?"":" · En progreso"}</p></div><div class="session-volume">${Math.round(volume).toLocaleString("es-MX")} kg<small>volumen</small></div>${!session.finishedAt?`<button class="button secondary" data-resume="${session.id}">Reanudar</button>`:""}</article>`
}
function renderHistory() {
  const ordered=[...sessions].sort((a,b)=>new Date(b.startedAt)-new Date(a.startedAt))
  return `<div class="section-head page-section-head"><div><span class="eyebrow">REGISTRO</span><h2>Historial de entrenamientos</h2></div><button class="button secondary" data-export-csv>Exportar CSV</button></div><div class="history-list">${ordered.map(sessionRow).join("")||`<div class="empty">Tus entrenamientos aparecerán aquí.</div>`}</div>`
}
function renderCalendar() {
  const year=monthCursor.getFullYear(), month=monthCursor.getMonth(), first=new Date(year,month,1), offset=(first.getDay()+6)%7, days=new Date(year,month+1,0).getDate(), cells=[]
  for(let i=0;i<offset;i++) cells.push(`<span class="day-cell blank"></span>`)
  for(let day=1;day<=days;day++){const key=`${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`; const selected=selectedDay.toDateString()===new Date(year,month,day).toDateString(); cells.push(`<button class="day-cell ${selected?"selected":""} ${plans[key]?"has-plan":""}" data-select-day="${key}"><b>${day}</b>${plans[key]?`<i></i>`:""}</button>`)}
  const key=dayKey(selectedDay), selectedPlans=plans[key]||[]
  return `<div class="section-head page-section-head"><div><span class="eyebrow">PLANIFICACIÓN</span><h2>Calendario</h2></div><button class="button" data-schedule>＋ Programar rutina</button></div><div class="calendar-layout"><section class="card calendar-card"><header><button class="icon-button" data-month="-1">‹</button><h3>${monthCursor.toLocaleDateString("es-MX",{month:"long",year:"numeric"})}</h3><button class="icon-button" data-month="1">›</button></header><div class="calendar-grid weekday-row">${["LUN","MAR","MIÉ","JUE","VIE","SÁB","DOM"].map(x=>`<span>${x}</span>`).join("")}</div><div class="calendar-grid">${cells.join("")}</div></section><aside class="card day-card"><span class="eyebrow">${fmtDate(selectedDay,{weekday:"long",day:"numeric",month:"long"}).toUpperCase()}</span><h3>Plan del día</h3>${selectedPlans.map((id)=>{const r=routines.find((x)=>x.id===id);return r?`<article class="planned-routine"><div><b>${esc(r.name)}</b><small>${esc(r.description)}</small></div><button class="button" data-start="${r.id}">Entrenar</button><button class="icon-button" data-unschedule="${id}" aria-label="Quitar del calendario">×</button></article>`:""}).join("")||`<p class="muted">No tienes actividades programadas.</p>`}<button class="button secondary full-button" data-schedule>＋ Añadir actividad</button></aside></div>`
}
function dayKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`}
function renderProfile() {
  const displayName=profile?.name||"Atleta"
  return `<div class="profile-grid"><article class="card profile-card"><div class="profile-large">${esc(initials(displayName))}</div><h2>${esc(displayName)}</h2><p>Intermedio · Hipertrofia</p><div class="profile-metrics"><span><b>76.4</b> kg<small>Peso</small></span><span><b>178</b> cm<small>Altura</small></span><span><b>18</b> meses<small>Experiencia</small></span></div></article><section class="card preferences"><span class="eyebrow">AJUSTES</span><h3>Preferencias de entrenamiento</h3><label>Tu nombre<input id="profile-name-input" maxlength="60" value="${esc(displayName)}"></label><button class="button secondary" data-save-profile>Guardar nombre</button><label>Unidades<select id="units-select"><option value="kg" ${settings.units!=="lb"?"selected":""}>Kilogramos (kg)</option><option value="lb" ${settings.units==="lb"?"selected":""}>Libras (lb)</option></select></label><label>Descanso predeterminado<select id="rest-select">${[30,60,90,120,180].map(x=>`<option value="${x}" ${Number(settings.rest||90)===x?"selected":""}>${x} segundos</option>`).join("")}</select></label><label class="switch-label">Iniciar descanso al completar una serie<input id="auto-rest" type="checkbox" ${settings.autoRest===false?"":"checked"}></label><label>Tema<select id="theme-select"><option value="system" ${(settings.theme||"system")==="system"?"selected":""}>Seguir el sistema</option><option value="light" ${settings.theme==="light"?"selected":""}>Claro</option><option value="dark" ${settings.theme==="dark"?"selected":""}>Oscuro</option></select></label></section><section class="card measurements"><span class="eyebrow">MEDIDAS CORPORALES</span><h3>Último registro</h3><div class="measure-grid"><span>Peso <b>76.4 kg</b></span><span>Cintura <b>81 cm</b></span><span>Brazo <b>37.2 cm</b></span><span>Pecho <b>103 cm</b></span></div></section></div>`
}
function renderTools() {
  return `<div class="tools-grid"><article class="card tool-card"><span class="eyebrow">CALCULADORA</span><h3>Discos para barra</h3><p>Calcula cuánto cargar en cada lado. Barra estándar: 20 kg.</p><label>Peso total (${settings.units||"kg"})<input id="bar-weight" type="number" min="20" value="100"></label><div class="plate-result" id="plate-result">40 kg por lado</div></article><article class="card tool-card"><span class="eyebrow">CALCULADORA</span><h3>Repetición máxima (1RM)</h3><p>Estimación con la fórmula de Epley.</p><div class="tool-input-row"><label>Peso<input id="rm-weight" type="number" value="90" min="1"></label><label>Reps<input id="rm-reps" type="number" value="8" min="1" max="30"></label></div><div class="plate-result" id="rm-result">114 kg estimados</div></article><article class="card tool-card"><span class="eyebrow">DATOS</span><h3>Respaldo y notas</h3><p>Exporta una copia de tus rutinas y entrenamientos.</p><button class="button secondary full-button" data-export-json>Exportar datos JSON</button><button class="button secondary full-button" data-export-csv>Exportar historial CSV</button><label>Notas personales<textarea id="personal-notes" rows="4" placeholder="Anota tus objetivos o recordatorios…">${esc(localStorage.getItem("myflow-notes")||"")}</textarea></label></article></div>`
}
function renderSummary(session=lastCompleted) {
  if(!session) return `<div class="empty">No hay una sesión completada para mostrar.</div>`
  const completed=(session.sets||[]).filter((x)=>x.completed), volume=volumeOf(session), duration=session.durationSeconds??Math.max(0,Math.round((new Date(session.finishedAt||Date.now())-new Date(session.startedAt))/1000))
  const breakdown=[...new Set(completed.map((x)=>x.exercise))].map((name)=>{const rows=completed.filter((x)=>x.exercise===name);return `<article class="summary-exercise"><b>${esc(name)}</b><span>${rows.length} series</span><span>${rows.map((x)=>`${fmtWeight(x.weight)} × ${x.reps}`).join(" · ")}</span></article>`}).join("")
  return `<section class="summary-page"><div class="summary-icon">✓</div><span class="eyebrow">ENTRENAMIENTO COMPLETADO</span><h2>Gran sesión, ${esc(profile?.name||"atleta")}.</h2><p>Registraste ${completed.length} de ${(session.sets||[]).length} series.</p><div class="summary-stats"><article class="stat"><small>Duración</small><strong>${fmtTime(duration)}</strong></article><article class="stat"><small>Series</small><strong>${completed.length}</strong></article><article class="stat"><small>Volumen</small><strong>${Math.round(volume).toLocaleString("es-MX")} kg</strong></article><article class="stat"><small>Ejercicios</small><strong>${new Set(completed.map((x)=>x.exercise)).size}</strong></article></div><div class="card summary-detail"><div class="section-head"><div><span class="eyebrow">DETALLE</span><h3>${esc(session.routineName)}</h3></div><span class="sync">${fmtDate(session.finishedAt||Date.now())}</span></div>${breakdown||`<p class="muted">No registraste series completadas.</p>`}</div><div class="share-box"><button class="button share-result-button" id="share-workout-result">Compartir resultados (.txt)</button><span id="share-status" class="share-status" role="status" aria-live="polite"></span></div><button class="button secondary" data-page="inicio">Guardar y volver al inicio</button></section>`
}
function applyTheme() {
  const prefersLight=window.matchMedia?.("(prefers-color-scheme: light)").matches||false
  const light=settings.theme==="light"||(settings.theme!=="dark"&&prefersLight)
  document.body.classList.toggle("light",light)
  document.documentElement.style.colorScheme=light?"light":"dark"
  const meta=document.querySelector('meta[name="theme-color"]')
  if(meta)meta.content=light?"#f3f3f3":"#111111"
  const themeButton=document.querySelector("#theme-button")
  if(themeButton){const label=settings.theme==="system"?"Tema del sistema":light?"Tema claro":"Tema oscuro";themeButton.setAttribute("aria-label",`${label}. Pulsa para cambiar`);themeButton.title=label}
}
function render() {
  applyTheme()
  updateIdentity()
  const screens={inicio:renderHome,rutinas:renderRoutines,entrenar:renderWorkout,biblioteca:renderLibrary,progreso:renderProgress,historial:renderHistory,calendario:renderCalendar,perfil:renderProfile,herramientas:renderTools,resumen:()=>renderSummary()}
  view.innerHTML=(screens[page]||renderHome)()
  if(page==="resumen") bindShareButton()
  if(page==="herramientas") updateCalculators()
}
function initials(name) { return String(name||"").trim().split(/\s+/).slice(0,2).map((part)=>part[0]?.toLocaleUpperCase("es-MX")||"").join("")||"MF" }
function updateIdentity() {
  const name=profile?.name||"Mi perfil"
  const nameNode=document.querySelector("#profile-name-text"), initialsNode=document.querySelector("#profile-initials")
  if(nameNode)nameNode.textContent=name
  if(initialsNode)initialsNode.textContent=initials(profile?.name)
}
function newSet(exercise,weight=40,reps=10) { return {exercise,weight,reps,completed:false} }
async function startWorkout(routine) {
  if(activeSession&&!activeSession.finishedAt){navTitle("entrenar");showNotice("Ya tienes una sesión en curso. Continúa esa sesión antes de iniciar otra.");return}
  activeRoutine=routine||{name:"Entrenamiento libre",exercises:[]}
  const config=exerciseData(activeRoutine)
  sets=config.flatMap((exercise)=>Array.from({length:Number(exercise.sets||3)},()=>newSet(exercise.name,60,Number.parseInt(exercise.reps,10)||8)))
  if(!sets.length) sets=[newSet(defaultExercises[0][0])]
  sessionSeconds=0;restSeconds=0;paused=false
  activeSession=await api("sessions",{method:"POST",body:JSON.stringify({routineName:activeRoutine.name,sets,durationSeconds:0})})
  sessions=[activeSession,...sessions.filter((session)=>session.id!==activeSession.id)]
  workoutStartedAt=new Date(activeSession.startedAt).getTime()
  navTitle("entrenar");startClock()
}
function startClock() {
  clearInterval(timerHandle)
  timerHandle=setInterval(()=>{if(!paused){sessionSeconds++;const timer=document.querySelector("#timer-display");if(timer)timer.textContent=fmtTime(sessionSeconds)}},1000)
}
function workoutRest(duration=Number(settings.rest||90)) {
  restSeconds=Math.max(5,Math.min(900,duration)); clearInterval(restHandle)
  restHandle=setInterval(()=>{
    if(paused)return
    restSeconds=Math.max(0,restSeconds-1)
    if(restSeconds===0){clearInterval(restHandle);restHandle=null;render();return}
    const el=document.querySelector("#rest-clock")
    if(el)el.textContent=fmtTime(restSeconds)
  },1000)
  render()
}
function startRestModal() {
  const form = document.querySelector("#rest-form")
  const dialog = document.querySelector("#rest-dialog")
  form.elements.seconds.value = Math.max(5, Math.min(900, restSeconds || Number(settings.rest || 90)))
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
    focus=`<section class="training-focus rest-focus"><span class="eyebrow">DESCANSO ENTRE SERIES</span><div class="rest-ring"><strong id="rest-clock">${fmtTime(restSeconds)}</strong><small>RECUPERA</small></div><h2>Respira y prepárate</h2><p>Después sigue ${nextSet?`${esc(nextSet.exercise)} · Serie ${currentOrdinal} de ${exerciseSets.length}`:"terminar tu sesión"}.</p><div class="rest-progress"><i style="width:${Math.max(4,Math.min(100,restSeconds/Number(settings.rest||90)*100))}%"></i></div><button class="button secondary skip-rest-button" data-rest-skip>Omitir descanso →</button></section>`
  }else if(nextSet){
    const displayWeight=settings.units==="lb"?Math.round(nextSet.weight*2.20462):nextSet.weight
    focus=`<section class="training-focus"><div class="exercise-step-top"><span class="eyebrow">${esc(routineName.toUpperCase())}</span><span class="step-count">EJERCICIO ${new Set(sets.slice(0,nextIndex+1).map((x)=>x.exercise)).size} · ${new Set(sets.map((x)=>x.exercise)).size}</span></div><h2>${esc(currentExercise)}</h2><p class="exercise-subtitle">${esc(libraryExercises.find((x)=>x.name===currentExercise)?.muscle||"Fuerza")} · ${esc(libraryExercises.find((x)=>x.name===currentExercise)?.equipment||"Equipo")}</p><div class="set-progress"><span>Serie ${currentOrdinal} <small>de ${exerciseSets.length}</small></span><span>${completeCount} de ${sets.length} completadas</span></div><div class="set-progress-track"><i style="width:${sets.length?completeCount/sets.length*100:0}%"></i></div><div class="set-inputs"><label>PESO <div><input type="number" min="0" step="0.5" value="${displayWeight}" data-current-weight><span>${settings.units||"kg"}</span></div></label><label>REPETICIONES <div><input type="number" min="1" value="${nextSet.reps}" data-current-reps><span>reps</span></div></label></div><div class="previous-card">${exerciseSets.filter(({item})=>item.completed).length?`Series anteriores: ${exerciseSets.filter(({item})=>item.completed).map(({item})=>`${fmtWeight(item.weight)} × ${item.reps}`).join(" · ")}`:"Primera serie de este ejercicio. Registra tu carga y repeticiones."}</div><button class="button complete-set-button" data-complete-current="${nextIndex}">✓ &nbsp;Completar serie</button><div class="exercise-dots">${sets.map((set,index)=>`<i class="${set.completed?"done":""} ${index===nextIndex?"current":""}" title="${esc(set.exercise)} · serie ${index+1}"></i>`).join("")}</div></section>`
  }else{
    focus=`<section class="training-focus workout-complete"><div class="summary-icon">✓</div><span class="eyebrow">TODOS LOS EJERCICIOS COMPLETADOS</span><h2>Buen trabajo.</h2><p>Revisa tus datos o finaliza para guardar los resultados.</p><div class="completion-stat"><strong>${completeCount}</strong><span>series completadas</span></div></section>`
  }
  const completedExercises=[...new Set(sets.filter((x)=>x.completed).map((x)=>x.exercise))]
  const upcoming=[...new Set(sets.filter((x,index)=>!x.completed&&index!==nextIndex).map((x)=>x.exercise))].slice(0,3)
  return `<div class="workout-session-heading"><div><span class="eyebrow">${activeSession?"SESIÓN ACTIVA":"PREPARANDO SESIÓN"}</span><h2>${esc(routineName)}</h2><p><span id="timer-display">${fmtTime(sessionSeconds)}</span> transcurridos · ${completedExercises.length} ejercicios completados</p></div><span class="live-dot">● En curso</span></div>${paused?`<div class="paused-banner">Entrenamiento en pausa. El cronómetro y el descanso se reanudarán juntos.</div>`:""}${focus}<section class="session-flow-summary"><div><span class="eyebrow">SECUENCIA</span><h3>Tu entrenamiento de hoy</h3></div><div class="flow-steps">${[...new Set(sets.map((x)=>x.exercise))].map((name,index)=>`<div class="flow-step ${completedExercises.includes(name)?"done":""} ${name===currentExercise?"current":""}"><i>${completedExercises.includes(name)?"✓":index+1}</i><span><b>${esc(name)}</b><small>${sets.filter((x)=>x.exercise===name).filter((x)=>x.completed).length} / ${sets.filter((x)=>x.exercise===name).length} series</small></span></div>`).join("")}</div></section><div class="workout-toolbar"><button class="toolbar-button" data-pause aria-label="${paused?"Reanudar":"Pausar"}"><span>${paused?"▶":"Ⅱ"}</span><b>${paused?"Reanudar":"Pausar"}</b></button><button class="toolbar-button" data-open-rest><span>⏱</span><b>Timer extras</b></button><button class="toolbar-button finish-toolbar" data-finish><span>■</span><b>Finalizar</b></button></div>`
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
function dayKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`}
async function refreshData() { [routines,sessions]=await Promise.all([api("routines"),api("sessions")]); }
async function load() {
  try {
    await refreshData()
    const profileResponse=await api("profile")
    profile=profileResponse.profile
    const unfinished=sessions.find((session)=>!session.finishedAt)
    if(unfinished){activeSession=unfinished;activeRoutine=routines.find((r)=>r.name===unfinished.routineName)||{name:unfinished.routineName};sets=unfinished.sets?.length?unfinished.sets:[newSet(defaultExercises[0][0])];workoutStartedAt=new Date(unfinished.startedAt).getTime();sessionSeconds=unfinished.durationSeconds??Math.floor((Date.now()-workoutStartedAt)/1000);page="entrenar";title.textContent="Entrenamiento";startClock()}
    render()
    if(!profile?.name)document.querySelector("#welcome-dialog").showModal()
  } catch(error) { showNotice(`No se pudo conectar con Vapor: ${error.message}`);view.innerHTML=`<div class="empty">No se pudo cargar MyFlow. Comprueba que el servidor Swift esté en ejecución.</div>` }
}

// Navigation and actions
view.addEventListener("click",async(event)=>{
  const button=event.target.closest("button");if(!button)return
  try {
    if(button.dataset.page){navTitle(button.dataset.page);return}
    if(button.hasAttribute("data-create-routine")){openRoutineEditor();return}
    if(button.dataset.routineTab){routineTab=button.dataset.routineTab;render();return}
    if(button.hasAttribute("data-save-profile")){
      const name=document.querySelector("#profile-name-input").value.trim()
      profile=await api("profile",{method:"PUT",body:JSON.stringify({name})})
      render();showNotice("Tu nombre quedó guardado en tu perfil.");return
    }
    if(button.dataset.edit){openRoutineEditor(routines.find((r)=>r.id===button.dataset.edit));return}
    if(button.dataset.delete){if(confirm("¿Eliminar esta rutina?")){await api(`routines/${button.dataset.delete}`,{method:"DELETE"});await refreshData();render();showNotice("Rutina eliminada.")}return}
    if(button.dataset.start!==undefined){const routine=routines.find((r)=>r.id===button.dataset.start);if(!routine){showNotice("Crea una rutina antes de comenzar.");navTitle("rutinas");return}await startWorkout(routine);return}
    if(button.hasAttribute("data-create-exercise")){exerciseForm.reset();delete exerciseForm.dataset.addToRoutine;exerciseDialog.showModal();return}
    if(button.dataset.favorite){favorites.has(button.dataset.favorite)?favorites.delete(button.dataset.favorite):favorites.add(button.dataset.favorite);saveLocal();render();return}
    if(button.dataset.period){period=button.dataset.period;render();return}
    if(button.dataset.month){monthCursor=new Date(monthCursor.getFullYear(),monthCursor.getMonth()+Number(button.dataset.month),1);render();return}
    if(button.dataset.selectDay){selectedDay=new Date(`${button.dataset.selectDay}T12:00:00`);render();return}
    if(button.hasAttribute("data-schedule")){if(!routines.length){showNotice("Crea una rutina antes de programarla.");return}const choice=prompt(`Escribe el número de la rutina que quieres programar:\n${routines.map((r,i)=>`${i+1}. ${r.name}`).join("\n")}`,"1");const routine=routines[Number(choice)-1];if(routine){const key=dayKey(selectedDay);plans[key]=[...new Set([...(plans[key]||[]),routine.id])];saveLocal();render()}return}
    if(button.dataset.unschedule){const key=dayKey(selectedDay);plans[key]=(plans[key]||[]).filter((id)=>id!==button.dataset.unschedule);saveLocal();render();return}
    if(button.dataset.exportCsv!==undefined){exportCSV();return}
    if(button.dataset.exportJson!==undefined){downloadJSON();return}
    if(button.dataset.pause!==undefined){paused=!paused;render();return}
    if(button.dataset.openRest!==undefined){startRestModal();return}
    if(button.dataset.restAdd){restSeconds=Math.min(900,restSeconds+Number(button.dataset.restAdd));render();return}
    if(button.dataset.restSkip!==undefined){restSeconds=0;clearInterval(restHandle);render();return}
    if(button.dataset.addSet!==undefined){const name=sets.find((x)=>!x.completed)?.exercise||sets.at(-1)?.exercise||defaultExercises[0][0];sets.push(newSet(name,sets.at(-1)?.weight||40,sets.at(-1)?.reps||8));render();return}
    if(button.dataset.addExercise!==undefined){const options=libraryExercises.map((x,i)=>`${i+1}. ${x.name}`).join("\n");const selection=Number(prompt(`Elige un ejercicio:\n${options}`,"1"))-1;if(libraryExercises[selection]){sets.push(...Array.from({length:3},()=>newSet(libraryExercises[selection].name)));render()}return}
    if(button.dataset.completeCurrent!==undefined){const index=Number(button.dataset.completeCurrent);const row=document.querySelector("[data-current-weight]");const reps=document.querySelector("[data-current-reps]");sets[index].weight=toKg(Number(row.value)||0);sets[index].reps=Math.max(1,Number(reps.value)||1);sets[index].completed=true;if(activeSession)await saveSession();const config=exerciseData(activeRoutine);const exercise=config.find((x)=>x.name===sets[index].exercise);workoutRest(Number(exercise?.restSeconds||settings.rest||90));return}
    if(button.dataset.finish!==undefined){await finishWorkout();return}
    if(button.dataset.resume){const session=sessions.find((x)=>x.id===button.dataset.resume);if(session){activeSession=session;activeRoutine=routines.find((r)=>r.name===session.routineName)||{name:session.routineName};sets=session.sets||[];workoutStartedAt=new Date(session.startedAt).getTime();sessionSeconds=session.durationSeconds??Math.floor((Date.now()-workoutStartedAt)/1000);navTitle("entrenar");startClock()}return}
  }catch(error){showNotice(error.message)}
})
view.addEventListener("input",(event)=>{
  if(event.target.id==="exercise-search"){const pos=event.target.selectionStart;render();const search=document.querySelector("#exercise-search");search.focus();search.setSelectionRange(pos,pos)}
  if(event.target.id==="bar-weight"||event.target.id==="rm-weight"||event.target.id==="rm-reps")updateCalculators()
})
view.addEventListener("change",async(event)=>{
  const target=event.target
  if(target.id==="muscle-filter"||target.id==="equipment-filter"){
    const values={muscle:document.querySelector("#muscle-filter").value,equipment:document.querySelector("#equipment-filter").value,search:document.querySelector("#exercise-search").value,favorites:document.querySelector("#favorites-filter").classList.contains("active")}
    render();document.querySelector("#muscle-filter").value=values.muscle;document.querySelector("#equipment-filter").value=values.equipment;document.querySelector("#exercise-search").value=values.search;document.querySelector("#favorites-filter").classList.toggle("active",values.favorites);return
  }
  if(target.dataset.weight!==undefined){sets[Number(target.dataset.weight)].weight=toKg(Number(target.value)||0);if(activeSession)await saveSession()}
  if(target.dataset.reps!==undefined){sets[Number(target.dataset.reps)].reps=Math.max(1,Number(target.value)||1);if(activeSession)await saveSession()}
  if(target.hasAttribute("data-current-weight")){const index=sets.findIndex((x)=>!x.completed);if(index>=0)sets[index].weight=toKg(Number(target.value)||0)}
  if(target.hasAttribute("data-current-reps")){const index=sets.findIndex((x)=>!x.completed);if(index>=0)sets[index].reps=Math.max(1,Number(target.value)||1)}
  if(target.id==="personal-notes")localStorage.setItem("myflow-notes",target.value)
  if(target.id==="units-select"){settings.units=target.value;saveLocal();render();return}
  if(target.id==="rest-select"){settings.rest=Number(target.value);saveLocal();showNotice("Descanso predeterminado actualizado.");return}
  if(target.id==="auto-rest"){settings.autoRest=target.checked;saveLocal();return}
  if(target.id==="theme-select"){settings.theme=target.value;saveLocal();render();return}
})
routineForm.addEventListener("input",(event)=>{if(event.target.matches("[data-routine-field]")){const index=Number(event.target.dataset.index);editingExercises[index][event.target.dataset.routineField]=event.target.value}})
routineForm.addEventListener("change",(event)=>{if(event.target.matches("[data-routine-field]")){const index=Number(event.target.dataset.index);editingExercises[index][event.target.dataset.routineField]=event.target.value}})
document.querySelector("#routine-exercise-picker").addEventListener("change",(event)=>{document.querySelector("#add-routine-exercise").disabled=!event.target.value})
routineForm.querySelector("#add-routine-exercise").addEventListener("click",()=>{
  const index=Number(document.querySelector("#routine-exercise-picker").value), exercise=libraryExercises[index]
  if(exercise){editingExercises.push({name:exercise.name,muscle:exercise.muscle,equipment:exercise.equipment,sets:3,reps:"8–12",restSeconds:Number(settings.rest||90)});paintRoutineExercises();paintRoutineExercisePicker()}
})
document.querySelector("#add-new-routine-exercise").addEventListener("click",()=>{exerciseForm.reset();exerciseForm.dataset.addToRoutine="true";exerciseDialog.showModal()})
routineForm.addEventListener("click",(event)=>{const button=event.target.closest("[data-remove-routine-exercise]");if(button){editingExercises.splice(Number(button.dataset.removeRoutineExercise),1);paintRoutineExercises()}})
routineForm.addEventListener("submit",async(event)=>{
  event.preventDefault();saveRoutineEditor()
  const id=routineForm.elements.id.value
  const payload={name:routineForm.elements.name.value.trim(),description:routineForm.elements.description.value.trim(),dayOfWeek:routineForm.elements.day.value,exercises:editingExercises,color:"green"}
  const submitButton=routineForm.querySelector('[type="submit"]')
  if(routineSaving)return
  routineSaving=true;submitButton.disabled=true
  try{if(id)await api(`routines/${id}`,{method:"PUT",body:JSON.stringify(payload)});else await api("routines",{method:"POST",body:JSON.stringify(payload)});await refreshData();routineDialog.close();render();showNotice("Rutina guardada.")}
  catch(error){showNotice(error.message)}
  finally{routineSaving=false;submitButton.disabled=false}
})


document.querySelector("#welcome-form").addEventListener("submit",async(event)=>{
  event.preventDefault()
  const name=event.currentTarget.elements.name.value.trim()
  if(!name)return
  const submit=event.currentTarget.querySelector("[type=submit]");submit.disabled=true
  try{profile=await api("profile",{method:"PUT",body:JSON.stringify({name})});document.querySelector("#welcome-dialog").close();render();showNotice(`¡Bienvenido a MyFlow, ${profile.name}!`)}
  catch(error){showNotice(error.message)}
  finally{submit.disabled=false}
})
document.querySelector("#rest-form").addEventListener("submit",(event)=>{event.preventDefault();const seconds=Math.max(5,Math.min(900,Number(event.currentTarget.elements.seconds.value)||90));settings.rest=seconds;saveLocal();document.querySelector("#rest-dialog").close();workoutRest(seconds)})
document.querySelector("#rest-form").addEventListener("click",(event)=>{const preset=event.target.closest("[data-timer-preset]");if(preset)event.currentTarget.elements.seconds.value=preset.dataset.timerPreset})
exerciseForm.addEventListener("submit",(event)=>{event.preventDefault();const data=new FormData(exerciseForm);const name=String(data.get("name")).trim();if(name){if(libraryExercises.some((item)=>item.name.toLocaleLowerCase("es-MX")===name.toLocaleLowerCase("es-MX"))){showNotice("Ya existe un ejercicio con ese nombre.");return}const exercise={name,muscle:String(data.get("muscle")),equipment:String(data.get("equipment")),favorite:false};libraryExercises.push(exercise);saveLocal();const addToRoutine=exerciseForm.dataset.addToRoutine==="true"&&routineDialog.open;delete exerciseForm.dataset.addToRoutine;if(addToRoutine){editingExercises.push({...exercise,sets:3,reps:"8–12",restSeconds:Number(settings.rest||90)});paintRoutineExercisePicker();paintRoutineExercises()}exerciseDialog.close();if(!routineDialog.open)render();showNotice(addToRoutine?"Ejercicio creado y añadido a la rutina.":"Ejercicio añadido a la biblioteca.")}})
document.addEventListener("click",(event)=>{
  const close=event.target.closest("[data-close]");if(close){document.getElementById(close.dataset.close).close();return}
})
document.querySelector("#mobile-navigation").addEventListener("click",(event)=>{const button=event.target.closest("[data-page]");if(button)navTitle(button.dataset.page)})
document.querySelector("#navigation").addEventListener("click",(event)=>{const button=event.target.closest("[data-page]");if(button)navTitle(button.dataset.page)})
async function saveSession(){if(activeSession){activeSession=await api(`sessions/${activeSession.id}`,{method:"PUT",body:JSON.stringify({routineName:activeRoutine?.name||activeSession.routineName,sets,durationSeconds:sessionSeconds})});sessions=sessions.map((session)=>session.id===activeSession.id?activeSession:session)}}
async function finishWorkout(){
  if(!activeSession){showNotice("Inicia la sesión antes de finalizarla.");return}
  await saveSession();lastCompleted=await api(`sessions/${activeSession.id}/finish`,{method:"POST"});clearInterval(timerHandle);clearInterval(restHandle);restSeconds=0;await refreshData();activeSession=null;navTitle("resumen")
}
document.querySelector("#theme-button").addEventListener("click",()=>{settings.theme=settings.theme==="system"?"light":settings.theme==="light"?"dark":"system";saveLocal();render()})
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change",()=>{if(!settings.theme||settings.theme==="system")applyTheme()})
const moreButton=document.querySelector("#more-button")
moreButton.addEventListener("click",()=>{const menu=document.querySelector("#more-menu");menu.hidden=!menu.hidden;moreButton.setAttribute("aria-expanded",String(!menu.hidden))})
load()
