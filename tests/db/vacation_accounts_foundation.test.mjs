// Vacation System 2.0 – Phase 1 (Migration 40): rein additives, auditierbares Fundament. Belegt gegen echtes Postgres:
// bestehende Daten/Schemaobjekte bit-gleich, Migration wiederholbar, Browser-Rollen schreiben nie und lesen nur als Admin,
// „nur anhängen“ selbst für den Datenbank-Owner, Fachregeln der Buchungen, Löschfristen/Mitarbeiter-Löschung ohne
// stillen Datenverlust, bestehender Urlaubsablauf unverändert. Nur synthetische Personen.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startDb, addPeople, migration, MIGRATIONS, err, one, rows, EMP, U } from './harness.mjs'

const [ADMIN, MANAGER, E1, E2] = [1, 2, 3, 4]
const SYS = '00000000-0000-0000-0000-000000000000'
const M40 = '40_vacation_accounts_foundation.sql'
const NEW_TABLES = ['vacation_accounts', 'vacation_entitlement_terms', 'vacation_ledger', 'vacation_request_allocations']
let db

// Fingerabdruck aller bestehenden public-Tabellen (Inhalt) + Schemaobjekte außerhalb der neuen Tabellen
async function fingerprint(c) {
  const tables = (await rows(c, `SELECT table_name t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND NOT (table_name = ANY($1)) ORDER BY 1`, [NEW_TABLES])).map(r => r.t)
  const data = {}
  for (const t of tables) data[t] = (await one(c, `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h, count(*)::int n FROM public."${t}" x`)).h
  const cols = (await one(c, `SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,''), ',' ORDER BY 1)) h FROM information_schema.columns WHERE table_schema='public' AND NOT (table_name = ANY($1))`, [NEW_TABLES])).h
  const pols = (await one(c, `SELECT md5(string_agg(tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,''), ',' ORDER BY 1)) h FROM pg_policies WHERE schemaname='public' AND NOT (tablename = ANY($1))`, [NEW_TABLES])).h
  const trg = (await one(c, `SELECT md5(string_agg(c.relname||'.'||t.tgname||':'||p.proname, ',' ORDER BY 1)) h FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND NOT (c.relname = ANY($1))`, [NEW_TABLES])).h
  const fns = (await one(c, `SELECT md5(string_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||md5(pg_get_functiondef(p.oid)), ',' ORDER BY 1)) h FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT LIKE '\\_vacation\\_%'`)).h
  const grants = (await one(c, `SELECT md5(string_agg(table_name||':'||grantee||':'||privilege_type, ',' ORDER BY 1)) h FROM information_schema.role_table_grants WHERE table_schema='public' AND NOT (table_name = ANY($1))`, [NEW_TABLES])).h
  return { data, cols, pols, trg, fns, grants }
}

before(async () => {
  // Erst OHNE Migration 40 starten und mit Bestandsdaten füllen – dann 40 (zweimal) einspielen und vergleichen
  db = await startDb({ migrations: MIGRATIONS.filter(m => m !== M40) })
  await addPeople(db.sys, [[ADMIN, 'admin'], [MANAGER, 'manager'], [E1, 'employee'], [E2, 'employee']])
  const e1 = await db.as(E1)
  await e1.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date) VALUES ($1, '2026-12-28', '2027-01-05')`, [EMP(E1)])
  await e1.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date) VALUES ($1, '2026-03-02', '2026-03-13')`, [EMP(E1)])
  await (await db.as(MANAGER)).query(`UPDATE vacation_requests SET status = 'approved', approved_by = $1, approved_at = now() WHERE start_date = '2026-03-02'`, [EMP(MANAGER)])
  await db.sys.query(`INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, '2026-03-05', '2026-03-06')`, [EMP(E1)])
  await e1.end()
})
after(async () => { await db?.stop() })

test('Migration 40 ist rein additiv: Bestandsdaten, Spalten, Policies, Trigger, Funktionen, Rechte bit-gleich; wiederholbar', async () => {
  const beforeFp = await fingerprint(db.sys)
  assert.ok(Object.keys(beforeFp.data).length > 20)
  await db.sys.query(migration(M40))
  const once = await fingerprint(db.sys)
  await db.sys.query(migration(M40))   // erneut ausführbar, ohne Fehler und ohne Doppelungen
  const twice = await fingerprint(db.sys)
  assert.deepEqual(once, beforeFp, 'nichts Bestehendes verändert')
  assert.deepEqual(twice, beforeFp)
  for (const t of NEW_TABLES) assert.equal((await one(db.sys, `SELECT count(*)::int n FROM public.${t}`)).n, 0, `${t}: Phase 1 legt keine Daten an`)
  const pol = await rows(db.sys, `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1) ORDER BY 1`, [NEW_TABLES])
  assert.deepEqual(pol.map(p => [p.tablename, p.cmd]), NEW_TABLES.map(t => [t, 'SELECT']).sort(), 'je Tabelle genau eine Lese-Policy, keine Schreib-Policy')
  const trg = await one(db.sys, `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname = ANY($1) AND NOT t.tgisinternal`, [NEW_TABLES])
  assert.equal(trg.n, 11)
  const uq = await rows(db.sys, `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE $2 ORDER BY 1`, ['vacation_ledger', 'CREATE UNIQUE INDEX%WHERE%'])
  assert.deepEqual(uq.map(r => r.indexname), ['vacation_ledger_one_carry_in', 'vacation_ledger_one_carry_out', 'vacation_ledger_one_entitlement'])
})

// Hilfen für Buchungen als Owner (später ausschließlich über Server-Funktionen)
const openAccount = (emp, year) => db.sys.query(`INSERT INTO vacation_accounts (employee_id, year, opened_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [EMP(emp), year, SYS])
const book = (emp, year, kind, days, extra = {}) => db.sys.query(
  `INSERT INTO vacation_ledger (employee_id, account_year, kind, days, related_year, reverses_id, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
  [EMP(emp), year, kind, days, extra.related ?? null, extra.reverses ?? null, extra.reason ?? 'Testbuchung', SYS]).then(r => r.rows[0].id)
const allocate = (emp, year, request, days, supersedes = null) => db.sys.query(
  `INSERT INTO vacation_request_allocations (request_id, employee_id, account_year, days, computed_with, supersedes_id, created_by) VALUES ($1,$2,$3,$4,'{"weekdays":"Mo-Fr"}',$5,$6) RETURNING id`,
  [request, EMP(emp), year, days, supersedes, SYS]).then(r => r.rows[0].id)

test('Least Privilege: anon/authenticated/service_role schreiben nie; lesen nur Admin; Mitarbeiter/Manager sehen nichts', async () => {
  await openAccount(E1, 2026); await book(E1, 2026, 'entitlement', 30)
  await db.sys.query(`INSERT INTO vacation_entitlement_terms (employee_id, valid_from, days_per_year, reason, created_by) VALUES ($1, '2026-01-01', 30, 'Test', $2)`, [EMP(E1), SYS])
  for (const who of [E1, MANAGER, ADMIN]) {
    const c = await db.as(who)
    for (const t of NEW_TABLES) {
      assert.match(await err(() => c.query(`INSERT INTO public.${t} DEFAULT VALUES`)), /permission denied/, `${who} INSERT ${t}`)
      assert.match(await err(() => c.query(`UPDATE public.${t} SET id = id`)), /permission denied/, `${who} UPDATE ${t}`)
      assert.match(await err(() => c.query(`DELETE FROM public.${t}`)), /permission denied/, `${who} DELETE ${t}`)
    }
    const seen = (await one(c, `SELECT (SELECT count(*) FROM vacation_accounts)::int a, (SELECT count(*) FROM vacation_ledger)::int l, (SELECT count(*) FROM vacation_entitlement_terms)::int t`))
    if (who === ADMIN) assert.ok(seen.a >= 1 && seen.l >= 1 && seen.t >= 1, 'Admin liest')
    else assert.deepEqual(seen, { a: 0, l: 0, t: 0 }, `Rolle ${who}: keine Sicht (auch nicht auf eigene Zeilen – Entscheidung B10 offen)`)
    await c.end()
  }
  const a = await db.anon()
  assert.match(await err(() => a.query(`SELECT 1 FROM vacation_ledger`)), /permission denied/)
  await db.sys.query(`SET ROLE service_role`)
  try {
    assert.match(await err(() => db.sys.query(`SELECT 1 FROM vacation_ledger`)), /permission denied/)
    assert.match(await err(() => db.sys.query(`INSERT INTO vacation_accounts (employee_id, year, opened_by) VALUES ($1, 2030, $2)`, [EMP(E2), SYS])), /permission denied/)
  } finally { await db.sys.query(`RESET ROLE`) }
})

test('Nur anhängen – auch für den Datenbank-Owner: UPDATE/DELETE/TRUNCATE auf Buchungen, Zuordnungen, Anspruchsständen gesperrt', async () => {
  await openAccount(E2, 2026)
  const id = await book(E2, 2026, 'entitlement', 28)
  await allocate(E2, 2026, '20000000-0000-0000-0000-000000000001', 3)
  await db.sys.query(`INSERT INTO vacation_entitlement_terms (employee_id, valid_from, days_per_year, reason, created_by) VALUES ($1, '2026-01-01', 28, 'Test', $2)`, [EMP(E2), SYS])
  for (const t of ['vacation_ledger', 'vacation_request_allocations', 'vacation_entitlement_terms']) {
    assert.match(await err(() => db.sys.query(`UPDATE public.${t} SET created_at = now()`)), /nie geändert oder gelöscht/, `UPDATE ${t}`)
    assert.match(await err(() => db.sys.query(`DELETE FROM public.${t}`)), /nie geändert oder gelöscht/, `DELETE ${t}`)
    assert.match(await err(() => db.sys.query(`TRUNCATE public.${t} CASCADE`)), /nie geändert oder gelöscht|nie gelöscht/, `TRUNCATE ${t}`)
  }
  assert.match(await err(() => db.sys.query(`DELETE FROM vacation_accounts`)), /nie gelöscht/)
  assert.match(await err(() => db.sys.query(`TRUNCATE vacation_accounts CASCADE`)), /nie geändert oder gelöscht/)
  assert.equal((await one(db.sys, `SELECT days::float d FROM vacation_ledger WHERE id = $1`, [id])).d, 28, 'Buchung unverändert')
})

test('Konto: nur einmaliger Abschluss offen → abgeschlossen (mit Snapshot); danach unveränderlich, keine neuen Buchungen', async () => {
  await openAccount(E2, 2025)
  assert.match(await err(() => db.sys.query(`UPDATE vacation_accounts SET status = 'closed' WHERE employee_id = $1 AND year = 2025`, [EMP(E2)])), /close_consistent/, 'Abschluss ohne Snapshot/Akteur')
  assert.match(await err(() => db.sys.query(`UPDATE vacation_accounts SET year = 2024 WHERE employee_id = $1 AND year = 2025`, [EMP(E2)])), /nur der Abschluss/)
  await db.sys.query(`UPDATE vacation_accounts SET status = 'closed', closed_at = now(), closed_by = $2, snapshot = '{"available":0}' WHERE employee_id = $1 AND year = 2025`, [EMP(E2), SYS])
  assert.match(await err(() => db.sys.query(`UPDATE vacation_accounts SET status = 'open', closed_at = NULL, closed_by = NULL, snapshot = NULL WHERE employee_id = $1 AND year = 2025`, [EMP(E2)])), /abgeschlossen und bleibt unverändert/)
  assert.match(await err(() => book(E2, 2025, 'manual_adjustment', 1)), /abgeschlossen/)
  assert.match(await err(() => allocate(E2, 2025, '20000000-0000-0000-0000-000000000002', 1)), /abgeschlossen/)
})

test('Buchungsregeln: Pflicht-Grund, Vorzeichen, Herkunftsjahr bei Übertrag, Gegenbuchung exakt und einmalig', async () => {
  await openAccount(E1, 2027)
  assert.match(await err(() => book(E1, 2027, 'entitlement', 30, { reason: '  ' })), /check constraint/, 'Grund Pflicht')
  assert.match(await err(() => book(E1, 2027, 'entitlement', 30, { reason: 'x'.repeat(501) })), /check constraint/, 'Grund ≤ 500')
  assert.match(await err(() => book(E1, 2027, 'entitlement', -1)), /kind_rules/)
  assert.match(await err(() => book(E1, 2027, 'carry_in', 8)), /kind_rules/, 'Übertrag ohne Herkunftsjahr')
  assert.match(await err(() => book(E1, 2027, 'carry_in', 8, { related: 2027 })), /kind_rules/, 'Herkunft muss früher liegen')
  assert.match(await err(() => book(E1, 2027, 'carry_out', 8, { related: 2028 })), /kind_rules/, 'Übertrag hinaus ist negativ')
  assert.match(await err(() => book(E1, 2027, 'expiry', -3)), /check constraint/, 'kein Verfall in Phase 1')
  assert.match(await err(() => book(E1, 2027, 'entitlement', 0.001)), /check constraint|kind_rules/, '0 Tage nach Rundung auf 2 Stellen nicht erlaubt')
  assert.match(await err(() => book(E2, 2031, 'entitlement', 30)), /foreign key/, 'nur auf existierendes Konto')
  const c = await book(E1, 2027, 'carry_in', 8, { related: 2026, reason: 'Rest aus 2026' })
  assert.match(await err(() => book(E1, 2027, 'reversal', 5, { reverses: c })), /genau -8\.00 Tage/)
  assert.match(await err(() => book(E1, 2026, 'reversal', -8, { reverses: c })), /desselben Urlaubskontos/)
  const r = await book(E1, 2027, 'reversal', -8, { reverses: c, reason: 'Fehlbuchung' })
  assert.match(await err(() => book(E1, 2027, 'reversal', -8, { reverses: c })), /duplicate key/, 'höchstens eine Gegenbuchung')
  assert.match(await err(() => book(E1, 2027, 'reversal', 8, { reverses: r })), /nicht erneut aufgehoben/)
  await book(E1, 2027, 'opening_balance', 3, { related: 2025, reason: 'Eröffnungssaldo aus Unterlagen' })
  assert.equal((await rows(db.sys, `SELECT 1 FROM vacation_ledger WHERE employee_id = $1 AND account_year = 2027`, [EMP(E1)])).length, 3)
})

test('Zuordnungen: je Antrag/Jahr genau eine aktuelle; Neuberechnung nur als ausdrückliche Ablösung; alte bleibt erhalten', async () => {
  await openAccount(E1, 2026)
  const req = '20000000-0000-0000-0000-000000000003'
  const a1 = await allocate(E1, 2026, req, 4)
  assert.match(await err(() => allocate(E1, 2026, req, 5)), /nur ausdrückliche Ablösung/)
  const a2 = await allocate(E1, 2026, req, 5, a1)
  assert.match(await err(() => allocate(E1, 2026, req, 6, a1)), /nur ausdrückliche Ablösung|duplicate key/, 'abgelöste Zeile kann nicht erneut abgelöst werden')
  await allocate(E1, 2026, req, 6, a2)
  assert.equal((await rows(db.sys, `SELECT 1 FROM vacation_request_allocations WHERE request_id = $1`, [req])).length, 3, 'Historie vollständig')
  assert.match(await err(() => allocate(E1, 2026, '20000000-0000-0000-0000-000000000004', -1)), /check constraint/)
})

test('Kein stiller Datenverlust: Mitarbeiter mit Konto nicht löschbar (laut); ohne Konto weiter löschbar; Löschfrist für Anträge unberührt', async () => {
  assert.match(await err(() => db.sys.query(`DELETE FROM employees WHERE id = $1`, [EMP(E1)])), /foreign key|violates/, 'Person mit Urlaubskonto bleibt')
  // Person ohne Urlaubskonto: bestehender Ablauf unverändert
  await addPeople(db.sys, [[9, 'employee']])
  assert.equal(await err(() => db.sys.query(`DELETE FROM employees WHERE id = $1`, [EMP(9)])), null)
  // Alte Anträge löschen (wie Löschfristen) – Zuordnungen hängen nicht daran und bleiben
  const req = (await one(db.sys, `SELECT id FROM vacation_requests WHERE employee_id = $1 AND start_date = '2026-03-02'`, [EMP(E1)])).id
  await allocate(E1, 2026, req, 8)
  assert.equal(await err(() => db.sys.query(`DELETE FROM vacation_requests WHERE id = $1`, [req])), null)
  assert.equal((await rows(db.sys, `SELECT 1 FROM vacation_request_allocations WHERE request_id = $1`, [req])).length, 1)
})

test('REGRESSION Urlaubsablauf unverändert: Antrag (Server zählt days_count, Status beantragt), Genehmigung, Zurückziehen, Lesen', async () => {
  const e2 = await db.as(E2)
  const ins = await one(e2, `INSERT INTO vacation_requests (employee_id, start_date, end_date, status) VALUES ($1, '2026-07-06', '2026-07-10', 'approved') RETURNING id, status, days_count`, [EMP(E2)])
  assert.deepEqual([ins.status, ins.days_count], ['pending', 5], 'Mitarbeiter kann nicht selbst genehmigen; Tage vom Server gezählt')
  assert.equal((await rows(e2, `SELECT 1 FROM vacation_requests WHERE employee_id <> $1`, [EMP(E2)])).length, 0, 'nur eigene Anträge sichtbar')
  const m = await db.as(MANAGER)
  assert.equal((await m.query(`UPDATE vacation_requests SET status = 'approved' WHERE id = $1`, [ins.id])).rowCount, 1)
  const ins2 = await one(e2, `INSERT INTO vacation_requests (employee_id, start_date, end_date) VALUES ($1, '2026-09-07', '2026-09-08') RETURNING id`, [EMP(E2)])
  assert.equal((await e2.query(`DELETE FROM vacation_requests WHERE id = $1`, [ins2.id])).rowCount, 1, 'eigenen offenen Antrag zurückziehen')
  assert.equal((await e2.query(`DELETE FROM vacation_requests WHERE id = $1`, [ins.id])).rowCount, 0, 'genehmigten nicht')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM vacation_ledger WHERE employee_id = $1 AND account_year = 2026`, [EMP(E2)])).n, 1, 'kein Trigger bucht automatisch ins neue Konto')
  await e2.end(); await m.end()
})

// ── Final Review: Doppelbuchungen und Gleichzeitigkeit ───────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))
const BOOK_SQL = `INSERT INTO vacation_ledger (employee_id, account_year, kind, days, related_year, reason, created_by) VALUES ($1,$2,$3,$4,$5,'Test',$6)`

test('Keine Doppelbuchung: je Konto ein Jahresanspruch, je Herkunfts-/Zieljahr ein Übertrag; Korrektur über Anpassung; Gegenbuchung ohne Jahr', async () => {
  await openAccount(E2, 2028)
  await book(E2, 2028, 'entitlement', 30)
  assert.match(await err(() => book(E2, 2028, 'entitlement', 30)), /vacation_ledger_one_entitlement/)
  assert.equal(await err(() => book(E2, 2028, 'entitlement_adjustment', -2, { reason: 'Vertrag geändert' })), null, 'Korrektur weiterhin möglich')
  await book(E2, 2028, 'carry_in', 4, { related: 2027 })
  assert.match(await err(() => book(E2, 2028, 'carry_in', 4, { related: 2027 })), /vacation_ledger_one_carry_in/, 'zweiter Abschluss bucht nicht erneut')
  assert.equal(await err(() => book(E2, 2028, 'carry_in', 1, { related: 2026 })), null, 'anderes Herkunftsjahr erlaubt')
  await book(E2, 2028, 'carry_out', -3, { related: 2029 })
  assert.match(await err(() => book(E2, 2028, 'carry_out', -3, { related: 2029 })), /vacation_ledger_one_carry_out/)
  const id = (await one(db.sys, `SELECT id FROM vacation_ledger WHERE employee_id = $1 AND account_year = 2028 AND kind = 'carry_in' AND related_year = 2026`, [EMP(E2)])).id
  assert.match(await err(() => book(E2, 2028, 'reversal', -1, { reverses: id, related: 2026 })), /kind_rules/)
})

test('Gleichzeitig: zwei parallele Jahresanspruch-Buchungen → genau eine gelingt', async () => {
  await openAccount(E2, 2029)
  const [c1, c2] = [await db.connect(), await db.connect()]
  try {
    const r = await Promise.allSettled([c1.query(BOOK_SQL, [EMP(E2), 2029, 'entitlement', 30, null, SYS]), c2.query(BOOK_SQL, [EMP(E2), 2029, 'entitlement', 30, null, SYS])])
    assert.deepEqual(r.map(x => x.status).sort(), ['fulfilled', 'rejected'])
    assert.equal((await one(db.sys, `SELECT count(*)::int n FROM vacation_ledger WHERE employee_id = $1 AND account_year = 2029 AND kind = 'entitlement'`, [EMP(E2)])).n, 1)
  } finally { await c1.end(); await c2.end() }
})

test('Gleichzeitig: Abschluss läuft → parallele Buchung wartet und wird danach abgelehnt (rutscht nie ins abgeschlossene Jahr)', async () => {
  await openAccount(E2, 2030)
  const [c1, c2] = [await db.connect(), await db.connect()]
  try {
    await c1.query('BEGIN')
    await c1.query(`UPDATE vacation_accounts SET status = 'closed', closed_at = now(), closed_by = $2, snapshot = '{}' WHERE employee_id = $1 AND year = 2030`, [EMP(E2), SYS])
    let done = false
    const p = c2.query(BOOK_SQL, [EMP(E2), 2030, 'manual_adjustment', 1, null, SYS]).then(() => null, e => e.message).finally(() => { done = true })
    await sleep(400)
    assert.equal(done, false, 'Buchung wartet auf den Abschluss')
    await c1.query('COMMIT')
    assert.match(await p, /abgeschlossen/)
    assert.equal((await one(db.sys, `SELECT count(*)::int n FROM vacation_ledger WHERE employee_id = $1 AND account_year = 2030`, [EMP(E2)])).n, 0)
  } finally { await c1.end(); await c2.end() }
})

test('Gleichzeitig: Buchung läuft → Abschluss wartet, bis sie fertig ist (Buchung liegt vollständig im Jahr vor dem Abschluss)', async () => {
  await openAccount(E2, 2031)
  const [c1, c2] = [await db.connect(), await db.connect()]
  try {
    await c1.query('BEGIN')
    await c1.query(BOOK_SQL, [EMP(E2), 2031, 'manual_adjustment', 2, null, SYS])
    let done = false
    const p = c2.query(`UPDATE vacation_accounts SET status = 'closed', closed_at = now(), closed_by = $2, snapshot = '{}' WHERE employee_id = $1 AND year = 2031`, [EMP(E2), SYS]).then(() => null, e => e.message).finally(() => { done = true })
    await sleep(400)
    assert.equal(done, false, 'Abschluss wartet auf die laufende Buchung')
    await c1.query('COMMIT')
    assert.equal(await p, null)
    const s = await one(db.sys, `SELECT a.status, (SELECT count(*)::int FROM vacation_ledger l WHERE l.employee_id = a.employee_id AND l.account_year = a.year) n FROM vacation_accounts a WHERE employee_id = $1 AND year = 2031`, [EMP(E2)])
    assert.deepEqual(s, { status: 'closed', n: 1 })
  } finally { await c1.end(); await c2.end() }
})
