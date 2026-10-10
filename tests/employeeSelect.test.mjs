// Mitarbeiter-Auswahl bei Mutationen (Upload, Anlage, Korrektur): nie automatisch die erste Person vorauswählen.
// Lohnabrechnung hochladen, Urlaub/Krankmeldung für andere eintragen (Manager/Admin), neue Schicht, Zeitkorrektur:
// Start ohne Auswahl, Platzhalter DE/EN, ohne bewusste Auswahl keine Mutation, nur die gewählte employee_id wird verwendet.
// Server: payroll_documents.employee_id NOT NULL + FK (tests/db/payroll_documents.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { de, en } from '../src/i18n/catalogs.js'
import { payrollUploadPath, findPayrollDoc, removePayrollFile } from '../src/lib/payrollUpload.js'
import { isTransientFailure } from '../src/lib/profileLoad.js'

const read = f => readFileSync(f, 'utf8')
const grab = (src, name) => {
  const s = src.indexOf(`async function ${name}(`); assert.ok(s >= 0, name)
  let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1
  while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- }
  return src.slice(s, i)
}
const PAGES = readdirSync('src/pages').filter(f => f.endsWith('.jsx')).map(f => `src/pages/${f}`)

test('Keine implizite Vorauswahl der ersten Person in irgendeiner Seite (employees[0] & Co.)', () => {
  for (const f of PAGES) {
    const s = read(f)
    assert.doesNotMatch(s, /\b(employees|emps|staff|users|staffList|activeEmployees)\??\.?\[0\]/, `${f}: erste Person als Default`)
    assert.doesNotMatch(s, /set(SelEmp|FilterEmp|SelectedEmployee)\([a-zA-Z]+\??\.?\[0\]/, `${f}: Auswahl auf ersten Datensatz gesetzt`)
  }
})

test('Platzhalter DE/EN und Auswahllisten beginnen mit „– Mitarbeiter auswählen –“', () => {
  assert.equal(de['time.selectEmployee'], '– Mitarbeiter auswählen –')
  assert.equal(en['time.selectEmployee'], '– Select employee –')
  const placeholderList = /\[\{ id: '', placeholder: true \}, \.\.\.employees\]\.map\(e => <option key=\{e\.id \|\| 'none'\} value=\{e\.id\}>\{e\.placeholder \? tr\("time\.selectEmployee"\)/g
  const expected = { 'src/pages/PayrollDocuments.jsx': 1, 'src/pages/Vacation.jsx': 2, 'src/pages/Shifts.jsx': 1, 'src/pages/TimeManagement.jsx': 1 }
  for (const [f, n] of Object.entries(expected)) assert.equal((read(f).match(placeholderList) || []).length, n, f)
})

test('Lohnabrechnung: Start ohne Auswahl, kein Nachladen setzt eine Person, Button ohne Auswahl gesperrt', () => {
  const s = read('src/pages/PayrollDocuments.jsx')
  assert.match(s, /const \[selEmp, +setSelEmp\] += useState\(''\)/)
  assert.doesNotMatch(s, /setSelEmp\((?!e\.target\.value)/, 'setSelEmp nur durch die Auswahl des Benutzers')
  assert.match(s, /onClick=\{handleUpload\} disabled=\{uploading \|\| !selEmp\}/)
})

// Echte handleUpload- und uploadChecked-Funktion (Batch 2F) mit nachgebildetem Supabase (Storage + Tabelle) ausführen;
// Belegungsprüfung über die echte lib/payrollUpload.js (Monat frei). reads = lesende Prüfungen, calls = Mutationen.
function uploader({ selEmp, employees, file = { type: 'application/pdf', size: 1000, name: 'abrechnung.pdf' } }) {
  const calls = [], warns = [], reads = []
  const supabase = {
    storage: { from: bucket => ({ upload: async (path, f, o) => { calls.push({ kind: 'storage', bucket, path, upsert: o.upsert }); return { error: null } } }) },
    from: table => {
      const q = { table, eq: [] }
      const api = {
        select: cols => { q.cols = cols; return api }, eq: (k, v) => { q.eq.push([k, v]); return api },
        maybeSingle: async () => { reads.push(q); return { data: null, error: null } },
        upsert: async (rows, o) => { calls.push({ kind: 'db', table, rows, onConflict: o.onConflict }); return { error: null, status: 201 } },
      }
      return api
    },
  }
  const deps = {
    fileRef: { current: { files: [file], value: 'x' } }, toast: { warn: m => warns.push(m), error: m => warns.push(m) },
    appMessage: k => k, messageParts: x => x, errorMessage: x => x, formatParam: () => '', logActivity: () => {}, setTimeout: () => {},
    selEmp, employees, selYear: 2026, selMonth: 9, selNotes: '', profile: { id: 'admin-user' }, supabase,
    setUploading: () => {}, setMsg: () => {}, setSelNotes: () => {}, fetchAll: () => {},
    uploadGuard: { begin: () => true, end: () => {} }, tr: k => k, window: { confirm: () => { throw new Error('Rückfrage bei freiem Monat') } },
    payrollUploadPath, findPayrollDoc, removePayrollFile, isTransientFailure,
  }
  const page = read('src/pages/PayrollDocuments.jsx')
  const fn = new Function(...Object.keys(deps), `${grab(page, 'uploadChecked')}\nreturn (${grab(page, 'handleUpload')})`)(...Object.values(deps))
  return { run: fn, calls, warns, reads }
}
const A = { id: 'emp-a', first_name: 'Anna', last_name: 'A' }, B = { id: 'emp-b', first_name: 'Ben', last_name: 'B' }

test('Lohnabrechnung: ohne Auswahl → Hinweis, KEIN Storage-Upload, KEIN Datensatz (echter handleUpload)', async () => {
  const u = uploader({ selEmp: '', employees: [A, B] })
  await u.run()
  assert.deepEqual(u.warns, ['ui.c0f1345f6930'])
  assert.equal(u.calls.length, 0, 'keine Mutation ohne Mitarbeiter')
  assert.equal(de['ui.c0f1345f6930'], 'Bitte einen Mitarbeiter auswählen!')
  assert.equal(en['ui.c0f1345f6930'], 'Please select an employee!')
})

test('Lohnabrechnung: unbekannte/veraltete employee_id (manipuliert oder nicht mehr in der Liste) → keine Mutation', async () => {
  for (const selEmp of ['emp-x', 'undefined', ' ', null, undefined]) {
    const u = uploader({ selEmp, employees: [A, B] })
    await u.run()
    assert.equal(u.calls.length, 0, String(selEmp))
  }
  const empty = uploader({ selEmp: 'emp-a', employees: [] })   // Liste (noch) nicht geladen
  await empty.run()
  assert.equal(empty.calls.length, 0)
})

test('Lohnabrechnung: Auswahl A → Upload nur für A; Wechsel A → B → Upload nur für B (Pfad + Datensatz)', async () => {
  for (const emp of [A, B]) {
    const u = uploader({ selEmp: emp.id, employees: [A, B] })
    await u.run()
    assert.deepEqual(u.warns, [])
    const [st, db] = u.calls
    assert.equal(st.kind, 'storage'); assert.equal(st.bucket, 'payroll-docs')
    assert.equal(st.path.split('/')[0], emp.id, 'Ordner = gewählte Person (Lese-Policy der Person)')
    assert.match(st.path, new RegExp(`^${emp.id}/2026-09-lohnabrechnung-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`), 'eindeutige Datei-ID je Upload')
    assert.equal(st.upsert, false, 'nie eine vorhandene Datei überschreiben')
    assert.equal(db.rows[0].file_path, st.path, 'Datensatz zeigt auf genau die hochgeladene Datei')
    assert.deepEqual(u.reads.map(r => r.eq), [[['employee_id', emp.id], ['year', 2026], ['month', 9]]], 'Belegung nur für die gewählte Person geprüft')
    assert.equal(db.table, 'payroll_documents'); assert.equal(db.rows.length, 1)
    assert.equal(db.rows[0].employee_id, emp.id)
    assert.ok([...u.calls, ...u.reads].every(c => JSON.stringify(c).indexOf(emp === A ? B.id : A.id) < 0), 'keine fremde ID')
  }
  // eindeutig: zwei Uploads derselben Person und desselben Monats erzeugen zwei verschiedene Pfade
  const [u1, u2] = [uploader({ selEmp: A.id, employees: [A, B] }), uploader({ selEmp: A.id, employees: [A, B] })]
  await u1.run(); await u2.run()
  assert.notEqual(u1.calls[0].path, u2.calls[0].path)
})

test('Lohnabrechnung: Prüfung der Person kommt vor jeder anderen Aktion (auch ohne Datei kein Upload)', async () => {
  const u = uploader({ selEmp: '', employees: [A], file: undefined })
  await u.run()
  assert.deepEqual(u.warns, ['ui.c0f1345f6930'])
})

test('Urlaub/Krank (Manager/Admin für andere): Formular startet ohne Person; Speichern ohne gültige Auswahl ohne Mutation', async () => {
  const s = read('src/pages/Vacation.jsx')
  assert.equal((s.match(/employee_id: canManage \? '' : profile\?\.employee_id/g) || []).length, 2)
  for (const name of ['doSaveVacation', 'saveSick']) {
    const body = grab(s, name)
    assert.match(body, /if \(canManage && !employees\.some\(e => e\.id === empId\)\) \{ setFormError\(appMessage\("time\.selectEmployeeFirst"\)\)/, name)
    assert.ok(body.indexOf('employees.some') < body.indexOf('supabase'), `${name}: Prüfung vor jedem Serveraufruf`)
  }
})

test('Urlaub: Speichern-Sperre wird nach jeder Hinweismeldung wieder freigegeben (echter saveVacation)', async () => {
  const s = read('src/pages/Vacation.jsx')
  const errors = []; let inner = 0
  const savingRef = { current: false }
  const doSaveVacation = async () => { inner++; errors.push('hinweis') }   // jeder frühe Abbruch (Resturlaub, Datum, Serverfehler)
  const save = new Function('savingRef', 'doSaveVacation', `return (${grab(s, 'saveVacation')})`)(savingRef, doSaveVacation)
  await save(); await save()
  assert.equal(inner, 2, 'zweiter Versuch nach Hinweis wird ausgeführt')
  assert.equal(savingRef.current, false)
  const failing = new Function('savingRef', 'doSaveVacation', `return (${grab(s, 'saveVacation')})`)(savingRef, async () => { throw new Error('netz') })
  await assert.rejects(failing()); assert.equal(savingRef.current, false, 'auch nach Ausnahme frei')
})

test('Urlaub: ohne Auswahl → Hinweis, kein Serveraufruf (echter doSaveVacation, Manager)', async () => {
  const s = read('src/pages/Vacation.jsx')
  const calls = [], errs = []
  const deps = { setFormError: e => errs.push(e), canManage: true, form: { employee_id: '', start_date: '2026-11-02', end_date: '2026-11-06' },
    profile: { employee_id: 'mgr' }, employees: [A, B], appMessage: k => k, savingRef: { current: true },
    supabase: new Proxy({}, { get: () => () => { calls.push(1); throw new Error('kein Serveraufruf erwartet') } }) }
  await new Function(...Object.keys(deps), `return (${grab(s, 'doSaveVacation')})`)(...Object.values(deps))()
  assert.deepEqual(errs, ['', 'time.selectEmployeeFirst']); assert.equal(calls.length, 0)
})

test('Schicht anlegen: Start ohne Person; ohne gültige Auswahl kein Insert (echter doAddShift)', async () => {
  const s = read('src/pages/Shifts.jsx')
  assert.match(s, /setForm\(\{ employee_id: '', date: today,/)
  const run = async employee_id => {
    const calls = [], warns = [], dupChecks = []
    const deps = { form: { employee_id, date: '2026-11-02', start_time: '08:00', end_time: '16:00', position: '', notes: '' }, employees: [A, B],
      toast: { warn: m => warns.push(m), error: m => warns.push(m), success: () => {} }, appMessage: k => k, translateSupabaseError: x => x,
      setSaving: () => {}, setModal: () => {}, fetchData: () => {}, notifyTimeDataChanged: () => {},
      // Resilience Batch 2b-1: Duplikat-Prüfung vor dem Insert (hier: kein Duplikat)
      findSameStartShift: async (client, q) => { dupChecks.push(q); return { ok: true, existing: null } }, tr: k => k, formatDate: d => d, hhmm: t => t,
      supabase: { from: t => ({ insert: async rows => { calls.push({ t, rows }); return { error: null } } }) } }
    await new Function(...Object.keys(deps), `return (${grab(s, 'doAddShift')})`)(...Object.values(deps))()
    return { calls, warns, dupChecks }
  }
  for (const id of ['', 'emp-x']) { const r = await run(id); assert.equal(r.calls.length, 0, id); assert.deepEqual(r.warns, ['time.selectEmployeeFirst']); assert.equal(r.dupChecks.length, 0, `${id}: ohne gültige Person auch keine Prüfung`) }
  const ok = await run('emp-b')
  assert.equal(ok.calls.length, 1); assert.equal(ok.calls[0].rows[0].employee_id, 'emp-b')
  assert.deepEqual(ok.dupChecks, [{ employeeId: 'emp-b', date: '2026-11-02', startTime: '08:00' }])
})

test('Zeitkorrekturen: None-Default bleibt (keine Regression)', () => {
  const tm = read('src/pages/TimeManagement.jsx')
  assert.match(tm, /const \[filterEmp, +setFilterEmp\] += useState\(''\)/)
  assert.doesNotMatch(tm, /setFilterEmp\(first|\[0\]/)
})
