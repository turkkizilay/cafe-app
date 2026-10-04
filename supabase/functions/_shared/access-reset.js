// Kern der Edge Functions „admin-reset-access“ und „complete-password-change“ (Migration 38).
// Rein (Abhängigkeiten werden übergeben) → in Deno ausgeführt, in Node getestet.
// Regeln: Passwörter werden NIE geloggt, gespeichert oder in Fehlermeldungen übernommen; der Service-Schlüssel bleibt
// in der Edge Function; Ziel und handelnde Person bestimmt ausschließlich der Server (JWT + Datenbank).

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'    // ohne I, O
const LOWER = 'abcdefghijkmnpqrstuvwxyz'    // ohne l, o
const DIGIT = '23456789'                    // ohne 0, 1
export const TEMP_ALPHABET = UPPER + LOWER + DIGIT   // 56 Zeichen, gut abzulesen
export const TEMP_GROUPS = 4, TEMP_GROUP_LEN = 5      // „Abcde-fgh2k-…“: 20 Zufallszeichen ≈ 116 Bit

const defaultRng = n => crypto.getRandomValues(new Uint8Array(n))

// Gleichverteilter Index ohne Modulo-Verzerrung (Verwerfen der Bytes ≥ größtem Vielfachen von n)
export function randomIndex(n, rng = defaultRng) {
  const limit = 256 - (256 % n)
  for (;;) { const b = rng(1)[0]; if (b < limit) return b % n }
}

// Temporäres Passwort: kryptografisch zufällig, nicht vom Admin gewählt, ohne Personenbezug. Bindestriche = Sonderzeichen,
// mindestens ein Groß-, Kleinbuchstabe und eine Ziffer (sonst neu ziehen) → erfüllt die Passwortregeln.
export function generateTempPassword(rng = defaultRng) {
  for (;;) {
    const groups = []
    for (let g = 0; g < TEMP_GROUPS; g++) {
      let s = ''
      for (let i = 0; i < TEMP_GROUP_LEN; i++) s += TEMP_ALPHABET[randomIndex(TEMP_ALPHABET.length, rng)]
      groups.push(s)
    }
    const pw = groups.join('-')
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw
  }
}

// Passwortregel wie in der App (≥ 8 Zeichen und mind. zwei von Großbuchstabe/Ziffer/Sonderzeichen), Obergrenze bcrypt 72 Byte
export function passwordPolicyProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'too_short'
  if (new TextEncoder().encode(pw).length > 72) return 'too_long'
  if ([/[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length < 2) return 'too_weak'
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const reply = (status, body) => ({ status, body })
const hintOf = e => String(e?.hint || '')

export function bearer(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim())
  return m ? m[1] : null
}

// Nutzlast eines (bereits von Auth geprüften) JWT lesen – nur für session_id
export function jwtPayload(jwt) {
  try {
    const p = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(p + '==='.slice((p.length + 3) % 4)))
  } catch { return {} }
}

export async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ error: { code: 'auth_timeout' } }), ms) })])
  } finally { clearTimeout(timer) }
}

// RPC-/Auth-Aufruf ohne Ausnahme (PostgREST-Builder sind nur „thenable“, Netzwerkfehler werfen)
async function call(fn) {
  try { return (await fn()) || {} } catch { return { error: { code: 'exception' } } }
}

const code = e => {
  const c = String(e?.code || e?.error_code || '').toLowerCase()
  return /^[a-z0-9_]{1,40}$/.test(c) ? c : 'unknown'
}

// Angemeldete Person über Auth bestätigen (Auth lehnt Tokens beendeter Sitzungen ab: session_not_found)
async function caller(jwt, auth) {
  if (!jwt) return null
  try {
    const { data, error } = await auth.getUser(jwt)
    return !error && data?.user?.id ? data.user : null
  } catch { return null }
}

/**
 * Admin setzt den Zugang zurück.
 * deps: auth.getUser(jwt), auth.updatePassword(userId, pw), userRpc(name, args) [mit JWT des Admins],
 *       serviceRpc(name, args) [Service-Schlüssel], generate(), timeoutMs, log(code)
 */
export async function handleAdminReset({ jwt, body, auth, userRpc, serviceRpc, generate = generateTempPassword, timeoutMs = 15000, log = (_code) => {} }) {
  if (!await caller(jwt, auth)) return reply(401, { ok: false, reason: 'unauthenticated' })
  const employeeId = body?.employee_id, expected = body?.expected_generation
  if (typeof employeeId !== 'string' || !UUID.test(employeeId) || !Number.isInteger(expected) || expected < 0)
    return reply(400, { ok: false, reason: 'bad_request' })

  // 1. Admin + Ziel + Generation prüft die Datenbank mit dem JWT des Admins (auth.uid() = handelnde Person)
  const { data: b, error: be } = await call(() => userRpc('admin_begin_access_reset', { p_employee_id: employeeId, p_expected_generation: expected }))
  if (be) { log('begin_failed'); return reply(hintOf(be) === 'session_revoked' ? 401 : 500, { ok: false, reason: hintOf(be) === 'session_revoked' ? 'unauthenticated' : 'server_error' }) }
  if (!b?.ok) {
    const status = b?.reason === 'forbidden' ? 403 : ['stale', 'in_progress'].includes(b?.reason) ? 409 : 422
    return reply(status, { ok: false, reason: b?.reason || 'server_error', ...(b?.generation != null ? { generation: b.generation } : {}) })
  }

  // 2. Passwort setzen (Auth Admin API). Bei Fehler/Zeitüberschreitung: protokollieren, kein Passwort zurückgeben.
  let password = generate()
  const res = await call(() => withTimeout(auth.updatePassword(b.user_id, password), timeoutMs))
  if (res?.error) {
    password = null
    log('password_update_failed:' + code(res.error))
    await call(() => serviceRpc('service_access_reset_failed', { p_user_id: b.user_id, p_generation: b.generation, p_reason: code(res.error) }))
    return reply(502, { ok: false, reason: 'password_update_failed' })
  }

  // 3. Sitzungen erneut beenden, Sperre lösen, Protokoll. Ein Wiederholungsversuch; danach Passwort trotzdem zeigen,
  //    denn es ist gesetzt und die Pflicht zur Änderung besteht seit Schritt 1 (sonst wäre die Person ausgesperrt).
  const finish = () => call(() => serviceRpc('service_access_reset_finish', { p_user_id: b.user_id, p_generation: b.generation }))
  let fin = await finish()
  if (fin.error) fin = await finish()
  if (fin?.data && fin.data.ok === false) {
    password = null
    log('finish_superseded')
    return reply(409, { ok: false, reason: 'superseded' })
  }
  if (fin?.error) log('finish_unconfirmed')
  return reply(200, { ok: true, temp_password: password, generation: b.generation, ...(fin?.error ? { warning: 'finish_unconfirmed' } : {}) })
}

/**
 * Person legt nach dem Reset ein neues Passwort fest. Erst Auth (PUT /user mit ihrem JWT: prüft Sitzung, Passwortregeln,
 * „gleiches Passwort“), danach löscht der Server die Pflicht. Scheitert Schritt 2, bleibt die Pflicht → erneut versuchen.
 * deps: auth.getUser(jwt), changeOwnPassword(jwt, pw) → { error: { code } }, userRpc, serviceRpc, log
 */
export async function handleCompletePasswordChange({ jwt, body, auth, changeOwnPassword, userRpc, serviceRpc, timeoutMs = 15000, log = (_code) => {} }) {
  const user = await caller(jwt, auth)
  if (!user) return reply(401, { ok: false, reason: 'unauthenticated' })
  const pw = body?.password
  const problem = passwordPolicyProblem(pw)
  if (problem) return reply(422, { ok: false, reason: problem })

  const { data: st, error: se } = await call(() => userRpc('my_access_state', {}))
  if (se) return reply(hintOf(se) === 'session_revoked' ? 401 : 500, { ok: false, reason: hintOf(se) === 'session_revoked' ? 'unauthenticated' : 'server_error' })
  if (!st?.must_change_password) return reply(409, { ok: false, reason: 'not_required' })

  const res = await call(() => withTimeout(changeOwnPassword(jwt, pw), timeoutMs))
  if (res?.error) {
    const c = code(res.error)
    log('password_change_failed:' + c)
    await call(() => serviceRpc('service_password_change_failed', { p_user_id: user.id, p_reason: c }))
    const known = ['same_password', 'weak_password', 'reauthentication_needed', 'session_not_found']
    return reply(c === 'session_not_found' ? 401 : 422, { ok: false, reason: known.includes(c) ? c : 'password_update_failed' })
  }

  const keep = jwtPayload(jwt).session_id
  const { data: done, error: de } = await call(() => serviceRpc('service_complete_password_change',
    { p_user_id: user.id, p_generation: st.generation, p_keep_session: UUID.test(String(keep || '')) ? keep : null }))
  if (de || !done?.ok) { log('complete_failed'); return reply(503, { ok: false, reason: done?.reason === 'superseded' ? 'superseded' : 'retry' }) }
  return reply(200, { ok: true })
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
export const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
