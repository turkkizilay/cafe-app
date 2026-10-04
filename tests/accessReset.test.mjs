// Migration 38 / Edge Functions: temporäres Passwort (Zufall, Format, Regeln), Ablauf und Fehlerpfade der Edge-Kerne
// mit simulierten Abhängigkeiten (kein echtes Supabase), keine Geheimnisse in Logs/Storage, Service-Schlüssel nie im
// Browser-Code, App-Sperre vor dem Profil, und alles Übrige byte-gleich.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as core from '../supabase/functions/_shared/access-reset.js'
import { passwordPolicyProblem as clientPolicy, invokeAccessFn, loadMyAccessState, resetReasonKey, changeReasonKey, maskPassword } from '../src/lib/accessReset.js'
import { de, en } from '../src/i18n/catalogs.js'
import { bn as catalogBn } from '../src/i18n/catalogBn.js'
const catalogs = { de, en }

const read = f => readFileSync(f, 'utf8')
const BEFORE = '5663ecd'
const atBefore = f => execFileSync('git', ['show', `${BEFORE}:${f}`], { encoding: 'utf8' })
const EMP = '10000000-0000-0000-0000-000000000004', UID = '00000000-0000-0000-0000-000000000004', SID = '11111111-2222-3333-4444-555555555555'
const fakeJwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

test('Temporäres Passwort: Format, alle Zeichenklassen, ohne verwechselbare Zeichen, besteht die Regeln, nie doppelt', () => {
  const seen = new Set()
  for (let i = 0; i < 3000; i++) {
    const pw = core.generateTempPassword()
    assert.match(pw, /^[A-HJ-NP-Za-km-np-z2-9]{5}(-[A-HJ-NP-Za-km-np-z2-9]{5}){3}$/)
    assert.ok(/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw))
    assert.equal(core.passwordPolicyProblem(pw), null)
    assert.ok(!seen.has(pw)); seen.add(pw)
  }
  assert.equal(core.TEMP_ALPHABET.length, 56)
  assert.ok(20 * Math.log2(56) > 100, 'über 100 Bit Entropie')
  const src = read('supabase/functions/_shared/access-reset.js')
  assert.doesNotMatch(src, /Math\.random/); assert.match(src, /crypto\.getRandomValues/)
})

test('Zufall gleichverteilt: Verwerfen statt Modulo-Verzerrung; grobe Gleichverteilung über das Alphabet', () => {
  const bytes = [250, 255, 3]   // 256 % 56 = 32 → Grenze 224: 250 und 255 verworfen, 3 genommen
  let i = 0
  assert.equal(core.randomIndex(56, () => [bytes[i++]]), 3)
  assert.equal(i, 3)
  // Deterministisch: Bytes ≥ 224 werden verworfen, danach 0,1,2,… → Gruppen ohne Ziffer/Kleinbuchstabe werden neu gezogen
  const seq = [255, 230, 224]; let n = 0
  assert.equal(core.generateTempPassword(() => [seq.length ? seq.shift() : n++ % 256]), 'stuvw-xyz23-45678-9ABCD')
  const counts = new Map()
  for (let k = 0; k < 2000; k++) for (const ch of core.generateTempPassword().replace(/-/g, '')) counts.set(ch, (counts.get(ch) || 0) + 1)
  assert.equal(counts.size, 56)
  const vals = [...counts.values()], mean = vals.reduce((a, b) => a + b) / vals.length
  assert.ok(Math.max(...vals) < mean * 1.25 && Math.min(...vals) > mean * 0.75, `Verteilung ${Math.min(...vals)}–${Math.max(...vals)} um ${mean}`)
})

test('Passwortregel: Server = Browser; Grenzfälle', () => {
  const samples = ['', 'Abc1!', 'abcdefgh', 'Abcdefgh', 'abcdefg1', 'Abcdefg1', 'abcdef1!', 'ABCDEFGH', 'Ab-cdefg', 'ä'.repeat(36), 'ä'.repeat(37), 'Ab1-' + 'x'.repeat(68), 'Ab1-' + 'x'.repeat(69), null, 12345678]
  for (const s of samples) assert.equal(clientPolicy(s), core.passwordPolicyProblem(s), String(s))
  assert.equal(core.passwordPolicyProblem('Abcdefg1'), null)
  assert.equal(core.passwordPolicyProblem('abcdefg1'), 'too_weak')
  assert.equal(core.passwordPolicyProblem('Ab1!'), 'too_short')
  assert.equal(core.passwordPolicyProblem('Ab1-' + 'x'.repeat(69)), 'too_long', '> 72 Byte (bcrypt)')
})

// Simulierte Edge-Umgebung: zeichnet alle Aufrufe auf
function env({ user = { id: 'admin-1' }, begin = { ok: true, user_id: UID, generation: 3 }, beginError = null, update = { error: null },
               finish = [{ data: { ok: true } }], state = { must_change_password: true, generation: 2 }, change = { error: null }, complete = [{ data: { ok: true } }] } = {}) {
  const calls = [], logs = []
  const fin = [...finish], comp = [...complete]
  return {
    calls, logs,
    deps: {
      auth: {
        getUser: async jwt => { calls.push(['getUser', jwt]); return user ? { data: { user }, error: null } : { data: null, error: { code: 'session_not_found' } } },
        updatePassword: (id, pw) => { calls.push(['updatePassword', id, pw]); return typeof update === 'function' ? update() : Promise.resolve(update) },
      },
      userRpc: (n, a) => { calls.push(['userRpc', n, a]); if (n === 'admin_begin_access_reset') return Promise.resolve({ data: begin, error: beginError }); return Promise.resolve(typeof state === 'function' ? state() : state) },
      serviceRpc: (n, a) => {
        calls.push(['serviceRpc', n, a])
        if (n === 'service_access_reset_finish') { const r = fin.shift() ?? { data: { ok: true } }; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r) }
        if (n === 'service_complete_password_change') return Promise.resolve(comp.shift() ?? { data: { ok: true } })
        return Promise.resolve({ data: { ok: true } })
      },
      changeOwnPassword: (jwt, pw) => { calls.push(['changeOwnPassword', jwt, pw]); return typeof change === 'function' ? change() : Promise.resolve(change) },
      log: c => logs.push(c),
    },
  }
}
const stateRpc = st => ({ data: st, error: null })

test('Admin-Reset: Erfolg – Ziel aus der Datenbank (nie aus dem Request), Passwort nur in der Antwort, Reihenfolge begin → Auth → finish', async () => {
  const e = env()
  let generated
  const r = await core.handleAdminReset({ ...e.deps, jwt: 'admin.jwt', generate: () => (generated = 'Abcde-fgh2k-mnp3q-rst4u'),
    body: { employee_id: EMP, expected_generation: 2, user_id: 'attacker', actor_id: 'x', role: 'admin', auth_user_id: 'attacker' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, temp_password: generated, generation: 3 })
  assert.deepEqual(e.calls.map(c => c[0] + ':' + (c[1] && typeof c[1] === 'string' && c[0] !== 'getUser' && c[0] !== 'updatePassword' ? c[1] : '')),
    ['getUser:', 'userRpc:admin_begin_access_reset', 'updatePassword:', 'serviceRpc:service_access_reset_finish'])
  assert.deepEqual(e.calls[1][2], { p_employee_id: EMP, p_expected_generation: 2 }, 'nur employee_id + Generation an die DB')
  assert.equal(e.calls[2][1], UID, 'Auth-ID aus der DB-Antwort')
  assert.deepEqual(e.calls[3][2], { p_user_id: UID, p_generation: 3 })
  assert.equal(e.logs.length, 0)
})

test('Admin-Reset: Ablehnungen – kein Passwort erzeugt, Auth nie aufgerufen', async () => {
  for (const [opts, body, jwt, status, reason] of [
    [{}, { employee_id: EMP, expected_generation: 0 }, null, 401, 'unauthenticated'],
    [{ user: null }, { employee_id: EMP, expected_generation: 0 }, 'revoked.jwt', 401, 'unauthenticated'],
    [{}, { employee_id: 'nicht-uuid', expected_generation: 0 }, 'j', 400, 'bad_request'],
    [{}, { employee_id: EMP, expected_generation: '0' }, 'j', 400, 'bad_request'],
    [{}, null, 'j', 400, 'bad_request'],
    [{ begin: { ok: false, reason: 'forbidden' } }, { employee_id: EMP, expected_generation: 0 }, 'j', 403, 'forbidden'],
    [{ begin: { ok: false, reason: 'stale', generation: 5 } }, { employee_id: EMP, expected_generation: 0 }, 'j', 409, 'stale'],
    [{ begin: { ok: false, reason: 'in_progress' } }, { employee_id: EMP, expected_generation: 0 }, 'j', 409, 'in_progress'],
    [{ begin: { ok: false, reason: 'owner' } }, { employee_id: EMP, expected_generation: 0 }, 'j', 422, 'owner'],
    [{ begin: null, beginError: { hint: 'session_revoked' } }, { employee_id: EMP, expected_generation: 0 }, 'j', 401, 'unauthenticated'],
    [{ begin: null, beginError: { message: 'boom' } }, { employee_id: EMP, expected_generation: 0 }, 'j', 500, 'server_error'],
  ]) {
    const e = env(opts)
    let gen = 0
    const r = await core.handleAdminReset({ ...e.deps, jwt, body, generate: () => { gen++; return 'x' } })
    assert.deepEqual([r.status, r.body.reason], [status, reason], JSON.stringify([opts, body]))
    assert.equal(r.body.temp_password, undefined)
    assert.equal(gen, 0, 'kein Passwort erzeugt')
    assert.ok(!e.calls.some(c => c[0] === 'updatePassword'))
  }
})

test('Admin-Reset: Auth-Fehler/Zeitüberschreitung/Ausnahme → 502, Fehler protokolliert (nur Code), kein Passwort in Antwort oder Log', async () => {
  const PW = 'Zzzzz-yyyyy-xxxx2-wwwww'
  for (const [update, codeExpected] of [[{ error: { code: 'weak_password', message: `bad ${PW}` } }, 'weak_password'],
                                         [() => new Promise(() => {}), 'auth_timeout'],
                                         [() => { throw new Error(PW) }, 'exception'],
                                         [{ error: { message: 'no code' } }, 'unknown']]) {
    const e = env({ update })
    const r = await core.handleAdminReset({ ...e.deps, jwt: 'j', body: { employee_id: EMP, expected_generation: 0 }, generate: () => PW, timeoutMs: 30 })
    assert.deepEqual([r.status, r.body], [502, { ok: false, reason: 'password_update_failed' }])
    const failed = e.calls.find(c => c[1] === 'service_access_reset_failed')
    assert.deepEqual(failed[2], { p_user_id: UID, p_generation: 3, p_reason: codeExpected })
    assert.ok(!e.calls.some(c => c[1] === 'service_access_reset_finish'), 'kein Abschluss')
    assert.doesNotMatch(JSON.stringify([r, e.logs, failed]), new RegExp(PW))
  }
})

test('Admin-Reset: neuerer Reset dazwischen → 409 ohne Passwort; Abschluss unbestätigt → ein Wiederholungsversuch, dann Passwort mit Hinweis', async () => {
  const e1 = env({ finish: [{ data: { ok: false, reason: 'superseded' } }] })
  const r1 = await core.handleAdminReset({ ...e1.deps, jwt: 'j', body: { employee_id: EMP, expected_generation: 0 } })
  assert.deepEqual([r1.status, r1.body], [409, { ok: false, reason: 'superseded' }])
  const e2 = env({ finish: [new Error('net'), { error: { message: 'db' } }] })
  const r2 = await core.handleAdminReset({ ...e2.deps, jwt: 'j', body: { employee_id: EMP, expected_generation: 0 }, generate: () => 'Aaaaa-bbbbb-ccccc-2dddd' })
  assert.equal(r2.status, 200); assert.equal(r2.body.warning, 'finish_unconfirmed'); assert.equal(r2.body.temp_password, 'Aaaaa-bbbbb-ccccc-2dddd')
  assert.equal(e2.calls.filter(c => c[1] === 'service_access_reset_finish').length, 2)
  const e3 = env({ finish: [{ error: { message: 'db' } }, { data: { ok: true } }] })
  const r3 = await core.handleAdminReset({ ...e3.deps, jwt: 'j', body: { employee_id: EMP, expected_generation: 0 } })
  assert.equal(r3.body.warning, undefined, 'Wiederholung erfolgreich → kein Hinweis')
})

test('Passwortänderung: erst Auth (mit dem JWT der Person), dann Pflicht löschen; aktuelle Sitzung aus dem JWT bleibt', async () => {
  const jwt = fakeJwt({ sub: UID, session_id: SID, role: 'authenticated' })
  const e = env({ user: { id: UID }, state: stateRpc({ must_change_password: true, generation: 2 }) })
  const r = await core.handleCompletePasswordChange({ ...e.deps, jwt, body: { password: 'Neues-Pass1' } })
  assert.deepEqual([r.status, r.body], [200, { ok: true }])
  const names = e.calls.map(c => c[0] === 'userRpc' || c[0] === 'serviceRpc' ? c[1] : c[0])
  assert.deepEqual(names, ['getUser', 'my_access_state', 'changeOwnPassword', 'service_complete_password_change'])
  assert.equal(e.calls[2][1], jwt, 'Auth mit dem JWT der Person (nicht Admin-API)')
  assert.deepEqual(e.calls[3][2], { p_user_id: UID, p_generation: 2, p_keep_session: SID })
  // Gefälschte Felder im Request werden ignoriert
  const e2 = env({ user: { id: UID }, state: stateRpc({ must_change_password: true, generation: 2 }) })
  await core.handleCompletePasswordChange({ ...e2.deps, jwt, body: { password: 'Neues-Pass1', user_id: 'victim', generation: 99 } })
  assert.deepEqual(e2.calls.at(-1)[2], { p_user_id: UID, p_generation: 2, p_keep_session: SID })
})

test('Passwortänderung: Fehlerpfade – Pflicht bleibt bestehen, nie False Success (A), Wiederholung möglich (B)', async () => {
  const jwt = fakeJwt({ sub: UID, session_id: SID })
  const run = async (opts, password = 'Neues-Pass1') => { const e = env({ user: { id: UID }, ...opts }); return { e, r: await core.handleCompletePasswordChange({ ...e.deps, jwt, body: { password }, timeoutMs: 30 }) } }
  let { e, r } = await run({}, 'kurz')
  assert.deepEqual([r.status, r.body.reason], [422, 'too_short']); assert.equal(e.calls.length, 1, 'nur Anmeldung geprüft')
  ;({ e, r } = await run({ state: stateRpc({ must_change_password: false, generation: 2 }) }))
  assert.deepEqual([r.status, r.body.reason], [409, 'not_required']); assert.ok(!e.calls.some(c => c[0] === 'changeOwnPassword'))
  ;({ e, r } = await run({ state: { data: null, error: { hint: 'session_revoked' } } }))
  assert.deepEqual([r.status, r.body.reason], [401, 'unauthenticated'])
  for (const c of ['same_password', 'weak_password', 'reauthentication_needed']) {
    ;({ e, r } = await run({ state: stateRpc({ must_change_password: true, generation: 2 }), change: { error: { code: c } } }))
    assert.deepEqual([r.status, r.body.reason], [422, c])
    assert.ok(!e.calls.some(x => x[1] === 'service_complete_password_change'), 'Pflicht NICHT gelöscht (A)')
    assert.deepEqual(e.calls.find(x => x[1] === 'service_password_change_failed')[2], { p_user_id: UID, p_reason: c })
  }
  ;({ e, r } = await run({ state: stateRpc({ must_change_password: true, generation: 2 }), change: () => new Promise(() => {}) }))
  assert.deepEqual([r.status, r.body.reason], [422, 'password_update_failed'])
  ;({ e, r } = await run({ state: stateRpc({ must_change_password: true, generation: 2 }), complete: [{ error: { message: 'db' } }] }))
  assert.deepEqual([r.status, r.body.reason], [503, 'retry'], 'Passwort gesetzt, Freigabe nicht bestätigt → erneut versuchen (B)')
  ;({ e, r } = await run({ state: stateRpc({ must_change_password: true, generation: 2 }), complete: [{ data: { ok: false, reason: 'superseded' } }] }))
  assert.deepEqual([r.status, r.body.reason], [503, 'superseded'])
  ;({ e, r } = await run({ user: null }))
  assert.deepEqual([r.status, r.body.reason], [401, 'unauthenticated'])
})

test('Edge Functions: Service-Schlüssel nur dort; kein Log von Passwort/Body/Fehlertext; no-store; nur POST', () => {
  for (const f of ['supabase/functions/admin-reset-access/index.ts', 'supabase/functions/complete-password-change/index.ts']) {
    const s = read(f)
    assert.match(s, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/)
    assert.doesNotMatch(s, /console\.log/)
    for (const m of s.matchAll(/console\.error\(([^)]*)\)/g)) assert.doesNotMatch(m[1].replace(/'[^']*'/g, ''), /pw|password|body|err|message|jwt/i, m[0])   // Bezeichner außerhalb des Labels
    assert.match(s, /req\.method !== 'POST'/)
  }
  assert.match(read('supabase/functions/_shared/access-reset.js'), /'Cache-Control': 'no-store'/)
  assert.doesNotMatch(read('supabase/functions/_shared/access-reset.js'), /console\./)
})

test('Browser: kein Service-Schlüssel im Quelltext oder Build; Passwort nie in Storage/Log/Protokoll', () => {
  const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
  for (const f of walk('src')) assert.doesNotMatch(read(f), /service_role|SERVICE_ROLE|serviceRole/i, f)
  if (existsSync('dist')) for (const f of walk('dist').filter(f => /\.(js|html)$/.test(f))) assert.doesNotMatch(read(f), /SERVICE_ROLE|service_role_key/i, f)
  for (const f of ['src/components/AccessResetDialog.jsx', 'src/lib/accessReset.js', 'src/pages/SetNewPassword.jsx']) {
    const s = read(f)
    assert.doesNotMatch(s, /localStorage|sessionStorage|indexedDB|console\.|logActivity|\.from\(/, f)
  }
  assert.match(read('src/components/AccessResetDialog.jsx'), /maskPassword\(password\)/)
})

test('Browser: Fehlerantworten der Edge Function lesbar; Netzwerk; eigener Status blockiert die App nie bei Fehlern', async () => {
  const sb = res => ({ functions: { invoke: async () => res } })
  assert.deepEqual(await invokeAccessFn(sb({ data: { ok: true, temp_password: 'p' }, error: null }), 'f', {}), { ok: true, temp_password: 'p' })
  assert.deepEqual(await invokeAccessFn(sb({ data: null, error: { name: 'FunctionsHttpError', context: { json: async () => ({ ok: false, reason: 'stale', generation: 4 }) } } }), 'f', {}),
                   { ok: false, reason: 'stale', generation: 4 })
  assert.deepEqual(await invokeAccessFn(sb({ data: null, error: { name: 'FunctionsFetchError' } }), 'f', {}), { ok: false, reason: 'network' })
  assert.deepEqual(await invokeAccessFn({ functions: { invoke: async () => { throw new Error('x') } } }, 'f', {}), { ok: false, reason: 'network' })
  const rpc = r => ({ rpc: async () => r })
  assert.deepEqual(await loadMyAccessState(rpc({ data: { must_change_password: true }, error: null })), { mustChange: true, revoked: false })
  assert.deepEqual(await loadMyAccessState(rpc({ data: null, error: { hint: 'session_revoked' } })), { mustChange: false, revoked: true })
  assert.deepEqual(await loadMyAccessState(rpc({ data: null, error: { code: 'PGRST202' } })), { mustChange: false, revoked: false }, 'Funktion fehlt (vor Migration)')
  assert.equal(resetReasonKey('owner'), 'accessReset.reason.owner'); assert.equal(resetReasonKey('nope'), 'accessReset.reason.server_error')
  assert.equal(changeReasonKey('same_password'), 'pwChange.reason.same_password')
  assert.equal(maskPassword('Abcde-fghjk'), '•••••-•••••')
})

test('Verdrahtung: Admin-only Einstieg (unauffällig), Pflichtseite vor dem Profil, Bestätigungs-/Ergebnistexte', () => {
  const emp = read('src/pages/Employees.jsx')
  assert.match(emp, /\{access\[form\.id\] === 'active' && \(\s*<button type="button" data-testid="access-reset-open"/)
  assert.ok(emp.indexOf('data-testid="access-reset-open"') > emp.indexOf('{isAdmin && modal === \'edit\' && ('), 'nur im Admin-Bearbeiten')
  assert.match(emp, /\{isAdmin && accessReset && <AccessResetDialog/)
  const app = read('src/App.jsx')
  assert.ok(app.indexOf('loadMyAccessState(supabase)') < app.indexOf(".from('profiles')"), 'Status vor dem Profil')
  assert.ok(app.indexOf('if (mustChangePw) return (') > app.indexOf('if (!session) return (') && app.indexOf('if (mustChangePw) return (') < app.indexOf('if (fetchErr) return ('))
  const dlg = read('src/components/AccessResetDialog.jsx')
  assert.match(dlg, /if \(busyRef\.current \|\| phase !== 'confirm'\) return/, 'Doppeltipp-Sperre')
  assert.match(dlg, /requestAccessReset\(supabase, employeeId, info\.generation\)/, 'Generation vom Server')
  assert.equal(catalogs.de['accessReset.confirm'], 'Zugang für {name} zurücksetzen? Das bisherige Passwort wird ungültig. Bestehende Sitzungen werden soweit technisch unterstützt beendet. Der Mitarbeiter muss beim nächsten Login ein neues Passwort festlegen.')
  assert.deepEqual([catalogs.de['accessReset.cancel'], catalogs.de['accessReset.submit'], catalogs.de['accessReset.resultTitle'], catalogs.de['accessReset.copy'], catalogs.de['accessReset.onceHint'], catalogs.de['pwChange.title']],
    ['Abbrechen', 'Zugang zurücksetzen', 'Temporärer Zugang erstellt', 'Passwort kopieren', 'Dieses Passwort wird aus Sicherheitsgründen nur einmal angezeigt.', 'Neues Passwort festlegen'])
})

test('i18n: alle neuen Schlüssel DE/EN/BN, BN mit lateinischen Ziffern, jeder Server-Grund übersetzt', () => {
  const keys = Object.keys(catalogs.de).filter(k => /^(accessReset|pwChange)\./.test(k))
  assert.equal(keys.length, 52)
  for (const k of keys) {
    assert.ok(catalogs.en[k] && catalogBn[k], k)
    assert.doesNotMatch(catalogBn[k], /[০-৯]/, k)
    if (catalogs.de[k].includes('{name}')) assert.ok(catalogs.en[k].includes('{name}') && catalogBn[k].includes('{name}'), k)
  }
  for (const r of ['forbidden', 'self', 'owner', 'privileged_role', 'not_active', 'inactive_employee', 'no_login', 'stale', 'in_progress', 'superseded', 'password_update_failed', 'unauthenticated', 'network', 'server_error'])
    assert.ok(catalogs.de[`accessReset.reason.${r}`], r)
})

test('Migration 38: Definer mit search_path, keine Datenänderung an Bestand, Pre-Request + Storage-Sperre, Grants eng', () => {
  const sql = read('supabase/migrations_onboarding/38_admin_access_reset.sql')
  const outside = sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--.*$/gm, '')
  assert.doesNotMatch(outside, /^\s*(UPDATE\s+\S+\s+SET|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/im)
  assert.doesNotMatch(outside, /ALTER TABLE (public\.)?(profiles|employees|time_entries|time_entry_breaks)/i)
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g)) assert.match(m[0], /SET search_path TO 'public'/)
  assert.match(sql, /ALTER ROLE authenticator SET pgrst\.db_pre_request TO 'public\.access_gate';\s*NOTIFY pgrst, 'reload config';/)
  assert.match(sql, /CREATE POLICY access_gate_restrictive ON storage\.objects AS RESTRICTIVE FOR ALL TO authenticated/)
  for (const f of ['service_access_reset_finish(uuid, integer)', 'service_access_reset_failed(uuid, integer, text)', 'service_complete_password_change(uuid, integer, uuid)', 'service_password_change_failed(uuid, text)'])
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f.replace(/[()]/g, '\\$&')} TO service_role;`), f)
  assert.match(sql, /REVOKE ALL ON public\.account_security FROM PUBLIC, anon, authenticated, service_role;/)
  assert.doesNotMatch(sql, /encrypted_password|crypt\(|gen_salt/, 'Passwort nie in SQL')
})

test('REGRESSION: Anmeldung, Passwort-vergessen, Konto, Registrierungs-Reset, Lohn/DATEV, Zeiten, Migrationen 1–37 byte-gleich', () => {
  const files = ['src/components/Auth/Login.jsx', 'src/pages/ResetPassword.jsx', 'src/pages/Account.jsx', 'src/lib/supabase.js', 'src/lib/accountRecovery.js',
    'src/pages/UserManagement.jsx', 'src/pages/Onboarding.jsx', 'src/components/PrivacyAckGate.jsx', 'src/pages/Payroll.jsx', 'src/lib/compensation.js',
    'src/lib/workHours.js', 'src/lib/workTimeModels.js', 'src/lib/breakRules.js', 'src/pages/Timesheet.jsx', 'src/lib/timesheetPdf.js', 'src/pages/MyHours.jsx',
    'src/lib/sickLeaveLogic.js', 'src/lib/vacationLogic.js', 'src/pages/ClockIn.jsx', 'src/pages/TimeManagement.jsx', 'src/pages/Dashboard.jsx',
    'src/components/LiveTimeControl.jsx', 'src/lib/liveTimeControl.js', 'src/pages/PayrollDocuments.jsx',
    ...readdirSync('supabase/migrations_onboarding').filter(f => f < '38').map(f => `supabase/migrations_onboarding/${f}`)]
  for (const f of files) assert.equal(read(f), atBefore(f), f)
})
