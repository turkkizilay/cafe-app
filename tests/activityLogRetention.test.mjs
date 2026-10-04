// Migration 39: Die 12-Monats-Frist des Aktivitätsprotokolls setzt der Server (pg_cron) durch. Der Browser ruft
// cleanup_old_activity_logs nicht mehr auf (lieferte immer 403: EXECUTE nur postgres/service_role – richtig so, die
// Funktion prüft keine Rolle). Rechtstext bleibt „12 Monate“; activityLog.js (i18n-geschützt) unverändert.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pinView } from './pinView.mjs'   // Pin-Ausnahme Production-Polish (nur a11y + Schichttausch-Fix; Lohn/Stundennachweis ohne Ausnahme)

const read = f => readFileSync(f, 'utf8')
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const BEFORE = '441d7dd'
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

test('Browser ruft die Aufräumfunktion nicht mehr auf (kein 403 beim Öffnen des Protokolls)', () => {
  const page = read('src/pages/ActivityLog.jsx')
  assert.doesNotMatch(page, /triggerLogCleanup|cleanup_old_activity_logs/)
  for (const f of walk('src').filter(f => /\.(jsx?|mjs)$/.test(f) && f !== join('src', 'lib', 'activityLog.js')))
    assert.doesNotMatch(read(f), /triggerLogCleanup\(|cleanup_old_activity_logs/, f)
  assert.match(page, /useRefreshHandler\(\(\) => loadEntries\(true\)\)/, 'Laden + Aktualisieren unverändert')
})

test('Frist im Rechtstext bleibt 12 Monate = Funktion; Migration 39 nur Job + Rechte, keine Daten', () => {
  assert.match(read('src/legal/legalContent.js'), /Protokolleinträge 12 Monate/)
  const sql = read('supabase/migrations_onboarding/39_activity_log_retention_job.sql')
  const code = sql.replace(/\$cron\$[\s\S]*?\$cron\$/g, '').replace(/--.*$/gm, '')
  assert.doesNotMatch(code, /\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET|INSERT\s+INTO|TRUNCATE|ALTER\s+TABLE|CREATE\s+OR\s+REPLACE\s+FUNCTION)\b/i)
  assert.match(sql, /SELECT cron\.schedule\('cafe-activity-log-retention', '30 3 \* \* \*', \$cron\$SELECT public\.cleanup_old_activity_logs\(\)\$cron\$\);/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.cleanup_old_activity_logs\(\) FROM PUBLIC, anon, authenticated;/)
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.cleanup_old_activity_logs\(\) TO (?!service_role;)/, 'kein Recht für Browser-Rollen')
})

test('REGRESSION: activityLog.js (geschützt), Protokoll-Schreiben, Account-Reset, Zeiterfassung, Lohn, Migrationen 1–38 byte-gleich', () => {
  for (const f of ['src/lib/activityLog.js', 'src/legal/legalContent.js', 'src/App.jsx', 'src/lib/accessReset.js', 'src/pages/TimeManagement.jsx',
    'src/components/UI/TimeInput24.jsx', 'src/pages/Payroll.jsx', 'src/pages/Dashboard.jsx', 'supabase/functions/_shared/access-reset.js',
    ...readdirSync('supabase/migrations_onboarding').filter(f => f < '39').map(f => `supabase/migrations_onboarding/${f}`)])
    assert.equal(pinView(f, read(f)), pinView(f, atBefore(f)), f)
})
