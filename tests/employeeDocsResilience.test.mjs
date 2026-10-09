// Resilience Batch 2e (Personalakte, Employees.jsx): 2e-1 unklarer DB-Eintrag ≠ fehlgeschlagen (nie löschen, gegenprüfen),
// 2e-2 Doppeltipp/parallele Uploads, 2e-3 Listen-Ladefehler + nur jüngste Liste der geöffneten Akte, 2e-4 Auswahl beim
// Mitarbeiterwechsel verwerfen, 2e-5 10 MB (= Bucket-Grenze in Production). Teil 1: Quelltext/i18n. Teil 2: ECHTE Seite
// Employees.jsx in Headless Chrome gegen nachgebildetes Storage + PostgREST (nur supabase ersetzt) – mit Gegenproben (5ded527).
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = '5ded527'   // Stand vor Batch 2e
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const EMPTY_TXT = de['ui.0f11c7238346'], OK_TXT = 'Dokument hochgeladen'

// ── Teil 1 ──
test('DE/EN/BN: neue Texte vollständig, gleiche Platzhalter, BN in Bangla; Größenangabe überall 10 MB (Bucket-Grenze)', () => {
  const ph = s => (s.match(/\{\w+\}/g) || []).sort().join()
  for (const k of ['employees.docUnclear', 'employees.docsLoadFailed', 'employees.docsRetry']) {
    assert.ok(de[k] && en[k] && bn[k], k); assert.equal(ph(en[k]), ph(de[k]), k); assert.equal(ph(bn[k]), ph(de[k]), k)
    assert.match(bn[k], /[ঀ-৿]/, k); assert.doesNotMatch(bn[k], /[০-৯]/, k)
  }
  for (const k of ['ui.4c2aef50a6c1', 'ui.aa60f073a46e']) for (const c of [de, en, bn]) { assert.match(c[k], /10 MB/, k); assert.doesNotMatch(c[k], /20 MB/, k) }
  assert.doesNotMatch(de['employees.docUnclear'], /hochgeladen\b(?! werden)|gespeichert\.$/, 'keine Erfolgs-/Fehlschlag-Behauptung')
})

function checkUpload(src) {
  const up = src.slice(src.indexOf('  async function uploadDoc() {'), src.indexOf('  async function openDoc(doc) {'))
  assert.match(up, /if \(!docGuard\.begin\(\)\) return/); assert.match(up, /finally \{ docGuard\.end\(\); setDocUploading\(false\) \}/)
  const rm = up.indexOf(".remove([filePath])")
  assert.ok(rm > 0 && up.lastIndexOf('if (dbErr && !isTransientFailure(dbStatus)) {', rm) > up.lastIndexOf('.insert([{', rm), 'Löschen nur nach eindeutiger Ablehnung')
  assert.equal((up.match(/\.remove\(/g) || []).length, 1, 'genau eine Bereinigung, nur des neuen Pfads')
  assert.match(up, /const filePath = `\$\{form\.id\}\/\$\{docForm\.document_type\}\/\$\{docId\}\/\$\{safeName\}`/, 'eindeutiger Pfad je Upload')
  assert.match(up, /upsert:false/)
  assert.match(up, /const list = await fetchDocs\(employeeId\)\n\s+if \(!list\?\.some\(d => d\.id === docId\)\)/, 'unklar → gegenprüfen')
  assert.doesNotMatch(up, /setTimeout|retry/i, 'keine automatische Wiederholung')
  const fd = src.slice(src.indexOf('  async function fetchDocs(employeeId) {'), src.indexOf('  function resetDocForm() {'))
  assert.match(fd, /if \(shown && my === docsSeq\.current && docsFor\.current === employeeId\)/)
  assert.match(fd, /if \(error\) setDocsError\(true\)/)
  assert.match(src, /if \(file\.size > 10485760\)/)
  assert.match(src, /function openEdit\(emp\) \{ switchDocsTo\(emp\.id\);/)
}
test('Employees.jsx: Sperre, Löschen nur nach eindeutiger Ablehnung, Gegenprüfung, Listen-Sequenz, 10 MB', () => checkUpload(read('src/pages/Employees.jsx')))
test('Gegenprobe Quelltext: Stand vor 2e erfüllt die Prüfung nicht', () => assert.throws(() => checkUpload(atBefore('src/pages/Employees.jsx'))))
test('Unverändert: Supabase-Aufrufe (Text + Reihenfolge), gespeicherte Felder, Archivieren/Öffnen/Herunterladen', () => {
  const calls = s => s.match(/supabase[\s\S]{0,4}?\.(from|rpc|storage)[^\n]*/g)
  assert.deepEqual(calls(read('src/pages/Employees.jsx')), calls(atBefore('src/pages/Employees.jsx')))
  const fn = (s, n) => s.slice(s.indexOf(`  async function ${n}(`), s.indexOf('\n  }\n', s.indexOf(`  async function ${n}(`)))
  for (const n of ['openDoc', 'downloadDoc', 'archiveDoc', 'handleSave', 'doDeactivate', 'doReactivate']) assert.equal(fn(read('src/pages/Employees.jsx'), n), fn(atBefore('src/pages/Employees.jsx'), n), n)
  const ins = s => s.slice(s.indexOf(".insert([{\n        id: docId"), s.indexOf('}])', s.indexOf(".insert([{\n        id: docId")))
  assert.equal(ins(read('src/pages/Employees.jsx')), ins(atBefore('src/pages/Employees.jsx')), 'gleiche Felder')
})

// ── Teil 2: echte Seite im Browser ──
const FAKE = String.raw`
function makeFake() {
  const db = { log: [], pending: 0, delay: {}, fail: {}, insertMode: 'ok', storageMode: 'ok',
    employees: [{ id: 'eA', first_name: 'Anna', last_name: 'Alpha', is_active: true }, { id: 'eB', first_name: 'Ben', last_name: 'Beta', is_active: true }],
    docs: [{ id: 'dA1', employee_id: 'eA', document_type: 'employment_contract', title: 'Vertrag Anna', file_path: 'eA/employment_contract/dA1/v.pdf', file_name: 'v.pdf', file_size: 1000, is_active: true, uploaded_at: '2026-01-01T10:00:00Z' },
           { id: 'dB1', employee_id: 'eB', document_type: 'employment_contract', title: 'Vertrag Ben', file_path: 'eB/employment_contract/dB1/v.pdf', file_name: 'v.pdf', file_size: 1000, is_active: true, uploaded_at: '2026-01-01T10:00:00Z' }],
    files: ['eA/employment_contract/dA1/v.pdf', 'eB/employment_contract/dB1/v.pdf'] }
  const wait = (k, out) => { const d = typeof db.delay[k] === 'function' ? db.delay[k]() : (db.delay[k] || 0); db.pending++; return new Promise(r => setTimeout(r, d)).then(() => { db.pending--; return out }) }
  const eq = (q, k) => (q.f.find(x => x[0] === 'eq' && x[1] === k) || [])[2]
  function run(q) {
    if (q.table === 'employee_documents' && q.op === 'insert') {
      const row = q.rows[0]; db.log.push('insert:' + row.id)
      const m = db.insertMode
      if (m === 'reject') return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' }, status: 403 }
      if (m === 'conflict') return { data: null, error: { message: 'duplicate key', code: '23505' }, status: 409 }
      db.docs.push({ ...row })                                         // gespeichert …
      if (m === 'lostSaved') return { data: null, error: { message: 'AbortError: request-timeout-write', code: '' }, status: 0 }   // … Antwort verloren
      if (m === 'gateway') return { data: null, error: { message: 'Bad gateway', code: '' }, status: 502 }
      return { data: null, error: null, status: 201 }
    }
    if (q.table === 'employee_documents' && q.op === 'insertLostNotSaved') return null
    if (q.table === 'employee_documents') {
      const id = eq(q, 'employee_id'); db.log.push('docs:' + id)
      if (db.fail.docs === true || (typeof db.fail.docs === 'number' && db.fail.docs-- > 0)) return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }
      return { data: db.docs.filter(d => d.employee_id === id).map(d => ({ ...d })), error: null, status: 200 }
    }
    if (q.table === 'employees') return { data: db.employees.map(e => ({ ...e })), error: null, status: 200 }
    return { data: q.single ? null : [], error: null, status: 200 }
  }
  function builder(table) {
    const q = { table, op: 'select', f: [], single: false }
    const api = new Proxy({}, { get(_, m) {
      if (m === 'then') return (res, rej) => {
        let out
        if (table === 'employee_documents' && q.op === 'insert' && db.insertMode === 'lostNotSaved') { db.log.push('insert:' + q.rows[0].id); out = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 } }
        else out = run(q)
        return wait(table + ':' + q.op, out).then(res, rej)
      }
      if (m === 'insert') return rows => { q.op = 'insert'; q.rows = rows; return api }
      if (m === 'update') return () => { q.op = 'update'; return api }
      if (m === 'maybeSingle' || m === 'single') return () => { q.single = true; return api }
      return (...a) => { q.f.push([m, ...a]); return api }
    } })
    return api
  }
  const storage = { from: bucket => ({
    upload(path, file, opts) {
      db.log.push('upload:' + path + ':' + opts.upsert)
      const m = db.storageMode
      let out
      if (db.files.includes(path)) out = { data: null, error: { message: 'The resource already exists', statusCode: '409', status: 409 } }
      else if (m === 'reject') out = { data: null, error: { message: 'new row violates row-level security policy', statusCode: '403', status: 403 } }
      else if (m === 'unknown') { db.files.push(path); out = { data: null, error: { name: 'StorageUnknownError', message: 'Failed to fetch' } } }   // evtl. angekommen
      else { db.files.push(path); out = { data: { path }, error: null } }
      return wait('upload', out)
    },
    remove(paths) { db.log.push('remove:' + paths.join(',')); db.files = db.files.filter(f => !paths.includes(f)); return wait('remove', { data: [], error: null }) },
    createSignedUrl() { return Promise.resolve({ data: { signedUrl: 'about:blank' }, error: null }) },
  }) }
  const client = { from: builder, storage, rpc: () => Promise.resolve({ data: [], error: null }) }
  return { db, client }
}`
const STUB = `window.__sb = window.__sb || { current: null }
export const supabase = new Proxy({}, { get: (_, k) => window.__sb.current[k] })
export const getInitials = (a, b) => ((a || '')[0] || '') + ((b || '')[0] || '')
export const getAvatarColor = () => '#C2793A'
export const toLocalDateStr = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')`
const entry = which => `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { LocaleProvider } from ${JSON.stringify(resolve('src/context/LocaleContext.jsx'))}
import { ProfileContext } from ${JSON.stringify(resolve('src/context/ProfileContext.jsx'))}
import { DarkModeProvider } from ${JSON.stringify(resolve('src/context/DarkModeContext.jsx'))}
import { ToastProvider, clearToasts } from ${JSON.stringify(resolve('src/components/UI/Toast.jsx'))}
import { RefreshProvider } from ${JSON.stringify(resolve('src/context/RefreshContext.jsx'))}
import Employees from ${JSON.stringify(which)}
${FAKE}
const root = createRoot(document.getElementById('app'))
let k = 0
window.__mount = setup => {
  const f = makeFake(); window.__db = f.db; window.__sb.current = f.client; clearToasts()   // Meldungen früherer Szenarien entfernen
  if (setup) (new Function('db', setup))(f.db)
  root.render(<LocaleProvider><DarkModeProvider><ToastProvider><RefreshProvider><MemoryRouter><ProfileContext.Provider key={++k} value={{ isAdmin: true, isManager: false, profile: { id: 'u1', employee_id: null, first_name: 'Ad', last_name: 'Min' } }}><div className="main"><Employees /></div></ProfileContext.Provider></MemoryRouter></RefreshProvider></ToastProvider></DarkModeProvider></LocaleProvider>)
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
  const settle = async () => { let quiet = 0; for (let i = 0; i < 400; i++) { if (await ev('window.__db.pending') === 0) { if (++quiet >= 8) return } else quiet = 0; await sleep(25) } throw new Error('Seite lädt nicht') }
  const state = () => ev(`(() => { const m = document.querySelector('.modal-overlay')
    return { modal: !!m, modalText: m?.innerText ?? '', body: document.body.innerText, docsError: !!document.querySelector('[data-testid="docs-load-error"]'),
      selected: m ? (m.innerText.match(/✅ (\\S+\\.pdf)/) || [])[1] ?? null : null,
      uploadDisabled: [...(m?.querySelectorAll('button') || [])].find(b => b.innerText.includes('Dokument hochladen') || b.innerText.includes('hochgeladen…'))?.disabled ?? null,
      log: window.__db.log.slice(), files: window.__db.files.slice(), docs: window.__db.docs.map(d => [d.id, d.employee_id, d.file_path]) } })()`)
  const mount = async setup => { await ev(`window.__mount(${JSON.stringify(setup || '')}); true`); await sleep(80); await settle() }
  const openEdit = async name => { await ev(`(() => { const row = [...document.querySelectorAll('tr')].find(r => r.innerText.includes(${JSON.stringify(name)})); [...row.querySelectorAll('button')].find(b => b.innerText.includes('Bearbeiten')).click(); return true })()`); await sleep(60) }
  const close = async () => { await ev(`(() => { document.querySelector('.modal-overlay [aria-label="${de['a11y.close']}"]').click(); return true })()`); await sleep(60) }
  const pick = async (name, size = 2048) => { await ev(`(() => { const i = document.querySelector('.modal-overlay input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(${size})], ${JSON.stringify(name)}, { type: 'application/pdf' })); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true })()`); await sleep(80) }
  const uploadBtn = `[...document.querySelectorAll('.modal-overlay button')].find(b => b.innerText.includes('Dokument hochladen') || b.innerText.includes('Wird hochgeladen'))`
  const upload = async (times = 1) => { await ev(`(() => { const b = ${uploadBtn}; for (let i = 0; i < ${times}; i++) b.click(); return true })()`); await sleep(60) }
  return { ev, send, front, state, mount, settle, openEdit, close, pick, upload, ws }
}

before(async () => {
  if (!CHROME) return
  dir = mkdtempSync(join(tmpdir(), 'cafe-empdocs-'))
  try {
    const esbuild = await import('esbuild')
    const plugin = { name: 'stubs', setup(b) {
      b.onResolve({ filter: /(^|\/)supabase(\.js)?$/ }, () => ({ path: 'supabase-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
      b.onResolve({ filter: /^before:Employees$/ }, () => ({ path: 'Employees.before.jsx', namespace: 'before' }))
      b.onLoad({ filter: /.*/, namespace: 'before' }, () => ({ contents: atBefore('src/pages/Employees.jsx'), loader: 'jsx', resolveDir: resolve('src/pages') }))
    } }
    for (const [name, which] of [['now', resolve('src/pages/Employees.jsx')], ['before', 'before:Employees']]) {
      const js = (await esbuild.build({ stdin: { contents: entry(which), loader: 'jsx', resolveDir: resolve('.') }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [plugin],
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SUPABASE_URL': '"http://x"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"x"' }, logLevel: 'silent' })).outputFiles[0].text
      writeFileSync(join(dir, `${name}.html`), `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${read('src/index.css')}</style></head><body><div id="app"></div><script>try { localStorage.setItem('cafe-buur-locale', 'de') } catch {}</script><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`)
    }
    const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
    proc = { ch }
    for (let i = 0; i < 100 && !proc.port; i++) { await sleep(100); try { proc.port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { /* startet */ } }
    if (!proc.port) throw new Error('Chrome-DevTools-Port nicht gefunden')
    pages.now = await openPage(join(dir, 'now.html')); pages.before = await openPage(join(dir, 'before.html'))
  } catch (e) { HARNESS_ERR = e.message }
})
after(() => { for (const p of Object.values(pages)) try { p.ws.close() } catch { /* */ } proc?.ch.kill('SIGKILL'); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })
const P = async name => { assert.ok(pages[name], `Browser-Harness ohne Ergebnis: ${HARNESS_ERR}`); await pages[name].front(); return pages[name] }
const EXISTING = ['eA/employment_contract/dA1/v.pdf', 'eB/employment_contract/dB1/v.pdf']
const uploads = s => s.log.filter(l => l.startsWith('upload:')), removes = s => s.log.filter(l => l.startsWith('remove:')), inserts = s => s.log.filter(l => l.startsWith('insert:'))
async function uploadScenario(p, setup, name = 'neu.pdf') {
  await p.mount(setup); await p.openEdit('Anna'); await p.settle()
  await p.pick(name); await p.upload(); await sleep(150); await p.settle(); await sleep(100)
  return p.state()
}
const newPath = s => (uploads(s)[0] || '').replace(/^upload:/, '').replace(/:false$/, '')

test('Browser: erfolgreicher Upload → genau ein Upload (upsert:false, eigener Pfad), ein Eintrag, nichts gelöscht, Erfolg, Formular leer', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await uploadScenario(await P('now'), '')
  assert.equal(uploads(s).length, 1); assert.match(uploads(s)[0], /^upload:eA\/employment_contract\/[0-9a-f-]{36}\/neu\.pdf:false$/)
  assert.equal(inserts(s).length, 1); assert.deepEqual(removes(s), [])
  assert.ok(s.files.includes(newPath(s))); for (const f of EXISTING) assert.ok(s.files.includes(f))
  assert.ok(s.body.includes(OK_TXT)); assert.equal(s.selected, null); assert.ok(s.modalText.includes('Vertrag Anna'))
})

test('Browser: Storage lehnt ab / Storage-Antwort unklar → kein Eintrag, keine Erfolgsmeldung, kein Löschen bestehender Dateien', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const mode of ['reject', 'unknown']) {
    const s = await uploadScenario(await P('now'), `db.storageMode = '${mode}'`)
    assert.equal(inserts(s).length, 0, mode); assert.deepEqual(removes(s), [], mode); assert.ok(!s.body.includes(OK_TXT), mode)
    assert.ok(s.body.includes('Upload fehlgeschlagen'), mode); for (const f of EXISTING) assert.ok(s.files.includes(f), mode)
    assert.equal(s.selected, 'neu.pdf', `${mode}: Auswahl bleibt für einen bewussten neuen Versuch`)
  }
})

test('Browser: DB lehnt eindeutig ab (RLS 403 / Konflikt 409) → NUR der soeben erzeugte Pfad wird bereinigt, Fehlermeldung', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const mode of ['reject', 'conflict']) {
    const s = await uploadScenario(await P('now'), `db.insertMode = '${mode}'`)
    assert.deepEqual(removes(s), ['remove:' + newPath(s)], mode); assert.ok(!s.files.includes(newPath(s)), mode)
    for (const f of EXISTING) assert.ok(s.files.includes(f), `${mode}: bestehende Datei unangetastet`)
    assert.ok(s.body.includes('Dokument konnte nicht gespeichert werden'), mode); assert.ok(!s.body.includes(OK_TXT), mode)
  }
})

test('Browser 2e-1: DB-Antwort verloren, Eintrag GESPEICHERT (Timeout / 502) → nichts gelöscht, Gegenprüfung findet ihn → Erfolg', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const mode of ['lostSaved', 'gateway']) {
    const s = await uploadScenario(await P('now'), `db.insertMode = '${mode}'`)
    assert.deepEqual(removes(s), [], `${mode}: nie löschen`); assert.ok(s.files.includes(newPath(s)), mode)
    const row = s.docs.find(d => d[2] === newPath(s)); assert.ok(row, mode)
    assert.ok(s.body.includes(OK_TXT), `${mode}: nach Gegenprüfung Erfolg`); assert.ok(s.log.filter(l => l === 'docs:eA').length >= 2, 'Liste gegengeprüft')
    assert.equal(uploads(s).length, 1, 'keine automatische Wiederholung'); assert.equal(inserts(s).length, 1)
  }
})
test('Gegenprobe Browser 2e-1: Stand vor 2e löscht die Datei trotz gespeichertem Eintrag → Dokument ohne Datei', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await uploadScenario(await P('before'), `db.insertMode = 'lostSaved'`)
  assert.equal(removes(s).length, 1); assert.ok(s.docs.some(d => d[2] === newPath(s)) && !s.files.includes(newPath(s)), 'Eintrag ohne Datei')
  assert.ok(s.body.includes('Dokument konnte nicht gespeichert werden'), 'falsche Fehlermeldung')
})

test('Browser 2e-1: DB-Antwort verloren, Eintrag NICHT gespeichert → nichts gelöscht, Hinweis „nicht bestätigt“, keine Erfolgsmeldung, Auswahl bleibt', async t => {
  if (SKIP) return t.skip(SKIP)
  const s = await uploadScenario(await P('now'), `db.insertMode = 'lostNotSaved'`)
  assert.deepEqual(removes(s), []); assert.ok(!s.body.includes(OK_TXT))
  assert.ok(s.body.includes('konnte nicht bestätigt werden')); assert.equal(s.selected, 'neu.pdf')
  assert.equal(uploads(s).length, 1); assert.equal(inserts(s).length, 1, 'keine Wiederholung')
})

test('Browser 2e-1: Gegenprüfung selbst scheitert → nichts gelöscht, Hinweis „nicht bestätigt“, Liste zeigt Ladefehler statt „keine Dokumente“', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now')
  await p.mount(`db.insertMode = 'lostSaved'`); await p.openEdit('Anna'); await p.settle()
  await p.pick('neu.pdf'); await p.ev(`window.__db.fail.docs = true; true`); await p.upload(); await sleep(150); await p.settle(); await sleep(100)
  const s = await p.state()
  assert.deepEqual(removes(s), []); assert.ok(!s.body.includes(OK_TXT)); assert.ok(s.body.includes('konnte nicht bestätigt werden'))
  assert.ok(s.docsError); assert.ok(!s.modalText.includes(EMPTY_TXT)); assert.ok(s.modalText.includes('Vertrag Anna'), 'letzter Stand derselben Akte bleibt')
})

test('Browser 2e-2: Doppeltipp → genau EIN Upload und EIN Eintrag (vorher: zwei)', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const [name, n] of [['now', 1], ['before', 2]]) {
    const p = await P(name); await p.mount(`db.delay.upload = 200`); await p.openEdit('Anna'); await p.settle()
    await p.pick('neu.pdf'); await p.upload(2); await sleep(300); await p.settle(); await sleep(100)
    const s = await p.state()
    assert.equal(uploads(s).length, n, `${name}: Uploads`); assert.equal(inserts(s).length, n, `${name}: Einträge`)
  }
})

test('Browser 2e-2/2e-4: paralleler Upload für andere Akte gesperrt; Abschluss von A verwirft NICHT die neue Auswahl bei B; B lädt in B', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount(`db.delay.upload = 500`); await p.openEdit('Anna'); await p.settle()
  await p.pick('anna.pdf'); await p.upload()                          // A läuft (langsam)
  await p.close(); await p.openEdit('Ben'); await sleep(80)
  let s = await p.state()
  assert.equal(s.selected, null, 'Auswahl von A nicht in Akte B'); assert.ok(!s.modalText.includes('Vertrag Anna'), 'keine Dokumente von A bei B')
  await p.pick('ben.pdf'); s = await p.state(); assert.equal(s.uploadDisabled, true, 'während A läuft gesperrt')
  await p.upload(); await sleep(700); await p.settle(); await sleep(100)
  s = await p.state()
  assert.equal(uploads(s).length, 1, 'kein paralleler Upload'); assert.ok(uploads(s)[0].includes('upload:eA/'), 'A in A')
  assert.equal(s.selected, 'ben.pdf', 'Abschluss von A lässt Auswahl bei B stehen'); assert.ok(!s.modalText.includes('Vertrag Anna'))
  await p.upload(); await sleep(700); await p.settle(); await sleep(100)
  s = await p.state(); assert.equal(uploads(s).length, 2); assert.ok(uploads(s)[1].includes('upload:eB/') && uploads(s)[1].includes('/ben.pdf'), 'B in B')
})

test('Browser 2e-3: Listen-Ladefehler → Hinweis + Erneut laden statt „Noch keine Dokumente“ (vorher: leer)', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const [name, err] of [['now', true], ['before', false]]) {
    const p = await P(name); await p.mount(`db.fail.docs = true`); await p.openEdit('Anna'); await p.settle()
    const s = await p.state()
    assert.equal(s.docsError, err, name); assert.equal(s.modalText.includes(EMPTY_TXT), !err, `${name}: „Noch keine Dokumente“`)
  }
  const p = await P('now')
  await p.ev(`window.__db.fail.docs = false; [...document.querySelectorAll('[data-testid="docs-load-error"] button')][0].click(); true`); await sleep(100); await p.settle()
  const s = await p.state(); assert.equal(s.docsError, false); assert.ok(s.modalText.includes('Vertrag Anna'))
})

async function switchScenario(p) {
  await p.mount(`db.delay['employee_documents:select'] = () => window.__slowNext ? (window.__slowNext = false, 600) : 0`)
  await p.ev('window.__slowNext = true; true'); await p.openEdit('Anna')   // Liste A langsam
  await p.close(); await p.openEdit('Ben'); await sleep(150)
  const early = await p.state()
  await sleep(700); await p.settle()
  return [early, await p.state()]
}
test('Browser 2e-3: Mitarbeiterwechsel – verspätete Liste von A erscheint NIE in der Akte von B (vorher: ja)', async t => {
  if (SKIP) return t.skip(SKIP)
  const [e1, s1] = await switchScenario(await P('now'))
  for (const s of [e1, s1]) { assert.ok(!s.modalText.includes('Vertrag Anna')); assert.ok(s.modalText.includes('Ben')) }
  assert.ok(s1.modalText.includes('Vertrag Ben'))
  // Liste von B scheitert direkt nach dem Wechsel → trotzdem nie die Dokumente von A (Ladefehler-Hinweis statt fremder Akte)
  const p = await P('now'); await p.mount(''); await p.openEdit('Anna'); await p.settle()
  assert.ok((await p.state()).modalText.includes('Vertrag Anna'))
  await p.ev('window.__db.fail.docs = true; true'); await p.close(); await p.openEdit('Ben'); await p.settle()
  const sf = await p.state(); assert.ok(sf.docsError); assert.ok(!sf.modalText.includes('Vertrag Anna'), 'keine fremde Akte bei Ladefehler')
  const [, s0] = await switchScenario(await P('before'))
  assert.ok(s0.modalText.includes('Vertrag Anna'), 'Gegenprobe: alter Stand zeigt A-Dokumente bei B')
})

test('Browser 2e-4: Dateiauswahl nach Mitarbeiterwechsel verworfen; derselbe Mitarbeiter erneut geöffnet → Auswahl bleibt (vorher: Auswahl wandert mit)', async t => {
  if (SKIP) return t.skip(SKIP)
  for (const [name, carried] of [['now', false], ['before', true]]) {
    const p = await P(name); await p.mount(''); await p.openEdit('Anna'); await p.settle(); await p.pick('anna.pdf')
    await p.close(); await p.openEdit('Ben'); await p.settle()
    assert.equal((await p.state()).selected === 'anna.pdf', carried, name)
  }
  const p = await P('now'); await p.close(); await p.openEdit('Ben'); await p.settle(); await p.pick('ben.pdf'); await p.close(); await p.openEdit('Ben'); await p.settle()
  assert.equal((await p.state()).selected, 'ben.pdf')
})

test('Browser 2e-5: 10-MB-Grenze vor dem Upload – 10 MB ok, 10 MB + 1 Byte abgelehnt mit Hinweis „max. 10 MB“ (vorher angenommen)', async t => {
  if (SKIP) return t.skip(SKIP)
  const p = await P('now'); await p.mount(''); await p.openEdit('Anna'); await p.settle()
  await p.pick('gross.pdf', 10485761); let s = await p.state()
  assert.equal(s.selected, null); assert.ok(s.body.includes('max. 10 MB')); assert.ok(s.modalText.includes('PDF, max. 10 MB'))
  await p.pick('genau.pdf', 10485760); s = await p.state(); assert.equal(s.selected, 'genau.pdf')
  const b = await P('before'); await b.mount(''); await b.openEdit('Anna'); await b.settle(); await b.pick('gross.pdf', 10485761)
  assert.equal((await b.state()).selected, 'gross.pdf', 'Gegenprobe: vorher akzeptiert (Server lehnt später ab)')
})
