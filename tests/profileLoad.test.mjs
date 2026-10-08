// Resilience F1: Ein fehlgeschlagener Profil-Request ist nie ein gültiger leerer Zustand – und ersetzt bei bereits geladenem
// Profil nicht mehr die ganze App (Rückkehr in die PWA bei noch fehlendem Netz). Gegenprobe gegen den Stand vor F1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { profileLoadOutcome, isTransientFailure } from '../src/lib/profileLoad.js'

const BEFORE = '3940e9f'   // Stand vor Resilience F1–F4
const read = f => readFileSync(f, 'utf8')
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })

test('Ergebnis: Antwort → apply; vorübergehender Fehler bei geladenem Profil derselben Person → keep; sonst fatal', () => {
  assert.equal(profileLoadOutcome({ failed: false, uid: 'u1', loadedUid: null }), 'apply')
  assert.equal(profileLoadOutcome({ failed: false, uid: 'u1', loadedUid: 'u1' }), 'apply', '„kein Profil“ ist eine gültige Serverantwort')
  assert.equal(profileLoadOutcome({ failed: true, transient: true, uid: 'u1', loadedUid: 'u1' }), 'keep')
  assert.equal(profileLoadOutcome({ failed: true, transient: true, uid: 'u1', loadedUid: null }), 'fatal', 'App-Start: Fehlerbildschirm')
  assert.equal(profileLoadOutcome({ failed: true, transient: true, uid: 'u2', loadedUid: 'u1' }), 'fatal', 'andere Person: nie fremdes Profil behalten')
  assert.equal(profileLoadOutcome({ failed: true, transient: false, uid: 'u1', loadedUid: 'u1' }), 'fatal', 'Server lehnt ab (401/403) → wie bisher')
  assert.equal(profileLoadOutcome({ failed: true, transient: true, uid: null, loadedUid: null }), 'fatal')
})

test('vorübergehend = keine Antwort (status 0, Timeout, Abbruch) oder Serverfehler 5xx; 4xx nicht', () => {
  for (const s of [0, undefined, null, 500, 502, 503, 520]) assert.equal(isTransientFailure(s), true, String(s))
  for (const s of [400, 401, 403, 404, 406, 409]) assert.equal(isTransientFailure(s), false, String(s))
})

// Quelltextprüfung von fetchProfile (App.jsx ist gepinnt; die Ausnahme steht wörtlich in tests/pinView.mjs)
function checkFetchProfile(src) {
  const start = src.indexOf('const fetchProfile = useCallback(')
  const body = src.slice(start, src.indexOf('}, [])', start))
  const errStart = body.indexOf('if (error) {')
  const errBranch = body.slice(errStart, body.indexOf('setFetchErr(', errStart))
  assert.match(errBranch, /profileLoadOutcome\(\{ failed: true, transient: isTransientFailure\(status\), uid, loadedUid: loadedUidRef\.current \}\) === 'keep'/, 'Fehlerzweig prüft zuerst „keep“')
  assert.match(errBranch, /showToast\(appMessage\('app\.profileRefreshFailed'\), 'warn', 6000\)/, 'Hinweis statt Fehlerbildschirm')
  assert.doesNotMatch(errBranch, /setProfile\(null\)/, 'Profil bleibt im keep-Fall erhalten')
  const catchBranch = body.slice(body.indexOf('} catch (err) {'))
  assert.ok(catchBranch.indexOf("=== 'keep'") >= 0 && catchBranch.indexOf("=== 'keep'") < catchBranch.indexOf('setFetchErr('), 'auch Ausnahmen behalten das Profil')
  assert.match(body, /const \{ data, error, status \} = await supabase\s*\n\s*\.from\('profiles'\)/)
  // Zähler: Ladefehler setzt nie „0“
  assert.match(body, /if \(!pErr && !oErr\) setPending\(/)
  assert.match(body, /if \(!vErr\) setVacPending\(/)
  assert.match(body, /if \(!sErr\) setSickPending\(/)
  // Erster Ladevorgang: Fehlerbildschirm bleibt (kein stilles „leer“)
  assert.match(body, /setFetchErr\(\/JWT\|token\/i\.test/)
}

test('App.jsx: Profil-Ladefehler im Hintergrund → Profil behalten + Hinweis; Erststart → Fehlerbildschirm; Zähler nie still 0', () => {
  checkFetchProfile(read('src/App.jsx'))
})

test('Gegenprobe: der Stand vor F1 erfüllt die Prüfung nicht', () => {
  assert.throws(() => checkFetchProfile(atBefore('src/App.jsx')))
})

test('Hinweistext in DE/EN/BN vorhanden', async () => {
  const { de, en } = await import('../src/i18n/catalogs.js')
  const { bn } = await import('../src/i18n/catalogBn.js')
  for (const c of [de, en, bn]) assert.ok(c['app.profileRefreshFailed'])
})
