// Option B: Manager sehen nur operative Daten – Frontend-Regressionen + Migration 19 (synthetische Daten).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeStaffRows, fillEmbeddedEmployees } from '../src/lib/staffMerge.js'

const read = f => readFileSync(f, 'utf8')
const staff = [
  { id: 'a', first_name: 'Test', last_name: 'A', is_active: true, hours_per_week: 40 },
  { id: 'b', first_name: 'Test', last_name: 'B', is_active: false, hours_per_week: 20 },
]

test('mergeStaffRows: ohne Verzeichnis unverändert, mit Verzeichnis operative Liste + eigene volle Zeile', () => {
  const own = [{ id: 'a', first_name: 'Test', last_name: 'A', hourly_rate: 15 }]
  assert.deepEqual(mergeStaffRows(own, null), own)                        // Mitarbeiter / Migration 19 fehlt
  const merged = mergeStaffRows(own, staff)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].hourly_rate, 15)                                 // eigene Zeile bleibt vollständig
  assert.equal('hourly_rate' in merged[1], false)                          // fremde Zeile nur operativ
  assert.equal(mergeStaffRows(own, staff, e => e.is_active).length, 1)
  assert.deepEqual(mergeStaffRows(null, null), [])
})

test('fillEmbeddedEmployees: ergänzt nur fehlende Namen, überschreibt nichts', () => {
  const items = [{ employee_id: 'a', employees: null }, { employee_id: 'b', employees: { first_name: 'X' } }, { employee_id: 'z', employees: null }]
  const out = fillEmbeddedEmployees(items, staff)
  assert.equal(out[0].employees.last_name, 'A')
  assert.equal(out[1].employees.first_name, 'X')
  assert.equal(out[2].employees, null)
  assert.equal(fillEmbeddedEmployees(items, null), items)
})

test('/lohn nur für Admin (Route + Navigation)', () => {
  assert.match(read('src/App.jsx'), /path="\/lohn"\s+element=\{isAdmin\s+\?/)
  const nav = read('src/components/Layout/Sidebar.jsx')
  const managerItems = nav.slice(nav.indexOf('const MANAGER_ITEMS'), nav.indexOf('const ADMIN_ITEMS'))
  const adminItems = nav.slice(nav.indexOf('const ADMIN_ITEMS'))
  assert.doesNotMatch(managerItems, /'\/lohn'/)
  assert.match(adminItems, /'\/lohn'/)
})

test('Dashboard: Personalkosten (aus Löhnen) nur für Admin', () => {
  const src = read('src/pages/Dashboard.jsx')
  assert.match(src, /\/\/ Live-Personalkosten berechnen – nur Admin[^\n]*\n\s*if \(isAdmin\) \{/)
  assert.match(src, /\{isAdmin && laborCosts && \(/)
  assert.doesNotMatch(src, /\{canManage && laborCosts && \(/)
})

test('Mitarbeiterseite: Vergütung, Bank-, Steuer-, SV-Daten und Dokumente nur für Admin', () => {
  const src = read('src/pages/Employees.jsx')
  assert.match(src, /\{isAdmin && <th>\{tr\("ui\.68c8ec0f16c7"\)\}<\/th>\}/)      // Spalte Stundenlohn/Gehalt
  assert.match(src, /\{isAdmin && \(<td>/)
  assert.match(src, /\{isAdmin && payFeatureOn && \(/)
  const personal = src.indexOf('tr("ui.c89f3b303b04")')
  assert.match(src.slice(personal - 200, personal), /\{isAdmin && \(<>/)
  for (const field of ['iban', 'tax_id', 'social_security_number', 'health_insurance']) {
    const i = src.indexOf(`f('${field}'`)
    assert.ok(i > personal, field)                                                   // liegt im Admin-Abschnitt
  }
  assert.match(src, /\{isAdmin && modal === 'edit' && \(/)
  assert.match(src, /const staff = isAdmin \? null : await fetchStaffOperational\(\)/)
})

test('Manager-Seiten laden fremde Mitarbeiter nur operativ', () => {
  for (const f of ['src/pages/Dashboard.jsx', 'src/pages/Vacation.jsx', 'src/pages/AbsenceCalendar.jsx', 'src/pages/Timesheet.jsx', 'src/pages/Employees.jsx'])
    assert.match(read(f), /fetchStaffOperational\(\)/, f)
  assert.doesNotMatch(read('src/lib/staffDirectory.js'), /select\('\*'\)|hourly_rate|monthly_salary|iban/)
})

test('Migration 19: Manager-Leseregeln entfernt, Verzeichnis ohne sensible Spalten', () => {
  const sql = read('supabase/migrations_onboarding/19_manager_data_minimization.sql').replace(/--.*$/gm, '')
  assert.match(sql, /DROP POLICY IF EXISTS emp_manager_read\s+ON public\.employees/)
  assert.match(sql, /DROP POLICY IF EXISTS pay_manager_read\s+ON public\.payroll_months/)
  assert.match(sql, /DROP POLICY IF EXISTS onb_select_staff\s+ON public\.employee_onboarding/)
  assert.match(sql, /CREATE POLICY onb_select_admin ON public\.employee_onboarding FOR SELECT TO authenticated USING \(is_admin\(\)\)/)
  const fn = sql.slice(sql.indexOf('get_staff_operational'), sql.indexOf('REVOKE'))
  for (const col of ['hourly_rate', 'monthly_salary', 'pay_type', 'iban', 'account_holder', 'tax_id', 'social_security_number', 'health_insurance', 'street', 'address', 'notes'])
    assert.doesNotMatch(fn, new RegExp(`\\b${col}\\b`), col)
  assert.match(fn, /WHERE is_manager_or_admin\(\)/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_staff_operational\(\) FROM PUBLIC, anon;/)
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|INSERT)\b/)                          // keine Datenänderung
})
