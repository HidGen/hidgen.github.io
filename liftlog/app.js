'use strict';
/* Подходы — лёгкий офлайн-дневник качалки. Ваниль + IndexedDB.
   Контракт расширяем под любые типы упражнений (kind + values),
   с заделом под пост-фактум синхронизацию (id/userId/updatedAt/deleted). */

// ──────────────── Реестр типов упражнений (единственное место расширения) ────────────────
const KINDS = {
  strength: {
    label: 'Силовое', icon: '🏋',
    fields: [
      { key: 'weight', label: 'Вес', unit: 'кг', step: 2.5, min: 0, def: 20 },
      { key: 'reps', label: 'Повторы', unit: '', step: 1, min: 0, def: 10, int: true },
    ],
    summary: (v) => `${fmtN(v.weight)}×${v.reps}`,
    tonnage: (v) => (v.weight || 0) * (v.reps || 0),
  },
  bodyweight: {
    label: 'Свой вес', icon: '🧎',
    fields: [
      { key: 'reps', label: 'Повторы', unit: '', step: 1, min: 0, def: 10, int: true },
      { key: 'addedWeight', label: 'Доп. вес', unit: 'кг', step: 2.5, min: 0, def: 0 },
    ],
    summary: (v) => `×${v.reps}${v.addedWeight ? ` +${fmtN(v.addedWeight)}` : ''}`,
    tonnage: (v) => (v.addedWeight || 0) * (v.reps || 0),
  },
  cardio: {
    label: 'Кардио', icon: '🏃',
    fields: [
      { key: 'duration', label: 'Время', unit: 'мин:сек', step: 30, min: 0, def: 600, time: true },
      { key: 'distance', label: 'Дистанция', unit: 'м', step: 100, min: 0, def: 0 },
      { key: 'avgHr', label: 'Ср. пульс', unit: 'уд/мин', step: 5, min: 0, def: 0, int: true },
      { key: 'level', label: 'Нагрузка', unit: '', step: 1, min: 0, def: 0, int: true },
    ],
    summary: (v) => [
      v.duration ? fmtClock(v.duration * 1000) : null,
      v.distance ? `${(v.distance / 1000).toFixed(2)} км` : null,
      v.avgHr ? `❤${v.avgHr}` : null,
      v.level ? `ур.${v.level}` : null,
    ].filter(Boolean).join(' · '),
    tonnage: () => 0,
  },
  timed: {
    label: 'На время', icon: '⏱',
    fields: [{ key: 'duration', label: 'Время', unit: 'мин:сек', step: 5, min: 0, def: 30, time: true }],
    summary: (v) => fmtClock((v.duration || 0) * 1000),
    tonnage: () => 0,
  },
};
const DEFAULT_KIND = 'strength';
function kindOf(k) { return KINDS[k] || KINDS[DEFAULT_KIND]; }
function defValues(kind) { const o = {}; kindOf(kind).fields.forEach((f) => { o[f.key] = f.def; }); return o; }

// ──────────────────────────── IndexedDB ────────────────────────────
let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open('liftlog', 2);
    r.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('exercises')) {
        d.createObjectStore('exercises', { keyPath: 'id' }).createIndex('workoutId', 'workoutId');
      }
      if (!d.objectStoreNames.contains('entries')) {
        d.createObjectStore('entries', { keyPath: 'id' }).createIndex('exerciseId', 'exerciseId');
      }
      if (!d.objectStoreNames.contains('catalog')) d.createObjectStore('catalog', { keyPath: 'name' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _db;
}
function reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
async function put(store, obj) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(obj);
    t.oncomplete = () => res(obj); t.onerror = () => rej(t.error);
  });
}
async function getAll(store) { const d = await db(); return reqP(d.transaction(store).objectStore(store).getAll()); }
async function byIndex(store, index, key) { const d = await db(); return reqP(d.transaction(store).objectStore(store).index(index).getAll(key)); }

// синк-конверт: ставится на каждую запись при сохранении
function stamp(obj) {
  obj.updatedAt = Date.now();
  if (obj.deleted === undefined) obj.deleted = false;
  if (!obj.userId) obj.userId = 'me';
  return obj;
}
const save = (store, obj) => put(store, stamp(obj));

// ──────────────────────────── утилиты ────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = (n) => (Math.round((+n || 0) * 100) / 100).toString();
const vibrate = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}
function parseTime(str) {
  str = String(str).trim();
  if (str.includes(':')) { const [m, s] = str.split(':'); return (parseInt(m, 10) || 0) * 60 + (parseInt(s, 10) || 0); }
  return parseInt(str, 10) || 0; // голое число = секунды
}
function fmtDate(ts) {
  const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(ts); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `сегодня, ${time}`;
  if (diff === 1) return `вчера, ${time}`;
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: '2-digit' }) + `, ${time}`;
}

// ──────────────────────────── состояние ────────────────────────────
const S = {
  screen: 'home', workout: null, exercise: null, entries: [],
  draft: { name: '', kind: DEFAULT_KIND, values: defValues(DEFAULT_KIND) },
  _restAt: 0,
  role: 'lifter', sync: { running: false, msg: '' }, trainee: null,
};

// ──────────────────────────── данные ────────────────────────────
async function activeWorkout() {
  return (await getAll('workouts')).filter((w) => !w.finishedAt && !w.deleted).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}
async function startWorkout() { const w = { id: uid(), startedAt: Date.now(), finishedAt: null }; await save('workouts', w); S.workout = w; }
async function finishWorkout() { if (!S.workout) return; S.workout.finishedAt = Date.now(); await save('workouts', S.workout); S.workout = null; }
async function recentNames(limit = 12) {
  return (await getAll('catalog')).filter((c) => !c.deleted).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit);
}
async function addExercise(name, kind, values) {
  const ex = { id: uid(), workoutId: S.workout.id, name: name.trim(), kind, startedAt: Date.now() };
  await save('exercises', ex);
  await save('catalog', { name: ex.name, kind, lastValues: { ...values }, lastUsed: Date.now() });
  S.exercise = ex; S.entries = []; S._restAt = 0;
}
async function logEntry(values) {
  const e = { id: uid(), exerciseId: S.exercise.id, idx: S.entries.length + 1, values: { ...values }, loggedAt: Date.now() };
  await save('entries', e);
  S.entries.push(e); S._restAt = Date.now();
  await save('catalog', { name: S.exercise.name, kind: S.exercise.kind, lastValues: { ...values }, lastUsed: Date.now() });
  vibrate(40);
}
async function deleteEntry(id) {
  const e = S.entries.find((x) => x.id === id);
  if (e) { e.deleted = true; await save('entries', e); }       // тумбстоун, не физическое удаление (для синка)
  S.entries = S.entries.filter((x) => x.id !== id);
  S.entries.forEach((x, i) => { x.idx = i + 1; });
}
async function entriesOf(exerciseId) {
  return (await byIndex('entries', 'exerciseId', exerciseId)).filter((e) => !e.deleted).sort((a, b) => a.idx - b.idx);
}
async function exercisesOf(workoutId) {
  const exs = (await byIndex('exercises', 'workoutId', workoutId)).filter((e) => !e.deleted).sort((a, b) => a.startedAt - b.startedAt);
  for (const ex of exs) ex._entries = await entriesOf(ex.id);
  return exs;
}
function exTonnage(ex) { const k = kindOf(ex.kind); return ex._entries.reduce((a, e) => a + k.tonnage(e.values), 0); }
function exSummary(ex) {
  const k = kindOf(ex.kind);
  return ex._entries.length ? ex._entries.map((e) => k.summary(e.values)).join(' · ') : 'нет подходов';
}

// ──────────────────────────── экспорт / импорт ────────────────────────────
async function exportData() {
  const data = { app: 'liftlog', version: 2, exportedAt: Date.now() };
  for (const s of ['workouts', 'exercises', 'entries', 'catalog']) data[s] = await getAll(s);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = 'podhody-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
}
async function importData(file) {
  const data = JSON.parse(await file.text());
  for (const s of ['workouts', 'exercises', 'entries', 'catalog']) {
    for (const rec of (data[s] || [])) {
      const cur = (await getAll(s)).find((x) => (x.id || x.name) === (rec.id || rec.name));
      if (!cur || (rec.updatedAt || 0) >= (cur.updatedAt || 0)) await put(s, rec); // LWW по updatedAt
    }
  }
}

// ──────────────────── аккаунт / роль / синхронизация ────────────────────
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ll_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { localStorage.setItem('ll_' + k, JSON.stringify(v)); },
};
const CODE_ALPH = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode(n) { let s = ''; for (let i = 0; i < n; i++) s += CODE_ALPH[Math.floor(Math.random() * CODE_ALPH.length)]; return s; }
function athleteId() { let id = LS.get('athleteId', null); if (!id) { id = genCode(4) + '-' + genCode(4); LS.set('athleteId', id); } return id; }
function syncUrl() { return LS.get('syncUrl', ''); }   // пусто = синк выключен, приложение чисто локальное
function trainees() { return LS.get('trainees', []); }

const STORES = ['workouts', 'exercises', 'entries', 'catalog'];
const keyOf = (store, r) => (store === 'catalog' ? r.name : r.id);

async function localChanges(since) {
  const out = [];
  for (const store of STORES) for (const r of await getAll(store)) {
    if ((r.updatedAt || 0) > since) out.push({ store, id: keyOf(store, r), updatedAt: r.updatedAt || 0, deleted: !!r.deleted, data: r });
  }
  return out;
}
async function applyChanges(changes) {
  for (const ch of changes) {
    const rec = ch.data; if (!rec) continue;
    const existing = (await getAll(ch.store)).find((x) => keyOf(ch.store, x) === keyOf(ch.store, rec));
    if (!existing || (rec.updatedAt || 0) >= (existing.updatedAt || 0)) await put(ch.store, rec); // put без stamp!
  }
}
async function syncNow() {
  if (S.sync.running) return;
  if (!syncUrl()) { S.sync.msg = 'синк выключен — укажи адрес сервера'; if (S.screen === 'settings') render(); return; }
  S.sync.running = true; S.sync.msg = 'синхронизация…'; if (S.screen === 'settings') render();
  try {
    const since = LS.get('lastSync', 0);
    const changes = await localChanges(since);
    const res = await fetch(syncUrl() + '/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId: athleteId(), since, changes }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    await applyChanges(data.changes || []);
    LS.set('lastSync', data.serverTime || since);
    S.sync.msg = `ок · ↑${changes.length} ↓${(data.changes || []).length} · ${new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
    if (S.workout) S.workout = await activeWorkout();
  } catch (e) {
    S.sync.msg = 'нет связи с сервером (' + e.message + ')';
  }
  S.sync.running = false; render();
}
async function fetchTrainee(id) {
  const res = await fetch(syncUrl() + '/api/athlete?id=' + encodeURIComponent(id) + '&since=0');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const g = { workouts: [], exercises: [], entries: [] };
  for (const ch of data.changes || []) if (!ch.deleted && g[ch.store]) g[ch.store].push(ch.data);
  return g;
}

// ──────────────────────────── навигация ────────────────────────────
function go(screen) { S.screen = screen; render(); }
async function openExercise(ex) {
  S.exercise = ex; S.entries = await entriesOf(ex.id);
  const last = S.entries[S.entries.length - 1];
  S._restAt = last ? last.loggedAt : 0;
  S.draft.kind = ex.kind;
  S.draft.values = last ? { ...last.values } : defValues(ex.kind);
  go('exercise');
}

// ──────────────────────────── рендер ────────────────────────────
const app = $('#app');
function topBar(title, right) { return `<div class="top"><h1>${esc(title)}</h1><span class="spacer"></span>${right || ''}</div>`; }

function fieldStepper(field, value) {
  const disp = field.time ? fmtClock((value || 0) * 1000) : fmtN(value);
  const hint = field.time ? 'мин:сек' : (field.unit || '');
  return `<div class="label-row"><span class="l">${esc(field.label)}</span><span class="r">${field.time ? '±' + field.step + 'с' : 'шаг ' + field.step + (field.unit ? ' ' + field.unit : '')}</span></div>
    <div class="stepper">
      <button class="pm" data-act="dec" data-field="${field.key}">−</button>
      <div class="val" data-act="edit" data-field="${field.key}"><div class="num">${disp}</div><div class="unit">${esc(hint)}</div></div>
      <button class="pm" data-act="inc" data-field="${field.key}">+</button></div>`;
}
function draftFields() { return kindOf(S.draft.kind).fields.map((f) => fieldStepper(f, S.draft.values[f.key])).join(''); }

async function render() {
  if (S.screen === 'settings') return renderSettings();
  if (S.role === 'trainer') return S.screen === 'trainee' ? renderTrainee() : renderTrainer();
  if (S.screen === 'newExercise') return renderNewExercise();
  if (S.screen === 'exercise') return renderExercise();
  if (S.screen === 'history') return renderHistory();
  return renderHome();
}

async function renderHome() {
  if (!S.workout) {
    app.innerHTML = topBar('Считалка для качалки') +
      `<div style="flex:1"></div>
       <button class="btn btn-primary btn-big" data-act="start-workout">▶ Начать тренировку</button>
       <div class="btn-row">
         <button class="btn" data-act="open-history">📋 История</button>
         <button class="btn" data-act="open-settings">⚙ Настройки</button></div>
       <div class="empty" style="padding-top:6px">Данные хранятся на устройстве, работает офлайн.</div>`;
    return;
  }
  const exs = await exercisesOf(S.workout.id);
  const tonnage = exs.reduce((a, ex) => a + exTonnage(ex), 0);
  const rows = exs.map((ex) => `<div class="item" data-act="open-exercise" data-id="${ex.id}">
      <div class="grow"><div class="name">${kindOf(ex.kind).icon} ${esc(ex.name)}</div><div class="meta">${esc(exSummary(ex))}</div></div>
      <div class="big">${ex._entries.length}</div></div>`).join('');
  app.innerHTML = topBar('Тренировка', `<button class="icon-btn" data-act="open-settings">⚙</button><button class="icon-btn" data-act="open-history">История</button>`) +
    `<div class="timer">идёт <b id="wtime">${fmtClock(Date.now() - S.workout.startedAt)}</b>${tonnage ? ` · тоннаж ${Math.round(tonnage)} кг` : ''}</div>
     <div class="list">${rows || '<div class="empty">Упражнений пока нет</div>'}</div>
     <button class="btn btn-primary" data-act="new-exercise">+ Упражнение</button>
     <div style="flex:1"></div>
     <button class="btn btn-ghost btn-danger" data-act="finish-workout">Завершить тренировку</button>`;
}

async function renderNewExercise() {
  const recent = await recentNames(12);
  const kindChips = Object.keys(KINDS).map((k) =>
    `<button class="chip ${k === S.draft.kind ? 'active' : ''}" data-act="pick-kind" data-kind="${k}">${KINDS[k].icon} ${KINDS[k].label}</button>`).join('');
  const nameChips = recent.map((c) =>
    `<button class="chip" data-act="pick-name" data-name="${esc(c.name)}">${kindOf(c.kind).icon} ${esc(c.name)}</button>`).join('');
  app.innerHTML = topBar('Новое упражнение', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<div class="chips">${kindChips}</div>
     <label class="field"><div class="lab">Название</div>
       <input class="text" id="exName" placeholder="напр. Жим лёжа" value="${esc(S.draft.name)}" autocomplete="off"></label>
     ${nameChips ? `<div class="chips">${nameChips}</div>` : ''}
     ${draftFields()}
     <div style="flex:1"></div>
     <button class="btn btn-primary btn-big" data-act="start-exercise">Начать упражнение</button>`;
  const inp = $('#exName'); inp.addEventListener('input', () => { S.draft.name = inp.value; });
}

async function renderExercise() {
  const ex = S.exercise, k = kindOf(ex.kind);
  const rows = S.entries.map((e) => `<div class="setrow">
      <div class="idx">${e.idx}</div><div class="sv">${esc(k.summary(e.values))}</div>
      <button class="x" data-act="del-set" data-id="${e.id}">✕</button></div>`).reverse().join('');
  app.innerHTML = topBar(`${k.icon} ${ex.name}`, `<button class="icon-btn" data-act="finish-exercise">Готово</button>`) +
    `${draftFields()}
     <button class="btn btn-primary btn-big" data-act="log-set">Записать&nbsp; <b>${esc(k.summary(S.draft.values)) || '—'}</b></button>
     <div class="timer" id="rest">${S._restAt ? 'отдых ' + fmtClock(Date.now() - S._restAt) : 'запиши первый подход'}</div>
     <div class="sets">${rows || ''}</div>`;
}

async function renderHistory() {
  const ws = (await getAll('workouts')).filter((w) => w.finishedAt && !w.deleted).sort((a, b) => b.startedAt - a.startedAt);
  const blocks = [];
  for (const w of ws) {
    const exs = await exercisesOf(w.id);
    const tonnage = exs.reduce((a, ex) => a + exTonnage(ex), 0);
    const cnt = exs.reduce((a, ex) => a + ex._entries.length, 0);
    const inner = exs.map((ex) => `<div class="item"><div class="grow"><div class="name">${kindOf(ex.kind).icon} ${esc(ex.name)}</div><div class="meta">${esc(exSummary(ex))}</div></div></div>`).join('');
    blocks.push(`<details class="card"><summary><div class="item" style="border:none;padding:0;background:none">
      <div class="grow"><div class="name">${esc(fmtDate(w.startedAt))}</div>
      <div class="meta">${exs.length} упр · ${cnt} подх${tonnage ? ` · ${Math.round(tonnage)} кг` : ''} · ${fmtClock(w.finishedAt - w.startedAt)}</div></div>
      <div class="muted">▾</div></div></summary><div class="list" style="margin-top:10px">${inner || '<div class="empty">пусто</div>'}</div></details>`);
  }
  app.innerHTML = topBar('История', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<div class="list">${blocks.join('') || '<div class="empty">Пока нет завершённых тренировок</div>'}</div>
     <div class="btn-row" style="margin-top:6px">
       <button class="btn btn-ghost" data-act="export">⬇ Экспорт</button>
       <button class="btn btn-ghost" data-act="import">⬆ Импорт</button></div>
     <input type="file" id="importFile" accept="application/json" hidden>`;
  const f = $('#importFile');
  f.addEventListener('change', async () => { if (f.files[0]) { await importData(f.files[0]); alert('Импорт завершён'); go('history'); } });
}

async function renderSettings() {
  const id = athleteId(), last = LS.get('lastSync', 0);
  app.innerHTML = topBar('Настройки', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<div class="label-row"><span class="l">Роль</span></div>
     <div class="chips">
       <button class="chip ${S.role === 'lifter' ? 'active' : ''}" data-act="set-role" data-role="lifter">🏋 Качок</button>
       <button class="chip ${S.role === 'trainer' ? 'active' : ''}" data-act="set-role" data-role="trainer">📋 Тренер</button></div>
     <div class="card">
       <div class="muted" style="font-size:13px">Твой ID — дай его тренеру, чтобы он видел твои тренировки:</div>
       <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
         <div style="font-size:24px;font-weight:800;letter-spacing:1px;flex:1">${esc(id)}</div>
         <button class="icon-btn" data-act="copy-id" data-id="${esc(id)}">копировать</button></div></div>
     <label class="field"><div class="lab">Сервер синхронизации (пусто = только на устройстве)</div>
       <input class="text" id="syncUrl" value="${esc(syncUrl())}" placeholder="напр. http://localhost:5090" autocomplete="off"></label>
     <button class="btn btn-primary" data-act="sync-now">${S.sync.running ? '…' : '⟳ Синхронизировать'}</button>
     <div class="timer">${esc(S.sync.msg || ('последняя: ' + (last ? new Date(last).toLocaleString('ru') : 'не было')))}</div>
     <div class="btn-row"><button class="btn btn-ghost" data-act="export">⬇ Экспорт</button><button class="btn btn-ghost" data-act="import">⬆ Импорт</button></div>
     <input type="file" id="importFile" accept="application/json" hidden>`;
  const u = $('#syncUrl'); if (u) u.addEventListener('change', () => LS.set('syncUrl', u.value.trim()));
  const f = $('#importFile'); if (f) f.addEventListener('change', async () => { if (f.files[0]) { await importData(f.files[0]); alert('Импорт завершён'); render(); } });
}

async function renderTrainer() {
  const rows = trainees().map((t) => `<div class="item">
      <div class="grow" data-act="open-trainee" data-id="${esc(t.id)}"><div class="name">${esc(t.label || t.id)}</div><div class="meta">${esc(t.id)}</div></div>
      <button class="x" data-act="remove-trainee" data-id="${esc(t.id)}">✕</button></div>`).join('');
  app.innerHTML = topBar('Подопечные', `<button class="icon-btn" data-act="open-settings">⚙</button>`) +
    `<div class="list">${rows || '<div class="empty">Пока никого. Добавь по ID, который дал качок.</div>'}</div>
     <label class="field"><div class="lab">ID подопечного</div>
       <input class="text" id="tId" placeholder="напр. K7Q2-9MF3" autocomplete="off"></label>
     <input class="text" id="tLabel" placeholder="Имя (необязательно)" autocomplete="off" style="margin-top:8px">
     <button class="btn btn-primary" data-act="add-trainee" style="margin-top:8px">+ Добавить</button>`;
}

async function renderTrainee() {
  const t = S.trainee; if (!t) return go('home');
  const g = t.data, exByW = {}, enByEx = {};
  g.exercises.forEach((ex) => { (exByW[ex.workoutId] = exByW[ex.workoutId] || []).push(ex); });
  g.entries.forEach((en) => { (enByEx[en.exerciseId] = enByEx[en.exerciseId] || []).push(en); });
  const ws = g.workouts.filter((w) => w.finishedAt && !w.deleted).sort((a, b) => b.startedAt - a.startedAt);
  const blocks = ws.map((w) => {
    const exs = (exByW[w.id] || []).filter((e) => !e.deleted).sort((a, b) => a.startedAt - b.startedAt);
    const inner = exs.map((ex) => {
      const k = kindOf(ex.kind);
      const ens = (enByEx[ex.id] || []).filter((e) => !e.deleted).sort((a, b) => a.idx - b.idx);
      const summary = ens.map((e) => k.summary(e.values)).join(' · ') || '—';
      return `<div class="item"><div class="grow"><div class="name">${k.icon} ${esc(ex.name)}</div><div class="meta">${esc(summary)}</div></div></div>`;
    }).join('');
    return `<details class="card"><summary><div class="item" style="border:none;padding:0;background:none">
      <div class="grow"><div class="name">${esc(fmtDate(w.startedAt))}</div><div class="meta">${exs.length} упр</div></div><div class="muted">▾</div></div></summary>
      <div class="list" style="margin-top:10px">${inner || '<div class="empty">пусто</div>'}</div></details>`;
  }).join('');
  app.innerHTML = topBar(t.label || t.id, `<button class="icon-btn" data-act="go-trainer">✕</button>`) +
    `<div class="muted" style="font-size:13px;margin-bottom:6px">только просмотр · ${esc(t.id)}</div>
     <div class="list">${blocks || '<div class="empty">Нет данных (или нет связи с сервером)</div>'}</div>`;
}

// ──────────────────────────── события ────────────────────────────
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;

  if (act === 'inc' || act === 'dec') {
    const f = kindOf(S.draft.kind).fields.find((x) => x.key === t.dataset.field);
    let v = (S.draft.values[f.key] || 0) + (act === 'inc' ? 1 : -1) * f.step;
    v = Math.max(f.min || 0, v); v = f.int ? Math.round(v) : Math.round(v * 100) / 100;
    S.draft.values[f.key] = v; vibrate(8); return render();
  }
  if (act === 'edit') {
    const f = kindOf(S.draft.kind).fields.find((x) => x.key === t.dataset.field);
    const cur = S.draft.values[f.key] || 0;
    const ans = prompt(f.label + (f.time ? ' (мин:сек или секунды)' : (f.unit ? ', ' + f.unit : '')) + ':', f.time ? fmtClock(cur * 1000) : fmtN(cur));
    if (ans == null) return;
    let v = f.time ? parseTime(ans) : parseFloat(String(ans).replace(',', '.'));
    if (isNaN(v)) return; v = Math.max(f.min || 0, v); if (f.int) v = Math.round(v);
    S.draft.values[f.key] = v; return render();
  }
  if (act === 'start-workout') { await startWorkout(); return go('home'); }
  if (act === 'finish-workout') { if (confirm('Завершить тренировку?')) { await finishWorkout(); return go('home'); } return; }
  if (act === 'new-exercise') { S.draft = { name: '', kind: DEFAULT_KIND, values: defValues(DEFAULT_KIND) }; return go('newExercise'); }
  if (act === 'pick-kind') { S.draft.kind = t.dataset.kind; S.draft.values = defValues(S.draft.kind); return go('newExercise'); }
  if (act === 'pick-name') {
    S.draft.name = t.dataset.name;
    const c = (await getAll('catalog')).find((x) => x.name === S.draft.name);
    if (c) { S.draft.kind = c.kind || DEFAULT_KIND; S.draft.values = { ...defValues(S.draft.kind), ...(c.lastValues || {}) }; }
    return go('newExercise');
  }
  if (act === 'start-exercise') {
    const name = (S.draft.name || '').trim();
    if (!name) { const i = $('#exName'); if (i) i.focus(); return; }
    await addExercise(name, S.draft.kind, S.draft.values); return go('exercise');
  }
  if (act === 'log-set') { await logEntry(S.draft.values); return render(); }
  if (act === 'del-set') { await deleteEntry(t.dataset.id); return render(); }
  if (act === 'open-exercise') {
    const ex = (await byIndex('exercises', 'workoutId', S.workout.id)).find((x) => x.id === t.dataset.id);
    if (ex) return openExercise(ex); return;
  }
  if (act === 'finish-exercise') { S.exercise = null; return go('home'); }
  if (act === 'open-history') return go('history');
  if (act === 'go-home') return go('home');
  if (act === 'export') return exportData();
  if (act === 'import') { const f = $('#importFile'); if (f) f.click(); return; }
  // ── роль / синхронизация / тренер ──
  if (act === 'open-settings') return go('settings');
  if (act === 'set-role') { S.role = t.dataset.role; LS.set('role', S.role); return go(S.role === 'trainer' ? 'trainer' : 'home'); }
  if (act === 'copy-id') { try { await navigator.clipboard.writeText(t.dataset.id); } catch (e) {} alert('ID скопирован: ' + t.dataset.id); return; }
  if (act === 'sync-now') { const u = $('#syncUrl'); if (u) LS.set('syncUrl', u.value.trim()); return syncNow(); }
  if (act === 'go-trainer') { S.trainee = null; return go('trainer'); }
  if (act === 'add-trainee') {
    const idEl = $('#tId'); const id = idEl && idEl.value.trim(); if (!id) return;
    const label = ($('#tLabel') && $('#tLabel').value.trim()) || '';
    const list = trainees(); if (!list.find((x) => x.id === id)) list.push({ id, label });
    LS.set('trainees', list); return go('trainer');
  }
  if (act === 'remove-trainee') { LS.set('trainees', trainees().filter((x) => x.id !== t.dataset.id)); return go('trainer'); }
  if (act === 'open-trainee') {
    const id = t.dataset.id, meta = trainees().find((x) => x.id === id) || { id };
    S.trainee = { id, label: meta.label, data: { workouts: [], exercises: [], entries: [] } };
    go('trainee');
    try { S.trainee.data = await fetchTrainee(id); } catch (e) { alert('Не удалось получить данные: ' + e.message); }
    return render();
  }
});

// тикающие таймеры
setInterval(() => {
  if (S.screen === 'home' && S.workout) { const el = $('#wtime'); if (el) el.textContent = fmtClock(Date.now() - S.workout.startedAt); }
  else if (S.screen === 'exercise' && S._restAt) { const el = $('#rest'); if (el) el.textContent = 'отдых ' + fmtClock(Date.now() - S._restAt); }
}, 1000);

// ──────────────────────────── старт ────────────────────────────
(async function init() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) {} }
  S.role = LS.get('role', 'lifter');
  athleteId();                                   // сгенерировать ID при первом запуске
  S.workout = await activeWorkout();
  S.screen = S.role === 'trainer' ? 'trainer' : 'home';
  render();
  if (S.role === 'lifter' && navigator.onLine && syncUrl()) syncNow();   // автосинк только если синк настроен
  window.addEventListener('online', () => { if (S.role === 'lifter' && syncUrl()) syncNow(); });
})();
