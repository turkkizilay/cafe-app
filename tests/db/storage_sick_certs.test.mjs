// Atteste im Bucket „sick-certs“ (Migration 22): Mitarbeiter/Manager dürfen nicht löschen, Admin schon;
// Upload, Lesen und Ersetzen bleiben für berechtigte Rollen möglich. Keine fremden Atteste für Mitarbeiter.
// Die Storage-Policies liegen nicht in den Repo-Migrationen (im Dashboard angelegt). Hier ist der live gelesene
// Stand vor Migration 22 (2026-09-28) nachgebildet; darauf wird die echte Migrationsdatei 22 angewendet.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, migration, EMP } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
let db
const own = `(storage.foldername(name))[1] = ( SELECT (profiles.employee_id)::text AS employee_id FROM profiles WHERE (profiles.id = auth.uid()))`
const mgrAdm = `EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = auth.uid()) AND ((profiles.role)::text = ANY ((ARRAY['admin'::character varying, 'manager'::character varying])::text[])) AND ((profiles.status)::text = 'approved'::text)))`
const LIVE_POLICIES_BEFORE_22 = `
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE POLICY sick_certs_admin ON storage.objects TO authenticated USING ((bucket_id = 'sick-certs') AND is_manager_or_admin()) WITH CHECK ((bucket_id = 'sick-certs') AND is_manager_or_admin());
  CREATE POLICY sick_cert_admin_delete ON storage.objects FOR DELETE TO authenticated USING ((bucket_id = 'sick-certs') AND is_admin());
  CREATE POLICY sick_cert_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'sick-certs') AND (split_part(name, '/', 1) = (my_employee_id())::text));
  CREATE POLICY sick_certs_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'sick-certs') AND ((${own}) OR (${mgrAdm})));
  CREATE POLICY sick_certs_upload_own ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'sick-certs') AND (${own}));
  CREATE POLICY sick_cert_admin_read ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'sick-certs') AND is_admin());
  CREATE POLICY sick_cert_read_own ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'sick-certs') AND (split_part(name, '/', 1) = (my_employee_id())::text));
  CREATE POLICY sick_certs_download ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'sick-certs') AND ((${own}) OR (${mgrAdm})));
  CREATE POLICY sick_certs_read ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'sick-certs') AND ((${own}) OR is_manager_or_admin()));
  CREATE POLICY sick_certs_update ON storage.objects FOR UPDATE TO authenticated USING ((bucket_id = 'sick-certs') AND is_manager_or_admin());`

before(async () => {
  db = await startDb()
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
  await db.sys.query(LIVE_POLICIES_BEFORE_22)
  await db.sys.query(migration('22_sick_certs_no_manager_delete.sql'))
})
after(async () => { await db?.stop() })

let seq = 0
const file = n => `${EMP(n)}/cert-${++seq}.pdf`
const put = async (who, name) => err(() => db.session(who).then(c => c.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('sick-certs', $1)`, [name])))
const sysPut = name => db.sys.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('sick-certs', $1)`, [name])
const del = async (who, name) => (await (await db.session(who)).query(`DELETE FROM storage.objects WHERE bucket_id='sick-certs' AND name=$1`, [name])).rowCount
const see = async (who, name) => (await (await db.session(who)).query(`SELECT 1 FROM storage.objects WHERE bucket_id='sick-certs' AND name=$1`, [name])).rowCount
const replace = async (who, name) => (await (await db.session(who)).query(`UPDATE storage.objects SET created_at = now() WHERE bucket_id='sick-certs' AND name=$1`, [name])).rowCount

test('Löschen: Mitarbeiter (eigenes/fremdes) und Manager verweigert, Admin erlaubt; Datei bleibt bis dahin erhalten', async () => {
  const f = file(E1); await sysPut(f)
  assert.equal(await del(E1, f), 0); assert.equal(await del(E2, f), 0); assert.equal(await del(MANAGER, f), 0)
  assert.equal((await db.sys.query(`SELECT 1 FROM storage.objects WHERE name=$1`, [f])).rowCount, 1)
  assert.equal(await del(ADMIN, f), 1)
})

test('Upload/Lesen/Ersetzen: eigene Atteste ja, fremde nein; Manager/Admin operativ wie bisher', async () => {
  const f = file(E1)
  assert.equal(await put(E1, f), null, 'eigener Upload')
  assert.match(await put(E1, file(E2)), /row-level security/, 'kein Upload in fremden Ordner')
  assert.equal(await see(E1, f), 1); assert.equal(await see(E2, f), 0, 'fremdes Attest unsichtbar')
  assert.equal(await see(MANAGER, f), 1); assert.equal(await see(ADMIN, f), 1)
  assert.equal(await put(MANAGER, file(E2)), null, 'Manager reicht Attest nach')
  assert.equal(await replace(MANAGER, f), 1, 'Ersetzen (upsert) für Manager wie bisher')
  assert.equal(await replace(E1, f), 0, 'Mitarbeiter überschreibt nicht')
})

test('Policy-Stand: einzige Lösch-Policy für Atteste ist Admin-only', async () => {
  const r = await db.sys.query(`SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND cmd IN ('DELETE','ALL') AND coalesce(qual,'') LIKE '%sick-certs%'`)
  assert.deepEqual(r.rows.map(x => x.policyname), ['sick_cert_admin_delete'])
})
