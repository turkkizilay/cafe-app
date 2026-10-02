// Migration 32: Notfallkontakt im Onboarding freiwillig (ganz oder gar nicht), eigene Telefonnummer Pflicht + Text
// (internationale Formate, höchstens 50 Zeichen wie employees.phone). Sichtbarkeit der Telefonnummer unverändert:
// Mitarbeiter nur eigene, Manager über das operative Verzeichnis (Migration 19), Admin alles.
// Gegen die Production-Funktionen + Migrationen 28/30/32. Nur synthetische Personen, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startDb, addPeople, loadLifecycle, loadProdFunctions, migration, one, rows, U, EMP, day } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const BASE = { first_name: 'Rafi', last_name: 'Test', birth_date: '1996-05-04', street: 'Testweg', house_number: '3', postal_code: '60311', city: 'Frankfurt',
  phone: '+880 1712-345678', iban: 'DE89370400440532013000', account_holder: 'Rafi Test', tax_id: '12345678901', social_security_number: '12345678A123',
  health_insurance: 'TK', other_employment: false, emergency_contact_name: '', emergency_contact_phone: '', privacy_accepted: true }
const asId = async id => { const c = await db.connect(); await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('SET ROLE authenticated'); return c }
let n = 0
async function draft() {
  const email = `onb${++n}@example.test`
  const { token } = await one(await db.session(ADMIN), `INSERT INTO invitations (email, role, created_by, expires_at) VALUES ($1, 'employee', $2, now() + interval '7 days') RETURNING token`, [email, U(ADMIN)])
  const id = randomUUID()
  await db.sys.query(`INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, now(), $3)`, [id, email, { invite_token: token }])
  return { id, c: await asId(id) }
}
const save = async (c, data, submit = false) => (await one(c, `SELECT save_onboarding($1, $2) v`, [data, submit])).v
const row = id => one(db.sys, `SELECT * FROM employee_onboarding WHERE profile_id = $1`, [id])
const approve = async onbId => (await one(await db.session(ADMIN),
  `SELECT approve_onboarding_with_pay($1, 'employee', 'Service', 'teilzeit', 20, 15, $2, 28, 'hourly', NULL) v`, [onbId, day(3)])).v

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
  await db.sys.query(`UPDATE employees SET phone = '+49 170 2222', emergency_contact_name = 'Mia (Schwester)', emergency_contact_phone = '+49 170 3333' WHERE id = $1`, [EMP(E2)])
  await loadLifecycle(db.sys)
  await loadProdFunctions(db.sys)
})
after(async () => { await db?.stop() })

test('Harness: aktiv ist save_onboarding aus Migration 32 (genau eine Variante)', async () => {
  const src = (await one(db.sys, `SELECT pg_get_functiondef(p.oid) s FROM pg_proc p WHERE p.proname = 'save_onboarding'`)).s
  assert.match(src, /oder lass beide Felder leer/)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM pg_proc WHERE proname = 'save_onboarding'`)).n, 1)
})

test('Ohne Notfallkontakt: Einreichen und Freischaltung gelingen, Felder bleiben NULL (nichts erfunden)', async () => {
  const { id, c } = await draft()
  const r = await save(c, BASE, true)
  assert.equal(r.success, true, JSON.stringify(r))
  const o = await row(id)
  assert.equal(o.status, 'submitted'); assert.equal(o.emergency_contact_name, null); assert.equal(o.emergency_contact_phone, null)
  const a = await approve(o.id)
  assert.equal(a.success, true, JSON.stringify(a))
  const e = await one(db.sys, `SELECT phone, emergency_contact_name, emergency_contact_phone FROM employees WHERE id = $1`, [a.employee_id])
  assert.deepEqual(e, { phone: '+880 1712-345678', emergency_contact_name: null, emergency_contact_phone: null })
})

test('Mit vollständigem Notfallkontakt: wie bisher, Werte werden übernommen', async () => {
  const { id, c } = await draft()
  assert.equal((await save(c, { ...BASE, emergency_contact_name: 'Nila (Mutter)', emergency_contact_phone: '+880 1811 000000' }, true)).success, true)
  const a = await approve((await row(id)).id)
  const e = await one(db.sys, `SELECT emergency_contact_name n, emergency_contact_phone p FROM employees WHERE id = $1`, [a.employee_id])
  assert.deepEqual(e, { n: 'Nila (Mutter)', p: '+880 1811 000000' })
})

test('Halber Notfallkontakt wird abgelehnt (am fehlenden Feld), Entwurf bleibt gespeichert und nicht eingereicht', async () => {
  for (const [part, field] of [[{ emergency_contact_name: 'Nur Name' }, 'emergency_contact_phone'], [{ emergency_contact_phone: '+49 170 4444' }, 'emergency_contact_name']]) {
    const { id, c } = await draft()
    const r = await save(c, { ...BASE, ...part }, true)
    assert.equal(r.success, false); assert.equal(r.field, field); assert.match(r.error, /oder lass beide Felder leer/)
    const o = await row(id)
    assert.equal(o.status, 'draft')
    assert.equal(o[Object.keys(part)[0]], Object.values(part)[0], 'Eingabe nicht verloren')
  }
  const { c } = await draft()
  const bad = await save(c, { ...BASE, emergency_contact_name: 'X', emergency_contact_phone: 'abc' }, true)
  assert.equal(bad.field, 'emergency_contact_phone', 'Format des Notfall-Telefons weiterhin geprüft')
})

test('Eigene Telefonnummer: Pflicht, Text mit führendem +, international, max. 50 Zeichen, Leerzeichen am Rand entfernt', async () => {
  const empty = await save((await draft()).c, { ...BASE, phone: '   ' }, true)
  assert.equal(empty.success, false); assert.equal(empty.field, 'phone')
  const long = await save((await draft()).c, { ...BASE, phone: '+' + '1'.repeat(50) }, true)
  assert.equal(long.success, false); assert.equal(long.field, 'phone', 'sonst scheitert erst die Freischaltung (varchar(50))')
  for (const phone of ['+880 1712-345678', '0049 (69) 123 456', '+1 415 555 0100', '01701234567']) {
    const { id, c } = await draft()
    assert.equal((await save(c, { ...BASE, phone: `  ${phone} ` }, true)).success, true, phone)
    assert.equal((await row(id)).phone, phone)
  }
  const types = await rows(db.sys, `SELECT table_name t, data_type d FROM information_schema.columns WHERE column_name = 'phone' AND table_name IN ('employees','employee_onboarding') ORDER BY 1`)
  assert.deepEqual(types.map(x => x.d), ['text', 'character varying'], 'Telefonnummern bleiben Text')
})

test('Fortsetzen: Telefon gespeichert, kein Notfallkontakt, App verlassen (neue Verbindung) → Daten da, Einreichen gelingt', async () => {
  const { id, c } = await draft()
  const { emergency_contact_name, emergency_contact_phone, privacy_accepted, ...rest } = BASE
  assert.equal((await save(c, rest)).success, true)                                  // Schritte ohne Notfallkontakt
  assert.equal((await save(c, { emergency_contact_name: '', emergency_contact_phone: '' })).success, true)
  await c.end()
  const again = await asId(id)                                                        // zurückkehren
  const o = (await again.query(`SELECT phone, emergency_contact_name, status FROM employee_onboarding WHERE profile_id = auth.uid()`)).rows[0]
  assert.deepEqual(o, { phone: '+880 1712-345678', emergency_contact_name: null, status: 'draft' })
  assert.equal((await save(again, { privacy_accepted: true }, true)).success, true)
})

test('Bestehende Mitarbeiter unverändert; Migration 32 wiederholt ausführbar, ändert keine Daten', async () => {
  const snap = () => rows(db.sys, `SELECT id, phone, emergency_contact_name, emergency_contact_phone FROM employees ORDER BY id`)
  const onb = () => rows(db.sys, `SELECT id, revision, status, phone, emergency_contact_name, emergency_contact_phone FROM employee_onboarding ORDER BY id`)
  const [e0, o0] = [await snap(), await onb()]
  await db.sys.query(migration('32_onboarding_emergency_optional.sql'))
  assert.deepEqual(await snap(), e0); assert.deepEqual(await onb(), o0)
  assert.deepEqual(e0.find(e => e.id === EMP(E2)), { id: EMP(E2), phone: '+49 170 2222', emergency_contact_name: 'Mia (Schwester)', emergency_contact_phone: '+49 170 3333' })
})

test('Sichtbarkeit Telefonnummer: Mitarbeiter nur eigene; Manager nur über das operative Verzeichnis (wie bisher); Admin alles', async () => {
  const e1 = await db.session(E1)
  assert.deepEqual((await e1.query(`SELECT id FROM employees`)).rows.map(r => r.id), [EMP(E1)], 'keine fremden Telefonnummern')
  assert.equal((await e1.query(`SELECT * FROM get_staff_operational()`)).rowCount, 0)
  assert.equal((await e1.query(`SELECT 1 FROM employee_onboarding`)).rowCount, 0, 'keine fremden Onboardings')
  const m = await db.session(MANAGER)
  assert.equal((await m.query(`SELECT phone FROM employees WHERE id = $1`, [EMP(E2)])).rowCount, 0, 'Manager: keine direkte Tabelle')
  const staff = await rows(m, `SELECT id, phone FROM get_staff_operational() WHERE id = $1`, [EMP(E2)])
  assert.deepEqual(staff, [{ id: EMP(E2), phone: '+49 170 2222' }], 'unverändert seit Migration 19: operative Kontaktnummer')
  const cols = (await m.query(`SELECT * FROM get_staff_operational() LIMIT 1`)).fields.map(f => f.name)
  assert.ok(!cols.some(c => /emergency/.test(c)), 'Notfallkontakt NICHT für Manager')
  assert.equal((await m.query(`SELECT 1 FROM employee_onboarding`)).rowCount, 0, 'Onboarding-Angaben nur Admin')
  assert.equal((await (await db.session(ADMIN)).query(`SELECT phone FROM employees WHERE id = $1`, [EMP(E2)])).rows[0].phone, '+49 170 2222')
})

test('Profil: Mitarbeiter ändert eigene Telefonnummer und darf den Notfallkontakt entfernen; fremde Daten unberührt', async () => {
  const e2 = await db.session(E2)
  const r = (await one(e2, `SELECT update_own_personal_data($1) v`, [{ phone: '+49 151 9999', emergency_contact_name: '', emergency_contact_phone: '' }])).v
  assert.equal(r.success, true, JSON.stringify(r))
  const e = await one(db.sys, `SELECT phone, emergency_contact_name, emergency_contact_phone FROM employees WHERE id = $1`, [EMP(E2)])
  assert.deepEqual(e, { phone: '+49 151 9999', emergency_contact_name: null, emergency_contact_phone: null })
  assert.equal((await e2.query(`UPDATE employees SET phone = '1' WHERE id = $1`, [EMP(E1)])).rowCount, 0, 'kein Schreibzugriff auf fremde Zeile')
})
