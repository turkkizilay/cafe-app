// Lohnabrechnungen: serverseitige Pagination (05.10.2026). Teil 1 prüft die Abfrage-Schicht (src/lib/payrollDocuments.js)
// gegen einen nachgebildeten PostgREST (eq/order/range/count, 416 hinter dem Ende). Teil 2 rendert die ECHTE Seite
// PayrollDocuments.jsx in Headless Chrome (nur src/lib/supabase.js ist durch denselben In-Memory-Server ersetzt) und
// bedient sie wie ein Mensch: Blättern, Filter, Upload, Löschen, Mitarbeiter-Sicht, 390-px-Touch-Layout.
// Die echte Sicherheitsgrenze (RLS) prüft tests/db/payroll_documents.test.mjs gegen Postgres.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PAGE_SIZE, DOC_COLUMNS, pageCount, clampPage, pageRange, hasFilters, documentsQuery, loadDocumentsPage } from '../src/lib/payrollDocuments.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

// ── Nachgebildeter PostgREST (auch im Browser verwendet: wird als Quelltext eingebettet) ──
const FAKE_SRC = String.raw`
function makeFake({ docs = [], employees = [], role = 'admin', ownEmployeeId = null } = {}) {
  const db = { docs: docs.map(d => ({ ...d })), employees, log: [], failNext: 0, seq: 1000 }
  const visible = () => role === 'admin' ? db.docs : db.docs.filter(d => d.employee_id === ownEmployeeId)   // RLS doc_read
  const pick = (row, cols) => {
    const out = {}
    for (const c of cols.split(',').map(s => s.trim())) {
      if (c.startsWith('employees!')) { const e = db.employees.find(x => x.id === row.employee_id); out.employees = e ? { first_name: e.first_name, last_name: e.last_name } : null }
      else if (c === '*') Object.assign(out, row)
      else out[c] = row[c]
    }
    return out
  }
  function builder(table) {
    const q = { table, op: 'select', cols: '*', count: null, eq: [], order: [], range: null, limit: null }
    const api = {
      select(cols, o = {}) { q.cols = cols; q.count = o.count || null; return api },
      eq(c, v) { q.eq.push([c, v]); return api },
      or(x) { q.or = x; return api },
      order(c, o = {}) { q.order.push([c, o.ascending !== false]); return api },
      range(a, b) { q.range = [a, b]; return api },
      limit(n) { q.limit = n; return api },
      delete() { q.op = 'delete'; return api },
      upsert(rows, o) { q.op = 'upsert'; q.rows = rows; q.onConflict = o?.onConflict; return api },
      then(res, rej) { const d = db.delay?.(q) || 0; return new Promise(r => setTimeout(r, d)).then(run).then(res, rej) },
    }
    function run() {
      db.log.push(JSON.parse(JSON.stringify(q)))
      if (db.failNext > 0 && q.table === 'payroll_documents' && q.op === 'select' && q.count) { db.failNext--; return { data: null, error: { message: 'network down', code: '' }, count: null } }
      if (q.table === 'employees') return { data: role === 'admin' ? db.employees.map(e => pick(e, q.cols)) : [], error: null }
      if (q.table !== 'payroll_documents') return { data: null, error: null }
      if (q.op === 'delete') {
        if (role !== 'admin') return { data: null, error: null }
        db.docs = db.docs.filter(d => !q.eq.every(([c, v]) => d[c] === v)); return { data: null, error: null }
      }
      if (q.op === 'upsert') {
        if (role !== 'admin') return { data: null, error: { message: 'new row violates row-level security policy' } }
        for (const r of q.rows) {
          const old = db.docs.find(d => d.employee_id === r.employee_id && d.year === r.year && d.month === r.month)
          if (old) Object.assign(old, r)
          else db.docs.push({ id: 'doc-new-' + (db.seq++), created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, db.seq)).toISOString(), ...r })
        }
        return { data: null, error: null }
      }
      let rows = visible().filter(d => q.eq.every(([c, v]) => d[c] === v))
      rows = rows.slice().sort((a, b) => { for (const [c, asc] of q.order) { if (a[c] < b[c]) return asc ? -1 : 1; if (a[c] > b[c]) return asc ? 1 : -1 } return 0 })
      const total = rows.length
      if (q.limit != null) rows = rows.slice(0, q.limit)
      if (q.range) {
        const [a, b] = q.range
        if (a > 0 && a >= total) return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' }, count: null, status: 416 }
        rows = rows.slice(a, b + 1)
      }
      return { data: rows.map(r => pick(r, q.cols)), error: null, count: q.count ? total : null }
    }
    return api
  }
  const client = {
    from: builder,
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), createSignedUrl: async p => ({ data: { signedUrl: 'about:blank#' + p }, error: null }) }) },
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  }
  return { db, client }
}`
const makeFake = new Function(`${FAKE_SRC}; return makeFake`)()

// Testdaten: n Abrechnungen, 5 Personen, je Monat 5 Dokumente, rückwärts ab 09/2026; innerhalb eines Monats
// verschiedene Upload-Zeitpunkte. (employee_id, year, month) eindeutig wie in Production.
const EMPS = [1, 2, 3, 4, 5].map(i => ({ id: `emp-${i}`, first_name: `Vorname${i}`, last_name: `Nachname${i}`, is_active: i !== 5 }))
function makeDocs(n) {
  return Array.from({ length: n }, (_, i) => {
    const back = Math.floor(i / 5), y = 2026 - Math.floor((back + 3) / 12), m = ((9 - 1 - back) % 12 + 12) % 12 + 1
    return { id: `doc-${String(i).padStart(4, '0')}`, employee_id: EMPS[i % 5].id, year: y, month: m, file_name: `abr-${i}.pdf`,
      file_path: `${EMPS[i % 5].id}/${y}-${String(m).padStart(2, '0')}-lohnabrechnung.pdf`, file_size: 1000 + i, notes: null,
      uploaded_by: 'admin-user', created_at: new Date(Date.UTC(y, m - 1, 28, 8, i % 5)).toISOString() }
  })
}
const newestFirst = docs => docs.slice().sort((a, b) => b.year - a.year || b.month - a.month || (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0) || (a.id < b.id ? -1 : 1))
const admin = (fake, page, filters = {}) => loadDocumentsPage(fake.client, { isAdmin: true, filters, page })

// ── Teil 1: Abfrage-Schicht ──
test('Seitenrechnung: 25 je Seite; 0/1/25 → 1 Seite, 26/50 → 2, 51 → 3; Grenzen werden geklemmt', () => {
  assert.equal(PAGE_SIZE, 25)
  assert.deepEqual([0, 1, 25, 26, 50, 51, 1000, 1001].map(pageCount), [1, 1, 1, 2, 2, 3, 40, 41])
  assert.deepEqual([pageRange(1), pageRange(2), pageRange(3)], [[0, 24], [25, 49], [50, 74]])
  assert.deepEqual([clampPage(0, 51), clampPage(-3, 51), clampPage(3, 51), clampPage(4, 51), clampPage(3, 50), clampPage(2, 0), clampPage('x', 10)], [1, 1, 3, 3, 2, 1, 1])
  assert.equal(hasFilters({}), false); assert.equal(hasFilters({ employeeId: '', year: '', month: '' }), false)
  assert.equal(hasFilters({ month: '3' }), true)
})

for (const [n, sizes] of [[0, [0]], [1, [1]], [25, [25]], [26, [25, 1]], [50, [25, 25]], [51, [25, 25, 1]]]) {
  test(`${n} Dokumente: Seiten ${sizes.join('/')} – exakte Gesamtzahl, lückenlos, ohne Doppelte, neueste zuerst`, async () => {
    const fake = makeFake({ docs: makeDocs(n), employees: EMPS })
    const seen = []
    for (let p = 1; p <= sizes.length; p++) {
      const r = await admin(fake, p)
      assert.equal(r.error, undefined); assert.equal(r.total, n); assert.equal(r.page, p)
      assert.equal(r.rows.length, sizes[p - 1], `Seite ${p}`)
      seen.push(...r.rows.map(d => d.id))
    }
    assert.deepEqual(seen, newestFirst(makeDocs(n)).map(d => d.id), 'Reihenfolge über alle Seiten = year↓ month↓ created_at↓ id')
    assert.equal(new Set(seen).size, n)
    assert.equal(pageCount(n), sizes.length)
  })
}

test('Neueste zuerst, deterministisch: gleiche Abrechnungsmonate nach Upload-Zeit, Gleichstand über id', async () => {
  const same = '2026-09-01T10:00:00.000Z'
  const docs = [
    { id: 'b', employee_id: 'emp-1', year: 2026, month: 9, created_at: same }, { id: 'a', employee_id: 'emp-2', year: 2026, month: 9, created_at: same },
    { id: 'c', employee_id: 'emp-3', year: 2026, month: 9, created_at: '2026-09-02T10:00:00.000Z' }, { id: 'd', employee_id: 'emp-1', year: 2026, month: 10, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'e', employee_id: 'emp-1', year: 2025, month: 12, created_at: '2027-01-01T00:00:00.000Z' }, { id: 'f', employee_id: 'emp-1', year: 2027, month: 1, created_at: '2020-01-01T00:00:00.000Z' },
  ]
  const r = await admin(makeFake({ docs, employees: EMPS }), 1)
  assert.deepEqual(r.rows.map(d => d.id), ['f', 'd', 'c', 'a', 'b', 'e'])
  const q = makeFake().db, fake = makeFake(); await admin(fake, 1)
  assert.deepEqual(fake.db.log.at(-1).order, [['year', false], ['month', false], ['created_at', false], ['id', true]])
  assert.ok(q)
})

test('Admin: Spalten explizit (kein uploaded_by, kein *), Namen per Embed, count exakt, Bereich per range()', async () => {
  const fake = makeFake({ docs: makeDocs(60), employees: EMPS })
  await admin(fake, 2)
  const q = fake.db.log.at(-1)
  assert.equal(q.table, 'payroll_documents'); assert.equal(q.count, 'exact'); assert.deepEqual(q.range, [25, 49])
  assert.equal(q.cols, `${DOC_COLUMNS}, employees!employee_id(first_name, last_name)`)
  assert.doesNotMatch(q.cols, /uploaded_by|\*/)
  assert.deepEqual(q.eq, [])
})

test('Filter + Pagination serverseitig: Mitarbeiter/Monat/Jahr als eq(), Gesamtzahl und Seiten beziehen sich auf den Filter', async () => {
  const docs = makeDocs(300), fake = makeFake({ docs, employees: EMPS })
  const want = newestFirst(docs.filter(d => d.employee_id === 'emp-2'))
  assert.ok(want.length > 50)
  const p1 = await admin(fake, 1, { employeeId: 'emp-2' }), p3 = await admin(fake, 3, { employeeId: 'emp-2' })
  assert.equal(p1.total, want.length); assert.deepEqual(p1.rows.map(d => d.id), want.slice(0, 25).map(d => d.id))
  assert.deepEqual(p3.rows.map(d => d.id), want.slice(50, 75).map(d => d.id))
  assert.deepEqual(fake.db.log.at(-1).eq, [['employee_id', 'emp-2']])
  const ym = await admin(fake, 1, { year: '2025', month: '3' })
  assert.deepEqual(fake.db.log.at(-1).eq, [['year', 2025], ['month', 3]])
  assert.deepEqual(ym.rows.map(d => d.id), newestFirst(docs.filter(d => d.year === 2025 && d.month === 3)).map(d => d.id))
  assert.equal(ym.total, 5)
  const all3 = await admin(fake, 1, { employeeId: 'emp-1', year: '2025', month: '3' })
  assert.equal(all3.total, 1); assert.equal(all3.rows[0].employee_id, 'emp-1')
  const none = await admin(fake, 1, { year: '1999' })
  assert.deepEqual([none.total, none.rows.length, none.page], [0, 0, 1])
})

test('Seite hinter dem Ende (416 PGRST103 oder 0 Zeilen) → letzte gültige Seite statt leerer Liste', async () => {
  const fake = makeFake({ docs: makeDocs(51), employees: EMPS })
  const r = await admin(fake, 7)
  assert.deepEqual([r.page, r.total, r.rows.length], [3, 51, 1])
  const empty = await admin(makeFake({ docs: [], employees: EMPS }), 4)
  assert.deepEqual([empty.page, empty.total, empty.rows.length], [1, 0, 0])
  // Variante „0 Zeilen mit count“ (anderes PostgREST-Verhalten)
  const zero = { from: () => { const b = { select: () => b, eq: () => b, order: () => b, range(a) { b.a = a; return b }, then: (res) => res(b.a >= 30 ? { data: [], count: 30, error: null } : { data: [{ id: 'x' }], count: 30, error: null }) }; return b } }
  const z = await loadDocumentsPage(zero, { isAdmin: true, page: 3 })
  assert.deepEqual([z.page, z.total, z.rows.length], [2, 30, 1])
})

test('Fehler bleiben Fehler (keine stille leere Liste)', async () => {
  const fake = makeFake({ docs: makeDocs(5), employees: EMPS }); fake.db.failNext = 1
  const r = await admin(fake, 1)
  assert.ok(r.error); assert.equal(r.rows, undefined)
})

test('Mitarbeiter: immer eq(eigene employee_id), KEIN Embed (keine Namen), Admin-Filter werden ignoriert; ohne Zuordnung keine Abfrage', async () => {
  const docs = makeDocs(80), fake = makeFake({ docs, employees: EMPS, role: 'employee', ownEmployeeId: 'emp-3' })
  const r = await loadDocumentsPage(fake.client, { isAdmin: false, ownEmployeeId: 'emp-3', filters: { employeeId: 'emp-1', year: '2025' }, page: 1 })
  const q = fake.db.log.at(-1)
  assert.deepEqual(q.eq, [['employee_id', 'emp-3']]); assert.equal(q.cols, DOC_COLUMNS); assert.doesNotMatch(q.cols, /employees|uploaded_by/)
  assert.equal(r.total, 16); assert.ok(r.rows.every(d => d.employee_id === 'emp-3' && !('employees' in d)))
  const before = fake.db.log.length
  const none = await loadDocumentsPage(fake.client, { isAdmin: false, ownEmployeeId: null, page: 1 })
  assert.deepEqual(none, { rows: [], total: 0, page: 1 }); assert.equal(fake.db.log.length, before)
  // Auch eine manipulierte Abfrage auf fremde IDs liefert nur, was RLS freigibt (hier nachgebildet; echt: tests/db)
  const forged = await documentsQuery(fake.client, { isAdmin: true, filters: { employeeId: 'emp-1' }, page: 1 })
  assert.deepEqual([forged.count, forged.data.length], [0, 0])
})

test('i18n DE/EN/BN: neue Texte vollständig, Platzhalter gleich, BN in Bangla-Schrift mit lateinischen Ziffern', () => {
  const keys = ['payrollDocs.allEmployees', 'payrollDocs.allMonths', 'payrollDocs.allYears', 'payrollDocs.filteredTitle', 'payrollDocs.loadFailed', 'payrollDocs.noMatches', 'payrollDocs.pageOf', 'payrollDocs.pagination']
  const ph = s => (s.match(/\{p\d\}/g) || []).sort().join()
  for (const k of keys) {
    assert.ok(de[k] && en[k] && bn[k], k); assert.notEqual(de[k], en[k], k)
    assert.equal(ph(en[k]), ph(de[k]), k); assert.equal(ph(bn[k]), ph(de[k]), k)
    assert.match(bn[k], /[ঀ-৿]/, k); assert.doesNotMatch(bn[k], /[০-৯]/, k)
  }
  assert.equal(de['payrollDocs.pageOf'], 'Seite {p1} von {p2}'); assert.equal(en['payrollDocs.pageOf'], 'Page {p1} of {p2}')
  assert.equal(de['a11y.previous'], 'Zurück'); assert.equal(de['a11y.next'], 'Weiter')
})

test('Unverändert: Upload-Jahre (Vorjahr/aktuell/nächstes), Signed URLs 120/60 s, Storage-Pfad, keine Migration/Payroll-Änderung', () => {
  const s = readFileSync('src/pages/PayrollDocuments.jsx', 'utf8')
  assert.match(s, /\{\[now\.getFullYear\(\)-1, now\.getFullYear\(\), now\.getFullYear\(\)\+1\]\.map\(y => <option key=\{y\}>\{y\}<\/option>\)\}/)
  assert.match(s, /createSignedUrl\(doc\.file_path, 120\)/); assert.match(s, /createSignedUrl\(doc\.file_path, 60, \{ download: filename \}\)/)
  assert.match(s, /const filePath = `\$\{selEmp\}\/\$\{selYear\}-\$\{monthPad\}-lohnabrechnung\.pdf`/)
  assert.doesNotMatch(s, /\.range\(|from\('payroll_documents'\)\.select\('\*/, 'Liste nur über src/lib/payrollDocuments.js')
  assert.doesNotMatch(readFileSync('src/lib/payrollDocuments.js', 'utf8'), /service_role|SERVICE_ROLE|rpc\(|storage/)
})

// ── Teil 2: echte Seite im Browser ──
const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => existsSync(p))
const SKIP = CHROME ? null : 'kein Chrome/Chromium gefunden (CHROME_BIN setzen)'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let dir, proc, page = null, HARNESS_ERR = null

const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import { ProfileContext } from ${JSON.stringify(resolve('src/context/ProfileContext.jsx'))}
import PayrollDocuments from ${JSON.stringify(resolve('src/pages/PayrollDocuments.jsx'))}
${FAKE_SRC}
const root = createRoot(document.getElementById('app'))
let k = 0
window.confirm = () => true
window.__mount = (opts) => {
  const fake = makeFake(opts); window.__db = fake.db; window.__sb.current = fake.client
  const profile = { id: 'user-1', role: opts.role, employee_id: opts.ownEmployeeId || null }
  root.render(<LocaleProvider><ProfileContext.Provider key={++k} value={{ isAdmin: opts.role === 'admin', profile }}><div className="main-content"><PayrollDocuments /></div></ProfileContext.Provider></LocaleProvider>)
}`
const SUPABASE_STUB = `window.__sb = window.__sb || { current: null }
export const supabase = new Proxy({}, { get: (_, k) => window.__sb.current[k] })`

async function openPage(file) {
  let id = 0; const pending = new Map()
  const tl = await (await fetch(`http://127.0.0.1:${proc.port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(tl.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) } }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text); return x.result.value }
  await send('Page.enable'); await send('Page.navigate', { url: pathToFileURL(file).href }); await sleep(600)
  const device = async mobile => {
    await send('Emulation.setDeviceMetricsOverride', mobile ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: mobile ? 'coarse' : 'fine' }] })
    await sleep(50)
  }
  const settle = async () => { for (let i = 0; i < 100; i++) { if (await ev(`!!document.querySelector('.card-title') && !document.querySelector('[aria-busy="true"]')`)) return sleep(30); await sleep(20) } throw new Error('Seite lädt nicht') }
  const mount = async (opts) => { await ev(`window.__mount(${JSON.stringify(opts)})`); await settle() }
  const state = () => ev(`(() => {
    const cards = [...document.querySelectorAll('.card')], list = cards[cards.length - 1]
    const pager = list.querySelector('nav.pager'), btn = re => pager && [...pager.querySelectorAll('button')].find(b => re.test(b.innerText))
    return { title: list.querySelector('.card-title').innerText.trim(), status: pager?.querySelector('.pager-status').innerText.trim() ?? null,
      prevDisabled: btn(/Zurück/)?.disabled ?? null, nextDisabled: btn(/Weiter/)?.disabled ?? null,
      files: [...list.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].find(td => td.innerText.includes('.pdf'))?.innerText.replace('📄', '').trim()),
      names: [...list.querySelectorAll('tbody tr td:first-child strong')].map(s => s.innerText.trim()),
      empty: list.querySelector('.empty-state')?.innerText.trim() ?? null, error: list.querySelector('[role=alert]')?.innerText.trim() ?? null,
      filters: !!list.querySelector('.doc-filters') }
  })()`)
  const click = async (re, scope = 'nav.pager') => { const ok = await ev(`(() => { const b = [...document.querySelectorAll('${scope} button')].find(b => ${re}.test(b.innerText)); if (!b || b.disabled) return false; b.click(); return true })()`); await settle(); return ok }
  const select = async (id, v) => { await ev(`(() => { const s = document.getElementById('${id}'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(v)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`); await settle() }
  const lastQuery = () => ev(`window.__db.log.filter(q => q.table === 'payroll_documents' && q.count).at(-1)`)
  return { ev, send, device, mount, state, click, select, settle, lastQuery, close: () => ws.close() }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-payroll-docs-'))
  try {
    const esbuild = await import('esbuild')
    const stub = { name: 'supabase-stub', setup(b) { b.onResolve({ filter: /lib\/supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: SUPABASE_STUB, loader: 'js' })) } }
    const js = (await esbuild.build({ stdin: { contents: ENTRY, loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [stub], define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"' }, logLevel: 'silent' })).outputFiles[0].text
    const css = readFileSync('src/index.css', 'utf8')
    writeFileSync(join(dir, 'p.html'), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de') } catch {}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    page = await openPage(join(dir, 'p.html'))
    await page.device(false)
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { try { page?.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async (mobile = false) => { assert.ok(page, `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await page.device(mobile); return page }
const files = (docs, from, to) => newestFirst(docs).slice(from, to).map(d => d.file_name)
const ADMIN = n => ({ docs: makeDocs(n), employees: EMPS, role: 'admin' })

test('Seite: 0 / 1 / 25 Dokumente – exakte Anzahl, keine Blätter-Leiste', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.mount(ADMIN(0)); let s = await p.state()
  assert.equal(s.title, 'Alle Lohnabrechnungen (0)'); assert.equal(s.status, null); assert.match(s.empty, /Noch keine Lohnabrechnungen hochgeladen/)
  await p.mount(ADMIN(1)); s = await p.state()
  assert.equal(s.title, 'Alle Lohnabrechnungen (1)'); assert.equal(s.status, null); assert.deepEqual(s.files, files(makeDocs(1), 0, 1))
  await p.mount(ADMIN(25)); s = await p.state()
  assert.equal(s.title, 'Alle Lohnabrechnungen (25)'); assert.equal(s.status, null); assert.equal(s.files.length, 25)
})

test('Seite: 26 Dokumente – Seite 1 von 2, Zurück gesperrt; Weiter → Seite 2 mit 1 Dokument, Weiter gesperrt; Zurück', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P(), docs = makeDocs(26)
  await p.mount(ADMIN(26)); let s = await p.state()
  assert.deepEqual([s.title, s.status, s.prevDisabled, s.nextDisabled, s.files.length], ['Alle Lohnabrechnungen (26)', 'Seite 1 von 2', true, false, 25])
  assert.deepEqual(s.files, files(docs, 0, 25))
  assert.equal(await p.click(/Zurück/), false, 'Zurück auf Seite 1 nicht bedienbar')
  assert.equal(await p.click(/Weiter/), true); s = await p.state()
  assert.deepEqual([s.status, s.prevDisabled, s.nextDisabled, s.files], ['Seite 2 von 2', false, true, files(docs, 25, 26)])
  assert.deepEqual((await p.lastQuery()).range, [25, 49])
  assert.equal(await p.click(/Weiter/), false, 'Weiter auf letzter Seite nicht bedienbar')
  await p.click(/Zurück/); s = await p.state()
  assert.deepEqual([s.status, s.files], ['Seite 1 von 2', files(docs, 0, 25)])
})

test('Seite: 50 / 51 Dokumente – Seiten 1, 2, 3, neueste zuerst, Grenzen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.mount(ADMIN(50)); let s = await p.state()
  assert.equal(s.status, 'Seite 1 von 2'); await p.click(/Weiter/); s = await p.state()
  assert.deepEqual([s.status, s.files.length, s.nextDisabled], ['Seite 2 von 2', 25, true])
  const docs = makeDocs(51)
  await p.mount(ADMIN(51)); s = await p.state()
  assert.deepEqual([s.title, s.status, s.files], ['Alle Lohnabrechnungen (51)', 'Seite 1 von 3', files(docs, 0, 25)])
  await p.click(/Weiter/); s = await p.state(); assert.deepEqual([s.status, s.files, s.prevDisabled, s.nextDisabled], ['Seite 2 von 3', files(docs, 25, 50), false, false])
  await p.click(/Weiter/); s = await p.state(); assert.deepEqual([s.status, s.files, s.nextDisabled], ['Seite 3 von 3', files(docs, 50, 51), true])
  // erste Zeile ist die neueste Abrechnung (09/2026), letzte die älteste
  await p.click(/Zurück/); await p.click(/Zurück/)
  assert.match(await p.ev(`document.querySelector('tbody tr').innerText`), /September\s+2026/)
})

test('Filter: Mitarbeiter/Monat/Jahr serverseitig, Filterwechsel setzt Seite 1, Anzahl = Treffer, Zurücksetzen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P(), docs = makeDocs(300)
  await p.mount({ docs, employees: EMPS, role: 'admin' })
  await p.click(/Weiter/); await p.click(/Weiter/)
  assert.equal((await p.state()).status, 'Seite 3 von 12')
  await p.select('doc-filter-emp', 'emp-2'); let s = await p.state()
  const e2 = docs.filter(d => d.employee_id === 'emp-2')
  assert.deepEqual([s.title, s.status, s.files], [`Gefundene Lohnabrechnungen (${e2.length})`, 'Seite 1 von 3', files(e2, 0, 25)])
  assert.ok(s.names.every(n => n === 'Vorname2 Nachname2'))
  let q = await p.lastQuery(); assert.deepEqual([q.eq, q.range], [[['employee_id', 'emp-2']], [0, 24]])
  await p.click(/Weiter/); assert.equal((await p.state()).status, 'Seite 2 von 3')
  await p.select('doc-filter-year', '2025'); s = await p.state()
  const e2y = e2.filter(d => d.year === 2025)
  assert.deepEqual([s.title, s.status, s.files], [`Gefundene Lohnabrechnungen (${e2y.length})`, null, files(e2y, 0, 25)])
  q = await p.lastQuery(); assert.deepEqual(q.eq, [['employee_id', 'emp-2'], ['year', 2025]])
  await p.select('doc-filter-month', '3'); s = await p.state()
  assert.deepEqual([s.title, s.files], ['Gefundene Lohnabrechnungen (1)', files(e2y.filter(d => d.month === 3), 0, 1)])
  await p.select('doc-filter-year', String(new Date().getFullYear() + 1)); s = await p.state()   // Jahr ohne Abrechnungen
  assert.equal(s.title, 'Gefundene Lohnabrechnungen (0)'); assert.match(s.empty, /Keine Lohnabrechnungen für diese Auswahl/)
  await p.click(/Filter zurücksetzen/, '.empty-state'); s = await p.state()
  assert.deepEqual([s.title, s.status], ['Alle Lohnabrechnungen (300)', 'Seite 1 von 12'])
  assert.deepEqual(await p.ev(`['doc-filter-emp','doc-filter-month','doc-filter-year'].map(id => document.getElementById(id).value)`), ['', '', ''])
  // Filterliste enthält auch ausgeschiedene Personen (archiviert markiert); Jahre reichen bis zum ältesten Dokument
  assert.match(await p.ev(`document.getElementById('doc-filter-emp').innerText`), /Vorname5 Nachname5/)
  const years = await p.ev(`[...document.getElementById('doc-filter-year').options].map(o => o.value).filter(Boolean).map(Number)`)
  assert.equal(Math.min(...years), Math.min(...docs.map(d => d.year))); assert.equal(Math.max(...years), new Date().getFullYear() + 1)
})

test('Upload während Pagination: Anzahl/Liste neu vom Server, Seite und Filter bleiben', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.mount(ADMIN(51)); await p.click(/Weiter/)
  const year = new Date().getFullYear() + 1
  await p.ev(`(() => {
    const [emp, month, yearSel] = document.querySelectorAll('.card .card-body select')
    const set = (s, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })) }
    set(emp, 'emp-1'); set(month, '1'); set(yearSel, '${year}')
  })()`)
  await sleep(50)
  await p.ev(`(() => { const i = document.querySelector('input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4'], 'neu.pdf', { type: 'application/pdf' })); i.files = dt.files })()`)
  await p.click(/Hochladen/, '.card-body'); await sleep(100); await p.settle()
  let s = await p.state()
  assert.deepEqual([s.title, s.status, s.files.length], ['Alle Lohnabrechnungen (52)', 'Seite 2 von 3', 25])
  assert.equal(await p.ev(`window.__db.docs.length`), 52)
  await p.click(/Zurück/); s = await p.state()
  assert.equal(s.files[0], 'neu.pdf', 'neueste Abrechnung (Jan. nächstes Jahr) steht ganz oben')
})

test('Löschen auf mittlerer Seite: Seite bleibt, rückt nach; letztes Dokument der letzten Seite → vorherige Seite', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P(), docs = makeDocs(51)
  await p.mount(ADMIN(51)); await p.click(/Weiter/)
  const victim = files(docs, 25, 26)[0]
  assert.equal((await p.state()).files[0], victim)
  await p.click(/🗑/, 'tbody tr')   // erste Zeile der Seite 2
  let s = await p.state()
  const rest = newestFirst(docs).filter(d => d.file_name !== victim)
  assert.deepEqual([s.title, s.status, s.files], ['Alle Lohnabrechnungen (50)', 'Seite 2 von 2', rest.slice(25, 50).map(d => d.file_name)])
  assert.ok(!s.files.includes(victim)); assert.equal(s.files.at(-1), files(docs, 50, 51)[0], 'erstes Dokument der früheren Seite 3 rückt nach')
  // Letztes Element der letzten Seite
  await p.mount(ADMIN(51)); await p.click(/Weiter/); await p.click(/Weiter/)
  s = await p.state(); assert.deepEqual([s.status, s.files.length], ['Seite 3 von 3', 1])
  const n0 = await p.ev(`window.__db.log.filter(q => q.table === 'payroll_documents' && q.count).length`)
  await p.click(/🗑/, 'tbody tr'); s = await p.state()
  assert.equal(await p.ev(`window.__db.log.filter(q => q.table === 'payroll_documents' && q.count).length`) - n0, 1, 'genau eine Abfrage: direkt die vorherige Seite')
  assert.deepEqual([s.title, s.status, s.files, s.nextDisabled], ['Alle Lohnabrechnungen (50)', 'Seite 2 von 2', files(docs, 25, 50), true])
  const q = await p.lastQuery(); assert.deepEqual(q.range, [25, 49], 'direkt die vorherige Seite geladen (kein 416-Umweg)')
})

test('Fremd gelöscht (anderer Admin): Blättern auf nicht mehr vorhandene Seite landet auf letzter gültiger Seite', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.mount(ADMIN(51)); await p.click(/Weiter/)
  await p.ev(`window.__db.docs.splice(0, 26)`)   // nur noch 25 → es gibt keine Seite 3 mehr
  await p.click(/Weiter/); const s = await p.state()
  assert.deepEqual([s.title, s.status, s.files.length], ['Alle Lohnabrechnungen (25)', null, 25])
})

test('Ladefehler: sichtbarer Hinweis + Erneut versuchen (keine leere „keine Abrechnungen“-Liste)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.mount(ADMIN(30)); await p.ev(`window.__db.failNext = 1`)
  await p.click(/Weiter/); let s = await p.state()
  assert.match(s.error, /konnten nicht geladen werden/); assert.equal(s.empty, null); assert.equal(s.status, 'Seite 1 von 2', 'alte Seite bleibt sichtbar')
  await p.click(/Erneut versuchen/, '[role=alert]'); s = await p.state()
  assert.deepEqual([s.error, s.status, s.files.length], [null, 'Seite 2 von 2', 5])
})

test('Veraltete Antwort (langsame Seite 2) überschreibt nicht den neueren Filter', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P(), docs = makeDocs(300)
  await p.mount({ docs, employees: EMPS, role: 'admin' })
  await p.ev(`(() => { let slow = true; window.__db.delay = q => q.range && q.range[0] === 25 && slow ? (slow = false, 400) : 0 })()`)
  await p.ev(`[...document.querySelectorAll('nav.pager button')].find(b => /Weiter/.test(b.innerText)).click()`)
  await p.select('doc-filter-emp', 'emp-3')
  await sleep(600); await p.settle()
  const s = await p.state(), e3 = docs.filter(d => d.employee_id === 'emp-3')
  assert.deepEqual([s.title, s.status, s.files], [`Gefundene Lohnabrechnungen (${e3.length})`, 'Seite 1 von 3', files(e3, 0, 25)])
})

test('Mitarbeiter: nur eigene Abrechnungen, eigene Anzahl, keine Filter, keine Namen/fremden Daten im Browser; Blättern geht', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P(), docs = makeDocs(200)
  await p.mount({ docs, employees: EMPS, role: 'employee', ownEmployeeId: 'emp-4' })
  const mine = docs.filter(d => d.employee_id === 'emp-4')
  let s = await p.state()
  assert.deepEqual([s.title, s.status, s.filters, s.files], [`Meine Lohnabrechnungen (${mine.length})`, 'Seite 1 von 2', false, files(mine, 0, 25)])
  await p.click(/Weiter/); s = await p.state(); assert.deepEqual(s.files, files(mine, 25, 50))
  const log = await p.ev(`window.__db.log`)
  assert.ok(!log.some(q => q.table === 'employees'), 'keine Mitarbeiterliste geladen')
  for (const q of log.filter(q => q.table === 'payroll_documents')) {
    assert.deepEqual(q.eq, [['employee_id', 'emp-4']]); assert.doesNotMatch(q.cols, /employees|uploaded_by|\*/)
  }
  assert.doesNotMatch(await p.ev(`document.body.innerText`), /Nachname[1235]|Hochladen|🗑/)
})

test('Admin: berechtigte Gesamtliste über alle Personen inkl. Namen', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P()
  await p.mount(ADMIN(12)); const s = await p.state()
  assert.equal(s.title, 'Alle Lohnabrechnungen (12)')
  assert.deepEqual([...new Set(s.names)].sort(), EMPS.map(e => `${e.first_name} ${e.last_name}`).sort())
})

test('Mobile 390 px Touch: kein Querscrollen, Blätter-Buttons ≥ 44 px, Filter volle Breite, Zeilen gestapelt', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const locale of ['de', 'en', 'bn']) {
    const p = await P(true)
    await p.ev(`localStorage.setItem('cafe-buur-locale', '${locale}'); location.reload()`).catch(() => {}); await sleep(700)
    await p.mount(ADMIN(1000)); assert.equal(await p.click(/Weiter|Next|পরের/), true)   // Seite 2 → beide Buttons aktiv
    const m = await p.ev(`(() => {
      const pager = document.querySelector('nav.pager'), r = e => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height } }
      const btns = [...pager.querySelectorAll('button')].map(b => ({ w: r(b).width, h: r(b).height, l: r(b).left, ri: r(b).right }))
      const sels = ['doc-filter-emp', 'doc-filter-month', 'doc-filter-year'].map(id => r(document.getElementById(id)))
      const tr = document.querySelector('tbody tr'), del = document.querySelector('tbody .btn-danger')
      return { vw: innerWidth, sw: document.documentElement.scrollWidth, btns, status: pager.querySelector('.pager-status').innerText,
        statusR: r(pager.querySelector('.pager-status')), pagerR: r(pager), sels: sels.map(s => ({ l: s.left, w: s.width })),
        trDisplay: getComputedStyle(tr).display, theadHidden: getComputedStyle(document.querySelector('thead')).display === 'none', del: { w: r(del).width, h: r(del).height } }
    })()`)
    assert.ok(m.sw <= m.vw, `${locale}: kein horizontales Überlaufen (${m.sw} > ${m.vw})`)
    for (const b of m.btns) { assert.ok(b.h >= 44 && b.w >= 44, `${locale}: Touch-Ziel ${b.w}×${b.h}`); assert.ok(b.l >= 0 && b.ri <= m.vw, `${locale}: Button sichtbar`) }
    assert.ok(m.btns[0].ri <= m.statusR.left && m.statusR.right <= m.btns[1].l, `${locale}: Zurück | Status | Weiter nebeneinander, überlappungsfrei ${JSON.stringify([m.btns, m.statusR, m.pagerR])}`)
    assert.match(m.status, /2/); assert.match(m.status, /40/)
    assert.ok(m.del.h >= 44 && m.del.w >= 44, `${locale}: Löschen-Touch-Ziel`)
    assert.ok(m.sels.every(s => s.w > m.vw * 0.7), `${locale}: Filter volle Breite`)
    assert.ok(m.sels.every(s => s.l >= 0 && s.l + s.w <= m.vw), `${locale}: Filter ragen nicht über den Rand ${JSON.stringify(m.sels)}`)
    assert.equal(m.trDisplay, 'block'); assert.ok(m.theadHidden)
  }
  await page.ev(`localStorage.setItem('cafe-buur-locale', 'de'); location.reload()`).catch(() => {}); await sleep(700)
  await page.device(false)
})
