// Resilience Batch 2d (Dashboard): 2d-1 Fehler je Datengruppe sichtbar, nie Nullen/„nichts zu tun“ statt Fehler,
// 2d-2 letzter erfolgreicher Stand bleibt, 2d-3 nur die jüngste Ladung wird angewendet, 2d-4 „Erneut laden“ ohne Request-Sturm,
// „Lädt…“ nur beim ersten Laden. Teil 1: rein + Quelltext. Teil 2: ECHTE Seite Dashboard.jsx in Headless Chrome gegen einen
// nachgebildeten Server (nur supabase ersetzt) – inkl. Gegenproben mit dem Stand vor 2d (64bae5f).
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = '64bae5f'   // Stand vor Batch 2d
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const NONE = de['attention.none'], LOADING = de['ui.ebbb1d1f265f']

// ── Teil 1 ──
const KEYS = ['dashboard.loadProblem', 'dashboard.loadFailed', 'dashboard.myShiftsFailed', 'dashboard.retry', 'attention.incomplete', 'attention.incompleteHint']
test('DE/EN/BN: neue Texte vollständig, ohne Platzhalter, BN in bengalischer Schrift ohne bengalische Ziffern; keine Entwarnung im Fehlertext', () => {
  for (const k of KEYS) {
    assert.ok(de[k] && en[k] && bn[k], k)
    for (const v of [de[k], en[k], bn[k]]) assert.doesNotMatch(v, /\{\w+\}/, k)
    assert.match(bn[k], /[ঀ-৿]/, k); assert.doesNotMatch(bn[k], /[০-৯]/, k)
  }
  assert.doesNotMatch(de['attention.incomplete'], /nichts zu erledigen/i)
  assert.doesNotMatch(en['attention.incomplete'], /nothing to do/i)
})

function checkDashboard(src) {
  const fa = src.slice(src.indexOf('  const fetchAll = useCallback(async () => {'), src.indexOf('  }, [profile?.employee_id, canManage])'))
  assert.match(fa, /const my = \+\+loadSeq\.current/)
  assert.equal((fa.match(/if \(outdated\(\)\) return/g) || []).length, 7, 'nach jedem await: veraltete Ladung bricht ab')
  assert.match(fa, /if \(!loadedOnceRef\.current\) setLoading\(true\)/, '„Lädt…“ nur beim ersten Laden')
  assert.doesNotMatch(fa, /^\s+setLoading\(true\)/m)
  for (const [guard, setter] of [['!failed.mine', 'setNextShift('], ['!failed.live', 'setLiveClockIns('], ['!failed.team', 'setStats('], ['!failed.team', 'setTodayShifts(']]) {
    const i = fa.indexOf(setter); assert.ok(i > 0, setter)
    assert.ok(fa.lastIndexOf(`if (${guard}) {`, i) > 0 && fa.lastIndexOf(`if (${guard}) {`, i) > fa.lastIndexOf('await', i), `${setter} nur ohne Fehler`)
  }
  assert.match(fa, /if \(fErr\) failed\.attention = true\n\s+else setForgotten\(fCount \|\| 0\)/)
  assert.match(fa, /catch \{ failed\.attention = true/)
  assert.match(src, /incomplete=\{hasProblem\('live'\) \|\| hasProblem\('attention'\)\}/)
  assert.match(src, /data-testid="dashboard-load-problem"/); assert.match(src, /disabled=\{retrying\}/)
}
test('Dashboard.jsx: Sequenz, kein Überschreiben bei Fehler, Fehler je Gruppe, „Lädt…“ nur beim ersten Laden, Hinweis + Erneut laden', () => checkDashboard(read('src/pages/Dashboard.jsx')))
test('Gegenprobe Quelltext: Stand vor 2d erfüllt die Prüfung nicht', () => assert.throws(() => checkDashboard(atBefore('src/pages/Dashboard.jsx'))))

test('Unverändert: alle Supabase-Aufrufe (Text + Reihenfolge), genau ein useRefreshHandler, Live-Personalkosten nur über revalidate', () => {
  const calls = s => s.match(/supabase\.(from|rpc)\([^\n]*/g)
  assert.deepEqual(calls(read('src/pages/Dashboard.jsx')), calls(atBefore('src/pages/Dashboard.jsx')))
  const now = read('src/pages/Dashboard.jsx')
  assert.equal((now.match(/useRefreshHandler\(/g) || []).length, 1)
  assert.equal((now.match(/fetchAll\(\)/g) || []).length, 3, 'useEffect, runLive, Erneut laden')
  assert.equal((now.match(/laborCosts\.revalidate\('load'\)/g) || []).length, 1)
  assert.doesNotMatch(now, /location\.reload|refreshData\(/)
})

test('AttentionPanel: incomplete ist abwärtskompatibel (Standard false, ohne incomplete unveränderte Ausgabe)', () => {
  const now = read('src/components/AttentionPanel.jsx'), was = atBefore('src/components/AttentionPanel.jsx')
  assert.match(now, /export default function AttentionPanel\(\{ role, loading, data, onOpenLive, incomplete = false \}\)/)
  // ohne incomplete: die alten Zweige stehen unverändert, die neuen greifen nur bei incomplete
  const strip = s => s.replace(/      \) : items\.length === 0 && incomplete \? \(\n[^\n]*\n/, '').replace(/      \{!initial && incomplete && items\.length > 0 && \(\n[^\n]*\n      \)\}\n/, '')
    .replace(/\/\/ incomplete \(Resilience Batch 2d\)[^\n]*\n\/\/[^\n]*\n/, '').replace(', incomplete = false }', ' }')
  assert.equal(strip(now), was)
})

// ── Teil 2: echte Seite im Browser ──
const FAKE = String.raw`
function makeFake() {
  const pad = n => String(n).padStart(2, '0'), ds = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  const today = ds(new Date()), tomorrow = ds(new Date(Date.now() + 86400000))
  const db = { log: [], fail: {}, delay: {}, pending: 0, data: {
    myShifts: [{ id: 's1', employee_id: 'e1', date: tomorrow, start_time: '09:00:00', end_time: '17:00:00', position: '' }],
    live: [{ id: 't1', employee_id: 'e2', clock_in: new Date(Date.now() - 2 * 3600000).toISOString(), clock_out: null, employees: { first_name: 'Ben', last_name: 'Live' } }],
    myEmp: { id: 'e1', first_name: 'Anna', last_name: 'Admin', birth_date: '1990-01-01', street: 'x', house_number: '1', postal_code: '1', city: 'x', phone: '1', iban: 'x', account_holder: 'x', tax_id: '1', social_security_number: '1', health_insurance: 'x', other_employment: false, emergency_contact_name: 'x', emergency_contact_phone: '1', employment_type: 'vollzeit' },
    myClock: null, breaks: [],
    'rpc:get_staff_operational': [{ id: 'e1', first_name: 'Anna', last_name: 'Admin', is_active: true }, { id: 'e2', first_name: 'Ben', last_name: 'Live', is_active: true }, { id: 'e3', first_name: 'Cara', last_name: 'Plan', is_active: true }],
    empCount: 3, vacCount: 1, usersPending: 0, swaps: [{ status: 'open' }, { status: 'accepted' }],
    todayShifts: [{ id: 's2', employee_id: 'e3', date: today, start_time: '23:58:00', end_time: '23:59:00', position: '', employees: { first_name: 'Cara', last_name: 'Plan' } }],
    allEmps: [], forgotten: 0, 'rpc:backup_list': { success: true, last_download_at: new Date().toISOString() }, adminCount: 2,
    'rpc:retention_overview': { success: true, total_due: 0, categories: [] }, onboarding: 0,
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
  function respond(k, single) {
    db.log.push(k)
    if (db.fail[k] || db.fail['*']) return { data: null, count: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }
    const v = db.data[k]
    if (typeof v === 'number') return { data: null, count: v, error: null, status: 200 }
    return { data: v == null ? (single || k.startsWith('rpc:') ? null : []) : JSON.parse(JSON.stringify(v)), error: null, status: 200 }
  }
  function send(k, single) {
    const out = respond(k, single)   // Stand zum Zeitpunkt der Anfrage (wie ein Server)
    const d = typeof db.delay[k] === 'function' ? db.delay[k]() : (db.delay[k] || 0)
    db.pending++
    return new Promise(r => setTimeout(r, d)).then(() => { db.pending--; return out })
  }
  function builder(table) {
    const q = { table, f: [], head: false, single: false }
    const api = new Proxy({}, { get(_, m) {
      if (m === 'then') return (res, rej) => send(kind(q), q.single).then(res, rej)
      if (m === 'select') return (c, o) => { q.head = !!(o && o.head); return api }
      if (m === 'maybeSingle' || m === 'single') return () => { q.single = true; return api }
      return (...a) => { q.f.push([m, ...a]); return api }
    } })
    return api
  }
  const client = { from: builder, rpc: n => send('rpc:' + n, true) }
  return { db, client }
}`
const STUB = `window.__sb = window.__sb || { current: null }
export const supabase = new Proxy({}, { get: (_, k) => window.__sb.current[k] })
export const getInitials = (a, b) => ((a || '')[0] || '') + ((b || '')[0] || '')`
const entry = which => `
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
const ROLES = { admin: { isAdmin: true, isManager: false }, manager: { isAdmin: false, isManager: true }, employee: { isAdmin: false, isManager: false } }
window.__mount = (role, setup) => {
  const f = makeFake(); window.__db = f.db; window.__sb.current = f.client
  if (setup) (new Function('db', setup))(f.db)
  root.render(<LocaleProvider><DarkModeProvider><ToastProvider><RefreshProvider><Expose /><MemoryRouter><ProfileContext.Provider key={++k} value={{ ...ROLES[role], profile: { id: 'u1', employee_id: 'e1', first_name: 'Anna' }, pendingCount: 0 }}><div className="main"><Dashboard /></div></ProfileContext.Provider></MemoryRouter></RefreshProvider></ToastProvider></DarkModeProvider></LocaleProvider>)
}`

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, pages = {}, HARNESS_ERR = null

async function openPage(file) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(700)
  const front = () => send('Page.bringToFront')
  const state = () => ev(`(() => { const q = s => document.querySelector(s), t = s => q(s)?.innerText ?? null
    return { text: q('.content').innerText, banner: t('[data-testid="dashboard-load-problem"]'), retryDisabled: q('[data-testid="dashboard-retry"]')?.disabled ?? null,
      tiles: [...document.querySelectorAll('.content a .card')].map(c => c.children[c.children.length - 2].innerText),
      attention: t('[data-testid="attention-panel"]'), incomplete: !!q('[data-testid="attention-incomplete"]'), incompleteHint: !!q('[data-testid="attention-incomplete-hint"]'),
      mineFailed: !!q('[data-testid="dashboard-mine-failed"]'), mineCardFailed: !!q('[data-testid="dashboard-mine-failed-card"]'),
      liveFailed: !!q('[data-testid="dashboard-live-failed"]'), teamFailed: !!q('[data-testid="dashboard-team-failed"]'), log: window.__db.log.slice() } })()`)
  // fertig = keine offene Anfrage für 200 ms (fetchAll lädt in Stufen)
  const settle = async () => { let quiet = 0; for (let i = 0; i < 300; i++) { if (await ev('window.__db.pending') === 0) { if (++quiet >= 8) return } else quiet = 0; await sleep(25) } throw new Error('Seite lädt nicht') }
  const mount = async (role, setup) => { await ev(`window.__mount(${JSON.stringify(role)}, ${JSON.stringify(setup || '')})`); await sleep(50); await settle() }
  const click = async jsSelectorExpr => { const ok = await ev(`(() => { const b = ${jsSelectorExpr}; if (!b) return false; b.click(); return true })()`); return ok }
  return { ev, send, front, state, mount, click, settle, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-dash-'))
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
    pages.now = await openPage(join(dir, 'now.html')); pages.before = await openPage(join(dir, 'before.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { for (const p of Object.values(pages)) try { p.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async name => { assert.ok(pages[name], `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await pages[name].front(); return pages[name] }
const sorted = a => a.filter(k => k !== 'rpc:labor_cost_today').sort()
const refresh = async p => { await p.ev('window.__refresh()'); await sleep(50); await p.settle() }

test('Browser: alles erfolgreich → gleiche Anzeige und GENAU dieselben Anfragen wie vor 2d (Admin, Manager, Mitarbeiter)', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const role of ['admin', 'manager', 'employee']) {
    const now = await P('now'); await now.mount(role); const a = await now.state()
    const was = await P('before'); await was.mount(role); const b = await was.state()
    assert.deepEqual(sorted(a.log), sorted(b.log), `${role}: keine zusätzlichen/fehlenden Anfragen`)
    assert.equal(a.banner, null, role); assert.equal(a.incomplete, false, role)
    assert.deepEqual(a.tiles, b.tiles, role); assert.equal(a.attention, b.attention, role)
    assert.equal(a.text, b.text, `${role}: Seite unverändert`)
  }
})

const ALL_FAIL = `db.fail['*'] = true`
test('Browser 2d-1: Erstladen mit Netzwerkfehler → Hinweis + „Erneut laden“, „nicht geladen“ statt Nullen/Leerzuständen, NIE „nichts zu erledigen“', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('admin', ALL_FAIL)
  const s = await p.state()
  assert.equal(s.banner?.includes(de['dashboard.loadProblem']), true); assert.equal(s.retryDisabled, false)
  assert.ok(s.mineFailed && s.liveFailed && s.teamFailed, 'jede Gruppe als „nicht geladen“ gekennzeichnet')
  assert.deepEqual(s.tiles.slice(0, 4), ['–', '–', '–', '–'], 'keine falschen Nullen')
  assert.equal(s.incomplete, true); assert.ok(!s.attention.includes(NONE), 'keine Entwarnung')
  for (const txt of [de['ui.0cd095ecb598'], de['ui.cb780633d4d3'], de['ui.e0543209621f'], LOADING]) assert.ok(!s.text.includes(txt), `kein „${txt}“`)
})
test('Gegenprobe Browser 2d-1: Stand vor 2d meldet bei Netzwerkfehler „nichts zu erledigen“, Nullen und „Niemand eingeclockt“', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('before'); await p.mount('admin', ALL_FAIL)
  const s = await p.state()
  assert.ok(s.attention.includes(NONE)); assert.deepEqual(s.tiles.slice(0, 4), ['0', '0', '0', '0']); assert.ok(s.text.includes(de['ui.0cd095ecb598']))
})

test('Browser 2d-1: Mitarbeiter – eigene Schichten nicht ladbar → „konnte nicht geladen werden“ statt „Keine Schichten geplant“', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('employee', `db.fail.myShifts = true`)
  const s = await p.state()
  assert.ok(s.mineFailed && s.mineCardFailed); assert.ok(s.banner); assert.ok(!s.text.includes(de['ui.e0543209621f']))
  assert.equal(s.attention, null, 'Mitarbeiter: kein Panel')
  const b = await P('before'); await b.mount('employee', `db.fail.myShifts = true`)
  assert.ok((await b.state()).text.includes(de['ui.e0543209621f']), 'Gegenprobe: vorher „Keine Schichten geplant“')
})

async function failAfterSuccess(p) {
  await p.mount('admin', `db.data.forgotten = 2`)
  const ok = await p.state()
  await p.ev(`window.__db.fail['*'] = true`); await refresh(p)
  return [ok, await p.state()]
}
test('Browser 2d-2: Fehler nach erfolgreichem Laden → letzter Stand bleibt (Live, Heute, Kacheln, Handlungsbedarf) + Hinweis', async t => {
  if (SKIP) return t.skip(SKIP)
  const [ok, s] = await failAfterSuccess(await P('now'))
  assert.deepEqual(ok.tiles.slice(0, 4), ['3', '1', '1', '2'])
  assert.deepEqual(s.tiles, ok.tiles, 'Kacheln behalten den letzten Stand')
  assert.ok(s.text.includes('Ben Live') && s.text.includes('Cara Plan'), 'Listen bleiben')
  assert.ok(s.text.includes('09:00'), 'eigene nächste Schicht bleibt')
  assert.ok(s.banner); assert.ok(!s.mineFailed && !s.liveFailed && !s.teamFailed, 'kein „nicht geladen“, es gibt ja einen Stand')
  assert.ok(s.attention.includes('Ausstempeln') || s.attention.includes('2'), 'Hinweise bleiben'); assert.equal(s.incompleteHint, true)
})
test('Gegenprobe Browser 2d-2: Stand vor 2d überschreibt bei Fehler alles mit Nullen/Leerlisten', async t => {
  if (SKIP) return t.skip(SKIP)
  const [, s] = await failAfterSuccess(await P('before'))
  assert.deepEqual(s.tiles.slice(0, 4), ['0', '0', '0', '0']); assert.ok(!s.text.includes('Ben Live'))
})

test('Browser 2d-1: Teilfehler je Datengruppe – nur die betroffene Gruppe ist markiert', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount('admin', `db.fail.vacCount = true`)              // Team-Zahlen
  let s = await p.state()
  assert.ok(s.teamFailed && !s.liveFailed && !s.mineFailed); assert.deepEqual(s.tiles.slice(0, 4), ['–', '1', '–', '–'])
  assert.equal(s.incomplete, false, 'Handlungsbedarf vollständig geprüft'); assert.equal(s.incompleteHint, false)
  await p.mount('admin', `db.fail.pendingVac = true`)            // Handlungsbedarf
  s = await p.state()
  assert.ok(!s.teamFailed && !s.liveFailed && !s.mineFailed); assert.deepEqual(s.tiles.slice(0, 4), ['3', '1', '1', '2'])
  assert.ok(s.banner); assert.ok(!s.attention.includes(NONE), 'keine Entwarnung bei fehlender Quelle'); assert.ok(s.incomplete || s.incompleteHint)
  await p.mount('admin', `db.fail.breaks = true`)                // Live (Pausen)
  s = await p.state()
  assert.ok(s.liveFailed && !s.teamFailed && !s.mineFailed); assert.equal(s.tiles[1], '–'); assert.ok(s.incomplete || s.incompleteHint)
  await p.mount('admin', `db.fail['rpc:get_staff_operational'] = true`)   // Personalverzeichnis (bisher still)
  s = await p.state()
  assert.ok(s.banner && s.liveFailed)
  await p.mount('manager', `db.fail.myEmp = true`)               // eigene Daten
  s = await p.state()
  assert.ok(s.mineFailed && !s.liveFailed && !s.teamFailed); assert.equal(s.incomplete, false)
  await p.mount('admin', `db.fail['rpc:backup_list'] = true`)   // Admin-Hinweis
  s = await p.state()
  assert.ok(s.banner && !s.teamFailed); assert.ok(!s.attention.includes(NONE))
})

test('Browser 2d-3: konkurrierende Ladungen – die ältere, später eintreffende Antwort wird ignoriert; kein „Lädt…“ beim Aktualisieren', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount('admin', `db.fail.vacCount = true`)              // Hinweis + „Erneut laden“ sichtbar
  // Ladung 1 (zentrales Aktualisieren): langsam, alter Stand
  await p.ev(`(() => { const db = window.__db; delete db.fail.vacCount; db.data.live[0].employees.last_name = 'Alt'; db.data['rpc:get_staff_operational'][1].last_name = 'Alt'; db.data.myShifts[0].start_time = '07:00:00'; db.delay.live = 900; db.delay.myShifts = 900; window.__refresh(); return true })()`)
  await sleep(80)
  let mid = await p.state()
  assert.ok(!mid.text.includes(LOADING), 'kein „Lädt…“ beim Aktualisieren'); assert.ok(mid.text.includes('Ben Live'), 'Stand bleibt stehen')
  // Ladung 2 (Erneut laden): schnell, neuer Stand
  await p.ev(`(() => { const db = window.__db; db.data.live[0].employees.last_name = 'Neu'; db.data['rpc:get_staff_operational'][1].last_name = 'Neu'; db.data.myShifts[0].start_time = '10:00:00'; db.delay.live = 0; db.delay.myShifts = 0; return true })()`)
  await p.click(`document.querySelector('[data-testid="dashboard-retry"]')`)
  await sleep(1300); await p.settle()
  const s = await p.state()
  assert.ok(s.text.includes('Ben Neu'), 'neuester Stand angezeigt'); assert.ok(!s.text.includes('Ben Alt'), 'veraltete Antwort ignoriert')
  assert.ok(s.text.includes('10:00') && !s.text.includes('07:00'), 'eigene Schicht: veraltete Antwort ignoriert')
  assert.equal(s.banner, null)
})

test('Browser 2d-4: manuelles Neuladen – Knopf während der Ladung gesperrt (Doppeltipp = eine Ladung), danach Daten da, Hinweis weg', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount('admin', ALL_FAIL)
  const n0 = (await p.ev('window.__db.log.length'))
  await p.ev(`(() => { const db = window.__db; delete db.fail['*']; db.delay.myShifts = 300; return true })()`)
  await p.click(`document.querySelector('[data-testid="dashboard-retry"]')`); await sleep(60)
  assert.equal((await p.state()).retryDisabled, true, 'gesperrt während der Ladung')
  await p.click(`document.querySelector('[data-testid="dashboard-retry"]')`)   // Doppeltipp
  await sleep(400); await p.settle()
  const s = await p.state()
  const once = (await P('before'), await pages.before.mount('admin'), sorted((await pages.before.state()).log))
  await P('now')
  assert.deepEqual(sorted(s.log.slice(n0)), once, 'genau eine vollständige Ladung, keine doppelten Anfragen')
  assert.equal(s.banner, null); assert.deepEqual(s.tiles.slice(0, 4), ['3', '1', '1', '2']); assert.ok(s.text.includes('Ben Live'))
  assert.equal(s.incomplete, false)
})

test('Browser: Aktualisieren nach Erfolg – genau eine Ladung je Aktualisieren, kein „Lädt…“-Flackern (vorher: „Lädt…“)', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const [name, flash] of [['now', false], ['before', true]]) {
    const p = await P(name); await p.mount('admin')
    const n0 = await p.ev('window.__db.log.length'), first = sorted((await p.state()).log)
    await p.ev(`window.__db.delay.myShifts = 300; window.__refresh(); true`); await sleep(100)   // nicht auf das Ende warten
    assert.equal((await p.state()).text.includes(LOADING), flash, `${name}: „Lädt…“ beim Aktualisieren`)
    await p.settle()
    assert.deepEqual(sorted((await p.state()).log.slice(n0)), first, `${name}: genau eine Ladung`)
  }
})
