// Stempeln außerhalb des Cafés (Migration 29): nur Manager/Admin, nur sich selbst, nur bestätigt, nur mit
// bestimmtem Standort; Mitarbeiter bleiben blockiert – auch per direktem API-/RPC-Aufruf. Pflichtprotokoll,
// keine Koordinaten, ein offener Eintrag (auch parallel), Serverzeit, > 12 h-Regel. Nur synthetische Daten, lokale DB.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, EMP, U } from './harness.mjs'

const [ADMIN, MANAGER, E1, M2, INACTIVE_M, ADMIN2] = [1, 2, 3, 4, 5, 6]
const CAFE = { lat: 50.1109, lng: 8.6821 }
const INSIDE = { lat: 50.1110, lng: 8.6822 }      // ≈ 13 m entfernt
const OUTSIDE = { lat: 50.2000, lng: 8.7000 }     // ≈ 10 km entfernt
const CAFE_IP = '198.51.100.23', HOME_IP = '203.0.113.9'
let db

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [M2, 'manager'],
                           [INACTIVE_M, 'manager', { active: false }], [ADMIN2, 'admin']])
  await db.sys.query(`INSERT INTO cafe_settings (id, gps_lat, gps_lng, gps_radius_m) VALUES (1, $1, $2, 200)`, [CAFE.lat, CAFE.lng])
  await db.sys.query(`INSERT INTO cafe_networks (cidr, label) VALUES ('198.51.100.0/24', 'Café-WLAN')`)
})
after(async () => { await db?.stop() })

// Jeder Test: keine offenen Einträge, GPS-Modus (GPS ODER WLAN), Rollen wie angelegt
beforeEach(async () => {
  // Jeder Test beginnt ohne Zeiteinträge: die Tests verschieben Einstempelzeiten künstlich zurück (Systemverbindung) –
  // ohne Aufräumen entstünden Überschneidungen, die es real nicht gibt (Migration 37 prüft sie)
  await db.sys.query(`DELETE FROM time_entries`)
  await db.sys.query(`UPDATE cafe_settings SET gps_lat = $1, gps_lng = $2, clock_require_network = false WHERE id = 1`, [CAFE.lat, CAFE.lng])
  await setProfile(MANAGER, 'manager', 'approved'); await setProfile(M2, 'manager', 'approved')
})

// Rolle/Status ändern wie in der App: durch einen Admin (Systemkontext würde der Eskalationsschutz zurücksetzen)
async function setProfile(n, role, status) {
  const a = await db.session(ADMIN)
  await a.query(`UPDATE profiles SET role = $2, status = $3 WHERE id = $1`, [U(n), role, status])
  const p = await one(db.sys, `SELECT role, status FROM profiles WHERE id = $1`, [U(n)])
  assert.deepEqual([p.role, p.status], [role, status], 'Testaufbau: Rolle gesetzt')
}

// Verbindung wie PostgREST hinter Cloudflare: Client-IP im Header (null = kein Header)
async function as(n, ip = HOME_IP) {
  const c = await db.as(n)
  if (ip) await c.query(`SELECT set_config('request.headers', $1, false)`, [JSON.stringify({ 'cf-connecting-ip': ip })])
  return c
}
const remoteIn  = (c, pos, confirmed = true) => c.query(`SELECT clock_in_remote($1, $2, $3) r`, [pos?.lat ?? null, pos?.lng ?? null, confirmed]).then(r => r.rows[0].r)
const remoteOut = (c, pos, confirmed = true) => c.query(`SELECT clock_out_remote($1, $2, $3) r`, [pos?.lat ?? null, pos?.lng ?? null, confirmed]).then(r => r.rows[0].r)
const normalIn  = (c, n, pos) => c.query(`INSERT INTO time_entries (employee_id, date, clock_in, gps_lat_in, gps_lng_in) VALUES ($1, current_date, now(), $2, $3) RETURNING id`, [EMP(n), pos?.lat ?? null, pos?.lng ?? null])
const normalOut = (c, id, pos) => c.query(`UPDATE time_entries SET clock_out = now(), gps_lat_out = $2, gps_lng_out = $3 WHERE id = $1 AND clock_out IS NULL RETURNING id`, [id, pos?.lat ?? null, pos?.lng ?? null])
const openOf = n => rows(db.sys, `SELECT * FROM time_entries WHERE employee_id = $1 AND clock_out IS NULL`, [EMP(n)])
const logs = (action, n) => rows(db.sys, `SELECT * FROM activity_log WHERE action = $1 AND actor_id = $2 ORDER BY created_at`, [action, U(n)])
const entryCount = async () => (await one(db.sys, `SELECT count(*)::int c FROM time_entries`)).c
// Fehler-HINT (Client entscheidet daran, nie am Text)
async function hint(fn) { try { await fn(); return null } catch (e) { return e.hint || e.message } }

test('Mitarbeiter: außerhalb weiterhin blockiert – normal, per RPC, mit gesetztem Flag, mit gefälschter Rolle im JWT', async () => {
  const before = await entryCount()
  const c = await as(E1)
  assert.match(await err(() => normalIn(c, E1, OUTSIDE)), /nur im Café/)
  assert.equal(await hint(() => remoteIn(c, OUTSIDE)), 'remote_not_allowed')
  assert.equal(await hint(() => remoteIn(c, INSIDE)), 'remote_not_allowed', 'RPC ist für Mitarbeiter ganz gesperrt')
  // Manipulation: Flag selbst setzen (geht über PostgREST nicht – hier trotzdem simuliert)
  await c.query(`SELECT set_config('cafe.remote_clock', 'on', false)`)
  assert.match(await err(() => normalIn(c, E1, OUTSIDE)), /nur im Café/, 'Flag allein reicht nicht – Rolle wird live geprüft')
  await c.query(`SELECT set_config('cafe.remote_clock', '', false)`)
  // Gefälschte Rolle in den JWT-Claims: Rolle kommt aus profiles, nicht aus dem Request
  const forged = await db.as(E1)
  await forged.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U(E1), role: 'authenticated', user_role: 'admin', app_metadata: { role: 'admin' } })])
  assert.equal(await hint(() => remoteIn(forged, OUTSIDE)), 'remote_not_allowed')
  assert.equal(await hint(() => remoteOut(c, OUTSIDE)), 'remote_not_allowed')
  assert.equal(await entryCount(), before, 'kein Eintrag entstanden')
  assert.equal((await logs('time.remote_clock_in', E1)).length, 0)
  // anonym: keine Ausführungsrechte
  const anon = await db.anon()
  assert.match(await err(() => anon.query(`SELECT clock_in_remote(1, 1, true)`)), /permission denied/)
  // interne Hilfsfunktionen (Protokoll schreiben, Prüfung, Selbst-ID) sind für angemeldete Personen nicht aufrufbar
  for (const sql of [`SELECT _remote_clock_log('time.remote_clock_in', 'x', gen_random_uuid(), gen_random_uuid(), 'gps')`,
                     `SELECT _remote_clock_check(1, 1, true)`, `SELECT _remote_clock_self()`])
    assert.match(await err(() => c.query(sql)), /permission denied/, sql)
  const m = await as(MANAGER)
  assert.match(await err(() => m.query(`SELECT _remote_clock_log('time.remote_clock_in', 'gefälscht', gen_random_uuid(), gen_random_uuid(), 'gps')`)), /permission denied/)
})

test('Mitarbeiter: normales Stempeln im Café unverändert (GPS und WLAN), Pause, Ausstempeln – keine Remote-Markierung', async () => {
  const c = await as(E1)
  const { rows: [{ id }] } = await normalIn(c, E1, INSIDE)
  let e = await one(db.sys, `SELECT clock_in_method, gps_ok_in, gps_lat_in FROM time_entries WHERE id = $1`, [id])
  assert.equal(e.clock_in_method, 'gps'); assert.equal(e.gps_ok_in, true)
  await c.query(`SELECT start_break()`); await c.query(`SELECT end_break()`)
  // Ausstempeln außerhalb: weiterhin blockiert – auch mit selbst gesetztem Flag (Rolle wird live geprüft)
  assert.match(await err(() => normalOut(c, id, OUTSIDE)), /nur im Café/)
  await c.query(`SELECT set_config('cafe.remote_clock', 'on', false)`)
  assert.match(await err(() => normalOut(c, id, OUTSIDE)), /nur im Café/)
  await c.query(`SELECT set_config('cafe.remote_clock', '', false)`)
  assert.equal((await normalOut(c, id, INSIDE)).rowCount, 1)
  e = await one(db.sys, `SELECT clock_out_method FROM time_entries WHERE id = $1`, [id])
  assert.equal(e.clock_out_method, 'gps')
  const w = await as(E1, CAFE_IP)                       // ohne GPS, im Café-WLAN
  const { rows: [{ id: id2 }] } = await normalIn(w, E1, null)
  assert.equal((await one(db.sys, `SELECT clock_in_method FROM time_entries WHERE id = $1`, [id2])).clock_in_method, 'wlan')
  assert.equal((await logs('time.remote_clock_in', E1)).length, 0)
})

test('Manager: außerhalb nur mit Bestätigung; dann Remote-Eintrag (Serverzeit, keine Koordinaten) + Protokoll', async () => {
  const c = await as(MANAGER)
  assert.match(await err(() => normalIn(c, MANAGER, OUTSIDE)), /nur im Café/, 'normaler Weg bleibt blockiert (kein stilles Remote)')
  assert.equal(await hint(() => remoteIn(c, OUTSIDE, false)), 'confirmation_required')
  assert.equal(await hint(() => remoteIn(c, OUTSIDE, null)), 'confirmation_required')
  assert.equal((await openOf(MANAGER)).length, 0, 'ohne Bestätigung kein Eintrag')
  const r = await remoteIn(c, OUTSIDE, true)
  assert.equal(r.success, true); assert.equal(r.remote, true)
  const e = await one(db.sys, `SELECT *, (now() AT TIME ZONE 'Europe/Berlin')::date AS berlin FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.employee_id, EMP(MANAGER))
  assert.equal(e.clock_in_method, 'remote'); assert.equal(e.gps_ok_in, false)
  assert.equal(e.gps_lat_in, null); assert.equal(e.gps_lng_in, null)
  assert.ok(Math.abs(new Date(e.clock_in) - Date.now()) < 60000, 'Serverzeit')
  assert.equal(e.date.toISOString().slice(0, 10), e.berlin.toISOString().slice(0, 10))
  assert.equal(e.clock_out, null); assert.equal(e.approved, false)
  const l = await logs('time.remote_clock_in', MANAGER)
  assert.equal(l.length, 1)
  assert.equal(l[0].actor_role, 'manager'); assert.equal(l[0].category, 'time'); assert.equal(l[0].target_id, r.id)
  assert.equal(l[0].metadata.employee_id, EMP(MANAGER)); assert.equal(l[0].metadata.location_check, 'gps')
  assert.match(l[0].summary, /außerhalb des Cafés eingestempelt \(bestätigt\)/)
  assert.doesNotMatch(JSON.stringify(l[0]), /50\.2|8\.7/, 'keine Koordinaten im Protokoll')
})

test('Manager: Standort unbekannt (kein GPS / ungültig) → Ablehnung, kein stilles Remote – auch mit Bestätigung', async () => {
  const c = await as(MANAGER)
  const logged = (await logs('time.remote_clock_in', MANAGER)).length
  assert.equal(await hint(() => remoteIn(c, null)), 'location_unknown')
  assert.equal(await hint(() => remoteIn(c, { lat: 123, lng: 8 })), 'location_unknown')
  assert.equal(await hint(() => remoteIn(c, { lat: 50, lng: null })), 'location_unknown')
  assert.equal((await openOf(MANAGER)).length, 0)
  assert.equal((await logs('time.remote_clock_in', MANAGER)).length, logged)
})

test('Manager im Café über die RPC → normaler Eintrag (gps/wlan), nicht als Remote protokolliert', async () => {
  const c = await as(MANAGER)
  const r = await remoteIn(c, INSIDE, true)
  assert.equal(r.remote, false)
  assert.equal((await one(db.sys, `SELECT clock_in_method FROM time_entries WHERE id = $1`, [r.id])).clock_in_method, 'gps')
  await db.sys.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [r.id])
  const w = await as(MANAGER, CAFE_IP)
  const r2 = await remoteIn(w, OUTSIDE, false)          // GPS draußen, aber im Café-WLAN → im Café, keine Bestätigung nötig
  assert.equal(r2.remote, false)
  assert.equal((await one(db.sys, `SELECT clock_in_method FROM time_entries WHERE id = $1`, [r2.id])).clock_in_method, 'wlan')
  assert.equal((await logs('time.remote_clock_in', MANAGER)).length, 1, 'nur der eine bestätigte Remote-Fall aus dem vorigen Test')
})

test('Nur-WLAN-Modus: außerhalb über Client-IP bestimmt; ohne IP unbekannt; im Café-WLAN normal', async () => {
  await db.sys.query(`UPDATE cafe_settings SET clock_require_network = true WHERE id = 1`)
  const noIp = await as(M2, null)
  assert.equal(await hint(() => remoteIn(noIp, INSIDE)), 'location_unknown', 'GPS zählt im Nur-WLAN-Modus nicht')
  const home = await as(M2, HOME_IP)
  assert.equal(await hint(() => remoteIn(home, null, false)), 'confirmation_required')
  const r = await remoteIn(home, null, true)
  assert.equal(r.remote, true)
  assert.equal((await logs('time.remote_clock_in', M2)).at(-1).metadata.location_check, 'network')
  await db.sys.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [r.id])
  const cafe = await as(M2, CAFE_IP)
  const r2 = await remoteIn(cafe, null, false)
  assert.equal(r2.remote, false)
  assert.equal((await one(db.sys, `SELECT clock_in_method FROM time_entries WHERE id = $1`, [r2.id])).clock_in_method, 'wlan')
})

test('Admin: außerhalb bestätigt → Remote-Eintrag mit Serverzeit und Markierung (Admin umgeht sonst den Trigger)', async () => {
  const c = await as(ADMIN)
  assert.equal(await hint(() => remoteIn(c, OUTSIDE, false)), 'confirmation_required')
  assert.equal(await hint(() => remoteIn(c, null, true)), 'location_unknown')
  const r = await remoteIn(c, OUTSIDE, true)
  const e = await one(db.sys, `SELECT * FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.employee_id, EMP(ADMIN)); assert.equal(e.clock_in_method, 'remote'); assert.equal(e.gps_ok_in, false)
  assert.equal(e.gps_lat_in, null); assert.ok(Math.abs(new Date(e.clock_in) - Date.now()) < 60000)
  assert.equal(e.break_minutes, 0); assert.equal(e.approved, false)
  const l = await logs('time.remote_clock_in', ADMIN)
  assert.equal(l.length, 1); assert.equal(l[0].actor_role, 'admin')
})

test('Nur sich selbst: keine Mitarbeiter-ID als Parameter; andere Personen unberührt', async () => {
  const sig = await rows(db.sys, `SELECT pg_get_function_identity_arguments(p.oid) a FROM pg_proc p WHERE proname IN ('clock_in_remote','clock_out_remote')`)
  for (const s of sig) assert.doesNotMatch(s.a, /employee|uuid/, s.a)
  const others = async () => (await one(db.sys, `SELECT count(*)::int c FROM time_entries WHERE employee_id <> $1`, [EMP(M2)])).c
  const before = await others()
  const c = await as(M2)
  const r = await remoteIn(c, OUTSIDE)
  assert.equal((await one(db.sys, `SELECT employee_id FROM time_entries WHERE id = $1`, [r.id])).employee_id, EMP(M2))
  assert.equal(await others(), before)
  // Ausstempeln betrifft nur den eigenen offenen Eintrag – fremder offener Eintrag bleibt offen
  const e1 = await as(E1)
  const { rows: [{ id: other }] } = await normalIn(e1, E1, INSIDE)
  await remoteOut(c, OUTSIDE)
  assert.equal((await one(db.sys, `SELECT clock_out FROM time_entries WHERE id = $1`, [other])).clock_out, null)
  assert.equal((await openOf(M2)).length, 0)
})

test('Parallel: 12 gleichzeitige bestätigte Remote-Einstempelungen (Geräte/Tabs/Doppeltipp) → genau 1 Eintrag, 1 Protokoll', async () => {
  const before = (await logs('time.remote_clock_in', MANAGER)).length
  const conns = await Promise.all(Array.from({ length: 12 }, () => as(MANAGER)))
  const res = await Promise.all(conns.map(c => hint(() => remoteIn(c, OUTSIDE))))
  assert.equal(res.filter(r => r === null).length, 1)
  assert.ok(res.filter(r => r !== null).every(r => r === 'already_clocked_in'), res.join(','))
  assert.equal((await openOf(MANAGER)).length, 1)
  assert.equal((await logs('time.remote_clock_in', MANAGER)).length, before + 1)
})

test('Parallel: Admin in zwei Tabs + normaler Weg gleichzeitig → genau 1 offener Eintrag', async () => {
  const [a, b, c] = [await as(ADMIN2), await as(ADMIN2), await as(ADMIN2)]
  const res = await Promise.all([hint(() => remoteIn(a, OUTSIDE)), hint(() => remoteIn(b, OUTSIDE)),
                                 err(() => normalIn(c, ADMIN2, INSIDE))])
  assert.equal(res.filter(r => r === null).length, 1, res.join(' | '))
  assert.equal((await openOf(ADMIN2)).length, 1)
})

test('Wiederholung nach Timeout (Antwort verloren): zweiter Aufruf ändert nichts → already_clocked_in, 1 Eintrag, 1 Protokoll', async () => {
  const c = await as(M2)
  const before = (await logs('time.remote_clock_in', M2)).length
  await remoteIn(c, OUTSIDE)
  const retry = await as(M2)
  assert.equal(await hint(() => remoteIn(retry, OUTSIDE)), 'already_clocked_in')
  assert.equal((await openOf(M2)).length, 1)
  assert.equal((await logs('time.remote_clock_in', M2)).length, before + 1)
  // UI glaubt „nicht eingestempelt“, normaler Weg aus dem Café → ebenfalls abgelehnt
  assert.match(await err(() => normalIn(retry, M2, INSIDE)), /bereits eingeclockt/)
})

test('Rolle zwischen Dialog und Bestätigung entzogen / Konto gesperrt / inaktiv → abgelehnt, nichts geschrieben', async () => {
  const c = await as(MANAGER)
  await setProfile(MANAGER, 'employee', 'approved')
  assert.equal(await hint(() => remoteIn(c, OUTSIDE)), 'remote_not_allowed')
  await setProfile(MANAGER, 'manager', 'disabled')
  assert.equal(await hint(() => remoteIn(c, OUTSIDE)), 'remote_not_allowed')
  const inactive = await as(INACTIVE_M)
  assert.equal(await hint(() => remoteIn(inactive, OUTSIDE)), 'inactive')
  assert.equal((await openOf(MANAGER)).length, 0); assert.equal((await openOf(INACTIVE_M)).length, 0)
  // Herabgestuft NACH dem Remote-Einstempeln: Ausstempeln außerhalb nur noch im Café möglich
  await setProfile(MANAGER, 'manager', 'approved')
  await remoteIn(c, OUTSIDE)
  await setProfile(MANAGER, 'employee', 'approved')
  assert.equal(await hint(() => remoteOut(c, OUTSIDE)), 'remote_not_allowed')
  const [{ id }] = await openOf(MANAGER)
  assert.match(await err(() => normalOut(c, id, OUTSIDE)), /nur im Café/)
  assert.equal((await normalOut(c, id, INSIDE)).rowCount, 1)
})

test('Protokoll ist Pflicht: schlägt der Protokolleintrag fehl, entsteht auch kein Zeiteintrag', async () => {
  await db.sys.query(`ALTER TABLE activity_log ADD CONSTRAINT test_block_remote CHECK (action <> 'time.remote_clock_in') NOT VALID`)
  try {
    const c = await as(M2)
    assert.match(await err(() => remoteIn(c, OUTSIDE)), /test_block_remote/)
    assert.equal((await openOf(M2)).length, 0)
  } finally {
    await db.sys.query(`ALTER TABLE activity_log DROP CONSTRAINT test_block_remote`)
  }
})

test('Manager: Remote-Einstempeln → Pausen → bestätigtes Remote-Ausstempeln (Trigger rechnet, Protokoll, keine Koordinaten)', async () => {
  const c = await as(MANAGER)
  const r = await remoteIn(c, OUTSIDE)
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '6 hours' WHERE id = $1`, [r.id])
  const b = await one(c, `SELECT * FROM start_break()`)
  await db.sys.query(`UPDATE time_entry_breaks SET break_start = now() - interval '3 hours' WHERE id = $1`, [b.id])
  await c.query(`SELECT end_break()`)
  await db.sys.query(`UPDATE time_entry_breaks SET break_end = now() - interval '2 hours 30 minutes' WHERE id = $1`, [b.id])
  await c.query(`SELECT start_break()`)                     // läuft noch beim Ausstempeln
  assert.equal(await hint(() => remoteOut(c, null)), 'location_unknown')
  assert.equal(await hint(() => remoteOut(c, OUTSIDE, false)), 'confirmation_required')
  assert.equal((await openOf(MANAGER)).length, 1, 'ohne Bestätigung bleibt der Eintrag offen')
  const o = await remoteOut(c, OUTSIDE, true)
  assert.equal(o.remote, true)
  const e = await one(db.sys, `SELECT * FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.clock_out_method, 'remote'); assert.equal(e.gps_lat_out, null); assert.equal(e.gps_ok_out, false)
  assert.equal(e.break_minutes, 30); assert.equal(Number(e.hours_worked), 5.5)
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end IS NULL`, [r.id])).c, 0)
  assert.equal((await logs('time.remote_clock_out', MANAGER)).length, 1)
  assert.equal(await hint(() => remoteOut(c, OUTSIDE)), 'not_clocked_in', 'zweites Ausstempeln: keine Wirkung')
})

test('Admin: Remote-Ausstempeln rechnet wie beim Mitarbeiter (Serverzeit, Pausen, > 12 h → 0 + Markierung)', async () => {
  const c = await as(ADMIN)
  let r = await remoteIn(c, OUTSIDE)
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '4 hours', break_minutes = 0 WHERE id = $1`, [r.id])
  let o = await remoteOut(c, OUTSIDE)
  assert.equal(Number(o.hours_worked), 4); assert.equal(o.break_minutes, 0)
  let e = await one(db.sys, `SELECT clock_out, clock_out_method FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.clock_out_method, 'remote'); assert.ok(Math.abs(new Date(e.clock_out) - Date.now()) < 60000)
  await db.sys.query(`DELETE FROM time_entries WHERE id = $1`, [r.id])   // Zeitreise unten würde den eben beendeten Eintrag überlappen
  r = await remoteIn(c, OUTSIDE)
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '14 hours' WHERE id = $1`, [r.id])
  o = await remoteOut(c, OUTSIDE)
  assert.equal(Number(o.hours_worked), 0); assert.match(o.notes, /VERGESSEN/)
  // Admin im Café über die RPC → normale Methode, kein Protokoll
  const w = await as(ADMIN, CAFE_IP)
  const before = (await logs('time.remote_clock_out', ADMIN)).length
  await db.sys.query(`DELETE FROM time_entries WHERE id = $1`, [r.id])   // Zeitreise unten würde den vorigen Eintrag überlappen
  r = await remoteIn(w, null, false)
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '2 hours' WHERE id = $1`, [r.id])
  o = await remoteOut(w, null, false)
  assert.equal(o.remote, false); assert.equal(Number(o.hours_worked), 2)
  assert.equal((await one(db.sys, `SELECT clock_out_method FROM time_entries WHERE id = $1`, [r.id])).clock_out_method, 'wlan')
  assert.equal((await logs('time.remote_clock_out', ADMIN)).length, before)
})

test('Über Mitternacht: Remote-Eintrag vom Vortag, Ausstempeln heute → Datum bleibt, Stunden korrekt', async () => {
  const c = await as(M2)
  const r = await remoteIn(c, OUTSIDE)
  await db.sys.query(`UPDATE time_entries SET clock_in = now() - interval '7 hours', date = ((now() - interval '7 hours') AT TIME ZONE 'Europe/Berlin')::date WHERE id = $1`, [r.id])
  const before = await one(db.sys, `SELECT date FROM time_entries WHERE id = $1`, [r.id])
  await remoteOut(c, OUTSIDE)
  const e = await one(db.sys, `SELECT date, hours_worked FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.date.getTime(), before.date.getTime()); assert.equal(Number(e.hours_worked), 7)
})

test('Remote-Markierung ist für Manager nicht änderbar; Admin-Korrektur funktioniert und lässt sie stehen', async () => {
  const c = await as(MANAGER)
  const r = await remoteIn(c, OUTSIDE)
  await c.query(`UPDATE time_entries SET clock_in_method = 'gps', gps_ok_in = true, clock_in = now() - interval '9 hours' WHERE id = $1`, [r.id])
  let e = await one(db.sys, `SELECT clock_in_method, gps_ok_in, clock_in FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.clock_in_method, 'remote'); assert.equal(e.gps_ok_in, false)
  assert.ok(Math.abs(new Date(e.clock_in) - Date.now()) < 60000)
  await remoteOut(c, OUTSIDE)
  const state = (await one(db.sys, `SELECT _time_entry_state($1) s`, [r.id])).s
  const a = await as(ADMIN)
  const res = (await one(a, `SELECT admin_save_time_entry($1, NULL, current_date - 3, '08:00', '12:00', '[]'::jsonb, 0, NULL, 'Test-Korrektur', $2) r`, [r.id, state])).r
  assert.equal(res.success, true)
  e = await one(db.sys, `SELECT clock_in_method, hours_worked FROM time_entries WHERE id = $1`, [r.id])
  assert.equal(e.clock_in_method, 'remote'); assert.equal(Number(e.hours_worked), 4)
})

test('Flag bleibt nicht hängen: nach einem Remote-Aufruf ist der normale Weg auf derselben Verbindung wieder blockiert', async () => {
  const c = await as(M2)
  const r = await remoteIn(c, OUTSIDE)
  await db.sys.query(`UPDATE time_entries SET clock_out = now() WHERE id = $1`, [r.id])
  assert.equal((await one(c, `SELECT COALESCE(current_setting('cafe.remote_clock', true), '') v`)).v, '')
  assert.match(await err(() => normalIn(c, M2, OUTSIDE)), /nur im Café/)
  // auch innerhalb DERSELBEN Transaktion nach dem RPC (Flag wird in der Funktion zurückgesetzt)
  await c.query('BEGIN')
  const r2 = await remoteIn(c, OUTSIDE)
  assert.equal((await one(c, `SELECT COALESCE(current_setting('cafe.remote_clock', true), '') v`)).v, '')
  await c.query(`UPDATE time_entries SET clock_in_method = clock_in_method WHERE id = $1`, [r2.id])
  await c.query('SAVEPOINT s')
  await db.sys.query(`SELECT 1`)
  // zweiter Eintrag in derselben Transaktion ist ohnehin durch „ein offener Eintrag“ gesperrt → eigenen schließen geht nur bestätigt
  assert.match(await err(() => normalOut(c, r2.id, OUTSIDE)), /nur im Café/)
  await c.query('ROLLBACK')
  assert.equal((await openOf(M2)).length, 0, 'zurückgerollt → kein Eintrag')
})
