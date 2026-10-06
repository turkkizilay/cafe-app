// Zeitkorrektur: Überschneidung verständlich melden (06.10.2026). Production 05.10.: Neuer Eintrag 08:00–16:00 wurde
// korrekt abgelehnt (Migration 37, Person hatte bereits gestempelt), die Meldung nannte aber nur den ersten Konflikt
// minutengenau – ein 5-Sekunden-Fehlstempel als „09:03 – 09:03“ – und wirkte wie ein App-Fehler. Hier: die ECHTE
// doSave-Funktion aus TimeManagement.jsx mit echter Hilfsfunktion, echten Prüfungen (Pausen, Zukunft) und echten
// Übersetzungen; nur Supabase ist nachgebildet. Die Schutzregeln selbst prüft tests/db/time_correction_overlap_ux.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setRuntimeLocale, localizeMessage, message as appMessage, messageParts, errorMessage } from '../src/i18n/runtime.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'
import { timeCorrectionSaveError, isOverlapError } from '../src/lib/timeCorrectionErrors.js'
import { correctionCheck } from '../src/lib/breakRules.js'
import { correctionFutureProblem } from '../src/lib/timeCorrectionRules.js'
import { timeEntryState } from '../src/lib/workHours.js'

const read = f => readFileSync(f, 'utf8')
const M37 = read('supabase/migrations_onboarding/37_time_correction_past_only.sql')
const grab = (src, name) => { const s = src.indexOf(`async function ${name}(`); let i = src.indexOf('{', src.indexOf(')', s)) + 1, d = 1; while (d) { const c = src[i++]; if (c === '{') d++; else if (c === '}') d-- } return src.slice(s, i) }
const TM = read('src/pages/TimeManagement.jsx')
const BREAK_ERROR_KEY = new Function(`return ${TM.slice(TM.indexOf('const BREAK_ERROR_KEY = ') + 'const BREAK_ERROR_KEY = '.length, TM.indexOf('}', TM.indexOf('const BREAK_ERROR_KEY = ')) + 1)}`)()

// Servertexte genau so, wie Migration 37 sie bildet (Vorlage aus der Migration, % durch Werte ersetzt)
const tpl = re => M37.match(re)[1]
const OVERLAP_RPC = tpl(/RAISE EXCEPTION '(Die Zeiten überschneiden sich[^']+)'/)
const OVERLAP_TRG = tpl(/RAISE EXCEPTION '(Der Zeiteintrag überschneidet sich[^']+)'/)
const fill = (t, ...v) => v.reduce((s, x) => s.replace('%', x), t)
const pgErr = (msg, hint, code = 'P0001') => ({ message: msg, hint, code, details: null })

test('Migration 37 unverändert: Überschneidung mit HINT entry_overlap an allen drei Stellen, Format „DD.MM. HH:MI – HH:MI|offen“', () => {
  assert.equal((M37.match(/HINT = 'entry_overlap'/g) || []).length, 4, 'Einstempeln + Neu + Bearbeiten + Konsistenz-Trigger')
  assert.equal((M37.match(/to_char\(v_other\.clock_in AT TIME ZONE 'Europe\/Berlin', 'DD\.MM\. HH24:MI'\), COALESCE\(to_char\(v_other\.clock_out AT TIME ZONE 'Europe\/Berlin', 'HH24:MI'\), 'offen'\)/g) || []).length, 3)
})

test('Erkennung: alle Überschneidungs-Texte (RPC neu/bearbeiten, Trigger) → klare Meldung; Kurz-Eintrag/offen/normal unterschieden', () => {
  setRuntimeLocale('de')
  const cases = [
    [fill(OVERLAP_RPC, '05.10. 09:03', '09:03'), 'Eintrag am 05.10. um 09:03, kürzer als 1 Minute'],
    [fill(OVERLAP_RPC, '05.10. 09:04', '14:04'), 'Eintrag am 05.10. von 09:04 bis 14:04'],
    [fill(OVERLAP_RPC, '05.10. 14:05', 'offen'), 'Eintrag am 05.10. ab 14:05, noch nicht beendet'],
    [fill(OVERLAP_TRG, '05.10. 22:00', '06:00'), 'Eintrag am 05.10. von 22:00 bis 06:00'],
  ]
  for (const [msg, detail] of cases) {
    for (const err of [pgErr(msg, 'entry_overlap'), pgErr(msg, undefined), pgErr(msg, 'entry_overlap', '23514')]) {
      assert.equal(isOverlapError(err), true, msg)
      const out = localizeMessage(timeCorrectionSaveError(err))
      assert.equal(out, `Zeitkorrektur nicht möglich: Für diesen Zeitraum ist bei dieser Person bereits Arbeitszeit erfasst (${detail}). Bitte den bestehenden Eintrag prüfen und anpassen oder löschen. Es wurde nichts gespeichert.`)
      assert.doesNotMatch(out, /P0001|23514|entry_overlap|Person \(/, 'keine Technik-Codes, kein roher Servertext')
    }
  }
  // HINT ohne auswertbaren Text → allgemeine, trotzdem klare Meldung
  assert.equal(localizeMessage(timeCorrectionSaveError(pgErr('irgendwas', 'entry_overlap'))), de['time.overlapBlockedGeneric'])
})

test('Andere Serverfehler bleiben unberührt (null → bisherige Anzeige mit Servertext)', () => {
  for (const err of [
    pgErr(fill(tpl(/RAISE EXCEPTION '(Beginn oder Ende liegt in der Zukunft[^']+)'/), '05.10. 08:00', '20:00'), 'entry_future'),
    pgErr(fill(tpl(/RAISE EXCEPTION '(Der Lohnmonat [^']+)'/), '09/2026'), 'payroll_locked'),
    pgErr('Pause 1: Bitte ein Ende angeben (die Schicht ist beendet).', 'break_missing'),
    pgErr('Der Zeiteintrag wurde inzwischen geändert (z. B. ausgestempelt oder Pause). Bitte die Ansicht aktualisieren und erneut korrigieren.'),
    pgErr('Nicht autorisiert.'), pgErr('Bitte einen Grund für die Korrektur angeben.'),
    { message: 'TypeError: Failed to fetch' }, null, undefined,
  ]) assert.equal(timeCorrectionSaveError(err), null, JSON.stringify(err))
})

test('i18n DE/EN/BN vollständig, gleiche Platzhalter, BN in Bangla-Schrift mit lateinischen Ziffern', () => {
  const ph = s => (s.match(/\{p\d\}/g) || []).sort().join()
  for (const k of ['time.overlapBlocked', 'time.overlapBlockedGeneric', 'time.overlapRange', 'time.overlapRangeShort', 'time.overlapRangeOpen']) {
    assert.ok(de[k] && en[k] && bn[k], k)
    assert.equal(ph(en[k]), ph(de[k]), k); assert.equal(ph(bn[k]), ph(de[k]), k)
    assert.match(bn[k], /[ঀ-৿]/, k); assert.doesNotMatch(bn[k], /[০-৯]/, k)
  }
  for (const loc of ['en', 'bn']) {
    setRuntimeLocale(loc)
    const out = localizeMessage(timeCorrectionSaveError(pgErr(fill(OVERLAP_RPC, '05.10. 09:03', '09:03'), 'entry_overlap')))
    assert.match(out, /05\.10\./); assert.match(out, /09:03/); assert.doesNotMatch(out, /time\.overlap|überschneid/)
  }
  setRuntimeLocale('de')
})

// ── echte doSave aus TimeManagement.jsx ──
const PAST = '2026-10-05'
function harness({ rpcResult, form: formPatch = {}, modal = 'add' }) {
  const toasts = [], calls = [], logs = []; let modalNow = modal, refetch = 0
  const form = { id: null, employee_id: 'emp-1', date: PAST, clock_in_time: '08:00', clock_out_time: '16:00', break_minutes: 0, notes: '', reason: 'Nachtrag', breaks: [], ...formPatch }
  const deps = {
    form, badTimes: {}, modal, entries: [], breaksByEntry: {}, employees: [{ id: 'emp-1', first_name: 'A', last_name: 'B' }],
    toast: { warn: m => toasts.push(['warn', m]), error: (m, d) => toasts.push(['error', m, d]), success: m => toasts.push(['success', m]) },
    appMessage, messageParts, errorMessage, correctionCheck, BREAK_ERROR_KEY, correctionFutureProblem, timeEntryState, timeCorrectionSaveError,
    supabase: { rpc: async (name, args) => { calls.push([name, args]); return rpcResult } },
    setSaving: () => {}, fetchEntries: () => { refetch++ }, logActivity: e => logs.push(e), setModal: m => { modalNow = m }, notifyTimeDataChanged: () => {},
  }
  const doSave = new Function(...Object.keys(deps), `return (${grab(TM, 'doSave')})`)(...Object.values(deps))
  return { run: doSave, toasts, calls, logs, get modal() { return modalNow }, get refetch() { return refetch } }
}
const shown = t => localizeMessage(t[1])

test('UI: Überschneidung → klare Meldung (9 s), Dialog bleibt offen, nichts protokolliert, Liste neu geladen', async () => {
  setRuntimeLocale('de')
  const h = harness({ rpcResult: { data: null, error: pgErr(fill(OVERLAP_RPC, '05.10. 09:03', '09:03'), 'entry_overlap') } })
  await h.run()
  assert.equal(h.calls.length, 1)
  assert.deepEqual([h.calls[0][1].p_in, h.calls[0][1].p_out, h.calls[0][1].p_id], ['08:00', '16:00', null], 'gesendet wird genau 08:00/16:00')
  assert.equal(h.toasts.length, 1); assert.equal(h.toasts[0][0], 'error'); assert.equal(h.toasts[0][2], 9000)
  assert.match(shown(h.toasts[0]), /^Zeitkorrektur nicht möglich: Für diesen Zeitraum ist bei dieser Person bereits Arbeitszeit erfasst \(Eintrag am 05\.10\. um 09:03, kürzer als 1 Minute\)/)
  assert.equal(h.modal, 'add', 'Dialog bleibt offen – Eingaben gehen nicht verloren')
  assert.equal(h.logs.length, 0); assert.equal(h.refetch, 1)
})

test('UI: Zukunft / Lohnmonat / sonstige Serverfehler → unverändert „nicht gespeichert: <Servertext>“', async () => {
  setRuntimeLocale('de')
  for (const err of [pgErr('Beginn oder Ende liegt in der Zukunft (05.10. 08:00 – 20:00). Die Zeitkorrektur ist nur für vergangene Zeiten – laufende Arbeit bitte stempeln.', 'entry_future'),
                     pgErr('Der Lohnmonat 10/2026 ist für diese Person abgeschlossen. Bitte zuerst in der Lohnabrechnung den Monat wieder öffnen.', 'payroll_locked'),
                     pgErr('Nicht autorisiert.')]) {
    const h = harness({ rpcResult: { data: null, error: err } })
    await h.run()
    assert.equal(shown(h.toasts[0]), de['time.saveFailed'] + err.message)
    assert.equal(h.modal, 'add'); assert.equal(h.logs.length, 0)
  }
})

test('UI: normale Zeitkorrektur speichert weiterhin; offenes Ende → p_out = null (nie Ersatzwert)', async () => {
  setRuntimeLocale('de')
  let h = harness({ rpcResult: { data: { success: true, id: 'te-1' }, error: null } })
  await h.run()
  assert.equal(h.toasts[0][0], 'success'); assert.equal(h.modal, null); assert.equal(h.logs.length, 1)
  h = harness({ rpcResult: { data: { success: true, id: 'te-2' }, error: null }, form: { clock_out_time: '' } })
  await h.run()
  assert.equal(h.calls[0][1].p_out, null); assert.equal(h.toasts[0][0], 'success')
})

test('UI: Zukunft wird weiterhin schon im Browser abgelehnt (keine Serveranfrage)', async () => {
  setRuntimeLocale('de')
  const tomorrow = new Date(Date.now() + 36 * 3600e3), d = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  const h = harness({ rpcResult: { data: { success: true }, error: null }, form: { date: d } })
  await h.run()
  assert.equal(h.calls.length, 0); assert.deepEqual([h.toasts[0][0], h.toasts[0][1].key], ['warn', 'time.futureNotAllowed'])
})
