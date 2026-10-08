// Resilience F3: zentraler Request-Timeout (src/lib/requestTimeout.js, eingebunden in src/lib/supabase.js).
// Lesen und Schreiben getrennt; Auth/Storage/Edge Functions unverändert; keine automatische Wiederholung; ein Schreib-
// Timeout wird nie als „fehlgeschlagen“ gemeldet. Teil 2 prüft mit der ECHTEN supabase-js/postgrest-js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { withRequestTimeout, timeoutPolicy, timeoutKind, REQUEST_TIMEOUT_MS, TIMEOUT_READ, TIMEOUT_WRITE } from '../src/lib/requestTimeout.js'
import { translateSupabaseError } from '../src/lib/errorHelper.js'
import { setRuntimeLocale, localizeMessage } from '../src/i18n/runtime.js'
import { remoteErrorKind } from '../src/lib/remoteClockLogic.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'

const BEFORE = '3940e9f'
const read = f => readFileSync(f, 'utf8')
const URL_ = 'https://proj.supabase.co'

// Fake-Timer: Callbacks werden gesammelt und gezielt ausgelöst
function fakeTimers() {
  const timers = new Map(); let id = 0
  return { timers, setTimer: (f, ms) => { timers.set(++id, { f, ms }); return id }, clearTimer: i => timers.delete(i),
    fire(ms) { for (const [i, t] of [...timers]) if (t.ms === ms) { timers.delete(i); t.f() } } }
}
// fetch, der nie antwortet, aber das Signal beachtet (wie der Browser)
function hangingFetch(log = []) {
  return (input, init) => { log.push({ input: String(input), init }); return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true })
  }) }
}

test('Richtlinie: nur PostgREST; GET/HEAD = Lesen, alles andere (auch rpc) = Schreiben; Auth/Storage/Functions ohne Timeout', () => {
  assert.equal(timeoutPolicy(`${URL_}/rest/v1/time_entries?select=*`, { method: 'GET' }), 'read')
  assert.equal(timeoutPolicy(`${URL_}/rest/v1/time_entries?select=*`, undefined), 'read', 'ohne Methode = GET')
  assert.equal(timeoutPolicy(`${URL_}/rest/v1/vacation_requests`, { method: 'HEAD' }), 'read')
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(timeoutPolicy(`${URL_}/rest/v1/shifts`, { method: m }), 'write', m)
  assert.equal(timeoutPolicy(`${URL_}/rest/v1/rpc/start_break`, { method: 'POST' }), 'write')
  assert.equal(timeoutPolicy(`${URL_}/rest/v1/rpc/clock_network_status`, { method: 'POST' }), 'write', 'unbekannt ob schreibend → wie Schreiben')
  for (const p of ['/auth/v1/token?grant_type=refresh_token', '/auth/v1/logout', '/auth/v1/user', '/storage/v1/object/sick-certs/a.pdf', '/functions/v1/admin-reset-access'])
    assert.equal(timeoutPolicy(`${URL_}${p}`, { method: 'POST' }), null, p)
  assert.equal(timeoutPolicy({ url: `${URL_}/rest/v1/x`, method: 'DELETE' }, undefined), 'write', 'Request-Objekt')
  assert.ok(REQUEST_TIMEOUT_MS.read >= 20000 && REQUEST_TIMEOUT_MS.write > 30000, 'über den Grenzen von boundedRequest (20/25/30 s)')
})

test('READ-Timeout: hängender GET endet nach dem Lese-Budget als AbortError „request-timeout-read“', async () => {
  const t = fakeTimers(), log = []
  const f = withRequestTimeout(hangingFetch(log), t)
  const p = f(`${URL_}/rest/v1/profiles?id=eq.1`, { method: 'GET', headers: {} })
  await Promise.resolve()
  assert.equal(log.length, 1); assert.ok(log[0].init.signal, 'Signal gesetzt')
  t.fire(REQUEST_TIMEOUT_MS.write); await Promise.resolve()   // falsches Budget: nichts passiert
  t.fire(REQUEST_TIMEOUT_MS.read)
  await assert.rejects(p, e => e.name === 'AbortError' && e.message === TIMEOUT_READ)
  assert.equal(t.timers.size, 0, 'kein Timer-Leck')
})

test('MUTATION-Timeout: hängender POST endet nach dem Schreib-Budget als „request-timeout-write“ – genau EIN Versuch', async () => {
  const t = fakeTimers(), log = []
  const p = withRequestTimeout(hangingFetch(log), t)(`${URL_}/rest/v1/time_entries`, { method: 'POST', body: '[]' })
  t.fire(REQUEST_TIMEOUT_MS.read); await Promise.resolve()
  t.fire(REQUEST_TIMEOUT_MS.write)
  await assert.rejects(p, e => e.name === 'AbortError' && e.message === TIMEOUT_WRITE)
  assert.equal(log.length, 1, 'keine Wiederholung')
})

test('Auth/Storage/Functions: unverändert durchgereicht (kein Signal, kein Timer)', async () => {
  const t = fakeTimers(), seen = []
  const f = withRequestTimeout((input, init) => { seen.push(init); return Promise.resolve('ok') }, t)
  const init = { method: 'POST', headers: { a: 1 } }
  for (const p of ['/auth/v1/token?grant_type=refresh_token', '/storage/v1/object/payroll-docs/x.pdf', '/functions/v1/complete-password-change'])
    assert.equal(await f(`${URL_}${p}`, init), 'ok')
  assert.ok(seen.every(i => i === init), 'dasselbe init-Objekt')
  assert.equal(t.timers.size, 0)
})

test('Abbruch durch den Aufrufer (boundedRequest/Dialog) wird mit SEINEM Grund durchgereicht, Timer + Listener aufgeräumt', async () => {
  const t = fakeTimers(), outer = new AbortController()
  const p = withRequestTimeout(hangingFetch(), t)(`${URL_}/rest/v1/invitations`, { method: 'GET', signal: outer.signal })
  const reason = new DOMException('Dialog geschlossen', 'AbortError')
  outer.abort(reason)
  await assert.rejects(p, e => e === reason)
  assert.equal(t.timers.size, 0)
  const pre = new AbortController(); pre.abort(reason)
  await assert.rejects(withRequestTimeout(hangingFetch(), t)(`${URL_}/rest/v1/x`, { signal: pre.signal }), e => e === reason)
  // Browser ohne signal.reason (ältere Safari): Abbruch des Aufrufers ist trotzdem KEIN Timeout
  const legacy = { aborted: false, reason: undefined, l: null, addEventListener(_, f) { this.l = f }, removeEventListener() { this.l = null } }
  const q = withRequestTimeout(hangingFetch(), t)(`${URL_}/rest/v1/x`, { method: 'POST', signal: legacy })
  legacy.aborted = true; legacy.l()
  await assert.rejects(q, e => e.name === 'AbortError' && timeoutKind(e) === null)
  assert.equal(t.timers.size, 0)
})

test('Antwort rechtzeitig → unverändert zurück, Timer gelöscht; fetch ohne Signal-Beachtung endet trotzdem', async () => {
  const t = fakeTimers()
  const res = { status: 200 }
  assert.equal(await withRequestTimeout(() => Promise.resolve(res), t)(`${URL_}/rest/v1/x`, {}), res)
  assert.equal(t.timers.size, 0)
  const deaf = withRequestTimeout(() => new Promise(() => {}), t)(`${URL_}/rest/v1/x`, { method: 'PATCH' })
  t.fire(REQUEST_TIMEOUT_MS.write)
  await assert.rejects(deaf, e => e.message === TIMEOUT_WRITE)
})

test('Skew-Retry (401 „issued at future“) läuft innerhalb EINES Budgets weiter', async () => {
  const t = fakeTimers(); let calls = 0
  const skewLike = async (input, init) => { calls++; if (calls === 1) return { status: 401 }; return hangingFetch()(input, init) }
  const outerFetch = async (input, init) => { const r = await skewLike(input, init); if (r.status === 401) return skewLike(input, init); return r }
  const p = withRequestTimeout(outerFetch, t)(`${URL_}/rest/v1/x`, {})
  await new Promise(r => setTimeout(r, 0))
  assert.equal(t.timers.size, 1, 'ein Budget für den ganzen Lauf')
  t.fire(REQUEST_TIMEOUT_MS.read)
  await assert.rejects(p, e => e.message === TIMEOUT_READ)
  assert.equal(calls, 2)
})

// ── Teil 2: echte supabase-js/postgrest-js ──
function client(fetchImpl) {
  return createClient(URL_, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchImpl } })
}
const SHORT = { ms: { read: 40, write: 60 } }

test('echtes supabase-js: hängender LESE-Request → { status: 0, error } nach dem Budget, KEINE automatische Wiederholung', async () => {
  const log = []
  const sb = client(withRequestTimeout(hangingFetch(log), SHORT))
  const t0 = Date.now()
  const r = await sb.from('profiles').select('*').eq('id', 'u1').maybeSingle()
  assert.equal(r.status, 0); assert.equal(r.data, null)
  assert.equal(timeoutKind(r.error), 'read')
  assert.ok(Date.now() - t0 < 2000, 'endet nach dem Budget (keine 1/2/4-s-Wiederholungen)')
  assert.equal(log.filter(l => l.input.includes('/rest/v1/profiles')).length, 1, 'postgrest-js wiederholt den AbortError nicht')
})

test('echtes supabase-js: hängende MUTATION (insert/update/rpc) → status 0 + Schreib-Timeout, genau ein Versuch', async () => {
  for (const run of [sb => sb.from('time_entries').insert([{ employee_id: 'e1' }]),
                     sb => sb.from('time_entries').update({ clock_out: 'x' }).eq('id', 't1').is('clock_out', null).select('id').maybeSingle(),
                     sb => sb.rpc('start_break')]) {
    const log = []
    const r = await run(client(withRequestTimeout(hangingFetch(log), SHORT)))
    assert.equal(r.status, 0); assert.equal(timeoutKind(r.error), 'write')
    assert.equal(log.length, 1, 'nie blind wiederholt')
  }
})

test('Gegenprobe: ohne Wrapper bleibt derselbe Request unbegrenzt offen', async () => {
  const sb = client(hangingFetch())
  const r = await Promise.race([sb.from('profiles').select('*'), new Promise(res => setTimeout(() => res('noch offen'), 300))])
  assert.equal(r, 'noch offen')
})

test('Meldungen: Schreib-Timeout = „möglicherweise gespeichert – prüfen“, nie „fehlgeschlagen“; Lese-Timeout = „erneut versuchen“', () => {
  const w = translateSupabaseError({ message: `AbortError: ${TIMEOUT_WRITE}`, hint: 'Request was aborted (timeout or manual cancellation)', code: '' }, 'Einstempeln')
  const r = translateSupabaseError({ message: `AbortError: ${TIMEOUT_READ}`, code: '' })
  for (const [loc, cat] of [['de', de], ['en', en], ['bn', bn]]) {
    setRuntimeLocale(loc)
    assert.equal(localizeMessage(w), cat['error.timeoutWrite']); assert.equal(localizeMessage(r), cat['error.timeoutRead'])
  }
  setRuntimeLocale('de')
  assert.match(de['error.timeoutWrite'], /möglicherweise trotzdem gespeichert/); assert.doesNotMatch(de['error.timeoutWrite'], /fehlgeschlagen|nicht gespeichert/i)
  assert.match(en['error.timeoutWrite'], /may have been saved/); assert.doesNotMatch(en['error.timeoutWrite'], /failed/i)
  // bestehende Zuordnungen unverändert
  assert.equal(localizeMessage(translateSupabaseError({ code: 'P0001', message: 'Bereits eingeclockt.' })), '❌ Bereits eingeclockt.')
  assert.equal(timeoutKind({ message: 'TypeError: Failed to fetch' }), null)
  // Remote-Stempeln: status 0 bleibt „keine Antwort“ → Stand neu laden (unverändert)
  assert.equal(remoteErrorKind({ error: { message: `AbortError: ${TIMEOUT_WRITE}` }, status: 0 }), 'no_response')
})

test('supabase.js: bestehender fetch (fetchWithSkewRetry) nur umhüllt; Stand vor F3 ohne Timeout', () => {
  const now = read('src/lib/supabase.js'), before = execFileSync('git', ['show', `${BEFORE}:src/lib/supabase.js`], { encoding: 'utf8' })
  assert.match(now, /\{ global: \{ fetch: withRequestTimeout\(\(\.\.\.args\) => fetchWithSkewRetry\(\.\.\.args\)\) \} \}/)
  assert.doesNotMatch(before, /withRequestTimeout/)
  const fn = s => s.slice(s.indexOf('export async function fetchWithSkewRetry'), s.indexOf('export const supabase'))
  assert.equal(fn(now), fn(before), 'fetchWithSkewRetry unverändert')
})
