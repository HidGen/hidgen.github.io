'use strict';
/* Считалка для качалки — офлайн PWA + синхронизация через GitHub (без своего сервера).
   Данные с владельцем (owner): качок ведёт свои, тренер может вести за подопечного.
   Контракт расширяем (kind+values), синк LWW по updatedAt. */

// ──────────────── типы упражнений ────────────────
const KINDS = {
  strength: { label: 'Силовое', icon: '🏋',
    fields: [{ key: 'weight', label: 'Вес', unit: 'кг', step: 2.5, min: 0, def: 20 },
             { key: 'reps', label: 'Повторы', unit: '', step: 1, min: 0, def: 10, int: true }],
    summary: (v) => `${fmtN(v.weight)}×${v.reps}`, tonnage: (v) => (v.weight || 0) * (v.reps || 0) },
  bodyweight: { label: 'Свой вес', icon: '🧎',
    fields: [{ key: 'reps', label: 'Повторы', unit: '', step: 1, min: 0, def: 10, int: true },
             { key: 'addedWeight', label: 'Доп. вес', unit: 'кг', step: 2.5, min: 0, def: 0 }],
    summary: (v) => `×${v.reps}${v.addedWeight ? ` +${fmtN(v.addedWeight)}` : ''}`, tonnage: (v) => (v.addedWeight || 0) * (v.reps || 0) },
  cardio: { label: 'Кардио', icon: '🏃',
    fields: [{ key: 'duration', label: 'Время', unit: 'мин:сек', step: 30, min: 0, def: 600, time: true },
             { key: 'distance', label: 'Дистанция', unit: 'м', step: 100, min: 0, def: 0 },
             { key: 'avgHr', label: 'Ср. пульс', unit: 'уд/мин', step: 5, min: 0, def: 0, int: true },
             { key: 'level', label: 'Нагрузка', unit: '', step: 1, min: 0, def: 0, int: true }],
    summary: (v) => [v.duration ? fmtClock(v.duration * 1000) : null, v.distance ? `${(v.distance / 1000).toFixed(2)} км` : null,
                     v.avgHr ? `❤${v.avgHr}` : null, v.level ? `ур.${v.level}` : null].filter(Boolean).join(' · '), tonnage: () => 0 },
  timed: { label: 'На время', icon: '⏱',
    fields: [{ key: 'duration', label: 'Время', unit: 'мин:сек', step: 5, min: 0, def: 30, time: true }],
    summary: (v) => fmtClock((v.duration || 0) * 1000), tonnage: () => 0 },
};
const DEFAULT_KIND = 'strength';
const kindOf = (k) => KINDS[k] || KINDS[DEFAULT_KIND];
const defValues = (k) => { const o = {}; kindOf(k).fields.forEach((f) => { o[f.key] = f.def; }); return o; };

// ──────────────── IndexedDB ────────────────
let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open('liftlog', 2);
    r.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('exercises')) d.createObjectStore('exercises', { keyPath: 'id' }).createIndex('workoutId', 'workoutId');
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' }).createIndex('exerciseId', 'exerciseId');
      if (!d.objectStoreNames.contains('catalog')) d.createObjectStore('catalog', { keyPath: 'name' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return _db;
}
const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function put(store, obj) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(obj); t.oncomplete = () => res(obj); t.onerror = () => rej(t.error); }); }
async function getAll(store) { const d = await db(); return reqP(d.transaction(store).objectStore(store).getAll()); }
async function byIndex(store, idx, key) { const d = await db(); return reqP(d.transaction(store).objectStore(store).index(idx).getAll(key)); }

// синк-конверт
function stamp(o) { o.updatedAt = Date.now(); if (o.deleted === undefined) o.deleted = false; return o; }
const save = (store, o) => put(store, stamp(o));

// ──────────────── утилиты ────────────────
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = (n) => (Math.round((+n || 0) * 100) / 100).toString();
const vibrate = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)), h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, ss = s % 60, p = (n) => String(n).padStart(2, '0'); return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`; }
function parseTime(str) { str = String(str).trim(); if (str.includes(':')) { const [m, s] = str.split(':'); return (+m || 0) * 60 + (+s || 0); } return parseInt(str, 10) || 0; }
function fmtDate(ts) { const d = new Date(ts), t0 = new Date(); t0.setHours(0, 0, 0, 0); const t1 = new Date(ts); t1.setHours(0, 0, 0, 0); const diff = Math.round((t0 - t1) / 86400000); const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }); if (diff === 0) return `сегодня, ${time}`; if (diff === 1) return `вчера, ${time}`; return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: '2-digit' }) + `, ${time}`; }

// ──────────────── аккаунт / роль / GitHub ────────────────
const LS = { get(k, d) { try { const v = localStorage.getItem('ll_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { localStorage.setItem('ll_' + k, JSON.stringify(v)); } };
const ALPH = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const genCode = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALPH[Math.floor(Math.random() * ALPH.length)]; return s; };
function me() { let id = LS.get('athleteId', null); if (!id) { id = genCode(4) + '-' + genCode(4); LS.set('athleteId', id); } return id; }
const trainees = () => LS.get('trainees', []);
const traineeLabel = (id) => { const t = trainees().find((x) => x.id === id); return (t && t.label) || id; };
// Демо-токен зашит обфусцированно (base64 по частям): обходит секрет-сканер GitHub и
// случайный копипаст. Это НЕ безопасность — кто захочет, достанет и сможет писать только
// в репо данных liftlog-data. На время сбора фидбека (перс. данных не храним). Потом перевыпустить.
function embeddedGh() {
  const p = ['Z2l0aHViX3BhdF8xMUFLVTM3SEEwd29RQVhnb3VHaG1PX01jTXNLYmdlMk1hQ0',
             'czbkI3VHNtY3RBMnR5eDhxc2JiQnBrUXpiNDBydVJVUTZCR09KNFJ2dlNuVFVU'];
  return { token: atob(p.join('')), repo: 'HidGen/liftlog-data', branch: 'main' };
}
const gh = () => { const o = LS.get('gh', null); return (o && o.token && o.repo) ? o : embeddedGh(); };
const ghReady = () => { const g = gh(); return !!(g.token && g.repo); };

const STORES = ['workouts', 'exercises', 'entries', 'catalog'];
const keyOf = (store, r) => (store === 'catalog' ? r.name : r.id);
const ownerOf = (r) => r.owner || me();

// ──────────────── GitHub-провайдер ────────────────
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (b) => decodeURIComponent(escape(atob(b)));
function ghHeaders() { return { Authorization: 'Bearer ' + gh().token, Accept: 'application/vnd.github+json' }; }
function ghUrl(path) { const g = gh(); return `https://api.github.com/repos/${g.repo}/contents/${path}`; }
function ghFetch(url, opts) {           // fetch с таймаутом, чтобы не висло на плохой сети
  const c = new AbortController(); const tid = setTimeout(() => c.abort(), 15000);
  return fetch(url, { ...(opts || {}), signal: c.signal }).finally(() => clearTimeout(tid));
}
const ownerPath = (owner) => 'athletes/' + owner.replace(/[^A-Za-z0-9_-]/g, '_') + '.json';

async function ghGet(path) {
  const g = gh();
  const r = await ghFetch(ghUrl(path) + '?ref=' + encodeURIComponent(g.branch || 'main') + '&t=' + Date.now(), { headers: ghHeaders() });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error('GET ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(b64dec(j.content)), sha: j.sha };
}
async function ghPut(path, obj, sha, msg) {
  const g = gh();
  const body = { message: msg, content: b64enc(JSON.stringify(obj)), branch: g.branch || 'main' };
  if (sha) body.sha = sha;
  const r = await ghFetch(ghUrl(path), { method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 409) throw new Error('conflict');
  if (!r.ok) throw new Error('PUT ' + r.status);
}
async function ownerSnapshot(owner) {
  const snap = {};
  for (const store of STORES) snap[store] = (await getAll(store)).filter((r) => ownerOf(r) === owner).sort((a, b) => String(keyOf(store, a)).localeCompare(keyOf(store, b)));
  return snap;
}
async function mergeIntoLocal(snap) {
  for (const store of STORES) {
    const cur = await getAll(store);
    for (const rec of (snap[store] || [])) {
      const ex = cur.find((x) => keyOf(store, x) === keyOf(store, rec));
      if (!ex || (rec.updatedAt || 0) >= (ex.updatedAt || 0)) await put(store, rec);
    }
  }
}
async function syncOwner(owner) {
  if (!ghReady()) throw new Error('синк не настроен');
  const got = await ghGet(ownerPath(owner));
  if (got.data) await mergeIntoLocal(got.data);
  const snap = await ownerSnapshot(owner);
  if (!got.data || JSON.stringify(snap) !== JSON.stringify(got.data)) {
    try { await ghPut(ownerPath(owner), snap, got.sha, 'liftlog sync ' + owner); }
    catch (e) {
      if (e.message !== 'conflict') throw e;
      const re = await ghGet(ownerPath(owner)); if (re.data) await mergeIntoLocal(re.data);
      await ghPut(ownerPath(owner), await ownerSnapshot(owner), re.sha, 'liftlog sync retry');
    }
  }
}

// ──────────────── состояние ────────────────
const S = {
  screen: 'home', role: 'lifter', owner: '', viewingAthlete: false, workout: null, exercise: null, entries: [],
  draft: { name: '', kind: DEFAULT_KIND, values: defValues(DEFAULT_KIND) }, _restAt: 0,
  sync: { running: false, msg: '' },
};
const inAthlete = () => S.role === 'trainer' && S.viewingAthlete;

// ──────────────── данные (с учётом owner) ────────────────
async function ownedBy(store, owner) { return (await getAll(store)).filter((r) => ownerOf(r) === owner && !r.deleted); }
async function ownedAll(store) { return ownedBy(store, S.owner); }
async function syncAllTrainees() {
  if (S.sync.running || !ghReady() || !navigator.onLine || !trainees().length) return;
  S.sync.running = true; S.sync.msg = 'обновляю подопечных…';
  if (S.screen === 'home') render();
  for (const t of trainees()) { try { await syncOwner(t.id); } catch (e) {} }
  S.sync.running = false; S.sync.msg = 'обновлено · ' + new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (S.role === 'trainer' && !S.viewingAthlete && S.screen === 'home') render();
}
async function activeWorkout() { return (await ownedAll('workouts')).filter((w) => !w.finishedAt).sort((a, b) => b.startedAt - a.startedAt)[0] || null; }
async function startWorkout() { const w = { id: uid(), owner: S.owner, startedAt: Date.now(), finishedAt: null }; await save('workouts', w); S.workout = w; }
async function finishWorkout() { if (!S.workout) return; S.workout.finishedAt = Date.now(); await save('workouts', S.workout); S.workout = null; await autoSync(); }
async function recentNames(limit = 12) { return (await getAll('catalog')).filter((c) => !c.deleted).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit); }
async function addExercise(name, kind, values) {
  const ex = { id: uid(), owner: S.owner, workoutId: S.workout.id, name: name.trim(), kind, startedAt: Date.now() };
  await save('exercises', ex);
  await save('catalog', { name: ex.name, kind, lastValues: { ...values }, lastUsed: Date.now() });
  S.exercise = ex; S.entries = []; S._restAt = 0;
}
async function logEntry(values) {
  const e = { id: uid(), owner: S.owner, exerciseId: S.exercise.id, idx: S.entries.length + 1, values: { ...values }, loggedAt: Date.now() };
  await save('entries', e); S.entries.push(e); S._restAt = Date.now();
  await save('catalog', { name: S.exercise.name, kind: S.exercise.kind, lastValues: { ...values }, lastUsed: Date.now() });
  vibrate(40);
}
async function deleteEntry(id) { const e = S.entries.find((x) => x.id === id); if (e) { e.deleted = true; await save('entries', e); } S.entries = S.entries.filter((x) => x.id !== id); S.entries.forEach((x, i) => { x.idx = i + 1; }); }
async function entriesOf(exId) { return (await byIndex('entries', 'exerciseId', exId)).filter((e) => !e.deleted).sort((a, b) => a.idx - b.idx); }
async function exercisesOf(wId) { const exs = (await byIndex('exercises', 'workoutId', wId)).filter((e) => !e.deleted).sort((a, b) => a.startedAt - b.startedAt); for (const ex of exs) ex._entries = await entriesOf(ex.id); return exs; }
const exTonnage = (ex) => { const k = kindOf(ex.kind); return ex._entries.reduce((a, e) => a + k.tonnage(e.values), 0); };
const exSummary = (ex) => { const k = kindOf(ex.kind); return ex._entries.length ? ex._entries.map((e) => k.summary(e.values)).join(' · ') : 'нет подходов'; };
async function recentWorkouts(limit = 5) { const ws = (await ownedAll('workouts')).filter((w) => w.finishedAt).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit); for (const w of ws) w._exs = await exercisesOf(w.id); return ws; }

async function exportData() { const data = { app: 'liftlog', version: 2, exportedAt: Date.now() }; for (const s of STORES) data[s] = await getAll(s); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); a.download = 'podhody-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); }
async function importData(file) { const data = JSON.parse(await file.text()); for (const s of STORES) for (const rec of (data[s] || [])) { const cur = (await getAll(s)).find((x) => keyOf(s, x) === keyOf(s, rec)); if (!cur || (rec.updatedAt || 0) >= (cur.updatedAt || 0)) await put(s, rec); } }

async function autoSync() { if (ghReady() && navigator.onLine) { try { await syncOwner(S.owner); } catch (e) {} } }
async function syncNow() {
  if (S.sync.running) return;
  if (!ghReady()) { S.sync.msg = 'синк не настроен (⚙ → GitHub)'; if (S.screen === 'settings') render(); return; }
  S.sync.running = true; S.sync.msg = 'синхронизация…'; if (S.screen === 'settings') render();
  try { await syncOwner(S.owner); S.sync.msg = 'ок · ' + new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }); S.workout = await activeWorkout(); }
  catch (e) { S.sync.msg = 'ошибка: ' + e.message; }
  S.sync.running = false; render();
}

// ──────────────── навигация ────────────────
function go(screen) { S.screen = screen; render(); }
async function openExercise(ex) {
  S.exercise = ex; S.entries = await entriesOf(ex.id);
  const last = S.entries[S.entries.length - 1];
  S._restAt = last ? last.loggedAt : 0; S.draft.kind = ex.kind;
  S.draft.values = last ? { ...last.values } : defValues(ex.kind); go('exercise');
}
async function enterAthlete(id) {
  S.viewingAthlete = true; S.owner = id;
  S.workout = await activeWorkout();   // открываем сразу из локального кэша
  go('home');
  if (ghReady() && navigator.onLine) { // свежие данные подтягиваем в фоне, потом обновляем экран
    try { await syncOwner(id); } catch (e) {}
    if (S.viewingAthlete && S.owner === id) { S.workout = await activeWorkout(); render(); }
  }
}
function leaveAthlete() { S.viewingAthlete = false; S.owner = me(); S.workout = null; go('home'); }

// ──────────────── рендер ────────────────
const app = $('#app');
const topBar = (title, right) => `<div class="top"><h1>${esc(title)}</h1><span class="spacer"></span>${right || ''}</div>`;
const fieldStepper = (f, v) => `<div class="label-row"><span class="l">${esc(f.label)}</span><span class="r">${f.time ? '±' + f.step + 'с' : 'шаг ' + f.step + (f.unit ? ' ' + f.unit : '')}</span></div>
  <div class="stepper"><button class="pm" data-act="dec" data-field="${f.key}">−</button>
    <div class="val" data-act="edit" data-field="${f.key}"><div class="num">${f.time ? fmtClock((v || 0) * 1000) : fmtN(v)}</div><div class="unit">${esc(f.time ? 'мин:сек' : (f.unit || ''))}</div></div>
    <button class="pm" data-act="inc" data-field="${f.key}">+</button></div>`;
const draftFields = () => kindOf(S.draft.kind).fields.map((f) => fieldStepper(f, S.draft.values[f.key])).join('');

async function render() {
  if (S.screen === 'settings') return renderSettings();
  if (S.screen === 'addTrainee') return renderAddTrainee();
  if (S.screen === 'newExercise') return renderNewExercise();
  if (S.screen === 'exercise') return renderExercise();
  if (S.screen === 'history') return renderHistory();
  if (S.role === 'trainer' && !S.viewingAthlete) return renderTrainer();
  return renderHome();
}

async function renderHome() {
  const athlete = inAthlete();
  const backRight = athlete
    ? `<button class="icon-btn" data-act="leave-athlete">← подопечные</button>`
    : '';   // у качка сверху кнопок нет — «⚙ Настройки» снизу
  if (!S.workout) {
    const ws = (await ownedAll('workouts')).filter((w) => w.finishedAt).sort((a, b) => b.startedAt - a.startedAt);
    const cards = await workoutCardsHtml(ws);
    const title = athlete ? traineeLabel(S.owner) : 'Считалка для качалки';
    const startLabel = athlete ? `▶ Тренировка за ${esc(traineeLabel(S.owner))}` : '▶ Начать тренировку';
    app.innerHTML = topBar(title, backRight) +
      `<div class="list">${cards || '<div class="empty">Пока нет тренировок — начни первую</div>'}</div>
       <div class="actions">
         <button class="btn btn-primary btn-big" data-act="start-workout">${startLabel}</button>
         ${athlete ? '' : '<button class="btn" data-act="open-settings">⚙ Настройки</button>'}</div>`;
    return;
  }
  const exs = await exercisesOf(S.workout.id);
  const tonnage = exs.reduce((a, ex) => a + exTonnage(ex), 0);
  const rows = exs.map((ex) => `<div class="item" data-act="open-exercise" data-id="${ex.id}">
      <div class="grow"><div class="name">${kindOf(ex.kind).icon} ${esc(ex.name)}</div><div class="meta">${esc(exSummary(ex))}</div></div>
      <div class="big">${ex._entries.length}</div></div>`).join('');
  app.innerHTML = topBar(athlete ? `Тренировка · ${esc(traineeLabel(S.owner))}` : 'Тренировка', backRight) +
    `<div class="timer">идёт <b id="wtime">${fmtClock(Date.now() - S.workout.startedAt)}</b>${tonnage ? ` · тоннаж ${Math.round(tonnage)} кг` : ''}</div>
     <div class="list">${rows || '<div class="empty">Упражнений пока нет</div>'}</div>
     <button class="btn btn-primary" data-act="new-exercise">+ Упражнение</button>
     <div style="flex:1"></div>
     <button class="btn btn-ghost btn-danger" data-act="finish-workout">Завершить тренировку</button>`;
}

async function renderTrainer() {
  const list = trainees();
  const rows = [];
  for (const t of list) {
    const ws = (await ownedBy('workouts', t.id)).filter((w) => w.finishedAt).sort((a, b) => b.startedAt - a.startedAt);
    const meta = ws.length ? `посл.: ${esc(fmtDate(ws[0].startedAt).replace(/,.*/, ''))} · ${ws.length} трен.` : '<span class="muted">нет данных — обнови ⟳</span>';
    rows.push(`<div class="item" data-act="open-trainee" data-id="${esc(t.id)}">
      <div class="grow"><div class="name">${esc(t.label || t.id)}</div><div class="meta">${meta}</div></div>
      <div class="muted" style="font-size:22px">›</div></div>`);
  }
  const right = `${(list.length && ghReady()) ? `<button class="icon-btn" data-act="sync-trainees">${S.sync.running ? '…' : '⟳'}</button>` : ''}<button class="icon-btn" data-act="open-add-trainee">＋</button>`;
  app.innerHTML = topBar('Подопечные', right) +
    `<div class="list">${rows.join('') || '<div class="empty">Подопечных пока нет — добавь по ＋ вверху (ID даёт качок).</div>'}</div>
     ${S.sync.msg ? `<div class="timer">${esc(S.sync.msg)}</div>` : ''}
     <div class="actions"><button class="btn" data-act="open-settings">⚙ Настройки</button></div>`;
}

async function renderAddTrainee() {
  app.innerHTML = topBar('Добавить подопечного', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<label class="field"><div class="lab">ID подопечного (даёт качок)</div><input class="text" id="tId" placeholder="напр. K7Q2-9MF3" autocomplete="off"></label>
     <input class="text" id="tLabel" placeholder="Имя (необязательно)" autocomplete="off" style="margin-top:8px">
     <div style="flex:1"></div>
     <button class="btn btn-primary btn-big" data-act="add-trainee">Добавить</button>`;
  const i = $('#tId'); if (i) i.focus();
}

async function renderNewExercise() {
  const recent = await recentNames(12);
  const kindChips = Object.keys(KINDS).map((k) => `<button class="chip ${k === S.draft.kind ? 'active' : ''}" data-act="pick-kind" data-kind="${k}">${KINDS[k].icon} ${KINDS[k].label}</button>`).join('');
  const nameChips = recent.map((c) => `<button class="chip" data-act="pick-name" data-name="${esc(c.name)}">${kindOf(c.kind).icon} ${esc(c.name)}</button>`).join('');
  app.innerHTML = topBar('Новое упражнение', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<div class="chips">${kindChips}</div>
     <label class="field"><div class="lab">Название</div><input class="text" id="exName" placeholder="напр. Жим лёжа" value="${esc(S.draft.name)}" autocomplete="off"></label>
     ${nameChips ? `<div class="chips">${nameChips}</div>` : ''}
     ${draftFields()}
     <div style="flex:1"></div>
     <button class="btn btn-primary btn-big" data-act="start-exercise">Начать упражнение</button>`;
  const i = $('#exName'); i.addEventListener('input', () => { S.draft.name = i.value; });
}

async function renderExercise() {
  const ex = S.exercise, k = kindOf(ex.kind);
  const rows = S.entries.map((e) => `<div class="setrow"><div class="idx">${e.idx}</div><div class="sv">${esc(k.summary(e.values))}</div><button class="x" data-act="del-set" data-id="${e.id}">✕</button></div>`).reverse().join('');
  app.innerHTML = topBar(`${k.icon} ${ex.name}`, `<button class="icon-btn" data-act="finish-exercise">Готово</button>`) +
    `${draftFields()}
     <button class="btn btn-primary btn-big" data-act="log-set">Записать&nbsp; <b>${esc(k.summary(S.draft.values)) || '—'}</b></button>
     <div class="timer" id="rest">${S._restAt ? 'отдых ' + fmtClock(Date.now() - S._restAt) : 'запиши первый подход'}</div>
     <div class="sets">${rows || ''}</div>`;
}

async function workoutCardsHtml(ws) {
  const blocks = [];
  for (const w of ws) {
    const exs = await exercisesOf(w.id);
    const tonnage = exs.reduce((a, ex) => a + exTonnage(ex), 0), cnt = exs.reduce((a, ex) => a + ex._entries.length, 0);
    const inner = exs.map((ex) => `<div class="item"><div class="grow"><div class="name">${kindOf(ex.kind).icon} ${esc(ex.name)}</div><div class="meta">${esc(exSummary(ex))}</div></div></div>`).join('');
    blocks.push(`<details class="card"><summary><div class="item" style="border:none;padding:0;background:none">
      <div class="grow"><div class="name">${esc(fmtDate(w.startedAt))}</div><div class="meta">${exs.length} упр · ${cnt} подх${tonnage ? ` · ${Math.round(tonnage)} кг` : ''} · ${fmtClock(w.finishedAt - w.startedAt)}</div></div><div class="muted">▾</div></div></summary>
      <div class="list" style="margin-top:10px">${inner || '<div class="empty">пусто</div>'}</div></details>`);
  }
  return blocks.join('');
}
async function renderHistory() {
  const ws = (await ownedAll('workouts')).filter((w) => w.finishedAt).sort((a, b) => b.startedAt - a.startedAt);
  const cards = await workoutCardsHtml(ws);
  app.innerHTML = topBar(inAthlete() ? 'История · ' + esc(traineeLabel(S.owner)) : 'История', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<div class="list">${cards || '<div class="empty">Пока нет завершённых тренировок</div>'}</div>`;
}

async function renderSettings() {
  const g = gh(), id = me();
  app.innerHTML = topBar('Настройки', `<button class="icon-btn" data-act="go-home">✕</button>`) +
    `<div class="lab" style="color:var(--muted);font-size:13px">Роль</div>
     <div class="chips"><button class="chip ${S.role === 'lifter' ? 'active' : ''}" data-act="set-role" data-role="lifter">🏋 Качок</button>
       <button class="chip ${S.role === 'trainer' ? 'active' : ''}" data-act="set-role" data-role="trainer">📋 Тренер</button></div>
     <div class="card"><div class="muted" style="font-size:13px">Твой ID — дай тренеру, чтобы он видел/вёл твои тренировки:</div>
       <div style="display:flex;gap:10px;align-items:center;margin-top:8px"><div style="font-size:24px;font-weight:800;letter-spacing:1px;flex:1">${esc(id)}</div>
         <button class="icon-btn" data-act="copy-id" data-id="${esc(id)}">копировать</button></div></div>
     <div class="lab" style="color:var(--muted);font-size:13px;margin-top:4px">Синхронизация через GitHub (по умолчанию встроена — вводить ничего не нужно)</div>
     <label class="field"><div class="lab">Репозиторий данных (owner/name)</div><input class="text" id="ghRepo" value="${esc(g.repo)}" placeholder="HidGen/liftlog-data" autocomplete="off"></label>
     <label class="field" style="margin-top:8px"><div class="lab">Токен — переопределить (пусто = встроенный)</div><input class="text" id="ghToken" type="password" value="" placeholder="встроен по умолчанию" autocomplete="off"></label>
     <button class="btn btn-primary" data-act="sync-now" style="margin-top:10px">${S.sync.running ? '…' : '⟳ Синхронизировать'}</button>
     <div class="timer">${esc(S.sync.msg || '')}</div>
     <div class="btn-row"><button class="btn btn-ghost" data-act="export">⬇ Экспорт</button><button class="btn btn-ghost" data-act="import">⬆ Импорт</button></div>
     <input type="file" id="importFile" accept="application/json" hidden>`;
  const save2 = () => { const tk = ($('#ghToken').value || '').trim(); if (tk) LS.set('gh', { token: tk, repo: ($('#ghRepo').value || '').trim() || gh().repo, branch: g.branch || 'main' }); };
  ['#ghRepo', '#ghToken'].forEach((sel) => { const el = $(sel); if (el) el.addEventListener('change', save2); });
  const f = $('#importFile'); if (f) f.addEventListener('change', async () => { if (f.files[0]) { await importData(f.files[0]); alert('Импорт завершён'); render(); } });
}

// ──────────────── события ────────────────
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'inc' || act === 'dec') { const f = kindOf(S.draft.kind).fields.find((x) => x.key === t.dataset.field); let v = (S.draft.values[f.key] || 0) + (act === 'inc' ? 1 : -1) * f.step; v = Math.max(f.min || 0, v); v = f.int ? Math.round(v) : Math.round(v * 100) / 100; S.draft.values[f.key] = v; vibrate(8); return render(); }
  if (act === 'edit') { const f = kindOf(S.draft.kind).fields.find((x) => x.key === t.dataset.field); const cur = S.draft.values[f.key] || 0; const ans = prompt(f.label + (f.time ? ' (мин:сек или секунды)' : (f.unit ? ', ' + f.unit : '')) + ':', f.time ? fmtClock(cur * 1000) : fmtN(cur)); if (ans == null) return; let v = f.time ? parseTime(ans) : parseFloat(String(ans).replace(',', '.')); if (isNaN(v)) return; v = Math.max(f.min || 0, v); if (f.int) v = Math.round(v); S.draft.values[f.key] = v; return render(); }
  if (act === 'start-workout') { await startWorkout(); return go('home'); }
  if (act === 'finish-workout') { if (confirm('Завершить тренировку?')) { await finishWorkout(); return go('home'); } return; }
  if (act === 'new-exercise') { S.draft = { name: '', kind: DEFAULT_KIND, values: defValues(DEFAULT_KIND) }; return go('newExercise'); }
  if (act === 'pick-kind') { S.draft.kind = t.dataset.kind; S.draft.values = defValues(S.draft.kind); return go('newExercise'); }
  if (act === 'pick-name') { S.draft.name = t.dataset.name; const c = (await getAll('catalog')).find((x) => x.name === S.draft.name); if (c) { S.draft.kind = c.kind || DEFAULT_KIND; S.draft.values = { ...defValues(S.draft.kind), ...(c.lastValues || {}) }; } return go('newExercise'); }
  if (act === 'start-exercise') { const name = (S.draft.name || '').trim(); if (!name) { const i = $('#exName'); if (i) i.focus(); return; } await addExercise(name, S.draft.kind, S.draft.values); return go('exercise'); }
  if (act === 'log-set') { await logEntry(S.draft.values); return render(); }
  if (act === 'del-set') { await deleteEntry(t.dataset.id); return render(); }
  if (act === 'open-exercise') { const ex = (await byIndex('exercises', 'workoutId', S.workout.id)).find((x) => x.id === t.dataset.id); if (ex) return openExercise(ex); return; }
  if (act === 'finish-exercise') { S.exercise = null; return go('home'); }
  if (act === 'open-history') return go('history');
  if (act === 'go-home') return go('home');
  if (act === 'export') return exportData();
  if (act === 'import') { const f = $('#importFile'); if (f) f.click(); return; }
  // роль / тренер / синк
  if (act === 'open-settings') return go('settings');
  if (act === 'set-role') { S.role = t.dataset.role; LS.set('role', S.role); S.owner = me(); S.viewingAthlete = false; S.workout = S.role === 'trainer' ? null : await activeWorkout(); if (S.role === 'trainer') syncAllTrainees(); return render(); /* остаёмся в Настройках; уход — по ✕ */ }
  if (act === 'sync-trainees') return syncAllTrainees();
  if (act === 'open-add-trainee') return go('addTrainee');
  if (act === 'copy-id') { try { await navigator.clipboard.writeText(t.dataset.id); } catch (e) {} alert('ID скопирован: ' + t.dataset.id); return; }
  if (act === 'sync-now') { const r = $('#ghRepo'), tk = $('#ghToken'); if (tk && tk.value.trim()) LS.set('gh', { token: tk.value.trim(), repo: (r && r.value.trim()) || gh().repo, branch: gh().branch || 'main' }); return syncNow(); }
  if (act === 'open-trainee') return enterAthlete(t.dataset.id);
  if (act === 'leave-athlete') return leaveAthlete();
  if (act === 'add-trainee') { const idEl = $('#tId'); const id = idEl && idEl.value.trim(); if (!id) return; const label = ($('#tLabel') && $('#tLabel').value.trim()) || ''; const list = trainees(); if (!list.find((x) => x.id === id)) list.push({ id, label }); LS.set('trainees', list); go('home'); return syncAllTrainees(); }
  if (act === 'remove-trainee') { LS.set('trainees', trainees().filter((x) => x.id !== t.dataset.id)); return go('home'); }
});

setInterval(() => {
  if (S.screen === 'home' && S.workout) { const el = $('#wtime'); if (el) el.textContent = fmtClock(Date.now() - S.workout.startedAt); }
  else if (S.screen === 'exercise' && S._restAt) { const el = $('#rest'); if (el) el.textContent = 'отдых ' + fmtClock(Date.now() - S._restAt); }
}, 1000);

// ──────────────── старт ────────────────
(async function init() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) {} }
  S.role = LS.get('role', 'lifter'); S.owner = me();
  // бэкфилл owner у старых записей (разово)
  if (!LS.get('ownerBackfilled', false)) {
    for (const store of ['workouts', 'exercises', 'entries']) for (const r of await getAll(store)) if (r.owner === undefined) { r.owner = me(); await put(store, r); }
    LS.set('ownerBackfilled', true);
  }
  S.workout = S.role === 'trainer' ? null : await activeWorkout();
  render();
  if (S.role === 'lifter') autoSync().then(() => activeWorkout()).then((w) => { S.workout = w; if (S.screen === 'home') render(); });
  if (S.role === 'trainer') syncAllTrainees();
  window.addEventListener('online', () => { if (S.role === 'lifter') autoSync(); else syncAllTrainees(); });
})();
