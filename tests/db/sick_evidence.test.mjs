// Nachweis ohne App-Datei (eAU): bestehendes Datenmodell kann ihn bereits abbilden – Manager/Admin setzen
// certificate_received ohne Datei; Mitarbeiter können ihn ohne Datei NICHT selbst setzen (Guard). Keine Migration,
// keine Datenänderung durch den Lohn-Fix. Nur synthetische Daten, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, one, err, EMP } from './harness.mjs'

const [ADMIN, MANAGER, E1] = [1, 2, 3]
let db
before(async () => { db = await startDb(); await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee']]) })
after(async () => { await db?.stop() })

const today = () => new Date().toISOString().slice(0, 10)

test('Mitarbeiter meldet sich krank: ohne Datei kein Nachweis-Flag, auch nicht per manipuliertem Insert/Update', async () => {
  const c = await db.session(E1)
  const s = await one(c, `INSERT INTO sick_leave (employee_id, start_date, certificate_received) VALUES ($1, $2, true) RETURNING id, certificate_received, continued_pay_end`, [EMP(E1), today()])
  assert.equal(s.certificate_received, false, 'Guard setzt beim Mitarbeiter-Insert zurück')
  assert.ok(s.continued_pay_end, 'Lohnfortzahlungsende wie bisher per Trigger')
  await c.query(`UPDATE sick_leave SET certificate_received = true WHERE id = $1`, [s.id])
  assert.equal((await one(db.sys, `SELECT certificate_received FROM sick_leave WHERE id = $1`, [s.id])).certificate_received, false)
})

test('eAU ohne App-Datei: Manager/Admin können den Nachweis vermerken (Datei bleibt leer) – Lohn rechnet ohnehin nicht mehr mit der Datei', async () => {
  for (const who of [ADMIN, MANAGER]) {
    const s = await one(db.sys, `INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, '2026-10-05', '2026-10-09') RETURNING id`, [EMP(E1)])
    const r = await (await db.session(who)).query(`UPDATE sick_leave SET certificate_received = true WHERE id = $1`, [s.id])
    assert.equal(r.rowCount, 1)
    const row = await one(db.sys, `SELECT certificate_received, certificate_file_path FROM sick_leave WHERE id = $1`, [s.id])
    assert.deepEqual(row, { certificate_received: true, certificate_file_path: null })
  }
  assert.match(await err(async () => (await db.session(E1)).query(`INSERT INTO sick_leave (employee_id, start_date) VALUES ($1, $2)`, [EMP(ADMIN), today()])), /row-level security/)
})
