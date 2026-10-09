// Resilience F4: zentraler Resume-/Online-Refresh (src/lib/resumeRefresh.js → RefreshProvider → refreshController).
// Simuliert Dokument, Fenster, Uhr und Timer: Rückkehr nach kurzer/langer Zeit, pageshow, Fokus, offline → online,
// Ereignis-Bündel, Tageswechsel, gesperrte Dialoge, laufende Läufe, Abbau ohne Listener-/Timer-Lecks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createResumeTrigger, localDay, msUntilNextLocalMidnight, RESUME_MIN_HIDDEN_MS, AUTO_MIN_GAP_MS, BURST_MS, BLOCKED_RETRY_MS, BLOCKED_RETRIES } from '../src/lib/resumeRefresh.js'
import { createRefreshController } from '../src/lib/refreshController.js'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function env({ visible = true, online = true, start = new Date(2026, 9, 8, 12, 0, 0).getTime(), result = () => undefined, runMs = 0 } = {}) {
  let t = start, id = 0
  const timers = new Map()
  const maps = { doc: new Map(), win: new Map() }
  const target = m => ({ addEventListener(type, fn) { if (!m.has(type)) m.set(type, new Set()); m.get(type).add(fn) }, removeEventListener(type, fn) { m.get(type)?.delete(fn) } })
  const doc = { visibilityState: visible ? 'visible' : 'hidden', ...target(maps.doc) }
  const win = target(maps.win)
  const state = { online, calls: [], inFlight: 0, maxInFlight: 0 }
  const setTimer = (f, ms) => { timers.set(++id, { f, at: t + ms }); return id }
  const clearTimer = i => { timers.delete(i) }
  const onTrigger = async reason => {
    state.calls.push(reason); state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      if (runMs) await new Promise(r => setTimer(r, runMs))
      return result(state.calls.length, reason)
    } finally { state.inFlight-- }
  }
  const trig = createResumeTrigger({ doc, win, onTrigger, now: () => t, setTimer, clearTimer, isOnline: () => state.online })
  const fire = (where, type, ev = {}) => { for (const fn of [...(maps[where].get(type) || [])]) fn(ev) }
  async function advance(ms) {
    const end = t + ms
    for (;;) {
      const next = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      t = next[1].at; timers.delete(next[0]); next[1].f(); await flush()
    }
    t = end; await flush()
  }
  const hide = () => { doc.visibilityState = 'hidden'; fire('doc', 'visibilitychange') }
  const show = () => { doc.visibilityState = 'visible'; fire('doc', 'visibilitychange') }
  const listenerCount = () => [...maps.doc.values(), ...maps.win.values()].reduce((n, s) => n + s.size, 0)
  return { trig, state, timers, fire, advance, hide, show, listenerCount, now: () => t, doc }
}

test('Rückkehr nach < 60 s → kein Laden; nach ≥ 60 s → genau ein Lauf', async () => {
  const e = env()
  e.hide(); await e.advance(30000); e.show(); await e.advance(2000)
  assert.deepEqual(e.state.calls, [])
  e.hide(); await e.advance(RESUME_MIN_HIDDEN_MS); e.show(); await e.advance(2000)
  assert.deepEqual(e.state.calls, ['resume'])
})

test('Ereignis-Bündel (visible + pageshow + online + focus, viele schnell hintereinander) → genau EIN Lauf', async () => {
  const e = env()
  e.hide(); e.fire('win', 'offline'); e.state.online = false
  await e.advance(5 * 60000)
  e.state.online = true
  e.show(); e.fire('win', 'pageshow', { persisted: true }); e.fire('win', 'online'); e.fire('win', 'focus')
  for (let i = 0; i < 20; i++) { e.fire('win', 'focus'); e.fire('doc', 'visibilitychange'); await e.advance(100) }
  await e.advance(3000)
  assert.equal(e.state.calls.length, 1)
  assert.equal(e.state.maxInFlight, 1, 'nie parallel')
})

test('iPhone-PWA nach Stunden im Hintergrund (am selben Tag) → ein Lauf; Fokus allein lädt nie', async () => {
  const e = env({ start: new Date(2026, 9, 8, 8, 0, 0).getTime() })
  e.fire('win', 'focus'); await e.advance(2000)
  assert.equal(e.state.calls.length, 0, 'reiner Fensterfokus')
  e.hide(); await e.advance(5 * 3600e3); e.show(); await e.advance(1000)
  assert.deepEqual(e.state.calls, ['resume'])
})

test('pageshow: nur aus dem Seiten-Cache (persisted) → Lauf; normales pageshow → nichts', async () => {
  const e = env()
  e.fire('win', 'pageshow', { persisted: false }); await e.advance(2000)
  assert.equal(e.state.calls.length, 0)
  e.fire('win', 'pageshow', { persisted: true }); await e.advance(2000)
  assert.deepEqual(e.state.calls, ['pageshow'])
})

test('offline → online: genau ein Lauf; „online“ ohne vorheriges offline → nichts; offline wird vorgemerkt bis online', async () => {
  const e = env()
  e.fire('win', 'online'); await e.advance(2000)
  assert.equal(e.state.calls.length, 0)
  e.fire('win', 'offline'); e.state.online = false; await e.advance(1000)
  e.state.online = true; e.fire('win', 'online'); await e.advance(2000)
  assert.deepEqual(e.state.calls, ['online'])
  // Rückkehr während offline: vormerken, nicht laden; dann online → nachholen
  const f = env()
  f.hide(); f.fire('win', 'offline'); f.state.online = false; await f.advance(120000)
  f.show(); await f.advance(2000)
  assert.equal(f.state.calls.length, 0, 'offline: kein Request')
  f.state.online = true; f.fire('win', 'online'); await f.advance(2000)
  assert.equal(f.state.calls.length, 1)
})

test('WLAN → Mobilfunk ohne Ereignis: kein Lauf (F3 begrenzt hängende Requests); Online-Wechsel innerhalb 30 s → kein zweiter Lauf', async () => {
  const e = env()
  e.hide(); await e.advance(120000); e.show(); await e.advance(1000)
  assert.equal(e.state.calls.length, 1)
  e.fire('win', 'offline'); e.state.online = false; await e.advance(2000); e.state.online = true; e.fire('win', 'online')
  await e.advance(2000)
  assert.equal(e.state.calls.length, 1, `Mindestabstand ${AUTO_MIN_GAP_MS} ms`)
  e.fire('win', 'offline'); e.state.online = false; await e.advance(AUTO_MIN_GAP_MS); e.state.online = true; e.fire('win', 'online')
  await e.advance(2000)
  assert.equal(e.state.calls.length, 2)
})

test('Tageswechsel im Hintergrund (auch < 60 s versteckt) → Lauf „day“, auch direkt nach einem anderen Lauf', async () => {
  const start = new Date(2026, 9, 8, 23, 59, 0).getTime()
  const e = env({ start })
  e.fire('win', 'offline'); e.state.online = false; e.state.online = true; e.fire('win', 'online'); await e.advance(2000)
  assert.equal(e.state.calls.length, 1)
  await e.advance(30000)   // 23:59:32
  e.hide(); await e.advance(40000); e.show(); await e.advance(1000)   // 00:00:12, nur 40 s versteckt
  assert.equal(localDay(e.now()), '2026-10-09')
  assert.deepEqual(e.state.calls.slice(1), ['day'])
})

test('App bleibt über Mitternacht sichtbar (Café-Tablet) → ein Lauf kurz nach Mitternacht, danach neu geplant', async () => {
  const start = new Date(2026, 9, 8, 23, 58, 0).getTime()
  const e = env({ start })
  assert.ok(msUntilNextLocalMidnight(start) === 120000)
  await e.advance(60000); assert.equal(e.state.calls.length, 0)
  await e.advance(70000); assert.deepEqual(e.state.calls, ['day'])
  assert.equal(e.timers.size, 1, 'nächste Mitternacht geplant, keine weiteren Timer')
  e.hide(); assert.equal(e.timers.size, 0, 'im Hintergrund kein Mitternachts-Timer')
})

test('Dialog offen/Eingabe aktiv (blocked) → vormerken, begrenzte Nachversuche, dann genau ein Lauf', async () => {
  let blockedUntil = 3
  const e = env({ result: n => (n < blockedUntil ? 'blocked' : undefined) })
  e.hide(); await e.advance(120000); e.show(); await e.advance(1000)
  assert.deepEqual(e.state.calls, ['resume'])                 // 1. Versuch: gesperrt
  await e.advance(BLOCKED_RETRY_MS + 1000); assert.equal(e.state.calls.length, 2)   // Nachversuch (+ Bündelung): noch gesperrt
  await e.advance(BLOCKED_RETRY_MS + 1000); assert.equal(e.state.calls.length, 3)   // frei → Lauf
  await e.advance(10 * BLOCKED_RETRY_MS); assert.equal(e.state.calls.length, 3, 'danach keine weiteren')
  // dauerhaft gesperrt: höchstens BLOCKED_RETRIES Nachversuche, dann nur noch bei einem Ereignis (Fokus)
  const f = env({ result: () => 'blocked' })
  f.hide(); await f.advance(120000); f.show(); await f.advance(1000)
  await f.advance(20 * BLOCKED_RETRY_MS)
  assert.equal(f.state.calls.length, 1 + BLOCKED_RETRIES)
  assert.equal(f.timers.size, 1, 'nur der Mitternachts-Timer bleibt')
  f.fire('win', 'focus'); await f.advance(1000)
  assert.equal(f.state.calls.length, 2 + BLOCKED_RETRIES, 'Fokus holt den vorgemerkten Lauf nach')
})

test('laufender Lauf: neue Auslöser starten nichts parallel; Tageswechsel währenddessen wird danach nachgeholt', async () => {
  const start = new Date(2026, 9, 8, 23, 59, 50).getTime()
  const e = env({ start: start - 120000, runMs: 20000 })
  e.hide(); await e.advance(120000 - 1000)   // 23:59:49
  e.show(); await e.advance(1000)            // Lauf startet (dauert 20 s, über Mitternacht)
  e.fire('win', 'pageshow', { persisted: true }); e.fire('win', 'focus')
  await e.advance(15000)                     // Mitternachts-Timer feuert während des Laufs
  assert.equal(e.state.maxInFlight, 1)
  await e.advance(30000)
  assert.equal(e.state.maxInFlight, 1, 'nie parallel')
  assert.ok(e.state.calls.includes('day'), 'Tageswechsel nachgeholt')
})

test('Abbau (Unmount) – auch während eines Laufs: alle Listener und Timer entfernt, danach keine Läufe', async () => {
  const e = env({ runMs: 5000 })
  assert.equal(e.listenerCount(), 5)
  e.hide(); await e.advance(120000); e.show(); await e.advance(1000)   // Lauf läuft
  e.fire('win', 'offline'); e.fire('win', 'online'); e.fire('win', 'online'); e.fire('win', 'pageshow', { persisted: true })   // Bündel kurz vor dem Abbau
  e.trig.dispose()
  assert.equal(e.timers.size, 1, 'nur der Timer des laufenden (simulierten) Requests – kein verwaister Bündel-/Mitternachts-Timer')
  assert.equal(e.listenerCount(), 0)
  await e.advance(10000)
  assert.equal(e.timers.size, 0, 'keine Timer-Lecks')
  e.hide(); await e.advance(120000); e.show(); e.fire('win', 'online'); await e.advance(5000)
  assert.equal(e.state.calls.length, 1)
})

test('Steuerung: auto = gleicher Single-Flight, ohne Toasts; ↻ während eines automatischen Laufs bekommt Fehler gemeldet', async () => {
  const notes = []; let loads = 0, release, fail = false
  const handler = () => { loads++; return new Promise((r, j) => { release = () => (fail ? j(new Error('x')) : r()) }) }
  let blocked = false, offline = false
  const c = createRefreshController({ getHandler: () => handler, isBlocked: () => blocked, isOffline: () => offline, notify: k => notes.push(k) })
  blocked = true; assert.equal(await c.refresh({ auto: true }), 'blocked')
  blocked = false; offline = true; assert.equal(await c.refresh({ auto: true }), 'offline')
  assert.deepEqual(notes, [], 'automatisch: keine Hinweise')
  offline = false
  fail = true
  const a = c.refresh({ auto: true }); await flush(); release(); await a
  assert.deepEqual(notes, [], 'automatischer Fehler: still (Seiten zeigen ihn selbst)')
  const b = c.refresh({ auto: true }); const m = c.refresh(); await flush()
  assert.equal(b, m, 'derselbe Lauf'); release(); await m
  assert.equal(loads, 2); assert.deepEqual(notes, ['failed'], '↻ während des automatischen Laufs → Fehler gemeldet')
  blocked = true; assert.equal(await c.refresh(), 'blocked'); assert.deepEqual(notes, ['failed', 'blocked'], 'manuell unverändert')
})

test('RefreshProvider: genau eine Bindung (stabile Steuerung), Abbau im Effekt-Cleanup, ↻-Weg unverändert', () => {
  const src = readFileSync('src/context/RefreshContext.jsx', 'utf8')
  assert.equal((src.match(/createResumeTrigger\(/g) || []).length, 1)
  assert.match(src, /onTrigger: \(\) => \{ checkForNewVersion\(\); return controller\.refresh\(\{ auto: true \}\) \}/, 'derselbe automatische Refresh; Versionsprüfung nur als Hinweis (F8)')
  assert.match(src, /return \(\) => trigger\.dispose\(\)\n  \}, \[controller\]\)/)
  assert.match(src, /const refreshData = useCallback\(\(\) => controller\.refresh\(\), \[controller\]\)/)
  for (const f of ['src/pages/Dashboard.jsx', 'src/pages/Vacation.jsx', 'src/pages/TimeManagement.jsx', 'src/pages/Shifts.jsx'])
    assert.doesNotMatch(readFileSync(f, 'utf8'), /resumeRefresh|visibilitychange/, `${f}: keine eigene Resume-Logik`)
  assert.ok(BURST_MS <= 1000 && RESUME_MIN_HIDDEN_MS === 60000)
})

test('Automatische Sperre: gefülltes Textfeld (auch ohne Fokus) sperrt NUR den automatischen Refresh; ↻ unverändert', async () => {
  const src = readFileSync('src/context/RefreshContext.jsx', 'utf8')
  const rb = src.slice(src.indexOf('export function refreshBlocked'), src.indexOf('export function RefreshProvider')).replace('export ', '')
  const tf = src.slice(src.indexOf('const TEXT_FIELDS'), src.indexOf('\n', src.indexOf('const TEXT_FIELDS')))
  const ab = src.slice(src.indexOf('export function autoRefreshBlocked')).replace('export ', '')
  const autoRefreshBlocked = new Function(`${rb}\n${tf}\n${ab}; return autoRefreshBlocked`)()
  // Nachbildung von querySelectorAll für genau die Selektoren aus TEXT_FIELDS
  const doc = (els, { modal = false, active = null } = {}) => ({
    querySelector: s => (s === '.modal-overlay' && modal ? {} : null), activeElement: active,
    querySelectorAll: sel => els.filter(e => e.tag === 'TEXTAREA' ? sel.includes('textarea')
      : e.type == null ? sel.includes('input:not([type])') : sel.includes(`input[type="${e.type}"]`)),
  })
  const input = (type, value, extra = {}) => ({ tag: 'INPUT', type, value, ...extra })
  assert.equal(autoRefreshBlocked(doc([])), false)
  for (const t of ['text', 'email', 'tel', 'number', 'password', 'url', 'search', null]) assert.equal(autoRefreshBlocked(doc([input(t, 'DE89…')])), true, String(t))
  assert.equal(autoRefreshBlocked(doc([{ tag: 'TEXTAREA', value: 'Notiz' }])), true)
  for (const t of ['file', 'date', 'checkbox', 'radio', 'hidden', 'month']) assert.equal(autoRefreshBlocked(doc([input(t, 'x')])), false, t)
  assert.equal(autoRefreshBlocked(doc([input('text', '   ')])), false, 'nur Leerzeichen')
  assert.equal(autoRefreshBlocked(doc([input('text', 'x', { disabled: true })])), false)
  assert.equal(autoRefreshBlocked(doc([input('text', 'x', { readOnly: true })])), false)
  assert.equal(autoRefreshBlocked(doc([], { modal: true })), true, 'Dialog wie bisher')
  // Steuerung: auto nutzt die strengere Sperre, ↻ die bisherige
  let loads = 0
  const c = createRefreshController({ getHandler: () => async () => { loads++ }, isBlocked: () => false, isAutoBlocked: () => true })
  assert.equal(await c.refresh({ auto: true }), 'blocked'); assert.equal(loads, 0)
  await c.refresh(); assert.equal(loads, 1, '↻ lädt trotz gefülltem Feld (bewusste Handlung)')
  assert.match(src, /isAutoBlocked: \(\) => autoRefreshBlocked\(\),/)
})
