// Fehlerpfade echter Handler: Funktion aus dem Quelltext laden und mit simulierter Supabase ausführen.
// Belegt: keine Erfolgsmeldung bei Backend-Fehler, keine hängenden Lade-/Doppelklick-Sperren.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function extractFn(file, name) {
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `${file}: ${name}`)
  let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return src.slice(start, i)
}
const load = (file, name, deps) => new Function(...Object.keys(deps), `return (${extractFn(file, name)})`)(...Object.values(deps))

// Supabase-Kette: jede Methode verkettbar, await liefert das Ergebnis der Tabelle/RPC
function chain(result) {
  const p = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? (res => res(result)) : p), apply: () => p })
  return p
}
const fakeSupabase = results => ({
  from: t => chain(results[t] ?? { error: null }),
  rpc: n => chain(results[`rpc:${n}`] ?? { error: null }),
  storage: { from: b => chain(results[`storage:${b}`] ?? { error: null }) },
})
function spyToast() { const calls = []; const f = kind => (...a) => calls.push([kind, ...a]); return { calls, success: f('success'), error: f('error'), warn: f('warn'), info: f('info') } }
const common = { appMessage: (k, v) => ({ k, v }), translateSupabaseError: () => 'ERR', errorMessage: e => e?.message, messageParts: a => a, logActivity: () => {}, notifyTimeDataChanged: () => {} }
const guard = () => { const g = { locked: false, begin: () => (g.locked ? false : (g.locked = true)), end: () => { g.locked = false } }; return g }
const ERR = { error: { message: 'boom' } }

test('Schicht löschen: Speichern-Sperre wird immer freigegeben, bei Fehler keine Erfolgsmeldung', async () => {
  for (const [label, res, ok] of [['Erfolg', { error: null }, true], ['Fehler', ERR, false]]) {
    const saving = []; const toast = spyToast(); let fetched = 0
    const fn = load('src/pages/Shifts.jsx', 'deleteShift', { ...common, saving: false, setSaving: v => saving.push(v), supabase: fakeSupabase({ shifts: res }), toast, setEditModal: () => {}, setDelConfirm: () => {}, fetchData: () => fetched++ })
    await fn('s1')
    assert.deepEqual(saving, [true, false], `${label}: saving zurückgesetzt`)
    assert.equal(toast.calls.some(c => c[0] === 'success'), ok, label)
    assert.equal(toast.calls.some(c => c[0] === 'error'), !ok, label)
    assert.equal(fetched, ok ? 1 : 0)
  }
})

test('Tausch ablehnen: bereits freigegebene Anfrage (veraltete Ansicht) → Fehler statt „abgelehnt“; nur laufende Anfragen', async () => {
  const src = extractFn('src/pages/Shifts.jsx', 'rejectSwap')
  assert.match(src, /\.eq\('id', id\)\.in\('status', \['open', 'accepted'\]\)\.select\('id'\)/)
  for (const [label, res, kinds] of [
    ['abgelehnt', { data: [{ id: 's1' }], error: null }, ['success']],
    ['schon freigegeben', { data: [], error: null }, ['error']],
    ['Backend-Fehler', { data: null, ...ERR }, ['error']],
  ]) {
    const toast = spyToast(); const saving = []
    const fn = load('src/pages/Shifts.jsx', 'rejectSwap', { ...common, swapSaving: false, setSwapSaving: v => saving.push(v), supabase: fakeSupabase({ shift_swap_requests: res }), toast, fetchSwaps: () => {}, fetchData: () => {} })
    await fn('s1')
    assert.deepEqual(toast.calls.map(c => c[0]), kinds, label)
    assert.deepEqual(saving, [true, false], `${label}: Sperre frei`)
  }
  const locked = spyToast()
  await load('src/pages/Shifts.jsx', 'rejectSwap', { ...common, swapSaving: true, setSwapSaving: () => { throw new Error('darf nicht') }, supabase: fakeSupabase({}), toast: locked, fetchSwaps: () => {}, fetchData: () => {} })('s1')
  assert.equal(locked.calls.length, 0, 'Doppelklick ignoriert')
})

test('Ausstempeln aus veralteter Ansicht (anderes Gerät hat schon ausgestempelt): nichts überschreiben, kein Erfolg', async () => {
  assert.match(extractFn('src/pages/ClockIn.jsx', 'clockOut'), /\.eq\('id', openEntry\.id\)\.is\('clock_out', null\)\.select\(/)
  for (const [label, res, kind] of [['bereits ausgestempelt', { data: null, error: null }, 'warn'], ['Erfolg', { data: { hours_worked: 7.5, notes: null }, error: null }, 'success'], ['Fehler', ERR, 'error']]) {
    const toast = spyToast(); const working = []; let fetched = 0
    const fn = load('src/pages/ClockIn.jsx', 'clockOut', { ...common, working: false, openEntry: { id: 'e1', clock_in: new Date(Date.now() - 8 * 3600e3).toISOString(), break_minutes: 0 }, breaks: [], openBreak: () => null, setWorking: v => working.push(v), sumBreakMinutes: () => 0, calcWorkedHours: () => 8, gps: {}, supabase: fakeSupabase({ time_entries: res }), toast, fetchData: async () => { fetched++ }, breakLoad: 'ok', breaksOn: true, formatParam: () => '', tr: k => k })
    await fn()
    assert.deepEqual(toast.calls.map(c => c[0]), [kind], label)
    assert.equal(working.at(-1), false, `${label}: Sperre frei`)
  }
})

test('Urlaub entscheiden aus veralteter Ansicht: fremde Entscheidung wird nicht überschrieben', async () => {
  const src = extractFn('src/pages/Vacation.jsx', 'vacAction')
  assert.match(src, /async function vacAction\(id, status, from = 'pending'\)/)
  assert.match(src, /\.eq\('id', id\)\.eq\('status', from\)\.select\('id'\)/)
  assert.match(readFileSync('src/pages/Vacation.jsx', 'utf8'), /vacAction\(v\.id, 'rejected', 'approved'\)/)   // bewusstes Ablehnen genehmigter Überschneidung
  for (const [label, res, kind] of [['schon entschieden', { data: [], error: null }, 'error'], ['entschieden', { data: [{ id: 'v1' }], error: null }, 'success'], ['Fehler', ERR, 'error']]) {
    const toast = spyToast(); const working = []
    const fn = load('src/pages/Vacation.jsx', 'vacAction', { ...common, canManage: true, actionWorking: false, setActionWorking: v => working.push(v), vacations: [], supabase: fakeSupabase({ vacation_requests: res }), toast, profile: { first_name: 'T' }, formatParam: () => '', fetchAll: async () => {}, refetch: () => {} })
    await fn('v1', 'rejected')
    assert.deepEqual(toast.calls.map(c => c[0]), [kind], label)
    assert.equal(working.at(-1), false, `${label}: Sperre frei`)
  }
})

test('Urlaubsantrag zurückziehen, der inzwischen genehmigt wurde → Fehler statt „zurückgezogen“', () => {
  const src = readFileSync('src/pages/Account.jsx', 'utf8')
  assert.match(src, /\.delete\(\)\.eq\('id', v\.id\)\.eq\('status','pending'\)\.select\('id'\)/)
  assert.match(src, /if \(!removed\?\.length\) \{ toast\.error\(appMessage\("error\.bd03e1e5cae8"\)\); fetchData\(\); return \}/)
})

test('Zeiteintrag löschen (Admin): Doppelklick-Sperre wird bei Fehler freigegeben', async () => {
  // Migration 27: Löschen + Protokoll atomar per RPC; Fehler oder success:false → keine Erfolgsmeldung
  for (const res of [ERR, { data: { success: false }, error: null }]) {
    const deleteGuard = guard(); const toast = spyToast(); let refreshed = 0
    const fn = load('src/pages/TimeManagement.jsx', 'confirmDelete', { ...common, deleteGuard, deleteReason: 'Test', deleteModal: { id: 'e1', employee_id: 'x', clock_in: null, clock_out: null }, timeEntryState: () => ({}), breaksByEntry: {}, profile: { id: 'p' }, supabase: fakeSupabase({ 'rpc:admin_delete_time_entry': res }), toast, setDeleteModal: () => {}, setDeleteReason: () => {}, employees: [], fetchEntries: () => refreshed++ })
    await fn()
    assert.equal(deleteGuard.locked, false, 'Sperre frei → erneuter Versuch möglich')
    assert.ok(toast.calls.some(c => c[0] === 'error'))
    assert.ok(!toast.calls.some(c => c[0] === 'success'))
    assert.equal(refreshed, 1, 'Ansicht neu laden (evtl. veraltet)')
  }
})

test('Registrierung ablehnen: Fehler wird gemeldet, nicht „abgelehnt“', async () => {
  // Migration 25: Ablehnen über admin_reject_pending_login (Auth + Profil); Erfolg nur bei success:true
  for (const [res, expectKind] of [[ERR, 'error'], [{ data: { success: false }, error: null }, 'error'], [{ data: { success: true }, error: null }, 'info']]) {
    const toast = spyToast(); const rejectGuard = guard()
    const fn = load('src/pages/UserManagement.jsx', 'confirmReject', { ...common, rejectGuard, confirmDel: { id: 'u1' }, setWorking: () => {}, supabase: fakeSupabase({ 'rpc:admin_reject_pending_login': res }), toast, setConfirmDel: () => {}, fetchAll: () => {} })
    await fn()
    assert.deepEqual(toast.calls.map(c => c[0]), [expectKind])
    assert.equal(rejectGuard.locked, false)
  }
})

test('Mitarbeiter deaktivieren: fehlgeschlagene Zugangssperre wird nicht als „gesperrt“ gemeldet', async () => {
  const run = async profilesResult => {
    const toast = spyToast(); const logs = []
    const fn = load('src/pages/Employees.jsx', 'doDeactivate', { ...common, deactGuard: guard(), confirmDeact: { id: 'e1', name: 'Test Person' }, lockLogin: true, access: { e1: true }, profile: { id: 'admin' }, toLocalDateStr: () => '2026-09-27',
      supabase: fakeSupabase({ employees: { error: null }, profiles: profilesResult }), toast, logActivity: l => logs.push(l), setConfirmDeact: () => {}, setLockLogin: () => {}, fetchEmployees: () => {} })
    await fn()
    const success = toast.calls.find(c => c[0] === 'success')
    return { toast, success, logs }
  }
  const failed = await run(ERR)
  assert.ok(failed.toast.calls.some(c => c[0] === 'error'), 'Fehler der Sperre sichtbar')
  assert.equal(failed.success[1].v.p2, '', 'kein „Zugang gesperrt“ im Erfolgstext')
  assert.doesNotMatch(failed.logs[0].summary, /gesperrt/)
  const ok = await run({ error: null })
  assert.notEqual(ok.success[1].v.p2, '')
  assert.match(ok.logs[0].summary, /App-Zugang gesperrt/)
})

test('Profilbild entfernen: bei Fehler keine Erfolgsmeldung', async () => {
  const toast = spyToast(); let cleared = false
  const fn = load('src/pages/Account.jsx', 'removeAvatar', { ...common, supabase: fakeSupabase({ 'rpc:update_own_avatar': ERR }), toast, setAvatarUrl: () => { cleared = true } })
  await fn()
  assert.equal(cleared, false)
  assert.deepEqual(toast.calls.map(c => c[0]), ['error'])
})

test('Krankmeldung mit Attest: fehlgeschlagene Verknüpfung wird gemeldet', () => {
  const src = readFileSync('src/pages/Vacation.jsx', 'utf8')
  assert.match(src, /const \{ error: linkErr \} = await supabase\.from\('sick_leave'\)\.update\(\{/)
  assert.match(src, /if \(linkErr\) toast\.warn\(messageParts\(\[appMessage\("ui\.c6b3e686f9fd"\), errorMessage\(linkErr\)\]\)\)/)
})

test('Keine Supabase-Schreibaktion ohne Fehlerauswertung in Seiten (außer bewusst tolerierten)', () => {
  const allowed = [
    "src/pages/PayrollDocuments.jsx: await supabase.storage.from('payroll-docs').remove([doc.file_path])",   // Datei nach gelöschtem Datensatz aufräumen
    "src/pages/Employees.jsx: await supabase.storage.from('employee-documents').remove([filePath])",
  ]
  const found = []
  for (const f of ['Shifts', 'UserManagement', 'Employees', 'Account', 'Vacation', 'TimeManagement', 'PayrollDocuments', 'Payroll', 'ClockIn', 'Dashboard', 'MyHours', 'Settings'].map(n => `src/pages/${n}.jsx`)) {
    readFileSync(f, 'utf8').split('\n').forEach(l => { if (/^\s*await supabase\.(from|rpc|storage)/.test(l)) found.push(`${f}: ${l.trim()}`) })
  }
  assert.deepEqual(found.filter(x => !allowed.includes(x)), [])
})
