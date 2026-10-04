// Production-Polish (Oktober 2026): Mitarbeiter-Bearbeitung ohne getroffene Zeile ist kein Erfolg; Admin-Erfassung
// fremder Daten ohne Autofill (eigene Adresse/Telefon des Admins nie eingefügt), Telefonfelder mit Zifferntastatur;
// Touch-Ziele ≥ 44 px auch für Icon-Buttons; Icon-Buttons mit übersetztem Namen; Lohn/Zeit/Account-Reset unverändert.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'
import { pinView } from './pinView.mjs'   // Pin-Ausnahme Production-Polish (nur a11y + Schichttausch-Fix; Lohn/Stundennachweis ohne Ausnahme)

const read = f => readFileSync(f, 'utf8')
const BEFORE = '56d47a3'
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

test('Mitarbeiter bearbeiten: 0 getroffene Zeilen (gelöscht/keine Berechtigung) → Fehlermeldung statt „gespeichert“', () => {
  const s = read('src/pages/Employees.jsx')
  const check = s.indexOf(`if (modal === 'edit' && !saved) { setError(appMessage("employee.saveNoRows")); fetchEmployees(); return }`)
  const success = s.indexOf(`else toast.success(appMessage("ui.4424bc9901a8"))`)
  assert.ok(check > 0 && check < success, 'Prüfung vor der Erfolgsmeldung')
  assert.match(s, /: await supabase\.from\('employees'\)\.update\(payload\)\.eq\('id', form\.id\)\.select\('id'\)\.maybeSingle\(\)/, 'Update liefert die getroffene Zeile')
})

test('Admin erfasst Daten anderer Personen: kein Autofill, Telefon mit Zifferntastatur', () => {
  const s = read('src/pages/Employees.jsx')
  const start = s.indexOf(`f('first_name'`), end = s.indexOf(`f('emergency_contact_phone'`) + 200
  const inputs = s.slice(start - 200, end).match(/<input\b[^>]*>/g) || []
  const text = inputs.filter(i => !/type="(radio|checkbox|date|number|file)"/.test(i))
  assert.ok(text.length >= 20, `${text.length} Textfelder`)
  for (const i of text) assert.match(i, /autoComplete="off"/, i.slice(0, 90))
  for (const k of ['phone', 'emergency_contact_phone']) assert.match(s, new RegExp(`<input[^>]*type="tel" inputMode="tel" autoComplete="off" value=\\{form\\.${k} \\|\\| ''\\}`), k)
})

test('Touch: Buttons ≥ 44 × 44 px (auch Icon-Buttons), Checkboxen ≥ 20 px, Rechtslinks mit Tippfläche – nur bei Touch', () => {
  const css = read('src/index.css')
  const block = css.slice(css.indexOf('@media (pointer: coarse) {'), css.indexOf('}', css.indexOf('.legal-links a { display: inline-block')) + 1)
  assert.match(block, /\.btn \{ min-height: 44px; min-width: 44px; \}/)
  assert.match(block, /input\[type="checkbox"\], input\[type="radio"\] \{ min-width: 20px; min-height: 20px; \}/)
  assert.match(block, /\.legal-links a \{ display: inline-block; padding: 10px 4px; \}/)
})

test('Icon-Buttons (✕ ← → ✓ ✗ 🗑) haben einen übersetzten Namen – überall außer Lohn/Stundennachweis (eingefroren)', () => {
  for (const f of ['src/pages/Employees.jsx', 'src/pages/AbsenceCalendar.jsx', 'src/components/RetentionCard.jsx', 'src/components/SickCasesPanel.jsx', 'src/components/CafeNetworkCard.jsx', 'src/components/UI/ImageCropper.jsx',
    'src/pages/Vacation.jsx', 'src/pages/TimeManagement.jsx', 'src/pages/PayrollDocuments.jsx', 'src/pages/UserManagement.jsx', 'src/pages/Account.jsx', 'src/pages/Shifts.jsx']) {
    const s = read(f)
    for (const m of s.matchAll(/<button\b([^>]*)>\s*(✕|←|→|✓|✗|🗑|🔗)\s*<\/button>/g))
      assert.match(m[1], /aria-label=|title=/, `${f}: ${m[0].slice(0, 80)}`)
  }
})

test('i18n: neue Texte DE/EN/BN vollständig, BN mit lateinischen Ziffern', () => {
  const keys = ['employee.saveNoRows', 'a11y.close', 'a11y.remove', 'a11y.cancel', 'a11y.previous', 'a11y.next', 'a11y.approve', 'a11y.reject', 'a11y.save', 'a11y.delete']
  for (const k of keys) { assert.ok(de[k] && en[k] && bn[k], k); assert.doesNotMatch(bn[k], /[০-৯]/, k) }
})

test('REGRESSION: Lohn/DATEV, Stundennachweis, Zeitkorrektur, Schichten, Urlaub/Krankheit, Lohndokumente, Konto, Benutzer, Auth/Account-Reset byte-gleich', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/pages/Timesheet.jsx', 'src/pages/TimeManagement.jsx', 'src/pages/Shifts.jsx', 'src/pages/Vacation.jsx',
    'src/pages/PayrollDocuments.jsx', 'src/pages/Account.jsx', 'src/pages/UserManagement.jsx', 'src/pages/ClockIn.jsx', 'src/pages/Dashboard.jsx',
    'src/App.jsx', 'src/lib/supabase.js', 'src/lib/accessReset.js', 'src/components/AccessResetDialog.jsx', 'src/pages/SetNewPassword.jsx',
    'src/components/Auth/Login.jsx', 'src/pages/ResetPassword.jsx', 'src/lib/compensation.js', 'src/lib/workHours.js', 'src/lib/breakRules.js',
    'src/components/UI/TimeInput24.jsx', 'src/lib/activityLog.js', 'src/legal/legalContent.js'])
    assert.equal(pinView(f, read(f)), pinView(f, atBefore(f)), f)
})

test('STRENG: Payroll.jsx und Timesheet.jsx sowie alle Migrationen byte-gleich – ohne jede Pin-Ausnahme', () => {
  for (const f of ['src/pages/Payroll.jsx', 'src/pages/Timesheet.jsx', 'src/lib/timesheetPdf.js', 'src/lib/compensation.js', 'src/lib/workHours.js', 'src/lib/workTimeModels.js',
    ...readdirSync('supabase/migrations_onboarding').map(f => `supabase/migrations_onboarding/${f}`), ...readdirSync('supabase/functions/_shared').map(f => `supabase/functions/_shared/${f}`)])
    assert.equal(read(f), atBefore(f), f)
})

test('Einladung: E-Mail-Feld ohne Autofill (Adresse des Admins nie in fremde Einladung)', () => {
  assert.match(read('src/pages/UserManagement.jsx'), /<input[^>]*type="email" autoComplete="off" value=\{inviteForm\.email\}/)
})
