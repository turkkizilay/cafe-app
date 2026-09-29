// Registrierung sicher zurücksetzen (Migration 26) mit den Production-Lifecycle-Funktionen. Prüft: Klassifizierung
// (vollständig / nur unbenutzte Anmeldung / blockiert), Rechte, dass Personalakte + Historie + Vergütung + Kenntnisnahmen
// nie verschwinden, Doppelklick/zwei Admins/veraltete Ansicht/parallele Registrierung, Pflichtprotokoll ohne False Success.
// Nur synthetische Personen/Adressen, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startDb, addPeople, loadLifecycle, err, one, U, EMP, day } from './harness.mjs'

const [ADMIN, MANAGER, E1, ADMIN2] = [1, 2, 3, 4]
let db
const asId = async id => { const c = await db.connect(); await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('SET ROLE authenticated'); return c }
const count = async (sql, p) => (await one(db.sys, sql, p)).n
const exists = async id => (await count(`SELECT count(*)::int n FROM auth.users WHERE id = $1`, [id])) === 1
const admin = () => db.session(ADMIN)
const check = async (id, c) => (await one(c || await admin(), `SELECT admin_registration_reset_check($1) v`, [id])).v
const reset = async (id, email, mode, c) => (await one(c || await admin(), `SELECT admin_reset_registration($1, $2, $3) v`, [id, email, mode])).v
const codes = a => a.blockers.map(b => b.code).sort()
const audits = async id => count(`SELECT count(*)::int n FROM activity_log WHERE action IN ('employee.registration_reset', 'employee.login_reset') AND target_id = $1`, [id])

async function invite({ email, employeeId = null }) {
  return one(await admin(), `INSERT INTO invitations (email, employee_id, role, created_by) VALUES ($1, $2, 'employee', $3) RETURNING id, token`, [email, employeeId, U(ADMIN)])
}
async function signup(email, token) {
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, NULL, $3)`, [id, email, token ? { invite_token: token } : {}])
  return id
}
const invitedDraft = async email => signup(email, (await invite({ email })).token)
const VALID = { first_name: 'Ada', last_name: 'Test', birth_date: '1995-04-01', street: 'Testweg', house_number: '1', postal_code: '60311', city: 'Frankfurt', phone: '+49 69 1', iban: 'DE89370400440532013000', account_holder: 'Ada Test', tax_id: '12345678901', social_security_number: '12345678A123', health_insurance: 'TK', other_employment: false, emergency_contact_name: 'Bo', emergency_contact_phone: '+49 170 1', privacy_accepted: true }

// Vollständige Beschäftigungshistorie an einem Mitarbeiter (alles hängt an employees.id)
async function seedHistory(emp, profileId) {
  const te = (await one(db.sys, `INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, 8) RETURNING id`, [emp, day(-5), `${day(-5)}T08:00:00Z`, `${day(-5)}T16:00:00Z`])).id
  await db.sys.query(`INSERT INTO time_entry_breaks (time_entry_id, employee_id, break_start, break_end, closed_by) VALUES ($1, $2, $3, $4, 'employee')`, [te, emp, `${day(-5)}T12:00:00Z`, `${day(-5)}T12:30:00Z`])
  await db.sys.query(`INSERT INTO time_corrections (time_entry_id, employee_id, corrected_by, field_changed, old_value, new_value, reason) VALUES ($1, $2, $3, 'clock_out', 'a', 'b', 'Test')`, [te, emp, U(ADMIN)])
  await db.sys.query(`INSERT INTO shifts (employee_id, date, start_time, end_time) VALUES ($1, $2, '08:00', '16:00')`, [emp, day(4)])
  await db.sys.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 2)`, [emp, day(10), day(11)])
  await db.sys.query(`INSERT INTO sick_leave (employee_id, start_date) VALUES ($1, $2)`, [emp, day(-20)])
  await db.sys.query(`INSERT INTO payroll_months (employee_id, year, month) VALUES ($1, 2026, 8)`, [emp])
  await db.sys.query(`INSERT INTO payroll_documents (employee_id, year, month, file_name, file_path) VALUES ($1, 2026, 8, 'l.pdf', 'x/l.pdf')`, [emp])
  await db.sys.query(`INSERT INTO employee_documents (employee_id, title, file_path, file_name) VALUES ($1, 'Vertrag', 'x/v.pdf', 'v.pdf')`, [emp])
  if (profileId) await db.sys.query(`INSERT INTO privacy_notice_acknowledgements (profile_id, notice_version) VALUES ($1, '2026-09-28')`, [profileId])
}
const HISTORY = ['time_entries', 'time_entry_breaks', 'time_corrections', 'shifts', 'vacation_requests', 'sick_leave', 'payroll_months', 'payroll_documents', 'employee_documents']
const snapshot = async emp => {
  const out = {}
  for (const t of HISTORY) out[t] = await count(`SELECT count(*)::int n FROM ${t} WHERE employee_id = $1`, [emp])
  const e = await one(db.sys, `SELECT id, is_active, pay_type, monthly_salary::float m, hourly_rate::float r, iban FROM employees WHERE id = $1`, [emp])
  return { ...out, employee: e }
}

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }], [ADMIN2, 'admin']])
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 2100 WHERE id = $1`, [EMP(E1)])
  await db.sys.query(`UPDATE auth.users SET last_sign_in_at = now() WHERE id IN ($1, $2, $3, $4)`, [U(ADMIN), U(MANAGER), U(E1), U(ADMIN2)])
  await seedHistory(EMP(E1), U(E1))
  await loadLifecycle(db.sys)
})
after(async () => { await db?.stop() })

test('Verwaiste unbestätigte Registrierung (Einladung eingelöst, Onboarding-Entwurf): vollständig zurücksetzbar, danach neu einladbar + registrierbar', async () => {
  const email = 'kaputt1@example.test'
  const inv = await invite({ email })
  const id = await signup(email, inv.token)
  const a = await check(id)
  assert.equal(a.mode, 'full')
  assert.deepEqual([a.email, a.email_confirmed, a.ever_signed_in, a.onboarding_status, a.blockers.length], [email, false, false, 'draft', 0])
  assert.deepEqual(a.deletes, { auth_user: 1, profile: 1, onboarding: 1, push_subscriptions: 0 })

  const r = await reset(id, email, 'full')
  assert.deepEqual([r.success, r.already, r.mode], [true, false, 'full'])
  assert.equal(await exists(id), false)
  for (const t of ['profiles WHERE id', 'employee_onboarding WHERE profile_id']) assert.equal(await count(`SELECT count(*)::int n FROM ${t} = $1`, [id]), 0, t)
  assert.equal(await count(`SELECT count(*)::int n FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id)`), 0, 'keine Waise')
  assert.ok((await one(db.sys, `SELECT used_at FROM invitations WHERE id = $1`, [inv.id])).used_at, 'alte Einladung bleibt als Historie')
  // Protokoll: wer/wann/welche Registrierung/welche Aktion – ohne Token/Personalangaben
  const log = await one(db.sys, `SELECT * FROM activity_log WHERE action = 'employee.registration_reset' AND target_id = $1`, [id])
  assert.deepEqual([log.actor_id, log.target_type, log.target_name, log.metadata.mode], [U(ADMIN), 'auth_user', email, 'full'])
  assert.ok(log.created_at)
  assert.doesNotMatch(JSON.stringify(log), new RegExp(inv.token), 'kein Token im Protokoll')

  // Dieselbe Adresse: Prüfung frei, neue Einladung gültig, Registrierung legt sauber neu an
  assert.equal((await one(await admin(), `SELECT check_email_registered($1) v`, [email])).v.exists, false)
  const inv2 = await invite({ email })
  assert.equal((await one(await db.anon(), `SELECT get_invitation_info($1) v`, [inv2.token])).v.valid, true)
  const id2 = await signup(email, inv2.token)
  assert.equal((await one(db.sys, `SELECT status FROM employee_onboarding WHERE profile_id = $1`, [id2])).status, 'draft')
  assert.equal((await one(db.sys, `SELECT email_confirmed_at FROM auth.users WHERE id = $1`, [id2])).email_confirmed_at, null, 'Bestätigung nicht umgangen')
})

test('Nur Admin: Mitarbeiter, Manager und anonym können weder prüfen noch zurücksetzen', async () => {
  const email = 'rechte@example.test'
  const id = await invitedDraft(email)
  for (const who of [E1, MANAGER]) {
    const c = await db.session(who)
    assert.match(await err(() => c.query(`SELECT admin_registration_reset_check($1)`, [id])), /Nicht autorisiert/)
    assert.match(await err(() => c.query(`SELECT admin_reset_registration($1, $2, 'full')`, [id, email])), /Nicht autorisiert/)
  }
  // Die betroffene Person selbst auch nicht
  assert.match(await err(async () => (await asId(id)).query(`SELECT admin_reset_registration($1, $2, 'full')`, [id, email])), /Nicht autorisiert/)
  const anon = await db.anon()
  for (const f of [`admin_registration_reset_check('${id}')`, `admin_reset_registration('${id}', '${email}', 'full')`, `_registration_reset_assessment('${id}')`]) {
    assert.match(await err(() => anon.query(`SELECT ${f}`)), /permission denied/, f)
  }
  assert.match(await err(() => db.session(E1).then(c => c.query(`SELECT _registration_reset_assessment($1)`, [id]))), /permission denied/, 'interne Funktion nicht direkt aufrufbar')
  assert.equal(await exists(id), true)
  assert.equal((await reset(id, email, 'full')).success, true, 'Gegenprobe Admin')
})

test('Aktiver Mitarbeiter mit Historie: blockiert mit Gründen; Personalakte, Zeiten, Pausen, Korrekturen, Schichten, Urlaub, Krankheit, Lohn, Dokumente, Vergütung, Kenntnisnahme bleiben', async () => {
  const before1 = await snapshot(EMP(E1))
  assert.ok(HISTORY.every(t => before1[t] >= 1), 'Historie vorhanden')
  const a = await check(U(E1))
  assert.equal(a.mode, 'blocked')
  assert.equal(a.intended_mode, 'login_only')
  assert.deepEqual(codes(a), ['login_used', 'privacy_proof'])
  for (const mode of ['full', 'login_only']) assert.ok(await err(() => reset(U(E1), 'person3@example.test', mode)))
  assert.deepEqual(await snapshot(EMP(E1)), before1)
  assert.deepEqual([before1.employee.id, before1.employee.pay_type, before1.employee.m, before1.employee.r], [EMP(E1), 'fixed', 2100, 15])
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [U(E1)]), 1)
  assert.equal(await exists(U(E1)), true)
  assert.equal(await audits(U(E1)), 0, 'kein Protokoll ohne Wirkung')
})

test('Nie benutzte Anmeldung eines bestehenden Mitarbeiters: nur Login wird zurückgesetzt, Personalakte + gesamte Historie + Vergütung unverändert, Neu-Einladung verknüpft dieselbe Mitarbeiter-ID', async () => {
  const emp = (await one(db.sys, `INSERT INTO employees (first_name, last_name, email, hourly_rate, start_date, employment_type, hours_per_week, pay_type, monthly_salary, iban) VALUES ('Bea', 'Bestand', 'bea@example.test', 15, '2025-01-01', 'vollzeit', 40, 'fixed', 3000, 'DE00BEA') RETURNING id`)).id
  await seedHistory(emp, null)
  const email = 'bea@example.test'
  const id = await signup(email, (await invite({ email, employeeId: emp })).token)
  assert.equal((await one(db.sys, `SELECT employee_id FROM profiles WHERE id = $1`, [id])).employee_id, emp)
  const before1 = await snapshot(emp)
  const a = await check(id)
  assert.equal(a.mode, 'login_only')
  assert.equal(a.employee_id, emp)
  assert.deepEqual(a.keeps, { time_entries: 1, breaks: 1, time_corrections: 1, shifts: 1, vacation_requests: 1, sick_leave: 1, payroll_months: 1, payroll_documents: 1, employee_documents: 1 })
  // Veraltete Ansicht mit anderem Modus → Abbruch, nichts geändert
  assert.match(await err(() => reset(id, email, 'full')), /hat sich geändert/)
  assert.equal(await exists(id), true)
  const r = await reset(id, email, 'login_only')
  assert.deepEqual([r.success, r.mode], [true, 'login_only'])
  assert.equal(await exists(id), false)
  assert.deepEqual(await snapshot(emp), before1, 'Personalakte + Historie + Vergütung unverändert')
  assert.equal((await one(db.sys, `SELECT metadata FROM activity_log WHERE action = 'employee.login_reset' AND target_id = $1`, [id])).metadata.employee_id, emp)
  const id2 = await signup(email, (await invite({ email, employeeId: emp })).token)
  assert.equal((await one(db.sys, `SELECT employee_id FROM profiles WHERE id = $1`, [id2])).employee_id, emp, 'gleiche Mitarbeiter-ID')
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE lower(email) = $1`, [email]), 1, 'kein Duplikat')
})

test('Blockiert: eingereicht, Kenntnisnahme, abgebrochen nach Einreichung, fremde Referenzen, Storage, eigenes/Owner-/Admin-Konto, Waise', async () => {
  // Eingereicht (Personalangaben + Kenntnisnahme im Onboarding)
  const sub = await invitedDraft('eingereicht@example.test')
  assert.equal((await one(await asId(sub), `SELECT save_onboarding($1, true) v`, [VALID])).v.success, true)
  assert.deepEqual(codes(await check(sub)), ['onboarding_submitted', 'privacy_proof', 'references'].sort(), 'Einreichung protokolliert → Referenz')
  // Nach Einreichung abgebrochen: Kenntnisnahme bleibt Nachweis → blockiert (Weg: wieder öffnen)
  const onb = (await one(db.sys, `SELECT id FROM employee_onboarding WHERE profile_id = $1`, [sub])).id
  assert.equal((await one(await admin(), `SELECT reject_onboarding($1, 'Test') v`, [onb])).v.success, true)
  assert.ok(codes(await check(sub)).includes('privacy_proof'))
  assert.ok(await err(() => reset(sub, 'eingereicht@example.test', 'full')))
  assert.equal(await count(`SELECT count(*)::int n FROM employee_onboarding WHERE profile_id = $1 AND privacy_accepted_at IS NOT NULL`, [sub]), 1)
  // Abgebrochen als Entwurf (nie eingereicht) → erlaubt
  const draftRej = await invitedDraft('entwurf-abgebrochen@example.test')
  const onb2 = (await one(db.sys, `SELECT id FROM employee_onboarding WHERE profile_id = $1`, [draftRej])).id
  await one(await admin(), `SELECT reject_onboarding($1, NULL) v`, [onb2])
  assert.equal((await check(draftRej)).mode, 'full')
  // Datenschutz-Kenntnisnahme im Portal (würde per CASCADE verschwinden) → blockiert, bleibt erhalten
  const ack = await invitedDraft('kenntnis@example.test')
  await db.sys.query(`UPDATE auth.users SET email_confirmed_at = now(), last_sign_in_at = now() WHERE id = $1`, [ack])
  await (await asId(ack)).query(`SELECT acknowledge_privacy_notice('2026-09-28')`)
  assert.deepEqual(codes(await check(ack)), ['privacy_proof'])
  assert.ok(await err(() => reset(ack, 'kenntnis@example.test', 'full')))
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [ack]), 1)
  // Protokoll-/Bearbeiter-Referenz (actor_id würde auf NULL gesetzt) → blockiert
  const ref = await invitedDraft('referenz@example.test')
  await db.sys.query(`INSERT INTO activity_log (actor_id, action, category, summary) VALUES ($1, 'x', 'employee', 'x')`, [ref])
  const rr = (await check(ref)).blockers.find(b => b.code === 'references')
  assert.deepEqual(rr.refs, { 'activity_log.actor_id': 1 })
  // Storage-Objekt des Kontos (kein FK, würde verwaisen) → blockiert
  const st = await invitedDraft('storage@example.test')
  await db.sys.query(`INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('sick-certs', 'x/y.pdf', $1)`, [st])
  assert.deepEqual(codes(await check(st)), ['storage_objects'])
  // Neuere Storage-Versionen: nur owner_id (text) gesetzt
  const st2 = await invitedDraft('storage2@example.test')
  await db.sys.query(`INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('sick-certs', 'x/z.pdf', $1)`, [st2])
  assert.deepEqual((await check(st2)).blockers, [{ code: 'storage_objects', count: 1 }])
  assert.ok(await err(() => reset(st2, 'storage2@example.test', 'full')))
  // Eigenes Konto, zweiter Admin, Owner
  assert.ok(codes(await check(U(ADMIN))).includes('self'))
  assert.ok(codes(await check(U(ADMIN2))).includes('privileged_role'))
  const own = await invitedDraft('owner@example.test')
  await db.sys.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE profiles SET is_owner = true WHERE id = '${own}'; COMMIT`)
  assert.ok(codes(await check(own)).includes('owner'))
  // Auth ohne Profil → eigener Weg (Migration 25)
  const orphan = await signup('waise@example.test')
  await db.sys.query(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM profiles WHERE id = '${orphan}'; COMMIT`)
  assert.deepEqual(codes(await check(orphan)), ['orphan_login'])
  assert.ok(await err(() => reset(orphan, 'waise@example.test', 'full')))
  for (const id of [sub, ack, ref, st, st2, own, orphan, U(ADMIN), U(ADMIN2)]) assert.equal(await exists(id), true)
})

test('Doppelklick und zwei Admins gleichzeitig: genau ein Reset, ein Protokolleintrag, zweiter Aufruf „bereits entfernt“', async () => {
  const email = 'doppel@example.test'
  const id = await invitedDraft(email)
  assert.equal((await reset(id, email, 'full')).already, false)
  const again = await reset(id, email, 'full')
  assert.deepEqual([again.success, again.already, again.email_registered_again], [true, true, false])
  assert.equal(await audits(id), 1)

  const email2 = 'parallel@example.test'
  const id2 = await invitedDraft(email2)
  const conns = [await db.as(ADMIN), await db.as(ADMIN2), await db.as(ADMIN)]
  const res = await Promise.all(conns.map(c => reset(id2, email2, 'full', c)))
  assert.equal(res.filter(r => r.success && !r.already).length, 1)
  assert.equal(res.filter(r => r.success && r.already).length, 2)
  assert.equal(await audits(id2), 1)
  assert.equal(await exists(id2), false)
})

test('Veraltete Admin-Ansicht und Rennen mit der Person: Einreichung/Kenntnisnahme gewinnt → kein Reset; Reset gewinnt → keine halben Daten', async () => {
  // Admin prüft (Entwurf), Person reicht danach ein → Reset bricht ab
  const email = 'stale@example.test'
  const id = await invitedDraft(email)
  assert.equal((await check(id)).mode, 'full')
  assert.equal((await one(await asId(id), `SELECT save_onboarding($1, true) v`, [VALID])).v.success, true)
  assert.match(await err(() => reset(id, email, 'full')), /nicht möglich/)
  assert.equal(await exists(id), true)
  // Falsche/alte Adresse in der Ansicht → Abbruch
  const id2 = await invitedDraft('stale2@example.test')
  assert.match(await err(() => reset(id2, 'andere@example.test', 'full')), /hat sich geändert/)
  assert.equal(await exists(id2), true)

  // Person reicht in offener Transaktion ein, Reset wartet auf die Sperre und sieht danach „eingereicht“
  const id3 = await invitedDraft('race1@example.test')
  const p = await asId(id3)
  await p.query('BEGIN')
  assert.equal((await one(p, `SELECT save_onboarding($1, true) v`, [VALID])).v.success, true)
  const k0 = await db.as(ADMIN)
  const pending = err(() => reset(id3, 'race1@example.test', 'full', k0))
  await new Promise(r => setTimeout(r, 300))
  await p.query('COMMIT')
  assert.match(await pending, /nicht möglich/)
  assert.equal((await one(db.sys, `SELECT status FROM employee_onboarding WHERE profile_id = $1`, [id3])).status, 'submitted')

  // Reset hält die Sperren, Person bestätigt Kenntnisnahme parallel → scheitert sauber, nichts verwaist
  const id4 = await invitedDraft('race2@example.test')
  const k = await db.as(ADMIN)
  await k.query('BEGIN')
  assert.equal((await reset(id4, 'race2@example.test', 'full', k)).success, true)
  const ackP = err(async () => (await asId(id4)).query(`SELECT acknowledge_privacy_notice('2026-09-28')`))
  await new Promise(r => setTimeout(r, 300))
  await k.query('COMMIT')
  assert.ok(await ackP, 'Kenntnisnahme nach Reset scheitert')
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [id4]), 0)
  assert.equal(await exists(id4), false)
})

test('Auth-Konto bereits entfernt: kein Fehler-Erfolg, keine Datenänderung; Einladung parallel neu erstellt bleibt gültig', async () => {
  const email = 'weg@example.test'
  const id = await invitedDraft(email)
  await db.sys.query(`DELETE FROM auth.users WHERE id = $1`, [id])
  assert.equal((await check(id)).mode, 'gone')
  const logsBefore = await count(`SELECT count(*)::int n FROM activity_log`)
  const r = await reset(id, email, 'full')
  assert.deepEqual([r.success, r.already], [true, true])
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log`), logsBefore, 'nichts protokolliert, nichts geändert')
  // Adresse inzwischen neu registriert → wird gemeldet, das neue Konto bleibt unberührt
  const again = await invitedDraft(email)
  const r2 = await reset(id, email, 'full')
  assert.deepEqual([r2.already, r2.email_registered_again], [true, true])
  assert.equal(await exists(again), true)

  // Neue Einladung existiert schon während des Resets → bleibt nutzbar
  const email3 = 'neuinvite@example.test'
  const id3 = await invitedDraft(email3)
  const inv = await invite({ email: email3 })
  assert.equal((await check(id3)).open_invitations, 1)
  await reset(id3, email3, 'full')
  assert.equal((await one(await db.anon(), `SELECT get_invitation_info($1) v`, [inv.token])).v.valid, true)
})

test('Fehler erzeugt keinen False Success: scheitert das Pflichtprotokoll, wird nichts gelöscht', async () => {
  const email = 'protokoll@example.test'
  const id = await invitedDraft(email)
  await db.sys.query(`CREATE FUNCTION test_fail_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'employee.registration_reset' THEN RAISE EXCEPTION 'simulierter Protokollfehler'; END IF; RETURN NEW; END $$;
                      CREATE TRIGGER test_fail_log BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION test_fail_log();`)
  try {
    assert.match(await err(() => reset(id, email, 'full')), /simulierter Protokollfehler/)
  } finally {
    await db.sys.query(`DROP TRIGGER test_fail_log ON activity_log; DROP FUNCTION test_fail_log();`)
  }
  assert.equal(await exists(id), true)
  assert.equal(await count(`SELECT count(*)::int n FROM employee_onboarding WHERE profile_id = $1`, [id]), 1)
  assert.equal((await reset(id, email, 'full')).success, true, 'danach regulär möglich')
  // Ungültige Anfrage
  const id2 = await invitedDraft('ungueltig@example.test')
  for (const [e, m] of [['ungueltig@example.test', 'alles'], ['', 'full'], [null, 'full']]) assert.match(await err(() => reset(id2, e, m)), /Ungültige Anfrage/)
  assert.equal(await exists(id2), true)
})

test('Invarianten: keine Funktion bestätigt E-Mails, E1 unverändert, keine doppelten Mitarbeiter', async () => {
  const src = (await one(db.sys, `SELECT string_agg(prosrc, ' ') s FROM pg_proc WHERE proname IN ('_registration_reset_assessment', 'admin_registration_reset_check', 'admin_reset_registration')`)).s
  assert.doesNotMatch(src, /email_confirmed_at\s*=|DELETE FROM (employees|time_entries|privacy_notice)/)
  assert.equal(await count(`SELECT count(*)::int n FROM (SELECT lower(email) FROM employees GROUP BY 1 HAVING count(*) > 1) x`), 0)
  assert.equal((await snapshot(EMP(E1))).employee.m, 2100)
})
