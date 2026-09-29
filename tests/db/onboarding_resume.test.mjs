// Migration 28: Onboarding fortsetzbar, idempotent, konfliktsicher – gegen die Production-Funktionen + Migration 28.
// Registrierung ganz oder gar nicht (keine Sackgasse), Revision gegen stille Überschreibungen (zwei Tabs/Geräte),
// Patch-Semantik, idempotentes Einreichen (verlorene Antwort), Server-Prüfung wie der Client, Rückwärtskompatibilität
// mit dem bisherigen Client. Nur synthetische Personen/Adressen, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startDb, addPeople, loadLifecycle, loadProdFunctions, err, one, U, EMP } from './harness.mjs'

const [ADMIN, MANAGER, E1] = [1, 2, 3]
let db
const asId = async id => { const c = await db.connect(); await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('SET ROLE authenticated'); return c }
const count = async (sql, p) => (await one(db.sys, sql, p)).n
const invite = async (email, extra = {}) => one(await db.session(ADMIN),
  `INSERT INTO invitations (email, employee_id, role, created_by, expires_at) VALUES ($1, $2, 'employee', $3, now() + $4::interval) RETURNING id, token`,
  [email, extra.employeeId ?? null, U(ADMIN), extra.expiresIn ?? '7 days'])
const signupOn = async (conn, email, token) => { const id = randomUUID(); await conn.query(`INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, NULL, $3)`, [id, email, token ? { invite_token: token } : {}]); return id }
const signup = (email, token) => signupOn(db.sys, email, token)
const nothingFor = async email => ({
  auth: await count(`SELECT count(*)::int n FROM auth.users WHERE lower(email) = lower($1)`, [email]),
  profile: await count(`SELECT count(*)::int n FROM profiles WHERE lower(email) = lower($1)`, [email]),
  onboarding: await count(`SELECT count(*)::int n FROM employee_onboarding WHERE lower(email) = lower($1)`, [email]),
})
const save = async (c, data, submit = false, rev) => (await one(c, rev === undefined ? `SELECT save_onboarding($1, $2) v` : `SELECT save_onboarding($1, $2, $3) v`,
  rev === undefined ? [data, submit] : [data, submit, rev])).v
const row = id => one(db.sys, `SELECT * FROM employee_onboarding WHERE profile_id = $1`, [id])
const VALID = { first_name: 'Ada', last_name: 'Test', birth_name: '', birth_date: '1995-04-01', birth_place: '', nationality: '', street: 'Testweg', house_number: '1', postal_code: '60311', city: 'Frankfurt', phone: '+49 69 1234', iban: 'DE89370400440532013000', account_holder: 'Ada Test', tax_id: '12345678901', social_security_number: '12345678A123', health_insurance: 'TK', other_employment: false, other_employment_note: '', emergency_contact_name: 'Bo', emergency_contact_phone: '+49 170 1', privacy_accepted: true }
const draft = async email => { const id = await signup(email, (await invite(email)).token); return { id, c: await asId(id) } }

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee']])
  await loadLifecycle(db.sys)
  await loadProdFunctions(db.sys)   // request_onboarding_changes u. a.
})
after(async () => { await db?.stop() })

test('Harness: Tests laufen gegen Migration 28 (nicht gegen den Stand davor)', async () => {
  const src = (await one(db.sys, `SELECT string_agg(pg_get_functiondef(p.oid), ' ') s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('handle_new_user', 'save_onboarding')`)).s
  assert.match(src, /p_expected_revision/)
  assert.doesNotMatch(src, /EXCEPTION WHEN OTHERS THEN\s*NULL/)
  const overloads = (await db.sys.query(`SELECT p.oid::regprocedure::text s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'save_onboarding'`)).rows.map(r => r.s)
  assert.deepEqual(overloads, ['save_onboarding(jsonb,boolean,integer)'], 'genau eine Variante → Aufruf per Namen eindeutig (PostgREST)')
})

test('Registrierung mit ungültiger Einladung: gar nichts wird angelegt, Einladung unverändert (keine Sackgasse)', async () => {
  const cases = {
    abgelaufen: async e => (await invite(e, { expiresIn: '-1 minute' })).token,
    zurückgezogen: async e => { const i = await invite(e); await db.sys.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1`, [i.id]); return i.token },
    'unbekannter Token': async () => randomUUID(),
    'andere Adresse': async () => (await invite('jemand-anders@example.test')).token,
    'Mitarbeiter inaktiv': async e => { const emp = (await one(db.sys, `INSERT INTO employees (first_name, last_name, email, hourly_rate, start_date, employment_type, hours_per_week, is_active) VALUES ('In', 'Aktiv', $1, 15, '2026-01-01', 'minijob', 10, false) RETURNING id`, [e])).id; return (await invite(e, { employeeId: emp })).token },
  }
  let n = 0
  for (const [label, make] of Object.entries(cases)) {
    const email = `ungueltig${n++}@example.test`
    const token = await make(email)
    const usedBefore = await count(`SELECT count(*)::int n FROM invitations WHERE used_at IS NOT NULL`)
    assert.match(await err(() => signup(email, token)), /nicht mehr gültig/, label)
    assert.deepEqual(await nothingFor(email), { auth: 0, profile: 0, onboarding: 0 }, label)
    assert.equal(await count(`SELECT count(*)::int n FROM invitations WHERE used_at IS NOT NULL`), usedBefore, `${label}: keine Einladung verbraucht`)
  }
  // Bereits benutzt: zweites Konto (andere Adresse) mit demselben Link → abgelehnt
  const { id } = await draft('benutzt@example.test')
  const tok = (await one(db.sys, `SELECT i.token FROM invitations i JOIN employee_onboarding o ON o.invitation_id = i.id WHERE o.profile_id = $1`, [id])).token
  assert.match(await err(() => signup('zweit@example.test', tok)), /nicht mehr gültig/)
  // Ohne Token: unverändert wartendes Profil (Admin entscheidet)
  const plain = await signup('ohne-einladung@example.test', null)
  assert.equal((await one(db.sys, `SELECT status FROM profiles WHERE id = $1`, [plain])).status, 'pending')
})

test('Registrierung: Fehler im Einladungsweg → alles zurückgerollt; danach mit demselben Link sauber möglich', async () => {
  const email = 'teilfehler@example.test'
  const inv = await invite(email)
  await db.sys.query(`CREATE FUNCTION test_fail_onb() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulierter Fehler'; END $$;
                      CREATE TRIGGER test_fail_onb BEFORE INSERT ON employee_onboarding FOR EACH ROW EXECUTE FUNCTION test_fail_onb();`)
  try {
    assert.match(await err(() => signup(email, inv.token)), /simulierter Fehler/, 'Fehler wird nicht verschluckt')
  } finally {
    await db.sys.query(`DROP TRIGGER test_fail_onb ON employee_onboarding; DROP FUNCTION test_fail_onb();`)
  }
  assert.deepEqual(await nothingFor(email), { auth: 0, profile: 0, onboarding: 0 }, 'kein halbes Konto')
  assert.equal((await one(db.sys, `SELECT used_at FROM invitations WHERE id = $1`, [inv.id])).used_at, null, 'Einladung nicht verbraucht')
  const id = await signup(email, inv.token)
  assert.deepEqual(Object.values(await one(db.sys, `SELECT p.status ps, o.status os FROM profiles p JOIN employee_onboarding o ON o.profile_id = p.id WHERE p.id = $1`, [id])), ['pending', 'draft'])
  assert.ok((await one(db.sys, `SELECT used_at FROM invitations WHERE id = $1`, [inv.id])).used_at)
})

test('Registrierung parallel mit demselben Link (zwei echte Verbindungen): genau ein Konto, genau ein Onboarding', async () => {
  const email = 'parallel-reg@example.test'
  const inv = await invite(email)
  const conns = [await db.connect(), await db.connect(), await db.connect()]
  const res = await Promise.allSettled(conns.map(c => signupOn(c, email, inv.token)))
  await Promise.all(conns.map(c => c.end()))
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1, JSON.stringify(res.map(r => r.reason?.message)))
  assert.deepEqual(await nothingFor(email), { auth: 1, profile: 1, onboarding: 1 })
})

test('Revision: jede Änderung zählt; veralteter Stand überschreibt nichts (zwei Tabs/Geräte)', async () => {
  const { id, c } = await draft('zwei-tabs@example.test')
  assert.equal((await row(id)).revision, 0)
  const tabB = await asId(id)
  // Tab B speichert Schritte 1–3 (kennt Revision 0)
  const b = await save(tabB, { first_name: 'Ada', last_name: 'Test', street: 'Weg', city: 'Frankfurt', iban: 'DE89370400440532013000' }, false, 0)
  assert.deepEqual([b.success, b.revision], [true, 1])
  // Tab A wurde bei Revision 0 geladen und speichert Schritt 1 mit leeren späteren Feldern → Konflikt, nichts geändert
  const a = await save(c, { first_name: 'Ada', last_name: 'Test', street: '', city: '', iban: '' }, false, 0)
  assert.deepEqual([a.success, a.conflict, a.revision], [false, true, 1])
  assert.match(a.error, /anderen Fenster oder auf einem anderen Gerät/)
  const r = await row(id)
  assert.deepEqual([r.street, r.city, r.iban, r.revision], ['Weg', 'Frankfurt', 'DE89370400440532013000', 1], 'Daten von Tab B erhalten')
  // Nach Neuladen (Revision 1) klappt es
  assert.deepEqual(Object.values(await save(c, { phone: '+49 69 1234' }, false, 1)).slice(0, 1), [true])
  // Konflikt auch beim Einreichen: nichts eingereicht, nichts geändert
  const sub = await save(c, VALID, true, 0)
  assert.deepEqual([sub.success, sub.conflict], [false, true])
  assert.equal((await row(id)).status, 'draft')
})

test('Patch-Semantik: ein Schritt ändert nur seine Felder; weitere Beschäftigung „nein“ entfernt die Beschreibung', async () => {
  const { id, c } = await draft('patch@example.test')
  await save(c, { ...VALID, other_employment: true, other_employment_note: 'Minijob Bäckerei' })
  assert.equal((await save(c, { first_name: 'Ada-Maria' })).success, true)
  const r = await row(id)
  assert.deepEqual([r.first_name, r.last_name, r.iban, r.tax_id, r.other_employment, r.other_employment_note], ['Ada-Maria', 'Test', 'DE89370400440532013000', '12345678901', true, 'Minijob Bäckerei'])
  assert.equal((await save(c, { other_employment: false })).success, true)
  assert.deepEqual(Object.values(await one(db.sys, `SELECT other_employment, other_employment_note FROM employee_onboarding WHERE profile_id = $1`, [id])), [false, null])
  // Ausdrücklich geleertes Feld wird geleert (gewollte Änderung)
  await save(c, { birth_place: 'Köln' }); await save(c, { birth_place: '' })
  assert.equal((await row(id)).birth_place, null)
})

test('Bisheriger Client (alle Felder, ohne Revision, 2 Argumente positional/benannt): Verhalten unverändert', async () => {
  const { id, c } = await draft('alt-client@example.test')
  const full = { ...VALID, street: '', city: '' }
  assert.equal((await one(c, `SELECT save_onboarding($1, false) v`, [VALID])).v.success, true, 'positional')
  assert.equal((await one(c, `SELECT save_onboarding(p_data => $1, p_submit => false) v`, [full])).v.success, true, 'benannt wie PostgREST')
  const r = await row(id)
  assert.deepEqual([r.street, r.city, r.first_name], [null, null, 'Ada'], 'mitgesendete leere Felder werden wie bisher geleert')
  const s = (await one(c, `SELECT save_onboarding(p_data => $1, p_submit => true) v`, [VALID])).v
  assert.deepEqual([s.success, s.status], [true, 'submitted'])
})

test('Einreichen idempotent: verlorene Antwort + erneutes Senden → Erfolg, eine Einreichung, ein Protokolleintrag', async () => {
  const { id, c } = await draft('idempotent@example.test')
  const first = await save(c, VALID, true)
  assert.deepEqual([first.success, first.status, first.already], [true, 'submitted', undefined])
  const snap = await row(id)
  const again = await save(c, { ...VALID, tax_id: '99999999999' }, true, 0)   // alter Stand + andere Daten
  assert.deepEqual([again.success, again.already, again.status, again.revision], [true, true, 'submitted', snap.revision])
  const r = await row(id)
  assert.deepEqual([r.tax_id, r.submitted_at.getTime(), r.revision], [snap.tax_id, snap.submitted_at.getTime(), snap.revision], 'nichts verändert')
  assert.equal(await count(`SELECT count(*)::int n FROM activity_log WHERE action = 'employee.onboarding_submitted' AND target_id = $1`, [r.id]), 1)
  // Entwurf speichern nach Einreichung: weiterhin abgelehnt (mit Status für den Client)
  const d = await save(c, { first_name: 'X' })
  assert.deepEqual([d.success, d.status], [false, 'submitted'])
})

test('Einreichen prüft wie der Client; Angaben bleiben als Entwurf gespeichert, Revision stimmt', async () => {
  const { id, c } = await draft('pruefung@example.test')
  const bad = [
    [{ other_employment: true, other_employment_note: '' }, 'other_employment_note'],
    [{ phone: '123' }, 'phone'],
    [{ phone: 'ruf mich an' }, 'phone'],
    [{ emergency_contact_phone: '+49 1' }, 'emergency_contact_phone'],
    [{ iban: 'DE89370400440532013001' }, 'iban'],   // Prüfziffer falsch
    [{ iban: 'DE8937040044053201300' }, 'iban'],    // Länge DE
    [{ tax_id: '123' }, 'tax_id'],
    [{ birth_date: '2020-01-01' }, 'birth_date'],
    [{ street: '' }, 'street'],
    [{ privacy_accepted: false }, 'privacy_accepted'],
  ]
  for (const [patch, field] of bad) {
    const rev = (await row(id)).revision
    const r = await save(c, { ...VALID, ...patch }, true, rev)
    assert.deepEqual([r.success, r.field, r.status], [false, field, 'draft'], JSON.stringify(patch))
    assert.equal(r.revision, (await row(id)).revision, 'Client bleibt synchron')
  }
  assert.equal((await row(id)).phone, '+49 69 1234', 'letzter Entwurf gespeichert')
  // Gültige Varianten
  for (const [iban, ok] of [['DE89370400440532013000', true], ['GB82WEST12345698765432', true], ['NL91ABNA0417164300', true], ['GB82WEST12345698765431', false]]) {
    assert.equal((await one(db.sys, `SELECT _iban_checksum_ok($1) v`, [iban])).v, ok, iban)
  }
  const good = await save(c, { ...VALID, other_employment: true, other_employment_note: 'Minijob', phone: '(069) 123-45/6' }, true, (await row(id)).revision)
  assert.equal(good.success, true, JSON.stringify(good))
})

test('Admin-Aktionen zählen mit: nach „Korrektur anfordern“ überschreibt ein alter Stand nichts; mit aktuellem Stand korrigierbar', async () => {
  const { id, c } = await draft('korrektur@example.test')
  const s = await save(c, VALID, true)
  const onb = (await row(id)).id
  assert.equal((await one(await db.session(ADMIN), `SELECT request_onboarding_changes($1, 'IBAN prüfen') v`, [onb])).v.success, true)
  const r = await row(id)
  assert.ok(r.revision > s.revision, 'Statuswechsel erhöht die Revision')
  assert.equal((await save(c, { iban: 'GB82WEST12345698765432' }, false, s.revision)).conflict, true)
  assert.equal((await save(c, { iban: 'GB82WEST12345698765432' }, false, r.revision)).success, true)
  const again = await save(c, { ...VALID, iban: 'GB82WEST12345698765432' }, true, r.revision + 1)
  assert.deepEqual([again.success, again.already], [true, undefined], 'erneut eingereicht')
})

test('Rechte: nur eigenes Onboarding, keine direkte Schreib-/Revisionsänderung, interne Funktionen gesperrt', async () => {
  const { id, c } = await draft('rechte-onb@example.test')
  const other = await draft('fremd-onb@example.test')
  await save(other.c, { first_name: 'Fremd' })
  assert.equal((await c.query(`UPDATE employee_onboarding SET revision = 0, status = 'approved' WHERE profile_id = $1`, [id])).rowCount, 0, 'kein direktes Schreiben')
  assert.equal((await c.query(`SELECT * FROM employee_onboarding WHERE profile_id = $1`, [other.id])).rowCount, 0, 'fremdes Onboarding unsichtbar')
  const conflict = await save(c, { first_name: 'X' }, false, 99)
  assert.deepEqual(Object.keys(conflict).sort(), ['conflict', 'error', 'revision', 'status', 'success'], 'Konflikt verrät keine Daten')
  assert.equal((await row(other.id)).first_name, 'Fremd')
  assert.match(await err(async () => (await db.anon()).query(`SELECT save_onboarding('{}'::jsonb, false, NULL)`)), /permission denied/)
  assert.match(await err(() => c.query(`SELECT _iban_checksum_ok('DE89370400440532013000')`)), /permission denied/)
  assert.match(await err(() => c.query(`SELECT onboarding_bump_revision()`)), /permission denied|trigger functions can only be called as triggers/)
  // Ohne Onboarding (bestehender Mitarbeiter) / ungültige Daten
  assert.match((await save(await db.session(E1), { first_name: 'X' })).error, /keine Einladung/)
  assert.equal((await one(c, `SELECT save_onboarding('[]'::jsonb, false) v`)).v.success, false)
  assert.equal((await save(c, { birth_date: 'kein-datum' })).field, 'birth_date')
  assert.equal((await save(c, { other_employment: 'vielleicht' })).field, 'other_employment')
})

test('Invarianten: kein doppeltes Onboarding je Profil, kein Profil ohne Einladungsweg aus dieser Suite', async () => {
  assert.equal(await count(`SELECT count(*)::int n FROM (SELECT profile_id FROM employee_onboarding GROUP BY 1 HAVING count(*) > 1) x`), 0)
  assert.equal(await count(`SELECT count(*)::int n FROM profiles p WHERE p.employee_id IS NULL AND p.email LIKE '%@example.test' AND p.email <> 'ohne-einladung@example.test' AND NOT EXISTS (SELECT 1 FROM employee_onboarding o WHERE o.profile_id = p.id)`), 0, 'keine wartenden Konten ohne Onboarding')
  assert.equal(await count(`SELECT count(*)::int n FROM employees WHERE id = $1`, [EMP(E1)]), 1)
})
