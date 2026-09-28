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
const common = { appMessage: (k, v) => ({ k, v }), translateSupabaseError: () => 'ERR', errorMessage: e => e?.message, messageParts: a => a, logActivity: () => {} }
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

test('Zeiteintrag löschen (Admin): Doppelklick-Sperre wird bei Fehler freigegeben', async () => {
  const deleteGuard = guard(); const toast = spyToast()
  const fn = load('src/pages/TimeManagement.jsx', 'confirmDelete', { ...common, deleteGuard, deleteReason: 'Test', deleteModal: { id: 'e1', employee_id: 'x', clock_in: null, clock_out: null }, toTime: () => '', profile: { id: 'p' }, supabase: fakeSupabase({ time_entries: ERR }), toast, setDeleteModal: () => {}, setDeleteReason: () => {}, employees: [], fetchEntries: () => {} })
  await fn()
  assert.equal(deleteGuard.locked, false, 'Sperre frei → erneuter Versuch möglich')
  assert.ok(toast.calls.some(c => c[0] === 'error'))
  assert.ok(!toast.calls.some(c => c[0] === 'success'))
})

test('Registrierung ablehnen: Fehler wird gemeldet, nicht „abgelehnt“', async () => {
  for (const [res, expectKind] of [[ERR, 'error'], [{ error: null }, 'info']]) {
    const toast = spyToast(); const rejectGuard = guard()
    const fn = load('src/pages/UserManagement.jsx', 'confirmReject', { ...common, rejectGuard, confirmDel: { id: 'u1' }, setWorking: () => {}, supabase: fakeSupabase({ profiles: res }), toast, setConfirmDel: () => {}, fetchAll: () => {} })
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
    "src/pages/TimeManagement.jsx: await supabase.from('time_corrections').insert([{",                         // Protokoll vor dem Speichern/Löschen
    "src/pages/Employees.jsx: await supabase.storage.from('employee-documents').remove([filePath])",
  ]
  const found = []
  for (const f of ['Shifts', 'UserManagement', 'Employees', 'Account', 'Vacation', 'TimeManagement', 'PayrollDocuments', 'Payroll', 'ClockIn', 'Dashboard', 'MyHours', 'Settings'].map(n => `src/pages/${n}.jsx`)) {
    readFileSync(f, 'utf8').split('\n').forEach(l => { if (/^\s*await supabase\.(from|rpc|storage)/.test(l)) found.push(`${f}: ${l.trim()}`) })
  }
  assert.deepEqual(found.filter(x => !allowed.includes(x)), [])
})
