// Stempeln außerhalb des Cafés (Migration 29) – Client-Seite: wann der Bestätigungsdialog angeboten wird
// (nie für Mitarbeiter, nie bei unbekanntem Standort), echter Dialog-Handler aus ClockIn.jsx gegen eine skriptbare
// Server-Nachbildung (kein False Success, Doppeltipp, Zeitüberschreitung, Serverstand immer neu geladen), DE/EN.
// Die eigentliche Berechtigung prüft der Server: tests/db/remote_clock.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { remoteClockState, remoteErrorKind } from '../src/lib/remoteClockLogic.js'
import { de, en } from '../src/i18n/catalogs.js'

const SRC = readFileSync('src/pages/ClockIn.jsx', 'utf8')
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  let i = SRC.indexOf('{', SRC.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = SRC[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return SRC.slice(SRC.lastIndexOf('\n', start) + 1, i).trim()
}

const base = { canManage: true, located: false, anyConfigured: true, stillChecking: false, netOnly: false, gpsConfigured: true, gpsStatus: 'too-far', netStatus: 'no' }

test('Angebot nur für Manager/Admin mit BESTIMMTEM Standort außerhalb – nie für Mitarbeiter, nie bei unbekanntem Standort', () => {
  assert.equal(remoteClockState(base), 'outside')
  assert.equal(remoteClockState({ ...base, canManage: false }), 'none', 'Mitarbeiter: kein Angebot')
  assert.equal(remoteClockState({ ...base, located: true }), 'none', 'im Café: normaler Weg, keine Warnung')
  assert.equal(remoteClockState({ ...base, anyConfigured: false }), 'none')
  assert.equal(remoteClockState({ ...base, stillChecking: true }), 'checking')
  for (const gpsStatus of ['denied', 'unavailable', 'checking', undefined])
    assert.equal(remoteClockState({ ...base, gpsStatus }), 'unknown', `GPS ${gpsStatus} ≠ außerhalb`)
  assert.equal(remoteClockState({ ...base, netOnly: true, gpsConfigured: false, netStatus: 'no' }), 'outside')
  assert.equal(remoteClockState({ ...base, netOnly: true, gpsConfigured: false, netStatus: 'error' }), 'unknown')
  assert.equal(remoteClockState({ ...base, gpsConfigured: false, netStatus: 'no' }), 'outside')
  assert.equal(remoteClockState({ ...base, gpsConfigured: false, netStatus: 'error' }), 'unknown')
})

test('Server-Antworten werden am HINT/Code erkannt, nie am Text; keine Antwort = Stand neu laden', () => {
  assert.equal(remoteErrorKind({ data: { success: true } }), null)
  for (const h of ['remote_not_allowed', 'inactive', 'location_unknown', 'confirmation_required', 'already_clocked_in', 'not_clocked_in'])
    assert.equal(remoteErrorKind({ error: { hint: h, message: 'egal welcher Text' } }), h)
  assert.equal(remoteErrorKind({ error: { code: '23505' } }), 'already_clocked_in')
  assert.equal(remoteErrorKind({ error: { code: 'PGRST202' } }), 'unavailable')
  assert.equal(remoteErrorKind({ error: { message: 'AbortError' }, status: 0 }), 'no_response')
  assert.equal(remoteErrorKind({ error: { message: 'x', code: 'XX000' } }), 'error')
})

// Echter Handler confirmRemote() aus ClockIn.jsx mit nachgebildeten Abhängigkeiten
function harness(serverResults) {
  const h = { toasts: [], calls: [], fetches: 0, remoteAsk: 'in', working: false, remoteBusy: { current: false } }
  const results = [...serverResults]
  const server = kind => async pos => { h.calls.push([kind, pos]); const r = results.shift(); return typeof r === 'function' ? r() : r }
  const deps = {
    get remoteAsk() { return h.remoteAsk }, remoteBusy: h.remoteBusy, get working() { return h.working },
    setWorking: v => { h.working = v }, setRemoteAsk: v => { h.remoteAsk = v },
    clockInRemote: server('in'), clockOutRemote: server('out'), remoteErrorKind,
    gps: { lat: 50.2, lng: 8.7 },
    toast: { success: m => h.toasts.push(['success', m]), error: m => h.toasts.push(['error', m]), warn: m => h.toasts.push(['warn', m]) },
    appMessage: (k, p) => ({ k, p }), translateSupabaseError: () => ({ k: 'generic' }),
    formatParam: (_t, v) => String(v), fetchData: async () => { h.fetches++ }, notifyTimeDataChanged: () => { h.notified = (h.notified || 0) + 1 },
  }
  const fn = new Function(...Object.keys(deps).filter(k => k !== 'remoteAsk' && k !== 'working'), 'getAsk', 'getWorking',
    `return (${extractFn('confirmRemote').replace(/\bremoteAsk\b/g, 'getAsk()').replace(/\|\| working\)/, '|| getWorking())')})`)
  const args = Object.keys(deps).filter(k => k !== 'remoteAsk' && k !== 'working').map(k => deps[k])
  h.run = fn(...args, () => h.remoteAsk, () => h.working)
  return h
}

test('Erfolg: genau ein Aufruf, Erfolgsmeldung erst nach bestätigter Serverwirkung, Stand neu geladen', async () => {
  const h = harness([{ data: { success: true, remote: true, clock_in: '2026-10-01T06:00:00Z', id: 'x' }, error: null, status: 200 }])
  await h.run()
  assert.deepEqual(h.calls, [['in', { lat: 50.2, lng: 8.7 }]])
  assert.equal(h.toasts.length, 1); assert.equal(h.toasts[0][0], 'success'); assert.equal(h.toasts[0][1].k, 'clock.remote.successIn')
  assert.equal(h.fetches, 1); assert.equal(h.remoteAsk, null); assert.equal(h.working, false); assert.equal(h.remoteBusy.current, false)
})

test('Serverfehler / Rolle entzogen / Standort unbekannt / keine Antwort → nie Erfolg, immer Serverstand neu laden', async () => {
  for (const [res, key] of [
    [{ data: null, error: { hint: 'remote_not_allowed', message: 'x' }, status: 400 }, 'clock.remote.errNotAllowed'],
    [{ data: null, error: { hint: 'location_unknown' }, status: 400 }, 'clock.remote.errUnknown'],
    [{ data: null, error: { hint: 'already_clocked_in' }, status: 400 }, 'clock.remote.errAlreadyIn'],
    [{ data: null, error: { message: 'AbortError' }, status: 0 }, 'clock.remote.errNoResponse'],
    [{ data: null, error: { code: 'PGRST202' }, status: 404 }, 'clock.remote.errUnavailable'],
    [{ data: { success: false }, error: null, status: 200 }, 'generic'],
  ]) {
    const h = harness([res])
    await h.run()
    assert.ok(h.toasts.every(([t]) => t !== 'success'), `kein Erfolg bei ${key}`)
    assert.equal(h.toasts[0]?.[1]?.k, key)
    assert.equal(h.fetches, 1, 'Serverstand ist maßgeblich')
    assert.equal(h.working, false); assert.equal(h.remoteBusy.current, false)
  }
})

test('Wirft der Aufruf unerwartet, bleiben Buttons nicht gesperrt und der Stand wird geladen', async () => {
  const h = harness([() => { throw new Error('boom') }])
  await assert.rejects(h.run())
  assert.equal(h.working, false); assert.equal(h.remoteBusy.current, false); assert.equal(h.fetches, 1)
})

test('Doppeltipp auf „Trotzdem einstempeln“: genau EIN Serveraufruf', async () => {
  let release
  const h = harness([() => new Promise(r => { release = () => r({ data: { success: true, remote: true, clock_in: '2026-10-01T06:00:00Z' }, error: null, status: 200 }) })])
  const first = h.run(); const second = h.run(); const third = h.run()
  await new Promise(r => setTimeout(r, 10)); release()
  await Promise.all([first, second, third])
  assert.equal(h.calls.length, 1)
  assert.equal(h.toasts.filter(([t]) => t === 'success').length, 1)
})

test('Ohne geöffneten Dialog (Abbrechen) wird nichts gesendet', async () => {
  const h = harness([{ data: { success: true } }])
  h.remoteAsk = null
  await h.run()
  assert.equal(h.calls.length, 0); assert.equal(h.toasts.length, 0)
})

test('Ausstempeln außerhalb: „vergessen“ (> 12 h) wird als Warnung gemeldet, nicht als Erfolg', async () => {
  const h = harness([{ data: { success: true, remote: true, notes: '⚠️ AUSSTEMPELN VERGESSEN – …', hours_worked: 0 }, error: null, status: 200 }])
  h.remoteAsk = 'out'
  await h.run()
  assert.deepEqual(h.calls.map(c => c[0]), ['out'])
  assert.equal(h.toasts[0][0], 'warn')
})

test('Dialog: Abbrechen ist Vorauswahl (Fokus/Escape/Tipp daneben), keine Checkbox, normale Wege unverändert', () => {
  const dialog = extractFn('RemoteClockDialog')
  assert.match(dialog, /ref=\{cancelRef\}[^>]*onClick=\{onCancel\}/)
  assert.match(dialog, /cancelRef\.current\?\.focus\(\)/)
  assert.match(dialog, /Escape/)
  assert.match(dialog, /modal-overlay" onClick=\{\(\) => !busy && onCancel\(\)\}/)
  assert.doesNotMatch(dialog, /type="checkbox"/)
  assert.match(dialog, /className="modal-body"/, 'scrollbarer Bereich (globale Dialog-Regeln)')
  // Remote-Aufrufe nur im bestätigten Handler – sonst nirgends
  const lines = SRC.split('\n').filter(l => /clockInRemote|clockOutRemote/.test(l))
  assert.equal(lines.length, 2, 'nur Import + ein Aufruf')
  assert.match(lines[0], /^import \{[^}]*clockInRemote, clockOutRemote \} from '\.\.\/lib\/remoteClock'/)
  assert.ok(extractFn('confirmRemote').includes(lines[1].trim()), 'Aufruf nur im bestätigten Handler')
  // Normales Ein-/Ausstempeln bleibt der bisherige Weg (Server prüft den Standort)
  assert.match(extractFn('clockIn'), /from\('time_entries'\)\.insert/)
  assert.match(extractFn('clockOut'), /\.is\('clock_out', null\)/)
  // Angebot nur, wenn der normale Weg gesperrt ist
  assert.match(SRC, /const remote = canClock \? 'none' : remoteClockState\(/)
})

test('DE und EN: alle Texte vorhanden, inhaltlich wie vorgegeben', () => {
  const keys = Object.keys(de).filter(k => k.startsWith('clock.remote.'))
  assert.ok(keys.length >= 25)
  for (const k of keys) assert.ok(en[k] && en[k] !== de[k] || k === 'clock.remote.method', `EN fehlt: ${k}`)
  for (const k of Object.keys(en).filter(k => k.startsWith('clock.remote.'))) assert.ok(de[k], `DE fehlt: ${k}`)
  for (const k of [...SRC.matchAll(/"(clock\.remote\.[A-Za-z]+)"/g)].map(m => m[1])) assert.ok(de[k] && en[k], `benutzter Schlüssel fehlt: ${k}`)
  assert.equal(de['clock.remote.body1'], 'Du befindest dich außerhalb des Café-Buur-Standorts.')
  assert.equal(en['clock.remote.body1'], 'You are outside the Café Buur location.')
  assert.equal(en['clock.remote.body2'], 'Managers and admins can clock in remotely when necessary.')
  assert.equal(en['clock.remote.question'], 'Are you sure you want to clock in from your current location?')
  assert.equal(de['clock.remote.cancel'], 'Abbrechen'); assert.equal(en['clock.remote.cancel'], 'Cancel')
  assert.equal(de['clock.remote.confirm'], 'Trotzdem einstempeln'); assert.equal(en['clock.remote.confirm'], 'Clock in anyway')
})
