// Betriebsintegrität (Migration 27): Schichten mit Tausch-Historie bleiben löschbar (keine Sackgasse, kein
// Umdeuten eines Tauschs in eine Abgabe); Krankmeldungen/Urlaub löscht nur der Admin, Manager arbeiten weiter operativ.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, EMP, U, day } from './harness.mjs'

const [ADMIN, MANAGER, A, B] = [1, 2, 3, 4]
let db, nextDay = 5
before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [A, 'employee'], [B, 'employee']])
})
after(async () => { await db?.stop() })

const count = async (sql, p) => (await one(db.sys, sql, p)).n
const shift = async n => (await one(db.sys, `INSERT INTO shifts (employee_id, date, start_time, end_time) VALUES ($1, $2, '08:00', '16:00') RETURNING id`, [EMP(n), day(nextDay++)])).id
const swap = async (s, t, st) => (await one(db.sys, `INSERT INTO shift_swap_requests (requester_id, requester_shift_id, target_id, target_shift_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [EMP(A), s, EMP(B), t, st])).id
const del = async (n, sql, p) => (await (await db.session(n)).query(sql, p)).rowCount

test('Gegenschicht mit Tausch-Historie (abgelehnt/erledigt/offen) ist für Manager und Admin löschbar', async () => {
  for (const [who, st] of [[MANAGER, 'rejected'], [ADMIN, 'declined'], [MANAGER, 'cancelled']]) {
    const s = await shift(A), t = await shift(B)
    const id = await swap(s, t, st)
    assert.equal(await del(who, `DELETE FROM shifts WHERE id = $1`, [t]), 1, `${st}: Schicht gelöscht`)
    assert.equal(await count(`SELECT count(*)::int n FROM shift_swap_requests WHERE id = $1`, [id]), 0, 'gegenstandslose Anfrage mit entfernt')
    assert.equal(await count(`SELECT count(*)::int n FROM shifts WHERE id = $1 AND employee_id = $2`, [s, EMP(A)]), 1, 'andere Schicht unverändert')
  }
})

test('Offener/angenommener Tausch: Löschen der Gegenschicht macht daraus KEINE Abgabe (Freigabe danach unmöglich)', async () => {
  const s = await shift(A), t = await shift(B)
  const id = await swap(s, t, 'accepted')
  assert.equal(await del(MANAGER, `DELETE FROM shifts WHERE id = $1`, [t]), 1)
  assert.match(await err(() => db.session(MANAGER).then(c => c.query(`SELECT approve_swap($1)`, [id]))), /nicht gefunden/)
  assert.equal(await count(`SELECT count(*)::int n FROM shifts WHERE id = $1 AND employee_id = $2`, [s, EMP(A)]), 1, 'Schicht von A bleibt bei A')
})

test('Krankmeldungen: Manager legen an/ändern/lesen, löschen aber nicht; Admin löscht; eigene frische Meldung weiter löschbar', async () => {
  const mk = async (n, cert = null) => (await one(db.sys, `INSERT INTO sick_leave (employee_id, start_date, end_date, days_count, certificate_file_path) VALUES ($1, $2, $2, 1, $3) RETURNING id`, [EMP(n), day(-2), cert])).id
  const m = await db.session(MANAGER)
  const withCert = await mk(B, `${EMP(B)}/attest.pdf`)
  assert.equal((await m.query(`SELECT id FROM sick_leave WHERE id = $1`, [withCert])).rowCount, 1, 'Manager liest')
  assert.equal((await m.query(`UPDATE sick_leave SET notes = 'geprüft' WHERE id = $1`, [withCert])).rowCount, 1, 'Manager ändert')
  const created = (await one(m, `INSERT INTO sick_leave (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $2, 1) RETURNING id`, [EMP(B), day(-1)])).id
  assert.ok(created, 'Manager legt an')
  assert.equal(await del(MANAGER, `DELETE FROM sick_leave WHERE id = $1`, [withCert]), 0, 'Manager löscht nicht')
  assert.equal(await count(`SELECT count(*)::int n FROM sick_leave WHERE id = $1`, [withCert]), 1)
  assert.equal(await del(ADMIN, `DELETE FROM sick_leave WHERE id = $1`, [withCert]), 1, 'Admin löscht')
  // Mitarbeiter: eigene frische Meldung ohne Attest ja, fremde nie
  const ownFresh = (await one(await db.session(A), `INSERT INTO sick_leave (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $2, 1) RETURNING id`, [EMP(A), day(0)])).id
  assert.equal(await del(A, `DELETE FROM sick_leave WHERE id = $1`, [created]), 0)
  assert.equal(await del(A, `DELETE FROM sick_leave WHERE id = $1`, [ownFresh]), 1)
})

test('Urlaub: Manager genehmigen/lesen, löschen aber keinen (genehmigten) Antrag; Admin löscht; eigener offener Antrag löschbar', async () => {
  const approved = (await one(db.sys, `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count, status) VALUES ($1, $2, $2, 1, 'approved') RETURNING id`, [EMP(B), day(20)])).id
  const pending = (await one(await db.session(B), `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 5) RETURNING id`, [EMP(B), day(30), day(36)])).id
  const m = await db.session(MANAGER)
  assert.equal((await m.query(`SELECT id FROM vacation_requests WHERE id IN ($1, $2)`, [approved, pending])).rowCount, 2, 'Manager liest')
  assert.equal((await m.query(`UPDATE vacation_requests SET status = 'approved' WHERE id = $1 AND status = 'pending'`, [pending])).rowCount, 1, 'Manager genehmigt')
  assert.equal(await del(MANAGER, `DELETE FROM vacation_requests WHERE id = $1`, [approved]), 0, 'Manager löscht keinen genehmigten Urlaub')
  assert.equal(await del(ADMIN, `DELETE FROM vacation_requests WHERE id = $1`, [approved]), 1, 'Admin löscht')
  const own = (await one(await db.session(A), `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 5) RETURNING id`, [EMP(A), day(40), day(46)])).id
  assert.equal(await del(A, `DELETE FROM vacation_requests WHERE id = $1`, [pending]), 0, 'fremder Antrag nie')
  assert.equal(await del(A, `DELETE FROM vacation_requests WHERE id = $1`, [own]), 1, 'eigener offener Antrag')
})

test('Policy-Stand: keine FOR-ALL-Policy mehr auf Krankmeldungen/Urlaub; DELETE nur Admin bzw. eigene', async () => {
  const rows = (await db.sys.query(`SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE tablename IN ('sick_leave','vacation_requests') ORDER BY 1, 2`)).rows
  assert.equal(rows.filter(r => r.cmd === 'ALL').length, 0)
  const deletes = rows.filter(r => r.cmd === 'DELETE').map(r => r.policyname).sort()
  assert.deepEqual(deletes, ['sick_admin_delete', 'sick_delete_own_recent', 'vac_admin_delete', 'vac_delete_own_pending'])
})

test('Mindestens ein Admin: einziger Admin kann sich nicht herabstufen/sperren/löschen; mit zweitem Admin geht es; parallel nie null', async () => {
  const self = await db.session(ADMIN)
  for (const sql of [`UPDATE profiles SET role = 'employee' WHERE id = $1`, `UPDATE profiles SET status = 'disabled' WHERE id = $1`]) {
    assert.match(await err(() => self.query(sql, [U(ADMIN)])), /mindestens ein freigeschalteter Admin/)
  }
  assert.match(await err(() => db.sys.query(`DELETE FROM auth.users WHERE id = $1`, [U(ADMIN)])), /mindestens ein freigeschalteter Admin/, 'auch per Konto-Löschung (CASCADE)')
  assert.equal((await one(db.sys, `SELECT role, status FROM profiles WHERE id = $1`, [U(ADMIN)])).role, 'admin')
  // Zweiter Admin (Manager befördern) → dann darf einer zurücktreten
  await self.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [U(MANAGER)])
  assert.equal((await self.query(`UPDATE profiles SET role = 'manager' WHERE id = $1`, [U(MANAGER)])).rowCount, 1, 'Herabstufen mit verbleibendem Admin erlaubt')
  await self.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [U(MANAGER)])
  // Beide Admins stufen sich gleichzeitig selbst herab → genau einer gelingt, es bleibt ein Admin
  const [x, y] = [await db.as(ADMIN), await db.as(MANAGER)]
  const res = await Promise.all([[x, ADMIN], [y, MANAGER]].map(([c, n]) => err(() => c.query(`UPDATE profiles SET role = 'employee' WHERE id = $1`, [U(n)]))))
  assert.equal(res.filter(e => e === null).length, 1, JSON.stringify(res))
  assert.equal(await count(`SELECT count(*)::int n FROM profiles WHERE role = 'admin' AND status = 'approved'`), 1)
})
