// Migration 39: 12-Monats-Frist des Aktivitätsprotokolls (Datenschutzhinweise) serverseitig per pg_cron statt per
// Browser-Aufruf (der nur 403 lieferte). Funktion unverändert, Rechte nur Server; Job genau einmal, wiederholt
// ausführbar; löscht nur Einträge älter als 12 Monate; Migration selbst ändert keine Daten.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, err, one, rows, migration } from './harness.mjs'

let db
const JOB = 'cafe-activity-log-retention'
const job = () => rows(db.sys, `SELECT jobname, schedule, command, username, active FROM cron.job WHERE jobname = $1`, [JOB])
const add = (ago, action = 'auth.login') => db.sys.query(`INSERT INTO activity_log (created_at, action, category, summary) VALUES (now() - $1::interval, $2, 'auth', 'Test')`, [ago, action])
const count = async () => (await one(db.sys, `SELECT count(*)::int c FROM activity_log`)).c

before(async () => { db = await startDb(); await addPeople(db.sys, [[1, 'admin'], [2, 'employee']]) })
after(async () => { await db?.stop() })
beforeEach(() => db.sys.query(`DELETE FROM activity_log`))

test('Job täglich, genau einmal, als postgres; Befehl ruft nur die unveränderte Funktion; wiederholt ausführbar', async () => {
  assert.deepEqual(await job(), [{ jobname: JOB, schedule: '30 3 * * *', command: 'SELECT public.cleanup_old_activity_logs()', username: 'postgres', active: true }])
  await db.sys.query(migration('39_activity_log_retention_job.sql'))
  await db.sys.query(migration('39_activity_log_retention_job.sql'))
  assert.equal((await job()).length, 1, 'kein doppelter Job')
  const other = await rows(db.sys, `SELECT jobname FROM cron.job WHERE jobname <> $1`, [JOB])
  assert.deepEqual(other, [], 'keine anderen Jobs angelegt/verändert')
})

test('Lauf des Jobs löscht nur Einträge älter als 12 Monate, gibt die Anzahl zurück', async () => {
  await add('13 months'); await add('12 months 1 day', 'retention.purged'); await add('11 months 29 days'); await add('1 day'); await add('0 seconds')
  const cmd = (await job())[0].command
  const r = await one(db.sys, cmd + ' AS n')
  assert.equal(r.n, 2)
  assert.equal(await count(), 3)
  assert.equal((await one(db.sys, `SELECT count(*)::int c FROM activity_log WHERE created_at < now() - interval '12 months'`)).c, 0)
  assert.equal((await one(db.sys, cmd + ' AS n')).n, 0, 'zweiter Lauf: nichts mehr zu löschen')
})

test('Nur der Server darf löschen: Mitarbeiter, Admin, anonym → verweigert; service_role erlaubt', async () => {
  await add('13 months')
  for (const c of [await db.as(1), await db.as(2), await db.anon()])
    assert.match(await err(() => c.query(`SELECT cleanup_old_activity_logs()`)), /permission denied/)
  assert.equal(await count(), 1, 'nichts gelöscht')
  const s = await db.connect(); await s.query(`SET ROLE service_role`)
  assert.equal((await one(s, `SELECT cleanup_old_activity_logs() n`)).n, 1)
})

test('Migration selbst ändert keine Daten', async () => {
  await add('13 months'); await add('1 day')
  await db.sys.query(migration('39_activity_log_retention_job.sql'))
  assert.equal(await count(), 2)
})
