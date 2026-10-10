// Resilience Batch 2F (Lohnabrechnungen, PayrollDocuments.jsx): eine vorhandene Monatsabrechnung wird nie unbemerkt
// überschrieben oder gelöscht. ECHTE Funktionen handleUpload/uploadChecked/handleDelete aus der Seite gegen einen
// zustandsbehafteten Nachbau von Storage + Tabelle (Dateiinhalte byte-vergleichbar, Reihenfolge protokolliert) –
// inkl. Gegenprobe mit dem Stand vor 2F (2fb4d48). Blättern/Upload im Browser: tests/payrollDocumentsPaging.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { payrollUploadPath, findPayrollDoc, removePayrollFile } from '../src/lib/payrollUpload.js'
import { isTransientFailure } from '../src/lib/profileLoad.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = '2fb4d48'
const PAGE = 'src/pages/PayrollDocuments.jsx'
const now = readFileSync(PAGE, 'utf8'), was = execFileSync('git', ['show', `${BEFORE}:${PAGE}`], { encoding: 'utf8' })
const grab = (src, name) => {
  const s = src.indexOf(`async function ${name}(`); assert.ok(s >= 0, name)
  let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1
  while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- }
  return src.slice(s, i)
}
const OLD_PATH = 'emp-a/2026-03-lohnabrechnung.pdf'
const A = { id: 'emp-a', first_name: 'Anna', last_name: 'Alpha' }, B = { id: 'emp-b', first_name: 'Ben', last_name: 'Beta' }

function makeEnv({ occupied = true, upsert = 'ok', storage = 'ok', check = [], removeFails = [], uploadDelay = 0, throwOn = null } = {}) {
  const db = {
    docs: occupied ? [{ id: 'doc-1', employee_id: 'emp-a', year: 2026, month: 3, file_path: OLD_PATH, file_name: 'maerz.pdf' }] : [],
    files: new Map(occupied ? [[OLD_PATH, 'ALTE-ABRECHNUNG'], ['emp-b/2026-03-lohnabrechnung.pdf', 'BEN']] : [['emp-b/2026-03-lohnabrechnung.pdf', 'BEN']]),
    log: [], checks: 0,
  }
  const supabase = {
    from: table => {
      const q = { table, eq: [] }
      const api = {
        select(cols) { q.cols = cols; return api }, eq(k, v) { q.eq.push([k, v]); return api },
        async maybeSingle() {
          const mode = check[db.checks++] || 'ok'; db.log.push('check')
          if (mode === 'fail') return { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }
          const d = db.docs.find(x => q.eq.every(([k, v]) => x[k] === v))
          return { data: d ? { id: d.id, file_path: d.file_path, file_name: d.file_name } : null, error: null, status: 200 }
        },
        async upsert(rows) {
          db.log.push('upsert'); const r = rows[0]
          const apply = () => { const o = db.docs.find(x => x.employee_id === r.employee_id && x.year === r.year && x.month === r.month); o ? Object.assign(o, r) : db.docs.push({ id: 'doc-new', ...r }) }
          if (upsert === 'reject') return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' }, status: 403 }
          if (upsert === 'lostNotSaved') return { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }
          apply()
          if (upsert === 'lostSaved') return { data: null, error: { message: 'AbortError: request-timeout-write' }, status: 0 }
          if (upsert === 'gateway') return { data: null, error: { message: 'Bad gateway' }, status: 502 }
          return { data: null, error: null, status: 201 }
        },
        delete() { q.op = 'delete'; return { eq: async (k, v) => { db.log.push('delete-row'); db.docs = db.docs.filter(x => x[k] !== v); return { error: null } } } },
      }
      return api
    },
    storage: {
      from: bucket => {
        if (throwOn === 'storage') throw new Error('boom')
        return {
          async upload(path, file, o) {
            db.log.push('upload:' + (db.files.has(path) ? 'EXISTING' : 'new') + ':' + o.upsert)
            if (uploadDelay) await new Promise(r => setTimeout(r, uploadDelay))
            if (db.files.has(path) && !o.upsert) return { data: null, error: { message: 'The resource already exists', status: 409 } }
            if (storage === 'reject') return { data: null, error: { message: 'unauthorized', status: 403 } }
            db.files.set(path, file.content)
            if (storage === 'unknown') return { data: null, error: { name: 'StorageUnknownError', message: 'Failed to fetch' } }
            return { data: { path }, error: null }
          },
          async remove(paths) {
            db.log.push('remove:' + paths.join(','))
            if (paths.some(p => removeFails.includes(p === OLD_PATH ? 'old' : 'new'))) return { data: null, error: { message: 'network' } }
            for (const p of paths) db.files.delete(p)
            return { data: [], error: null }
          },
        }
      },
    },
  }
  return { db, supabase }
}

function guard() { let active = false; return { begin: () => (active ? false : (active = true)), end: () => { active = false }, get active() { return active } } }

function uploader(src, env, { confirm = true, selEmp = 'emp-a' } = {}) {
  const toasts = [], confirms = [], state = { uploading: [] }
  const deps = {
    fileRef: { current: { files: [{ type: 'application/pdf', size: 1000, name: 'neu.pdf', content: 'NEUE-ABRECHNUNG' }], value: 'x' } },
    toast: { warn: (m, d) => toasts.push(['warn', m]), error: (m, d) => toasts.push(['error', m]), success: m => toasts.push(['success', m]) },
    appMessage: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k), messageParts: x => x.join(''), errorMessage: e => e?.message || '', formatParam: () => 'März',
    logActivity: a => toasts.push(['log', a.action]), setTimeout: () => {}, tr: (k, p) => `${k}${JSON.stringify(p)}`,
    window: { confirm: m => { confirms.push(m); return confirm } },
    selEmp, employees: [A, B], selYear: 2026, selMonth: 3, selNotes: '', profile: { id: 'admin-user' }, supabase: env.supabase,
    setUploading: v => state.uploading.push(v), setMsg: m => toasts.push(['msg', m]), setSelNotes: () => {}, fetchAll: () => toasts.push(['fetchAll']),
    uploadGuard: guard(), payrollUploadPath, findPayrollDoc, removePayrollFile, isTransientFailure,
  }
  const body = src.includes('async function uploadChecked(') ? `${grab(src, 'uploadChecked')}\nreturn (${grab(src, 'handleUpload')})` : `return (${grab(src, 'handleUpload')})`
  const run = new Function(...Object.keys(deps), body)(...Object.values(deps))
  return { run, toasts, confirms, state, guard: deps.uploadGuard }
}
const newPath = db => db.docs.find(d => d.employee_id === 'emp-a' && d.month === 3)?.file_path
const UUID_PATH = /^emp-a\/2026-03-lohnabrechnung-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/
const has = (toasts, kind, key) => toasts.some(([k, m]) => k === kind && String(m).startsWith(key))

// ── Lib ──
test('Lib: Pfad = Mitarbeiterordner zuerst + eindeutige ID; Belegung: frei | belegt | Fehler → ok:false; Entfernen meldet Erfolg/Misserfolg', async () => {
  const p1 = payrollUploadPath('emp-a', 2026, '03'), p2 = payrollUploadPath('emp-a', 2026, '03')
  assert.match(p1, UUID_PATH); assert.notEqual(p1, p2); assert.equal(p1.split('/')[0], 'emp-a')
  const env = makeEnv()
  assert.deepEqual(await findPayrollDoc(env.supabase, { employeeId: 'emp-a', year: 2026, month: 3 }), { ok: true, doc: { id: 'doc-1', file_path: OLD_PATH, file_name: 'maerz.pdf' } })
  assert.deepEqual(await findPayrollDoc(env.supabase, { employeeId: 'emp-a', year: 2026, month: 4 }), { ok: true, doc: null })
  assert.deepEqual(await findPayrollDoc(makeEnv({ check: ['fail'] }).supabase, { employeeId: 'emp-a', year: 2026, month: 3 }), { ok: false })
  assert.deepEqual(await findPayrollDoc({ from() { throw new Error('x') } }, { employeeId: 'a', year: 1, month: 1 }), { ok: false })
  assert.equal(await removePayrollFile(env.supabase, 'emp-b/2026-03-lohnabrechnung.pdf'), true)
  assert.equal(await removePayrollFile(makeEnv({ removeFails: ['old'] }).supabase, OLD_PATH), false)
  assert.equal(await removePayrollFile({ storage: { from() { throw new Error('x') } } }, 'p'), false)
})

// ── Upload ──
test('Freier Monat: keine Rückfrage, 1 Upload (neuer Pfad, upsert:false), Eintrag zeigt darauf, nichts gelöscht, Erfolg + Protokoll', async () => {
  const env = makeEnv({ occupied: false }); const u = uploader(now, env)
  await u.run()
  assert.equal(u.confirms.length, 0); assert.deepEqual(env.db.log, ['check', 'upload:new:false', 'upsert'])
  assert.match(newPath(env.db), UUID_PATH); assert.equal(env.db.files.get(newPath(env.db)), 'NEUE-ABRECHNUNG')
  assert.equal(env.db.files.get('emp-b/2026-03-lohnabrechnung.pdf'), 'BEN')
  assert.ok(has(u.toasts, 'msg', 'ui.2137fc6a781d') && has(u.toasts, 'log', 'payroll.document_uploaded') && has(u.toasts, 'fetchAll', ''))
})

test('Belegter Monat → Rückfrage nennt Person, Monat, Datei und das Entfernen; „Abbrechen“ → KEIN Schreibvorgang, alte Abrechnung byte-gleich', async () => {
  const env = makeEnv(); const u = uploader(now, env, { confirm: false })
  await u.run()
  assert.equal(u.confirms.length, 1); assert.match(u.confirms[0], /payrollDocs\.replaceConfirm/); assert.match(u.confirms[0], /Anna Alpha/); assert.match(u.confirms[0], /März/); assert.match(u.confirms[0], /maerz\.pdf/)
  assert.deepEqual(env.db.log, ['check'], 'nur gelesen')
  assert.equal(env.db.files.get(OLD_PATH), 'ALTE-ABRECHNUNG'); assert.equal(newPath(env.db), OLD_PATH)
  assert.deepEqual(u.state.uploading, [true, false])
  assert.match(de['payrollDocs.replaceConfirm'], /bisherige Datei wird danach entfernt/)
})

test('Belegter Monat → „Ersetzen“: neue Datei unter eigenem Pfad, Eintrag bestätigt, ERST DANACH alte Datei entfernt (D2 a)', async () => {
  const env = makeEnv(); const u = uploader(now, env)
  await u.run()
  const np = newPath(env.db)
  assert.match(np, UUID_PATH); assert.deepEqual(env.db.log, ['check', 'upload:new:false', 'upsert', `remove:${OLD_PATH}`], 'Reihenfolge: hochladen → Eintrag → alte Datei')
  assert.equal(env.db.files.get(np), 'NEUE-ABRECHNUNG'); assert.equal(env.db.files.has(OLD_PATH), false)
  assert.ok(!env.db.log.some(l => l.startsWith('upload:EXISTING')), 'nie auf einen vorhandenen Pfad geschrieben')
  assert.ok(has(u.toasts, 'msg', 'ui.2137fc6a781d')); assert.ok(!u.toasts.some(([k]) => k === 'warn' || k === 'error'))
})

test('Belegung nicht prüfbar (Netz/Zeitlimit) → NICHTS hochgeladen, Fehlerhinweis, alte Abrechnung unverändert', async () => {
  const env = makeEnv({ check: ['fail'] }); const u = uploader(now, env)
  await u.run()
  assert.deepEqual(env.db.log, ['check']); assert.equal(u.confirms.length, 0)
  assert.ok(has(u.toasts, 'error', 'payrollDocs.replaceCheckFailed')); assert.equal(env.db.files.get(OLD_PATH), 'ALTE-ABRECHNUNG')
})

test('Storage lehnt ab / Storage-Antwort unklar → kein Eintrag, alte Datei + Eintrag unverändert, Fehlermeldung', async () => {
  for (const storage of ['reject', 'unknown']) {
    const env = makeEnv({ storage }); const u = uploader(now, env)
    await u.run()
    assert.ok(!env.db.log.includes('upsert'), storage); assert.ok(!env.db.log.some(l => l.startsWith('remove')), storage)
    assert.equal(env.db.files.get(OLD_PATH), 'ALTE-ABRECHNUNG', storage); assert.equal(newPath(env.db), OLD_PATH, storage)
    assert.ok(has(u.toasts, 'error', 'ui.93446336643a'), storage)
  }
})

test('Eintrag eindeutig abgelehnt (RLS 403) → NUR die neue Datei entfernt; alte Datei + alter Eintrag unverändert', async () => {
  const env = makeEnv({ upsert: 'reject' }); const u = uploader(now, env)
  await u.run()
  const removes = env.db.log.filter(l => l.startsWith('remove:'))
  assert.equal(removes.length, 1); assert.match(removes[0].slice(7), UUID_PATH); assert.notEqual(removes[0], `remove:${OLD_PATH}`)
  assert.equal(env.db.files.get(OLD_PATH), 'ALTE-ABRECHNUNG'); assert.equal(newPath(env.db), OLD_PATH)
  assert.equal([...env.db.files.keys()].filter(k => UUID_PATH.test(k)).length, 0, 'neue Datei bereinigt')
  assert.ok(has(u.toasts, 'error', 'ui.311318091447')); assert.ok(!has(u.toasts, 'msg', 'ui.2137fc6a781d'))
})

test('Eintrag unklar, aber gespeichert (Zeitlimit / 502) → nichts Neues gelöscht, Gegenprüfung bestätigt, dann alte Datei entfernt, Erfolg', async () => {
  for (const upsert of ['lostSaved', 'gateway']) {
    const env = makeEnv({ upsert }); const u = uploader(now, env)
    await u.run()
    const np = newPath(env.db)
    assert.match(np, UUID_PATH, upsert); assert.equal(env.db.files.get(np), 'NEUE-ABRECHNUNG', upsert)
    assert.deepEqual(env.db.log, ['check', 'upload:new:false', 'upsert', 'check', `remove:${OLD_PATH}`], `${upsert}: gegengeprüft, keine Wiederholung`)
    assert.ok(has(u.toasts, 'msg', 'ui.2137fc6a781d'), upsert)
  }
})

test('Eintrag unklar, NICHT gespeichert → nichts gelöscht (weder alt noch neu), Hinweis „nicht bestätigt“, keine Wiederholung', async () => {
  const env = makeEnv({ upsert: 'lostNotSaved' }); const u = uploader(now, env)
  await u.run()
  assert.deepEqual(env.db.log, ['check', 'upload:new:false', 'upsert', 'check'])
  assert.equal(env.db.files.get(OLD_PATH), 'ALTE-ABRECHNUNG'); assert.equal(newPath(env.db), OLD_PATH)
  assert.ok(has(u.toasts, 'warn', 'payrollDocs.uploadUnclear')); assert.ok(!has(u.toasts, 'msg', 'ui.2137fc6a781d'))
})

test('Gegenprüfung selbst scheitert → nichts gelöscht, Hinweis „nicht bestätigt“, alte Datei bleibt', async () => {
  const env = makeEnv({ upsert: 'lostSaved', check: ['ok', 'fail'] }); const u = uploader(now, env)
  await u.run()
  assert.ok(!env.db.log.some(l => l.startsWith('remove')))
  assert.equal(env.db.files.get(OLD_PATH), 'ALTE-ABRECHNUNG'); assert.ok(has(u.toasts, 'warn', 'payrollDocs.uploadUnclear'))
})

test('Alte Datei lässt sich nach bestätigtem Ersetzen nicht entfernen → neue Abrechnung gilt, ehrlicher Hinweis (Aufbewahrung)', async () => {
  const env = makeEnv({ removeFails: ['old'] }); const u = uploader(now, env)
  await u.run()
  assert.match(newPath(env.db), UUID_PATH); assert.ok(has(u.toasts, 'warn', 'payrollDocs.oldFileKept')); assert.ok(has(u.toasts, 'msg', 'ui.2137fc6a781d'))
})

test('Doppeltipp → genau EIN Upload; Ausnahme im Ablauf → Sperre und „wird hochgeladen“ werden immer freigegeben', async () => {
  const env = makeEnv({ occupied: false, uploadDelay: 30 }); const u = uploader(now, env)
  await Promise.all([u.run(), u.run()])
  assert.equal(env.db.log.filter(l => l.startsWith('upload:')).length, 1); assert.equal(env.db.log.filter(l => l === 'upsert').length, 1)
  const t = uploader(now, makeEnv({ occupied: false, throwOn: 'storage' }))
  await assert.rejects(t.run()); assert.equal(t.guard.active, false); assert.deepEqual(t.state.uploading, [true, false])
})

test('Gegenprobe: Stand vor 2F überschreibt eine vorhandene Monatsabrechnung OHNE Rückfrage (fester Pfad, upsert:true)', async () => {
  const env = makeEnv(); const u = uploader(was, env)
  await u.run()
  assert.equal(u.confirms.length, 0); assert.equal(env.db.files.get(OLD_PATH), 'NEUE-ABRECHNUNG', 'alte Abrechnung überschrieben')
  assert.ok(env.db.log.includes('upload:EXISTING:true'))
})

// ── Löschen (2F-2) ──
function deleter(src, env) {
  const toasts = [], loads = []
  const deps = {
    employees: [A, B], MONTHS: [{ v: 3, l: 'März' }], tr: k => k, window: { confirm: () => true }, deleteGuard: guard(),
    supabase: env.supabase, toast: { error: m => toasts.push(['error', m]), warn: m => toasts.push(['warn', m]), success: m => toasts.push(['success', m]) },
    appMessage: k => k, loadDocs: p => loads.push(p), clampPage: (p) => p, req: { current: { page: 1 } }, total: 5,
  }
  const run = new Function(...Object.keys(deps), `return (${grab(src, 'handleDelete')})`)(...Object.values(deps))
  return { run, toasts, loads }
}
test('Löschen: Datei entfernt → Erfolg; Datei nicht entfernbar → ehrlicher Hinweis statt Erfolg (vorher: Erfolg)', async () => {
  const doc = { id: 'doc-1', employee_id: 'emp-a', year: 2026, month: 3, file_path: OLD_PATH }
  let env = makeEnv(); let d = deleter(now, env)
  await d.run(doc)
  assert.deepEqual(d.toasts, [['success', 'ui.d01284bfc449']]); assert.equal(env.db.files.has(OLD_PATH), false)
  env = makeEnv({ removeFails: ['old'] }); d = deleter(now, env)
  await d.run(doc)
  assert.deepEqual(d.toasts, [['warn', 'payrollDocs.deleteFileKept']]); assert.deepEqual(env.db.log, ['delete-row', `remove:${OLD_PATH}`], 'Reihenfolge unverändert')
  env = makeEnv({ removeFails: ['old'] }); d = deleter(was, env)
  await d.run(doc)
  assert.deepEqual(d.toasts, [['success', 'ui.d01284bfc449']], 'Gegenprobe: vorher Erfolg trotz verbliebener Datei')
})

// ── Texte ──
test('DE/EN/BN: neue Texte vollständig, gleiche Platzhalter, BN in Bangla ohne bengalische Ziffern', () => {
  const ph = s => (s.match(/\{\w+\}/g) || []).sort().join()
  for (const k of ['payrollDocs.replaceConfirm', 'payrollDocs.replaceCheckFailed', 'payrollDocs.uploadUnclear', 'payrollDocs.oldFileKept', 'payrollDocs.deleteFileKept']) {
    assert.ok(de[k] && en[k] && bn[k], k); assert.equal(ph(en[k]), ph(de[k]), k); assert.equal(ph(bn[k]), ph(de[k]), k)
    assert.match(bn[k], /[ঀ-৿]/, k); assert.doesNotMatch(bn[k], /[০-৯]/, k)
  }
  assert.match(de['payrollDocs.uploadUnclear'], /bisherige Abrechnung bleibt erhalten/)
})
