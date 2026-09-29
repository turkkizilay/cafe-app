// Go-Live-Härtung (Audit 2026-09-29): Ausgeschiedene im Austrittsmonat abgerechnet, ungeklärte Zeiteinträge vor
// Abschluss/DATEV sichtbar, Krankmeldungen löscht nur der Admin, Korrekturprotokoll wird ausgewertet,
// Einstempel-Fehler zeigt den echten Serverzustand. DB-Seite: tests/db/ops_integrity.test.mjs (Migration 27).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isUnresolvedEntry, unresolvedByEmployee, FORGOT_CLOCKOUT_MARK } from '../src/lib/workHours.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i)) }

test('Ungeklärte Zeiteinträge: offen oder „Ausstempeln vergessen“; korrigierte/normale nicht', () => {
  assert.equal(isUnresolvedEntry({ clock_out: null, hours_worked: null }), true)
  assert.equal(isUnresolvedEntry({ clock_out: '2026-09-01T20:00:00Z', hours_worked: 0, notes: `⚠️ ${FORGOT_CLOCKOUT_MARK} – Zeit bitte korrigieren (14.2 Std. offen)` }), true)
  assert.equal(isUnresolvedEntry({ clock_out: '2026-09-01T16:00:00Z', hours_worked: 8, notes: '[ADMIN-KORREKTUR] Zeit angepasst' }), false)
  assert.equal(isUnresolvedEntry({ clock_out: '2026-09-01T16:00:00Z', hours_worked: 0, notes: null }), false, '0 Std. allein ist kein Fehler')
  assert.deepEqual(unresolvedByEmployee([
    { employee_id: 'a', clock_out: null }, { employee_id: 'a', clock_out: 'x', notes: FORGOT_CLOCKOUT_MARK },
    { employee_id: 'b', clock_out: 'x', hours_worked: 6 }, { employee_id: 'c', clock_out: null },
  ]), [{ employee_id: 'a', count: 2 }, { employee_id: 'c', count: 1 }])
  assert.deepEqual(unresolvedByEmployee(null), [])
})

test('Lohn: im Monat Ausgeschiedene werden abgerechnet; ungeklärte Einträge blockieren Abschluss/DATEV bis zur Bestätigung', () => {
  const p = read('src/pages/Payroll.jsx')
  assert.match(p, /from\('employees'\)\.select\('\*'\)\.or\(`is_active\.eq\.true,end_date\.gte\.\$\{start\}`\)/, 'Austrittsmonat enthalten')
  assert.doesNotMatch(p, /from\('employees'\)\.select\('\*'\)\.eq\('is_active', true\)/)
  assert.match(p, /from\('time_entries'\)\.select\('employee_id, hours_worked, date, clock_out, notes'\)/)
  assert.match(fn(p, 'finalizeMonth'), /if \(finalizing \|\| rows\.length === 0\) return\s*\n\s*if \(!confirmUnresolved\(\)\) return/)
  assert.match(fn(p, 'handleDatevExport'), /if \(!confirmUnresolved\(\)\) return\s*\n\s*exportDATEV\(allRows, monthLabel\)/)
  assert.match(p, /const confirmUnresolved = \(\) => unresolvedCount === 0 \|\| window\.confirm\(tr\('payroll\.unresolvedConfirm'/)
  assert.match(p, /\{unresolved\.length > 0 && !loading && \(/, 'sichtbarer Hinweis')
})

test('Krankmeldung löschen: im UI nur Admin oder eigene frische Meldung (wie die DB, Migration 27)', () => {
  const v = read('src/pages/Vacation.jsx')
  assert.equal((v.match(/\(isAdmin \|\| \((sc|lv)\.employee_id === profile\?\.employee_id && canSelfDeleteSick\(/g) || []).length, 2)
  assert.doesNotMatch(v, /\(canManage \|\| \((sc|lv)\.employee_id === profile\?\.employee_id && canSelfDeleteSick/)
  assert.match(fn(v, 'deleteSickLeave'), /if \(!isAdmin && !isOwnLeave\) \{/)
})

test('Zeitkorrektur: atomar per RPC (Eintrag + Pausen + Protokoll), mit Ausgangsstand; kein direkter Mehrschritt-Schreibzugriff mehr', () => {
  const t = read('src/pages/TimeManagement.jsx')
  const save = fn(t, 'doSave'), del = fn(t, 'confirmDelete')
  assert.match(save, /supabase\.rpc\('admin_save_time_entry', \{/)
  assert.match(save, /p_expected:\s+orig \? timeEntryState\(orig, breaksByEntry\[orig\.id\] \|\| \[\]\) : null/)
  assert.match(save, /if \(error \|\| !data\?\.success\) \{ toast\.error\([^;]+\); setSaving\(false\); fetchEntries\(\); return \}/)
  assert.match(del, /supabase\.rpc\('admin_delete_time_entry', \{\s*\n\s*p_id: entry\.id, p_reason: deleteReason, p_expected: timeEntryState\(entry,/)
  assert.doesNotMatch(t, /from\('time_(entries|corrections|entry_breaks)'\)\.(insert|update|delete)|syncBreaks|logBreakCorrection/, 'keine Einzelschreibzugriffe')
  assert.doesNotMatch(t, /clock_out_time <= form\.clock_in_time/, 'keine „gleicher Tag“-Annahme')
})

test('Einstempeln: Fehler (z. B. Antwort verloren, erneut getippt) lädt den echten Zustand neu', () => {
  const c = read('src/pages/ClockIn.jsx')
  assert.match(fn(c, 'clockIn'), /if \(error\) \{ toast\.error\([^;]+\); await fetchData\(\); setWorking\(false\); return \}/)
})

test('i18n: neue Texte DE/EN vollständig, Pluralformen und Platzhalter', () => {
  for (const k of ['payroll.unresolvedTitle', 'payroll.unresolvedConfirm']) {
    for (const c of [de, en]) { assert.ok(c[k]?.one && c[k]?.other, k); assert.match(c[k].other, /\{count\}/) }
  }
  for (const k of ['payroll.unresolvedHint', 'time.saveFailed', 'time.deleteFailed', 'time.sameInOut', 'time.nextDay']) { assert.ok(de[k] && en[k], k); assert.notEqual(de[k], en[k]) }
})

test('Offboarding: kürzlich Ausgeschiedene bleiben in Zeitkorrektur und Lohndokumenten auswählbar (ohne Reaktivieren)', async () => {
  const { formerStaffCutoff } = await import('../src/lib/workHours.js')
  assert.equal(formerStaffCutoff(new Date(2026, 8, 29)), '2025-09-01')
  assert.equal(formerStaffCutoff(new Date(2026, 0, 15)), '2025-01-01')
  for (const f of ['src/pages/TimeManagement.jsx', 'src/pages/PayrollDocuments.jsx']) {
    const s = read(f)
    assert.match(s, /\.or\(`is_active\.eq\.true,end_date\.gte\.\$\{formerStaffCutoff\(\)\}`\)/, f)
    assert.doesNotMatch(s, /from\('employees'\)[^\n]*\n?[^\n]*\.eq\('is_active', true\)/, f)
    assert.match(s, /\{e\.is_active === false \? tr\('employee\.archivedSuffix'\) : ''\}/, `${f}: als archiviert gekennzeichnet`)
  }
})
