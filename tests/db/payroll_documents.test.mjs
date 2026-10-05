// Lohnabrechnungs-Dokumente: Ein manipuliertes Frontend kann keine Abrechnung ohne oder mit ungültiger employee_id
// anlegen (kein Default, NOT NULL, FK) – und nur Admins dürfen überhaupt anlegen. Mitarbeiter sehen nur eigene Dokumente
// (Tabelle + Storage-Ordner = employee_id). Storage-Policies liegen nicht in den Repo-Migrationen; hier ist der live
// gelesene Stand (read-only 2026-10-02) nachgebildet. Nur synthetische Daten, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, EMP } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const LIVE_STORAGE_POLICIES = `
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE POLICY payroll_docs_admin ON storage.objects TO authenticated USING ((bucket_id = 'payroll-docs') AND is_admin()) WITH CHECK ((bucket_id = 'payroll-docs') AND is_admin());
  CREATE POLICY payroll_docs_read ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'payroll-docs') AND (((storage.foldername(name))[1] = ( SELECT (profiles.employee_id)::text AS employee_id FROM profiles WHERE (profiles.id = auth.uid()))) OR is_admin()));
  CREATE POLICY payroll_docs_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'payroll-docs') AND is_admin());`

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
  await db.sys.query(LIVE_STORAGE_POLICIES)
})
after(async () => { await db?.stop() })

const insertDoc = (c, empId, month, cols = 'employee_id, ') =>
  c.query(`INSERT INTO payroll_documents (${cols}year, month, file_name, file_path) VALUES (${cols ? '$1, ' : ''}2026, ${month}, 'a.pdf', 'p.pdf')`, cols ? [empId] : [])

test('Schema wie Production: employee_id ohne Default, NOT NULL, FK auf employees', async () => {
  const c = await one(db.sys, `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='payroll_documents' AND column_name='employee_id'`)
  assert.equal(c.column_default, null); assert.equal(c.is_nullable, 'NO')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM pg_constraint WHERE conname='payroll_documents_employee_id_fkey'`)).n, 1)
})

test('Admin: fehlende / NULL / unbekannte employee_id scheitert – es wird nie „irgendein“ Mitarbeiter verwendet', async () => {
  const c = await db.session(ADMIN)
  assert.match(await err(() => insertDoc(c, null, 1, '')), /null value in column "employee_id"/)
  assert.match(await err(() => insertDoc(c, null, 2)), /null value in column "employee_id"/)
  assert.match(await err(() => insertDoc(c, '10000000-0000-0000-0000-000000000099', 3)), /foreign key/)
  assert.match(await err(() => insertDoc(c, '', 4)), /invalid input syntax for type uuid/)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM payroll_documents`)).n, 0, 'nichts angelegt')
})

test('Admin: gültige Auswahl A bzw. B legt genau für diese Person an; Mitarbeiter sehen nur eigene', async () => {
  const c = await db.session(ADMIN)
  await insertDoc(c, EMP(E1), 9); await insertDoc(c, EMP(E2), 9)
  const e1 = await db.session(E1)
  const mine = (await e1.query(`SELECT employee_id FROM payroll_documents`)).rows
  assert.deepEqual(mine.map(r => r.employee_id), [EMP(E1)])
})

test('Nur Admin darf anlegen: Mitarbeiter (auch für sich selbst) und Manager verweigert', async () => {
  for (const who of [E1, MANAGER]) {
    const c = await db.session(who)
    assert.match(await err(() => insertDoc(c, EMP(E1), 10)), /row-level security/, String(who))
  }
})

test('Storage: Upload nur Admin; Mitarbeiter lesen nur den eigenen Ordner (Ordner = gewählte employee_id)', async () => {
  const put = async (who, name) => err(async () => (await db.session(who)).query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payroll-docs', $1)`, [name]))
  const see = async (who, name) => (await (await db.session(who)).query(`SELECT 1 FROM storage.objects WHERE bucket_id='payroll-docs' AND name=$1`, [name])).rowCount
  const f1 = `${EMP(E1)}/2026-09-lohnabrechnung.pdf`
  assert.match(await put(E1, `${EMP(E1)}/x.pdf`), /row-level security/)
  assert.match(await put(MANAGER, `${EMP(E1)}/x.pdf`), /row-level security/)
  assert.equal(await put(ADMIN, f1), null)
  assert.equal(await see(E1, f1), 1); assert.equal(await see(E2, f1), 0); assert.equal(await see(MANAGER, f1), 0)
})

// ── Pagination (05.10.2026): genau die Abfragen, die PostgREST für die Liste erzeugt (count + ORDER + LIMIT/OFFSET),
// ausgeführt in der Rolle des jeweiligen Benutzers. RLS bleibt die einzige Grenze: Filter/Seiten können nichts Fremdes
// sichtbar machen, die Gesamtzahl zählt nur Erlaubtes.
const COLS = 'id, employee_id, year, month, file_name, file_path, file_size, notes, created_at'
const ORDER = 'ORDER BY year DESC, month DESC, created_at DESC, id ASC'
async function listPage(c, { emp, year, month } = {}, page = 1) {
  const cond = [], params = []
  if (emp) { params.push(emp); cond.push(`employee_id = $${params.length}`) }
  if (year) { params.push(year); cond.push(`year = $${params.length}`) }
  if (month) { params.push(month); cond.push(`month = $${params.length}`) }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  const total = (await c.query(`SELECT count(*)::int n FROM payroll_documents ${where}`, params)).rows[0].n
  const rows = (await c.query(`SELECT ${COLS} FROM payroll_documents ${where} ${ORDER} LIMIT 25 OFFSET ${(page - 1) * 25}`, params)).rows
  return { total, rows }
}

test('Pagination unter RLS: Mitarbeiter blättert nur durch eigene, Admin durch alle; Seiten lückenlos und ohne Doppelte', async () => {
  await db.sys.query(`INSERT INTO payroll_documents (employee_id, year, month, file_name, file_path, created_at)
    SELECT $1::uuid, y, m, 'p.pdf', $1::text || '/' || y || '-' || m || '.pdf', make_timestamptz(y, m, 28, 8, 0, 0) FROM generate_series(2019, 2023) y, generate_series(1, 12) m`, [EMP(E1)])
  await db.sys.query(`INSERT INTO payroll_documents (employee_id, year, month, file_name, file_path) SELECT $1, 2019, m, 'p.pdf', 'x' FROM generate_series(1, 7) m`, [EMP(E2)])
  const all = (await db.sys.query(`SELECT id, employee_id FROM payroll_documents ${ORDER}`)).rows
  const own1 = all.filter(r => r.employee_id === EMP(E1)), own2 = all.filter(r => r.employee_id === EMP(E2))
  assert.ok(own1.length > 50 && own2.length > 0)

  const e1 = await db.session(E1), seen = []
  for (let p = 1; p <= Math.ceil(own1.length / 25); p++) {
    const r = await listPage(e1, {}, p)
    assert.equal(r.total, own1.length, 'Gesamtzahl = nur eigene')
    assert.ok(r.rows.every(x => x.employee_id === EMP(E1)))
    seen.push(...r.rows.map(x => x.id))
  }
  assert.deepEqual(seen, own1.map(r => r.id), 'eigene Liste vollständig, neueste zuerst, keine Doppelten')
  const beyond = await listPage(e1, {}, Math.ceil(own1.length / 25) + 1)
  assert.deepEqual(beyond.rows, [])

  const adm = await db.session(ADMIN), first = await listPage(adm, {}, 1)
  assert.equal(first.total, all.length); assert.deepEqual(first.rows.map(r => r.id), all.slice(0, 25).map(r => r.id))
  const f2 = await listPage(adm, { emp: EMP(E2) }, 1)
  assert.equal(f2.total, own2.length); assert.ok(f2.rows.every(x => x.employee_id === EMP(E2)))
  const ym = await listPage(adm, { year: 2019, month: 3 }, 1)
  assert.deepEqual(ym.rows.map(r => r.employee_id).sort(), [EMP(E1), EMP(E2)].sort())
})

test('RLS: fremde employee_id / Jahr / Monat als Filter liefert Mitarbeitern 0 Zeilen und 0 als Anzahl; Manager sieht nichts', async () => {
  const e1 = await db.session(E1), e2 = await db.session(E2)
  for (const f of [{ emp: EMP(E2) }, { emp: EMP(E2), year: 2019 }, { emp: EMP(E2), year: 2019, month: 3 }]) {
    const r = await listPage(e1, f, 1)
    assert.deepEqual([r.total, r.rows.length], [0, 0], JSON.stringify(f))
  }
  const r2 = await listPage(e2, { year: 2019, month: 3 }, 1)
  assert.equal(r2.total, 1); assert.equal(r2.rows[0].employee_id, EMP(E2))
  const m = await listPage(await db.session(MANAGER), {}, 1)
  assert.deepEqual([m.total, m.rows.length], [0, 0])
  // Mitarbeiter kann eigene Abrechnung nicht löschen (nur Admin)
  const id = (await e1.query(`SELECT id FROM payroll_documents LIMIT 1`)).rows[0].id
  assert.equal((await e1.query(`DELETE FROM payroll_documents WHERE id = $1`, [id])).rowCount, 0)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM payroll_documents WHERE id = $1`, [id])).n, 1)
})
