// Versionierte Kenntnisnahme der Datenschutzhinweise (Migration 23) – App-Funktionen gegen die echte DB mit RLS.
// Nur eigene Kenntnisnahme per RPC, kein Backfill, altes privacy_accepted zählt nicht, idempotent unter Parallelität.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, U, EMP } from './harness.mjs'
import { loadPrivacyAck, acknowledgePrivacyNotice } from '../../src/lib/privacyAck.js'
import { PRIVACY_NOTICE_VERSION } from '../../src/legal/legalContent.js'

const [ADMIN, MANAGER, E1, E2, PENDING, DISABLED] = [1, 2, 3, 4, 5, 6]
let db
before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee'], [PENDING, 'employee', { status: 'pending' }], [DISABLED, 'employee', { status: 'disabled' }]])
  // Altbestand: Onboarding-Bestätigung der alten Hinweise (Zeitstempel ohne Version)
  const req = (await db.sys.query(`SELECT column_name FROM information_schema.columns WHERE table_name='employee_onboarding' AND is_nullable='NO' AND column_default IS NULL`)).rows.map(r => r.column_name)
  const row = { profile_id: U(E1), privacy_accepted_at: '2026-09-23T11:39:42Z' }; for (const c of req) if (!(c in row)) row[c] = 'x'
  await db.sys.query(`INSERT INTO employee_onboarding (${Object.keys(row)}) VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`)})`, Object.values(row))
})
after(async () => { await db?.stop() })

// supabase-js-kompatibler Mini-Adapter: jede Anfrage als die angemeldete Person (wie PostgREST)
const client = n => ({
  from(table) {
    let cols = '*'; const where = []
    const api = {
      select(c) { cols = c; return api }, eq(k, v) { where.push([k, v]); return api },
      async maybeSingle() {
        try { const r = await (await db.session(n)).query(`SELECT ${cols} FROM ${table} WHERE ${where.map((w, i) => `${w[0]} = $${i + 1}`).join(' AND ')}`, where.map(w => w[1])); return { data: r.rows[0] ?? null, error: null } }
        catch (e) { return { data: null, error: { message: e.message } } }
      },
    }
    return api
  },
  async rpc(name, args) {
    try { const r = await (await db.session(n)).query(`SELECT ${name}($1) AS v`, [args.p_version]); return { data: r.rows[0].v, error: null } }
    catch (e) { return { data: null, error: { message: e.message } } }
  },
})
const count = async (sql, p) => (await one(db.sys, sql, p)).n

test('Kein Backfill; bestehende Konten (auch mit altem privacy_accepted, Admin/Manager) müssen die aktuelle Version bestätigen', async () => {
  assert.equal(PRIVACY_NOTICE_VERSION, '2026-09-28')
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements`), 0)
  for (const n of [E1, E2, ADMIN, MANAGER]) assert.equal(await loadPrivacyAck(client(n), U(n)), 'required', `Person ${n}`)
})

test('Bestätigen speichert Version + Serverzeit; neue Sitzung sieht „ok“; ältere/künftige Version → erneut erforderlich', async () => {
  const t0 = Date.now()
  const r = await acknowledgePrivacyNotice(client(E2))
  assert.equal(r.ok, true)
  const row = await one(db.sys, `SELECT notice_version, acknowledged_at FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [U(E2)])
  assert.equal(row.notice_version, '2026-09-28')
  assert.ok(Math.abs(row.acknowledged_at - t0) < 10000 && +new Date(r.acknowledgedAt) === +row.acknowledged_at)
  const fresh = await db.as(E2)                                              // anderes Gerät / neue Sitzung
  assert.equal((await fresh.query(`SELECT 1 FROM privacy_notice_acknowledgements WHERE profile_id = $1 AND notice_version = $2`, [U(E2), PRIVACY_NOTICE_VERSION])).rowCount, 1)
  assert.equal(await loadPrivacyAck(client(E2), U(E2)), 'ok')
  assert.equal(await loadPrivacyAck(client(E2), U(E2), '2027-03-01'), 'required')
  await db.sys.query(`INSERT INTO privacy_notice_acknowledgements (profile_id, notice_version) VALUES ($1, '2025-01-01')`, [U(E1)])
  assert.equal(await loadPrivacyAck(client(E1), U(E1)), 'required', 'nur ältere Version bestätigt')
})

test('Nur eigene Kenntnisnahme: kein direktes Schreiben, nichts für andere, Manager/Admin setzen nichts für Mitarbeiter', async () => {
  for (const who of [E1, MANAGER, ADMIN]) {
    const c = await db.session(who)
    assert.match(await err(() => c.query(`INSERT INTO privacy_notice_acknowledgements (profile_id, notice_version) VALUES ($1, '2026-09-28')`, [U(E2 === who ? E1 : E2)])), /permission denied/, `INSERT (${who})`)
    assert.match(await err(() => c.query(`UPDATE privacy_notice_acknowledgements SET acknowledged_at = now() - interval '1 year'`)), /permission denied/, `UPDATE (${who})`)
    assert.match(await err(() => c.query(`DELETE FROM privacy_notice_acknowledgements`)), /permission denied/, `DELETE (${who})`)
  }
  const e1 = await db.session(E1)
  assert.equal((await e1.query(`SELECT 1 FROM privacy_notice_acknowledgements WHERE profile_id <> $1`, [U(E1)])).rowCount, 0, 'nur eigener Status sichtbar')
  assert.ok((await (await db.session(ADMIN)).query(`SELECT 1 FROM privacy_notice_acknowledgements`)).rowCount >= 2, 'Admin sieht Status')
  assert.equal((await one(db.sys, `SELECT pg_get_function_identity_arguments('public.acknowledge_privacy_notice(text)'::regprocedure) a`)).a, 'p_version text', 'RPC ohne Parameter für andere Person')
  assert.match(await err(() => e1.query(`SELECT acknowledge_privacy_notice('2026-09-28; x')`)), /Ungültige Version/)
  assert.equal((await acknowledgePrivacyNotice(client(DISABLED))).ok, false, 'gesperrtes Konto')
  const anon = await db.anon()
  assert.match(await err(() => anon.query(`SELECT acknowledge_privacy_notice('2026-09-28')`)), /permission denied/)
  assert.match(await err(() => anon.query(`SELECT * FROM privacy_notice_acknowledgements`)), /permission denied/)
})

test('Parallel/doppelt: 12 gleichzeitige Bestätigungen → alle ok, genau ein Eintrag, erster Zeitpunkt bleibt', async () => {
  const conns = await Promise.all(Array.from({ length: 12 }, () => db.as(MANAGER)))
  const res = await Promise.all(conns.map(c => c.query(`SELECT acknowledge_privacy_notice($1) AS v`, [PRIVACY_NOTICE_VERSION]).then(r => r.rows[0].v)))
  const stored = await db.sys.query(`SELECT acknowledged_at FROM privacy_notice_acknowledgements WHERE profile_id = $1 AND notice_version = $2`, [U(MANAGER), PRIVACY_NOTICE_VERSION])
  assert.equal(stored.rowCount, 1)
  assert.equal(new Set(res.map(v => +new Date(v.acknowledged_at))).size, 1)
  const again = await acknowledgePrivacyNotice(client(MANAGER))
  assert.equal(+new Date(again.acknowledgedAt), +stored.rows[0].acknowledged_at)
})

test('Onboarding-Konto (pending) speichert die Kenntnisnahme; Konto löschen entfernt sie mit', async () => {
  assert.equal((await acknowledgePrivacyNotice(client(PENDING))).ok, true)
  await db.sys.query(`UPDATE profiles SET status = 'approved' WHERE id = $1`, [U(PENDING)])
  assert.equal(await loadPrivacyAck(client(PENDING), U(PENDING)), 'ok')
  await db.sys.query(`DELETE FROM profiles WHERE id = $1`, [U(PENDING)])
  assert.equal(await count(`SELECT count(*)::int n FROM privacy_notice_acknowledgements WHERE profile_id = $1`, [U(PENDING)]), 0)
})
