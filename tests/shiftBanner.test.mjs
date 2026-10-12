// Schichtbanner-Bugfix (12.10.2026): gemeldet „Deine Schicht startet gleich!“ am So 11.10.2026 um 22:50 für eine
// Schicht 08:30–18:00 (längst beendet). Ursache: erste Schicht ab heute 00:00 + Ersatztext „gleich“ für einen Beginn in
// der Vergangenheit. Teil 1: reine Logik (lib/shiftAnnouncement.js). Teil 2: ECHTE Seite Dashboard.jsx in Headless Chrome
// mit steuerbarer Uhr (fester Zeitpunkt, Minutentakt von Hand) und Zeitzonen-Emulation – Gegenprobe mit a023cca.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { announceShift, berlinNow, shiftWindow, SOON_MIN, IMMINENT_MIN } from '../src/lib/shiftAnnouncement.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = 'a023cca'
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const S = (date, a, b, position = 'Service') => ({ id: `${date}-${a}`, employee_id: 'e1', date, start_time: `${a}:00`, end_time: `${b}:00`, position })
const at = iso => new Date(iso)

// ── Teil 1: Logik ──
test('Originalfehler: So 11.10.2026 22:50 (Berlin), Schicht 08:30–18:00 → KEINE Ankündigung', () => {
  const r = announceShift([S('2026-10-11', '08:30', '18:00')], at('2026-10-11T20:50:00Z'))
  assert.equal(r.shift, null); assert.equal(r.phase, 'none')
})

test('Phasen und Grenzen: > 60 later · 60–15 soon · 15–0 imminent · Beginn bis Ende running · danach nichts', () => {
  const sh = [S('2026-10-12', '08:30', '18:00')]                       // 12.10. = Sommerzeit (UTC+2)
  const ph = iso => announceShift(sh, at(iso)).phase
  assert.equal(ph('2026-10-12T05:29:00Z'), 'later')                    // 61 min vorher
  assert.equal(ph('2026-10-12T05:30:00Z'), 'soon')                     // 60 min
  assert.equal(ph('2026-10-12T06:00:00Z'), 'soon')                     // 30 min
  assert.equal(ph('2026-10-12T06:14:00Z'), 'soon')                     // 16 min
  assert.equal(ph('2026-10-12T06:15:00Z'), 'imminent')                 // 15 min
  assert.equal(ph('2026-10-12T06:20:00Z'), 'imminent')                 // 10 min
  assert.equal(ph('2026-10-12T06:29:30Z'), 'imminent')                 // 30 s
  assert.equal(ph('2026-10-12T06:30:00Z'), 'running')                  // Beginn
  assert.equal(ph('2026-10-12T15:59:00Z'), 'running')                  // 17:59
  assert.equal(ph('2026-10-12T16:00:00Z'), 'none')                     // 18:00 = Ende
  assert.equal(announceShift(sh, at('2026-10-12T06:00:00Z')).startsIn, 30)
  assert.equal(announceShift(sh, at('2026-10-12T06:00:00Z')).isToday, true)
  assert.equal([SOON_MIN, IMMINENT_MIN].join(), '60,15')
})

test('Beendete Schichten werden übersprungen; nächste echte Schicht; keine Schicht; Grenzfall limit(3) → neutral', () => {
  const r = announceShift([S('2026-10-12', '06:00', '10:00'), S('2026-10-12', '14:00', '18:00'), S('2026-10-13', '08:30', '18:00')], at('2026-10-12T09:00:00Z'))
  assert.equal(r.shift.start_time, '14:00:00'); assert.equal(r.phase, 'later')
  assert.equal(announceShift([], at('2026-10-12T09:00:00Z')).phase, 'none')
  assert.equal(announceShift(null, at('2026-10-12T09:00:00Z')).phase, 'none')
  const three = [S('2026-10-12', '06:00', '07:00'), S('2026-10-12', '07:00', '08:00'), S('2026-10-12', '08:00', '09:00')]
  assert.deepEqual([announceShift(three, at('2026-10-12T12:00:00Z')).phase, announceShift(three.slice(0, 2), at('2026-10-12T12:00:00Z')).phase], ['unknown', 'none'])
})

test('Nachtschicht 22:00–06:00: vor Mitternacht und nach Mitternacht laufend, danach beendet', () => {
  const sh = [S('2026-10-12', '22:00', '06:00')]
  assert.equal(announceShift(sh, at('2026-10-12T19:30:00Z')).phase, 'soon')      // 21:30
  assert.equal(announceShift(sh, at('2026-10-12T21:30:00Z')).phase, 'running')   // 23:30
  assert.equal(announceShift(sh, at('2026-10-13T02:00:00Z')).phase, 'running')   // 04:00 Folgetag
  assert.equal(announceShift(sh, at('2026-10-13T04:30:00Z')).phase, 'none')      // 06:30
  assert.deepEqual(shiftWindow(sh[0]).end - shiftWindow(sh[0]).start, 8 * 60)
})

test('Europe/Berlin fest, Sommer-/Winterzeit: gleiche Wandzeit → gleiche Phase (29.03. / 25.10.2026)', () => {
  assert.equal(berlinNow(at('2026-10-11T20:50:00Z')).date, '2026-10-11')
  assert.equal(berlinNow(at('2026-10-11T22:30:00Z')).date, '2026-10-12', '00:30 Berlin = schon der 12.')
  for (const [iso, d] of [['2026-03-29T06:00:00Z', '2026-03-29'], ['2026-10-25T07:00:00Z', '2026-10-25'], ['2026-01-15T07:00:00Z', '2026-01-15'], ['2026-07-15T06:00:00Z', '2026-07-15']]) {
    const r = announceShift([S(d, '08:30', '18:00')], at(iso))                    // jeweils 08:00 Berliner Zeit
    assert.deepEqual([r.phase, r.startsIn], ['soon', 30], iso)
  }
})

test('Europe/Berlin auch auf einem Gerät in New York (eigener Prozess mit TZ=America/New_York)', () => {
  const code = `import { announceShift, berlinNow } from ${JSON.stringify(pathToFileURL(resolve('src/lib/shiftAnnouncement.js')).href)}
    const S = (d, a, b) => ({ date: d, start_time: a + ':00', end_time: b + ':00' })
    console.log(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, day: berlinNow(new Date('2026-10-11T22:30:00Z')).date,
      bug: announceShift([S('2026-10-11', '08:30', '18:00')], new Date('2026-10-11T20:50:00Z')).phase,
      imm: announceShift([S('2026-10-12', '08:30', '18:00')], new Date('2026-10-12T06:20:00Z')).phase }))`
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }))
  assert.equal(out.tz, 'America/New_York', 'Prozess läuft wirklich in New York')
  assert.deepEqual([out.day, out.bug, out.imm], ['2026-10-12', 'none', 'imminent'])
})

test('Texte DE/EN/BN: neue Schlüssel vollständig, Platzhalter gleich, BN in Bangla; „gleich“ nur noch im 15-Minuten-Fenster', () => {
  const ph = s => (s.match(/\{\w+\}/g) || []).sort().join()
  for (const k of ['dashboard.shiftSoon', 'dashboard.shiftRunning', 'dashboard.shiftUnknown']) {
    assert.ok(de[k] && en[k] && bn[k], k); assert.equal(ph(en[k]), ph(de[k]), k); assert.equal(ph(bn[k]), ph(de[k]), k); assert.match(bn[k], /[ঀ-৿]/, k)
  }
  assert.equal(de['dashboard.shiftSoon'], 'Deine Schicht beginnt bald.'); assert.equal(de['dashboard.shiftRunning'], 'Deine Schicht läuft seit {time} Uhr.')
  const src = read('src/pages/Dashboard.jsx')
  assert.doesNotMatch(src, /until \|\| tr\('dashboard\.soon'\)/, 'kein Ersatztext „gleich“ für einen Beginn in der Vergangenheit')
  assert.match(src, /shiftInfo\.phase === 'imminent'\n\s+\? tr\("ui\.686825b73377", \{ p1: tr\('dashboard\.soon'\) \}\)/)
  assert.match(src, /const canClockIn = \['soon', 'imminent', 'running'\]\.includes\(shiftInfo\.phase\) && loadState\.mine === 'ok' && !clockedIn/)
  assert.match(src, /\{canClockIn && \(/)
})

test('Unverändert: Supabase-Aufrufe (Text + Reihenfolge) – auch die limit(3)-Abfrage der eigenen Schichten', () => {
  const calls = s => s.match(/supabase\.(from|rpc)\([^\n]*/g)
  assert.deepEqual(calls(read('src/pages/Dashboard.jsx')), calls(atBefore('src/pages/Dashboard.jsx')))
  assert.match(read('src/pages/Dashboard.jsx'), /supabase\.from\('shifts'\)\.select\('\*'\)\.eq\('employee_id', profile\.employee_id\)\.gte\('date', todayISO\)\.order\('date'\)\.order\('start_time'\)\.limit\(3\)/)
})

// ── Teil 2: echte Seite im Browser ──
const FAKE = String.raw`
function makeFake() {
  const db = { log: [], queries: [], fail: {}, failOnce: {}, pending: 0, data: {
    myShifts: [], myClock: null, myEmp: { id: 'e1', first_name: 'Anna', last_name: 'Test', birth_date: '1990-01-01', street: 'x', house_number: '1', postal_code: '1', city: 'x', phone: '1', iban: 'x', account_holder: 'x', tax_id: '1', social_security_number: '1', health_insurance: 'x', other_employment: false, emergency_contact_name: 'x', emergency_contact_phone: '1', employment_type: 'vollzeit' },
    live: [], breaks: [], 'rpc:get_staff_operational': [{ id: 'e1', first_name: 'Anna', last_name: 'Test', is_active: true }],
    empCount: 1, vacCount: 0, usersPending: 0, swaps: [], todayShifts: [], allEmps: [], forgotten: 0, adminCount: 2, onboarding: 0,
    'rpc:backup_list': { success: true, last_download_at: new Date().toISOString() }, 'rpc:retention_overview': { success: true, total_due: 0, categories: [] },
    pendingVac: [], pendingSick: [], approvedVacs: [], sickNoAttest: [], 'rpc:labor_cost_today': null,
  } }
  const has = (q, m, k) => q.f.some(x => x[0] === m && (k === undefined || x[1] === k))
  const eqv = (q, k) => (q.f.find(x => x[0] === 'eq' && x[1] === k) || [])[2]
  function kind(q) {
    switch (q.table) {
      case 'shifts': return has(q, 'eq', 'employee_id') ? 'myShifts' : 'todayShifts'
      case 'time_entries': return has(q, 'like') ? 'forgotten' : has(q, 'eq', 'employee_id') ? 'myClock' : 'live'
      case 'time_entry_breaks': return 'breaks'
      case 'employees': return has(q, 'eq', 'id') ? 'myEmp' : q.head ? 'empCount' : 'allEmps'
      case 'vacation_requests': return q.head ? 'vacCount' : eqv(q, 'status') === 'approved' ? 'approvedVacs' : 'pendingVac'
      case 'profiles': return has(q, 'eq', 'role') ? 'adminCount' : 'usersPending'
      case 'shift_swap_requests': return 'swaps'
      case 'sick_leave': return has(q, 'is', 'end_date') ? 'pendingSick' : 'sickNoAttest'
      case 'employee_onboarding': return 'onboarding'
      default: return q.table
    }
  }
  function respond(k, single, q) {
    db.log.push(k); if (q) db.queries.push({ k, f: q.f })
    if (db.fail[k] || db.failOnce[k]) { delete db.failOnce[k]; return { data: null, count: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 } }
    const v = db.data[k]
    if (typeof v === 'number') return { data: null, count: v, error: null, status: 200 }
    return { data: v == null ? (single || k.startsWith('rpc:') ? null : []) : JSON.parse(JSON.stringify(v)), error: null, status: 200 }
  }
  const send = (k, single, q) => { const out = respond(k, single, q); db.pending++; return new Promise(r => setTimeout(r, 0)).then(() => { db.pending--; return out }) }
  function builder(table) {
    const q = { table, f: [], head: false, single: false }
    const api = new Proxy({}, { get(_, m) {
      if (m === 'then') return (res, rej) => send(kind(q), q.single, q).then(res, rej)
      if (m === 'select') return (c, o) => { q.head = !!(o && o.head); return api }
      if (m === 'maybeSingle' || m === 'single') return () => { q.single = true; return api }
      return (...a) => { q.f.push([m, ...a]); return api }
    } })
    return api
  }
  return { db, client: { from: builder, rpc: n => send('rpc:' + n, true) } }
}`
const STUB = `window.__sb = window.__sb || { current: null }
export const supabase = new Proxy({}, { get: (_, k) => window.__sb.current[k] })
export const getInitials = (a, b) => ((a || '')[0] || '') + ((b || '')[0] || '')`
const entry = which => `
// steuerbare Uhr (vor dem App-Code): fester Zeitpunkt + Minutentakt von Hand
const RealDate = Date; let offset = 0
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset) } static now() { return RealDate.now() + offset } }
globalThis.Date = FakeDate
window.__setNow = iso => { offset = new RealDate(iso).getTime() - RealDate.now() }
const realSetInterval = globalThis.setInterval; window.__ticks = []
globalThis.setInterval = (fn, ms, ...r) => { if (ms === 30000) window.__ticks.push(fn); return realSetInterval(fn, ms, ...r) }
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import { ProfileContext } from ${JSON.stringify(resolve('src/context/ProfileContext.jsx'))}
import { DarkModeProvider } from ${JSON.stringify(resolve('src/context/DarkModeContext.jsx'))}
import { ToastProvider } from ${JSON.stringify(resolve('src/components/UI/Toast.jsx'))}
import { RefreshProvider, useRefresh } from ${JSON.stringify(resolve('src/context/RefreshContext.jsx'))}
import Dashboard from ${JSON.stringify(which)}
${FAKE}
function Expose() { window.__refresh = useRefresh().refreshData; return null }
const root = createRoot(document.getElementById('app'))
let k = 0
const ROLES = { admin: { isAdmin: true, isManager: false }, employee: { isAdmin: false, isManager: false } }
window.__mount = (role, nowIso, setup) => {
  window.__setNow(nowIso); window.__ticks = []
  const f = makeFake(); window.__db = f.db; window.__sb.current = f.client
  if (setup) (new Function('db', setup))(f.db)
  root.render(<LocaleProvider><DarkModeProvider><ToastProvider><RefreshProvider><Expose /><MemoryRouter><ProfileContext.Provider key={++k} value={{ ...ROLES[role], profile: { id: 'u1', employee_id: 'e1', first_name: 'Anna' }, pendingCount: 0 }}><div className="main"><Dashboard /></div></ProfileContext.Provider></MemoryRouter></RefreshProvider></ToastProvider></DarkModeProvider></LocaleProvider>)
}`

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, pages = {}, HARNESS_ERR = null

async function openPage(file, tz = null) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  if (tz) await send('Emulation.setTimezoneOverride', { timezoneId: tz })   // vor dem Laden: Intl-Standardzeitzone der Seite
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(700)
  const settle = async () => { let quiet = 0; for (let i = 0; i < 300; i++) { if (await ev('window.__db.pending') === 0) { if (++quiet >= 8) return } else quiet = 0; await sleep(25) } throw new Error('Seite lädt nicht') }
  const state = () => ev(`({ text: document.querySelector('.content').innerText, log: window.__db.log.slice(), queries: window.__db.queries.slice() })`)
  const mount = async (role, nowIso, setup) => { await ev(`window.__mount(${JSON.stringify(role)}, ${JSON.stringify(nowIso)}, ${JSON.stringify(setup || '')}); true`); await sleep(60); await settle() }
  const tick = async nowIso => { await ev(`window.__setNow(${JSON.stringify(nowIso)}); window.__ticks.forEach(f => f()); true`); await sleep(80) }
  return { ev, send, state, mount, settle, tick, front: () => send('Page.bringToFront'), ws }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-shiftbanner-'))
  try {
    const esbuild = await import('esbuild')
    const plugin = { name: 'stubs', setup(b) {
      b.onResolve({ filter: /(^|\/)supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
      b.onResolve({ filter: /^before:Dashboard$/ }, () => ({ path: 'Dashboard.before.jsx', namespace: 'before' }))
      b.onLoad({ filter: /.*/, namespace: 'before' }, () => ({ contents: atBefore('src/pages/Dashboard.jsx'), loader: 'jsx', resolveDir: resolve('src/pages') }))
    } }
    for (const [name, which] of [['now', resolve('src/pages/Dashboard.jsx')], ['before', 'before:Dashboard']]) {
      const js = (await esbuild.build({ stdin: { contents: entry(which), loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [plugin],
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"', 'import.meta.env.VITE_VAPID_PUBLIC_KEY': '""' }, logLevel: 'silent' })).outputFiles[0].text
      writeFileSync(join(dir, `${name}.html`), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${read('src/index.css')}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de'); localStorage.setItem('cafe_hide_app_setup', '1'); localStorage.setItem('cafe_hide_admin_tip', '1') } catch {}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    }
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    pages.now = await openPage(join(dir, 'now.html'), 'Europe/Berlin'); pages.before = await openPage(join(dir, 'before.html'), 'Europe/Berlin')
    pages.ny = await openPage(join(dir, 'now.html'), 'America/New_York')
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { for (const p of Object.values(pages)) try { p.ws.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async name => { assert.ok(pages[name], `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await pages[name].front(); return pages[name] }

const GLEICH = de['ui.686825b73377'].replace('{p1}', de['dashboard.soon'])          // „Deine Schicht startet gleich!“
const BALD = de['dashboard.shiftSoon'], LAEUFT = de['dashboard.shiftRunning'].replace('{time}', '08:30')
const CLOCKIN = de['ui.30330faa0d54'], NONE = de['ui.e0543209621f'], IN = de['ui.721773fe1f69']
const shifts = (...list) => `db.data.myShifts = ${JSON.stringify(list)}`
const SUN = S('2026-10-11', '08:30', '18:00'), MON = S('2026-10-12', '08:30', '18:00')

test('Browser – Originalfehler So 11.10.2026 22:50: kein „startet gleich“, kein „Jetzt Einclocken“ (vorher: beides)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('employee', '2026-10-11T20:50:00Z', shifts(SUN))
  let s = await p.state()
  assert.ok(!s.text.includes(GLEICH)); assert.ok(!s.text.includes(CLOCKIN)); assert.ok(s.text.includes(NONE))
  const b = await P('before'); await b.mount('employee', '2026-10-11T20:50:00Z', shifts(SUN))
  s = await b.state()
  assert.ok(s.text.includes(GLEICH) && s.text.includes(CLOCKIN), 'Gegenprobe: alter Stand zeigt den gemeldeten Fehler')
})

test('Browser – keine Schicht: „Keine Schichten geplant“, keine Ankündigung, kein Einclocken', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('employee', '2026-10-12T06:00:00Z', shifts())
  const s = await p.state()
  assert.ok(s.text.includes(NONE)); for (const x of [GLEICH, BALD, CLOCKIN]) assert.ok(!s.text.includes(x), x)
})

test('Browser – 30 min vorher „beginnt bald“, 10 min vorher „startet gleich!“, laufend „läuft seit 08:30 Uhr.“, beendet → nächste Schicht', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  for (const [iso, want, clock] of [['2026-10-12T06:00:00Z', BALD, true], ['2026-10-12T06:20:00Z', GLEICH, true], ['2026-10-12T08:00:00Z', LAEUFT, true]]) {
    await p.mount('employee', iso, shifts(MON)); const s = await p.state()
    assert.ok(s.text.includes(want), `${iso}: ${want}`); assert.equal(s.text.includes(CLOCKIN), clock, `${iso}: Einclocken`)
    for (const other of [BALD, GLEICH, LAEUFT].filter(x => x !== want)) assert.ok(!s.text.includes(other), `${iso}: nicht ${other}`)
  }
  await p.mount('employee', '2026-10-12T17:00:00Z', shifts(MON, S('2026-10-13', '09:00', '17:00')))   // 19:00, beendet
  const s = await p.state()
  assert.ok(s.text.includes(de['ui.a0e4bf554be7'].replace('{p1}', de['ui.c4785ba17e12'])), 'Nächste Schicht: Morgen')
  for (const x of [GLEICH, BALD, LAEUFT, CLOCKIN]) assert.ok(!s.text.includes(x), x)
})

test('Browser – Clock-Status bei laufender Schicht: OFF_CLOCK → Einclocken · WORKING → „eingeclockt“ · ERROR → kein Button · UNKNOWN (veraltet) → kein Button', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'), RUN = '2026-10-12T08:00:00Z'
  await p.mount('employee', RUN, shifts(MON)); assert.ok((await p.state()).text.includes(CLOCKIN), 'OFF_CLOCK')
  await p.mount('employee', RUN, `${shifts(MON)}; db.data.myClock = { id: 't1' }`)
  let s = await p.state(); assert.ok(s.text.includes(IN) && !s.text.includes(CLOCKIN), 'WORKING')
  await p.mount('employee', RUN, `${shifts(MON)}; db.fail.myClock = true`)
  s = await p.state(); assert.ok(!s.text.includes(CLOCKIN) && !s.text.includes(GLEICH), 'ERROR: kein Button, keine Ankündigung')
  await p.mount('employee', RUN, shifts(MON))                                        // erst erfolgreich …
  await p.ev(`window.__db.failOnce.myClock = true; window.__refresh(); true`); await sleep(100); await p.settle()   // … dann Status-Fehler
  s = await p.state(); assert.ok(s.text.includes(LAEUFT), 'letzter Stand bleibt sichtbar'); assert.ok(!s.text.includes(CLOCKIN), 'UNKNOWN: kein Button')
})

test('Browser – Phasenwechsel ohne Neuladen (Minutentakt), ohne zusätzliche Anfragen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('employee', '2026-10-12T05:00:00Z', shifts(MON))   // 07:00 → later
  const n0 = (await p.state()).log.length
  assert.ok(!(await p.state()).text.includes(BALD))
  await p.tick('2026-10-12T06:00:00Z'); assert.ok((await p.state()).text.includes(BALD))
  await p.tick('2026-10-12T06:20:00Z'); assert.ok((await p.state()).text.includes(GLEICH))
  await p.tick('2026-10-12T06:35:00Z'); assert.ok((await p.state()).text.includes(LAEUFT))
  await p.tick('2026-10-12T16:05:00Z'); const s = await p.state(); assert.ok(!s.text.includes(LAEUFT) && !s.text.includes(GLEICH) && s.text.includes(NONE))
  assert.equal(s.log.length, n0, 'der Takt löst keine Anfragen aus')
})

test('Browser – Europe/Berlin fest: Gerät in New York zeigt dieselbe Phase; Zeitumstellung 29.03./25.10.', async t => {
  if (SKIP) return t.skip(SKIP)
  const ny = await P('ny')
  assert.equal(await ny.ev('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'America/New_York', 'Seite läuft wirklich in New York')
  await ny.mount('employee', '2026-10-12T06:20:00Z', shifts(MON))                   // 08:20 Berlin = 02:20 New York
  assert.ok((await ny.state()).text.includes(GLEICH), 'Phase nach Berliner Zeit, nicht nach Gerätezeit')
  await ny.mount('employee', '2026-10-11T20:50:00Z', shifts(SUN))                   // Originalfall, Gerät in New York (16:50)
  assert.ok(!(await ny.state()).text.includes(GLEICH))
  const p = await P('now')
  for (const [iso, d] of [['2026-03-29T06:00:00Z', '2026-03-29'], ['2026-10-25T07:00:00Z', '2026-10-25']]) {
    await p.mount('employee', iso, shifts(S(d, '08:30', '18:00'))); assert.ok((await p.state()).text.includes(BALD), iso)
  }
})

test('Browser – Mitarbeiterzuordnung (nur eigene employee_id), Grenzfall limit(3) neutral, Ladefehler ohne falsche Anzeige', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('employee', '2026-10-12T06:00:00Z', shifts(MON))
  const q = (await p.state()).queries.find(x => x.k === 'myShifts')
  assert.deepEqual(q.f.filter(x => x[0] === 'eq'), [['eq', 'employee_id', 'e1']])
  await p.mount('employee', '2026-10-12T12:00:00Z', shifts(S('2026-10-12', '06:00', '07:00'), S('2026-10-12', '07:00', '08:00'), S('2026-10-12', '08:00', '09:00')))
  let s = await p.state()
  assert.ok(s.text.includes(de['dashboard.shiftUnknown'])); assert.ok(!s.text.includes(NONE), 'keine falsche „Keine Schichten“-Aussage'); assert.ok(!s.text.includes(GLEICH))
  await p.mount('employee', '2026-10-12T06:20:00Z', `${shifts(MON)}; db.fail.myShifts = true`)
  s = await p.state(); assert.ok(s.text.includes(de['dashboard.myShiftsFailed'])); for (const x of [GLEICH, BALD, CLOCKIN, NONE]) assert.ok(!s.text.includes(x), x)
  // veralteter Stand nach Ladefehler: beendete Schicht wird nach der Uhr bewertet, nie als bevorstehend gemeldet
  await p.mount('employee', '2026-10-12T15:00:00Z', shifts(MON))
  await p.ev(`window.__db.fail['myShifts'] = true; window.__db.fail['myClock'] = true; window.__refresh(); true`); await sleep(100); await p.settle()
  await p.tick('2026-10-12T17:00:00Z'); s = await p.state()
  assert.ok(!s.text.includes(GLEICH) && !s.text.includes(LAEUFT) && !s.text.includes(CLOCKIN))
})

test('Browser – keine zusätzlichen Supabase-Anfragen: gleiche Anfragen wie vorher (Mitarbeiter und Admin)', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const role of ['employee', 'admin']) {
    const a = await P('now'); await a.mount(role, '2026-10-12T06:00:00Z', shifts(MON)); const la = (await a.state()).log.filter(k => k !== 'rpc:labor_cost_today').sort()
    const b = await P('before'); await b.mount(role, '2026-10-12T06:00:00Z', shifts(MON)); const lb = (await b.state()).log.filter(k => k !== 'rpc:labor_cost_today').sort()
    assert.deepEqual(la, lb, role)
  }
})
