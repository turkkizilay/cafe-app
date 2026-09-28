// Schichttausch (Migration 20): Guards, atomare Freigabe über approve_swap, veraltete Zustände, echte Parallelität.
// Hard Invariant: Ein Tausch ist vollständig durchgeführt ODER gar nicht; Status passt immer zu den Schichten.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, EMP, U, day } from './harness.mjs'

const [ADMIN, MANAGER, A, B, C] = [1, 2, 3, 4, 5]
let db, nextDay = 5
before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [A, 'employee'], [B, 'employee'], [C, 'employee']])
})
after(async () => { await db?.stop() })

const shift = async (n, offset = nextDay++) => (await one(db.sys, `INSERT INTO shifts (employee_id, date, start_time, end_time) VALUES ($1, $2, '08:00', '16:00') RETURNING id`, [EMP(n), day(offset)])).id
const owner = async id => (await one(db.sys, `SELECT employee_id FROM shifts WHERE id = $1`, [id]))?.employee_id
const status = async id => (await one(db.sys, `SELECT status FROM shift_swap_requests WHERE id = $1`, [id])).status
const request = async (n, s, target, ts = null) => (await one(await db.session(n), `INSERT INTO shift_swap_requests (requester_id, requester_shift_id, target_id, target_shift_id) VALUES ($1, $2, $3, $4) RETURNING id`, [EMP(n), s, EMP(target), ts])).id
const setStatus = async (n, id, st) => (await db.session(n)).query(`UPDATE shift_swap_requests SET status = $2 WHERE id = $1`, [id, st])
const approve = async (n, id) => (await db.session(n)).query(`SELECT approve_swap($1)`, [id])
// Ablehnen wie die App seit 6dcdeb9: nur laufende Anfragen
const rejectLikeApp = async (n, id) => (await db.session(n)).query(`UPDATE shift_swap_requests SET status = 'rejected' WHERE id = $1 AND status IN ('open','accepted') RETURNING id`, [id])

test('Anfrage: nur eigene zukünftige Schicht, andere Person, Gegenschicht gehört der Zielperson', async () => {
  const past = await shift(A, -3), own = await shift(A), foreign = await shift(C), other = await shift(A)
  assert.match(await err(() => request(A, past, B)), /eigene, zukünftige/)
  assert.match(await err(() => request(A, foreign, B)), /eigene, zukünftige/)
  assert.match(await err(() => request(A, own, A)), /andere Person/)
  assert.match(await err(() => request(A, own, B, other)), /gehört nicht/)
  const id = await request(A, own, B)
  assert.equal(await status(id), 'open')
})

test('Status: nur Zielperson nimmt an/lehnt ab, nur Anfragender storniert, Abgeschlossenes bleibt, keine Doppelanfrage', async () => {
  const s = await shift(A), t = await shift(B)
  const id = await request(A, s, B, t)
  assert.match(await err(() => request(A, s, C)), /läuft bereits/)
  assert.match(await err(() => setStatus(A, id, 'accepted')), /nicht erlaubt/)
  assert.equal((await setStatus(C, id, 'accepted')).rowCount, 0, 'Unbeteiligte ändern nichts')
  await setStatus(B, id, 'declined')
  assert.match(await err(() => setStatus(B, id, 'accepted')), /abgeschlossen/)
  const again = await request(A, s, C)                       // nach Ablehnung erneut möglich (partieller Unique-Index)
  await setStatus(A, again, 'cancelled')
  assert.ok(await request(A, s, B), 'nach Storno erneut möglich')
})

test('approve_swap: nur Manager/Admin, nur angenommene Anfragen, vollständiger Tausch, „approved“ nur über die RPC', async () => {
  const s = await shift(A), t = await shift(B)
  const id = await request(A, s, B, t)
  assert.match(await err(() => approve(MANAGER, id)), /angenommene/)
  await setStatus(B, id, 'accepted')
  assert.match(await err(() => approve(A, id)), /Nur Admin oder Manager/)
  assert.match(await err(() => setStatus(MANAGER, id, 'approved')), /Freigabe-Funktion/)
  await approve(MANAGER, id)
  assert.equal(await owner(s), EMP(B)); assert.equal(await owner(t), EMP(A))
  const r = await one(db.sys, `SELECT status, approved_by, approved_at FROM shift_swap_requests WHERE id = $1`, [id])
  assert.ok(r.status === 'approved' && r.approved_by === U(MANAGER) && r.approved_at)
  assert.match(await err(() => approve(ADMIN, id)), /angenommene/, 'zweite Freigabe ohne Wirkung')
  assert.equal(await owner(s), EMP(B))
  assert.equal((await rejectLikeApp(ADMIN, id)).rowCount, 0, 'veraltete Ansicht kann Freigegebenes nicht ablehnen')
  assert.equal(await status(id), 'approved')
  assert.ok(await request(B, s, C), 'neuer Besitzer kann weitertauschen')
  const anon = await db.anon()
  assert.match(await err(() => anon.query(`SELECT approve_swap($1)`, [id])), /permission denied/)
})

test('approve_swap prüft erneut: geänderte Schicht, vergebene Gegenschicht, Vergangenheit, Ablehnung → nichts halb umgebucht', async () => {
  const s1 = await shift(A), s2 = await shift(C), t = await shift(B)
  const x1 = await request(A, s1, B, t), x2 = await request(C, s2, B, t)
  await setStatus(B, x1, 'accepted'); await setStatus(B, x2, 'accepted')
  await approve(MANAGER, x1)
  assert.match(await err(() => approve(MANAGER, x2)), /Gegenschicht wurde inzwischen/)
  assert.equal(await owner(s2), EMP(C)); assert.equal(await owner(t), EMP(A)); assert.equal(await status(x2), 'accepted')

  const s3 = await shift(A)
  const y = await request(A, s3, B); await setStatus(B, y, 'accepted')
  await (await db.session(MANAGER)).query(`UPDATE shifts SET employee_id = $2 WHERE id = $1`, [s3, EMP(C)])
  assert.match(await err(() => approve(MANAGER, y)), /angefragte Schicht wurde inzwischen/)
  assert.equal(await owner(s3), EMP(C))

  const s4 = await shift(A)
  const z = await request(A, s4, B); await setStatus(B, z, 'accepted')
  await db.sys.query(`UPDATE shifts SET date = $2 WHERE id = $1`, [s4, day(-2)])
  assert.match(await err(() => approve(ADMIN, z)), /Vergangenheit/)

  const s5 = await shift(A), t5 = await shift(B)
  const w = await request(A, s5, B, t5); await setStatus(B, w, 'accepted'); await setStatus(MANAGER, w, 'rejected')
  assert.match(await err(() => approve(ADMIN, w)), /angenommene/)
  assert.equal(await owner(s5), EMP(A)); assert.equal(await owner(t5), EMP(B))
})

test('Parallel: 10 gleichzeitige Freigaben derselben Anfrage → genau 1 Erfolg, vollständiger Tausch', async () => {
  const s = await shift(A), t = await shift(B)
  const id = await request(A, s, B, t); await setStatus(B, id, 'accepted')
  const conns = await Promise.all(Array.from({ length: 10 }, (_, i) => db.as(i % 2 ? ADMIN : MANAGER)))
  const res = await Promise.all(conns.map(c => err(() => c.query(`SELECT approve_swap($1)`, [id]))))
  assert.equal(res.filter(r => r === null).length, 1)
  assert.equal(await owner(s), EMP(B)); assert.equal(await owner(t), EMP(A)); assert.equal(await status(id), 'approved')
})

test('Parallel: zwei Manager geben Anfragen mit derselben Gegenschicht frei → genau eine, keine halben Tausche', async () => {
  const s1 = await shift(A), s2 = await shift(C), t = await shift(B)
  const x1 = await request(A, s1, B, t), x2 = await request(C, s2, B, t)
  await setStatus(B, x1, 'accepted'); await setStatus(B, x2, 'accepted')
  const [m, a] = [await db.as(MANAGER), await db.as(ADMIN)]
  const [e1, e2] = await Promise.all([err(() => m.query(`SELECT approve_swap($1)`, [x1])), err(() => a.query(`SELECT approve_swap($1)`, [x2]))])
  assert.equal([e1, e2].filter(e => e === null).length, 1)
  const won1 = e1 === null
  assert.equal(await owner(t), won1 ? EMP(A) : EMP(C))
  assert.equal(await owner(won1 ? s1 : s2), EMP(B))
  assert.equal(await owner(won1 ? s2 : s1), won1 ? EMP(C) : EMP(A), 'Verlierer-Schicht unangetastet')
  assert.equal(await status(won1 ? x2 : x1), 'accepted')
})

test('Parallel: Freigabe und Ablehnen gleichzeitig → Status passt immer zu den Schichten', async () => {
  for (let i = 0; i < 5; i++) {
    const s = await shift(A), t = await shift(B)
    const id = await request(A, s, B, t); await setStatus(B, id, 'accepted')
    const [m, a] = [await db.as(MANAGER), await db.as(ADMIN)]
    await Promise.all([err(() => m.query(`SELECT approve_swap($1)`, [id])), err(() => a.query(`UPDATE shift_swap_requests SET status = 'rejected' WHERE id = $1 AND status IN ('open','accepted')`, [id]))])
    const st = await status(id), swapped = (await owner(s)) === EMP(B) && (await owner(t)) === EMP(A), untouched = (await owner(s)) === EMP(A) && (await owner(t)) === EMP(B)
    assert.ok((st === 'approved' && swapped) || (st === 'rejected' && untouched), `Runde ${i}: ${st}`)
  }
})
