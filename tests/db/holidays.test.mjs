// Hessische Feiertage berechnet (Migration 31): genau die 10 gesetzlichen Feiertage für jedes Jahr, Allerheiligen
// nicht; App (vacationLogic, Stundenzettel) und Server (vacation_guard_insert) lesen dieselbe View. Vorher/Nachher:
// Geschäftsdaten, Urlaubszählung 2025/2026 und Lohn-/DATEV-Ergebnisse eines festen Datensatzes bleiben identisch.
// Nur synthetische Personen, lokale Test-DB.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startDb, addPeople, migration, MIGRATIONS, one, rows, err, EMP, U } from './harness.mjs'
import { calculateRequestedDays, getVacationBalance, checkSickDuringVacation, vacationDaysMismatch } from '../../src/lib/vacationLogic.js'
import * as comp from '../../src/lib/compensation.js'

const [ADMIN, E1, E2] = [1, 3, 4]
// Fachlich bestätigt (Hessen): 10 gesetzliche Feiertage – erwartete Daten 2026–2030 (unabhängig von der DB-Formel geprüft)
const EXPECTED = {
  2026: ['01-01', '04-03', '04-06', '05-01', '05-14', '05-25', '06-04', '10-03', '12-25', '12-26'],
  2027: ['01-01', '03-26', '03-29', '05-01', '05-06', '05-17', '05-27', '10-03', '12-25', '12-26'],
  2028: ['01-01', '04-14', '04-17', '05-01', '05-25', '06-05', '06-15', '10-03', '12-25', '12-26'],
  2029: ['01-01', '03-30', '04-02', '05-01', '05-10', '05-21', '05-31', '10-03', '12-25', '12-26'],
  2030: ['01-01', '04-19', '04-22', '05-01', '05-30', '06-10', '06-20', '10-03', '12-25', '12-26'],
}
const NAMES = ['Neujahr', 'Karfreitag', 'Ostermontag', 'Tag der Arbeit', 'Christi Himmelfahrt', 'Pfingstmontag', 'Fronleichnam', 'Tag der Deutschen Einheit', '1. Weihnachtstag', '2. Weihnachtstag']
// Production-Stand der bisherigen Handliste (2025/2026, inkl. falschem Allerheiligen) – nur Daten, keine Personen
const LEGACY = [
  ['2025-01-01', 'Neujahr'], ['2025-04-18', 'Karfreitag'], ['2025-04-21', 'Ostermontag'], ['2025-05-01', 'Tag der Arbeit'], ['2025-05-29', 'Christi Himmelfahrt'],
  ['2025-06-09', 'Pfingstmontag'], ['2025-06-19', 'Fronleichnam'], ['2025-10-03', 'Tag der Deutschen Einheit'], ['2025-12-25', '1. Weihnachtstag'], ['2025-12-26', '2. Weihnachtstag'],
  ['2026-01-01', 'Neujahr'], ['2026-04-03', 'Karfreitag'], ['2026-04-06', 'Ostermontag'], ['2026-05-01', 'Tag der Arbeit'], ['2026-05-14', 'Christi Himmelfahrt'],
  ['2026-05-25', 'Pfingstmontag'], ['2026-06-04', 'Fronleichnam'], ['2026-10-03', 'Tag der Deutschen Einheit'], ['2026-11-01', 'Allerheiligen'],
  ['2026-12-25', '1. Weihnachtstag'], ['2026-12-26', '2. Weihnachtstag'],
]

// Unabhängiges Orakel: Gaußsche Osterformel mit Lichtenberg-Ergänzung (andere Methode als die DB-Funktion)
function easterLichtenberg(y) {
  const k = Math.floor(y / 100), m = 15 + Math.floor((3 * k + 3) / 4) - Math.floor((8 * k + 13) / 25)
  const s = 2 - Math.floor((3 * k + 3) / 4), a = y % 19, d = (19 * a + m) % 30
  const r = Math.floor((d + Math.floor(a / 11)) / 29), og = 21 + d - r
  const sz = 7 - ((y + Math.floor(y / 4) + s) % 7), oe = 7 - ((og - sz) % 7), os = og + oe   // Märzdatum (> 31 → April)
  return new Date(Date.UTC(y, 2, os))
}
const iso = d => d.toISOString().slice(0, 10)
const addDays = (d, n) => new Date(d.getTime() + n * 864e5)
function oracle(y) {
  const e = easterLichtenberg(y), f = (m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return [f(1, 1), iso(addDays(e, -2)), iso(addDays(e, 1)), f(5, 1), iso(addDays(e, 39)), iso(addDays(e, 50)), iso(addDays(e, 60)), f(10, 3), f(12, 25), f(12, 26)]
}

let db
const ymd = d => (typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
// wie die App (Vacation.jsx / MyHours.jsx / Account.jsx): Hessen, Jahre ±1
const appHolidays = async (c, years) => (await rows(c, `SELECT date, name FROM public_holidays WHERE bundesland = 'Hessen' AND year = ANY($1::int[])`, [years])).map(h => ({ date: ymd(h.date), name: h.name }))

// Lohn-/DATEV-Ergebnis wie in Payroll.jsx (echte Funktionen aus dem Quelltext) für einen Monat
const PAYROLL_SRC = readFileSync(new URL('../../src/pages/Payroll.jsx', import.meta.url), 'utf8')
const grab = name => { const s = PAYROLL_SRC.indexOf(`function ${name}(`); let i = PAYROLL_SRC.indexOf('{', PAYROLL_SRC.indexOf(')', s)) + 1, d = 1; while (d) { const ch = PAYROLL_SRC[i++]; if (ch === '{') d++; else if (ch === '}') d-- } return PAYROLL_SRC.slice(s, i) }
const toLocal = `function toLocalDateStr(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') }`
const paidAbsence = new Function(`${toLocal}; return (${grab('getPaidAbsenceDays')})`)()
async function payrollAndDatev(c, year, month) {
  const pad = String(month).padStart(2, '0'), start = `${year}-${pad}-01`, end = `${year}-${pad}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  const emps = await rows(c, `SELECT * FROM employees ORDER BY last_name`)
  const te = await rows(c, `SELECT employee_id, hours_worked::float h, date FROM time_entries WHERE date BETWEEN $1 AND $2`, [start, end])
  const vac = (await rows(c, `SELECT employee_id, start_date, end_date FROM vacation_requests WHERE status = 'approved' AND start_date <= $2 AND end_date >= $1`, [start, end])).map(v => ({ ...v, start_date: ymd(v.start_date), end_date: ymd(v.end_date) }))
  const sick = (await rows(c, `SELECT employee_id, start_date, end_date, continued_pay_end, certificate_received, certificate_file_path FROM sick_leave WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)`, [start, end]))
    .map(s => ({ ...s, start_date: ymd(s.start_date), end_date: s.end_date && ymd(s.end_date), continued_pay_end: s.continued_pay_end && ymd(s.continued_pay_end) }))
  const out = emps.map(emp => {
    const mine = te.filter(t => t.employee_id === emp.id)
    const actual = Math.round(mine.reduce((s, t) => s + (t.h || 0), 0) * 100) / 100
    const worked = new Set(mine.filter(t => t.h > 0).map(t => ymd(t.date)))
    const { vacationDays, sickDays } = paidAbsence(vac.filter(v => v.employee_id === emp.id), sick.filter(s => s.employee_id === emp.id), worked, start, end)
    const dailyH = emp.hours_per_week ? Number(emp.hours_per_week) / 5 : 0
    const e = { ...emp, hourly_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate), monthly_salary: emp.monthly_salary == null ? null : Number(emp.monthly_salary) }
    const vacH = Math.round(vacationDays * dailyH * 100) / 100, sickH = Math.round(sickDays * dailyH * 100) / 100
    const gross = comp.monthlyGross(e, Math.round((actual + vacH + sickH) * 100) / 100)
    return [emp.last_name, actual, vacH, sickH, gross, comp.datevRateCell({ ...e }), comp.datevHintCell({ ...e, isAlert: false })]
  })
  return JSON.stringify(out)
}

before(async () => {
  db = await startDb({ migrations: MIGRATIONS.filter(m => !m.startsWith('31')) })   // Stand VOR Migration 31
  await addPeople(db.sys, [[ADMIN, 'admin'], [E1, 'employee', { employment_type: 'teilzeit', hours_per_week: 20 }], [E2, 'employee', { employment_type: 'vollzeit', hours_per_week: 40 }]])
  await db.sys.query(`UPDATE employees SET pay_type = 'fixed', monthly_salary = 3100 WHERE id = $1`, [EMP(E2)])
  for (const [d, n] of LEGACY) await db.sys.query(`INSERT INTO public_holidays (date, name, bundesland, year) VALUES ($1, $2, 'Hessen', $3)`, [d, n, Number(d.slice(0, 4))])
})
after(async () => { await db?.stop() })

test('Vorher/Nachher: Geschäftsdaten, Urlaubszählung 2025/2026 und Lohn-/DATEV-Ergebnis bleiben identisch', async () => {
  // fester Datensatz VOR der Migration: Urlaube (Server zählt days_count), Krankheit über Feiertag, Arbeitszeit
  const e1 = await db.as(E1), e2 = await db.as(E2)
  const RANGES = [['2025-12-22', '2026-01-02'], ['2026-03-30', '2026-04-10'], ['2026-05-11', '2026-05-29'], ['2026-10-26', '2026-11-06'], ['2026-12-21', '2026-12-31'], ['2025-04-14', '2025-04-25']]
  for (const [s, e] of RANGES) {
    await e1.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 1)`, [EMP(E1), s, e])
    await e2.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 1)`, [EMP(E2), s, e])
  }
  await db.sys.query(`UPDATE vacation_requests SET status = 'approved'`)
  await e1.query(`INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, '2026-12-23', '2026-12-29')`, [EMP(E1)])
  await db.sys.query(`UPDATE sick_leave SET certificate_received = true`)
  await e2.query(`INSERT INTO sick_leave (employee_id, start_date, end_date) VALUES ($1, '2026-06-03', '2026-06-05')`, [EMP(E2)])
  for (const [d, h] of [['2026-11-02', 6], ['2026-11-03', 4.5], ['2026-12-01', 8], ['2026-06-08', 7]])
    await db.sys.query(`INSERT INTO time_entries (employee_id, date, clock_in, clock_out, hours_worked) VALUES ($1, $2, $3, $4, $5)`, [EMP(E1), d, `${d}T08:00:00Z`, `${d}T16:00:00Z`, h])

  const SNAP = `SELECT (SELECT md5(string_agg(v::text, '|' ORDER BY id)) FROM vacation_requests v) vac,
                       (SELECT md5(string_agg(s::text, '|' ORDER BY id)) FROM sick_leave s) sick,
                       (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM time_entries t) te,
                       (SELECT md5(string_agg(e::text, '|' ORDER BY id)) FROM employees e) emp,
                       (SELECT md5(string_agg(p::text, '|' ORDER BY id)) FROM payroll_months p) pm`
  const months = [[2025, 12], [2026, 1], [2026, 4], [2026, 6], [2026, 11], [2026, 12]]
  const before = await one(db.sys, SNAP)
  const payBefore = []; for (const [y, m] of months) payBefore.push(await payrollAndDatev(db.sys, y, m))
  const countsBefore = (await rows(db.sys, `SELECT employee_id, start_date, days_count FROM vacation_requests ORDER BY employee_id, start_date`)).map(r => r.days_count)
  const legacyBefore = (await rows(db.sys, `SELECT date, name FROM public_holidays ORDER BY date`)).map(r => `${ymd(r.date)} ${r.name}`)

  await db.sys.query(migration('31_hessen_holidays.sql'))

  assert.deepEqual(await one(db.sys, SNAP), before, 'Urlaub, Krankheit, Zeiten, Mitarbeiter, Abrechnungsmonate unverändert')
  for (const [i, [y, m]] of months.entries()) assert.equal(await payrollAndDatev(db.sys, y, m), payBefore[i], `Lohn/DATEV ${m}/${y} identisch`)
  // gleiche Zeiträume NACH der Migration erneut beantragt → gleiche Tagezahl (2025/2026; Allerheiligen 2026 war Sonntag)
  for (const [s, e] of RANGES) await e1.query(`INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 1)`, [EMP(E1), s, e])
  const fresh = (await rows(db.sys, `SELECT days_count FROM vacation_requests WHERE employee_id = $1 AND status = 'pending' ORDER BY start_date`, [EMP(E1)])).map(r => r.days_count)
  const old = (await rows(db.sys, `SELECT days_count FROM vacation_requests WHERE employee_id = $1 AND status = 'approved' ORDER BY start_date`, [EMP(E1)])).map(r => r.days_count)
  assert.deepEqual(fresh, old, 'Urlaubszählung 2025/2026 vorher = nachher')
  assert.deepEqual((await rows(db.sys, `SELECT days_count FROM vacation_requests WHERE status = 'approved' ORDER BY employee_id, start_date`)).map(r => r.days_count), countsBefore)
  await db.sys.query(`DELETE FROM vacation_requests WHERE status = 'pending'`)
  // einziger Unterschied der Feiertagsdaten 2025/2026: Allerheiligen entfällt
  const now = (await rows(db.sys, `SELECT date, name FROM public_holidays WHERE year IN (2025, 2026) ORDER BY date`)).map(r => `${ymd(r.date)} ${r.name}`)
  assert.deepEqual(legacyBefore.filter(x => !now.includes(x)), ['2026-11-01 Allerheiligen'])
  assert.deepEqual(now.filter(x => !legacyBefore.includes(x)), [])
  // Handliste bleibt unverändert erhalten (Nachweis), wird aber nicht mehr gelesen
  assert.deepEqual((await rows(db.sys, `SELECT date, name FROM public_holidays_manual_2025_2026 ORDER BY date`)).map(r => `${ymd(r.date)} ${r.name}`), legacyBefore)
})

test('Alle hessischen Feiertage 2026–2030 exakt (View und Funktion), je Jahr genau 10, richtige Namen', async () => {
  for (const [y, days] of Object.entries(EXPECTED)) {
    const v = await rows(db.sys, `SELECT date, name, bundesland, year FROM public_holidays WHERE year = $1 ORDER BY date`, [Number(y)])
    assert.deepEqual(v.map(r => ymd(r.date)), days.map(d => `${y}-${d}`), `View ${y}`)
    assert.deepEqual(v.map(r => r.name), NAMES, `Namen ${y}`)
    assert.ok(v.every(r => r.bundesland === 'Hessen' && r.year === Number(y)))
    const f = await rows(db.sys, `SELECT holiday_date FROM cafe_calendar.hessen_holidays($1) ORDER BY 1`, [Number(y)])
    assert.deepEqual(f.map(r => ymd(r.holiday_date)), days.map(d => `${y}-${d}`), `Funktion ${y}`)
  }
})

test('Ostern und bewegliche Feiertage: bekannte Ostersonntage; Abgleich mit unabhängiger Formel 1990–2100', async () => {
  const KNOWN = { 2024: '03-31', 2025: '04-20', 2026: '04-05', 2027: '03-28', 2028: '04-16', 2029: '04-01', 2030: '04-21', 2031: '04-13', 2032: '03-28', 2033: '04-17', 2034: '04-09', 2035: '03-25', 2038: '04-25', 2049: '04-18', 2057: '04-22', 2073: '03-26' }
  for (const [y, d] of Object.entries(KNOWN)) assert.equal(ymd((await one(db.sys, `SELECT cafe_calendar.easter_sunday($1) e`, [Number(y)])).e), `${y}-${d}`, `Ostern ${y}`)
  const all = await rows(db.sys, `SELECT year, array_agg(date::text ORDER BY date) d FROM public_holidays GROUP BY year ORDER BY year`)
  assert.equal(all.length, 111, '1990–2100')
  for (const r of all) assert.deepEqual(r.d, oracle(r.year).sort(), `Jahr ${r.year}`)
  // Relativlage zu Ostern
  for (const y of [2026, 2027, 2028, 2029, 2030]) {
    const e = ymd((await one(db.sys, `SELECT cafe_calendar.easter_sunday($1) e`, [y])).e)
    const get = async n => ymd((await one(db.sys, `SELECT date FROM public_holidays WHERE year = $1 AND name = $2`, [y, n])).date)
    const off = async n => Math.round((new Date(await get(n) + 'T00:00:00Z') - new Date(e + 'T00:00:00Z')) / 864e5)
    assert.deepEqual([await off('Karfreitag'), await off('Ostermontag'), await off('Christi Himmelfahrt'), await off('Pfingstmontag'), await off('Fronleichnam')], [-2, 1, 39, 50, 60], `Abstände ${y}`)
  }
})

test('Keine Feiertage: Allerheiligen, Reformationstag, Hl. Drei Könige, Heiligabend, Silvester, Oster-/Pfingstsonntag, normale Werktage', async () => {
  const no = async d => (await one(db.sys, `SELECT cafe_calendar.is_hessen_holiday($1::date) h`, [d])).h
  for (let y = 2025; y <= 2030; y++) {
    for (const md of ['11-01', '10-31', '01-06', '12-24', '12-31', '11-11', '08-15']) assert.equal(await no(`${y}-${md}`), false, `${y}-${md}`)
    const e = ymd((await one(db.sys, `SELECT cafe_calendar.easter_sunday($1) e`, [y])).e)
    assert.equal(await no(e), false, `Ostersonntag ${y}`)
    assert.equal(await no(ymd(new Date(new Date(e + 'T12:00:00').getTime() + 49 * 864e5))), false, `Pfingstsonntag ${y}`)
    assert.equal((await one(db.sys, `SELECT count(*)::int n FROM public_holidays WHERE name IN ('Allerheiligen', 'Reformationstag') OR date = $1`, [`${y}-11-01`])).n, 0)
  }
  for (const d of ['2026-10-01', '2026-11-02', '2027-01-04', '2028-02-29']) assert.equal(await no(d), false, d)
  for (const d of ['2026-01-01', '2027-03-26', '2028-06-15', '2029-05-10', '2030-06-10']) assert.equal(await no(d), true, d)
})

test('View: gleiche Spalten wie die bisherige Tabelle, nur lesbar (anon/authenticated), Abfragen der App funktionieren', async () => {
  const cols = await rows(db.sys, `SELECT column_name, udt_name, character_maximum_length l FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'public_holidays' ORDER BY ordinal_position`)
  assert.deepEqual(cols.map(c => `${c.column_name}:${c.udt_name}${c.l ? `(${c.l})` : ''}`), ['id:uuid', 'date:date', 'name:varchar(200)', 'bundesland:varchar(50)', 'year:int4'])
  const anon = await db.anon(), user = await db.as(E1)
  assert.equal((await rows(anon, `SELECT date FROM public_holidays WHERE bundesland = 'Hessen' AND year = ANY('{2026,2027}')`)).length, 20)
  assert.equal((await rows(user, `SELECT date, name, bundesland FROM public_holidays WHERE date BETWEEN '2027-03-01' AND '2027-03-31'`)).length, 2, 'Stundenzettel-Abfrage (Datumsbereich)')
  for (const c of [anon, user]) {
    assert.match(await err(() => c.query(`INSERT INTO public_holidays (date, name, bundesland, year) VALUES ('2026-11-01', 'Allerheiligen', 'Hessen', 2026)`)), /permission denied|cannot insert into view/)
    assert.match(await err(() => c.query(`DELETE FROM public_holidays`)), /permission denied|cannot delete from view/)
  }
  for (const role of ['anon', 'authenticated']) {
    const p = await one(db.sys, `SELECT has_table_privilege($1, 'public.public_holidays', 'SELECT') s, has_table_privilege($1, 'public.public_holidays', 'INSERT') i, has_table_privilege($1, 'public.public_holidays', 'UPDATE') u, has_table_privilege($1, 'public.public_holidays', 'DELETE') d`, [role])
    assert.deepEqual([p.s, p.i, p.u, p.d], [true, false, false, false], `Rechte ${role}`)
  }
  assert.equal(new Set((await rows(db.sys, `SELECT id FROM public_holidays`)).map(r => r.id)).size, 1110, 'eindeutige ids')
  // 01.05.2008: Tag der Arbeit = Christi Himmelfahrt → zwei Zeilen, aber ein Feiertag; Zählung einmal
  assert.deepEqual((await rows(db.sys, `SELECT name FROM public_holidays WHERE date = '2008-05-01' ORDER BY name`)).map(r => r.name), ['Christi Himmelfahrt', 'Tag der Arbeit'])
  assert.equal(calculateRequestedDays('2008-04-28', '2008-05-02', await appHolidays(db.sys, [2008])), 4)
  // Funktionen liegen nicht im API-Schema public (keine neuen öffentlichen RPCs)
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('easter_sunday', 'hessen_holidays', 'is_hessen_holiday')`)).n, 0)
})

test('Server zählt Urlaubstage über Feiertage, Monats- und Jahreswechsel; unabhängig von der Sitzungs-Zeitzone', async () => {
  const e1 = await db.as(E1)
  const CASES = [
    ['2026-12-28', '2027-01-08', 9],   // Jahreswechsel: 01.01.2027 (Fr) nicht gezählt
    ['2027-03-22', '2027-03-31', 6],   // Karfreitag + Ostermontag 2027
    ['2027-04-26', '2027-05-07', 9],   // Monatswechsel; 01.05. Sa, Himmelfahrt 06.05. Do
    ['2026-12-21', '2026-12-31', 8],   // Weihnachten 2026 (25.12. Fr)
    ['2028-12-22', '2029-01-05', 8],   // 11 Werktage − 25./26.12.2028 (Mo/Di) − 01.01.2029 (Mo)
  ]
  for (const tz of ['UTC', 'Europe/Berlin', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    await e1.query(`SET TIME ZONE '${tz}'`)
    for (const [s, e, n] of CASES) {
      const r = await one(e1, `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 1) RETURNING days_count`, [EMP(E1), s, e])
      assert.equal(r.days_count, n, `${s}–${e} (${tz})`)
    }
    const v = await rows(e1, `SELECT date FROM public_holidays WHERE year = 2027 ORDER BY date`)
    assert.deepEqual(v.map(r => ymd(r.date)), EXPECTED[2027].map(d => `2027-${d}`), `View in ${tz}`)
    await db.sys.query(`DELETE FROM vacation_requests WHERE status = 'pending'`)
  }
})

test('App und Server zählen identisch (gleiche Feiertagsquelle) – Zufallszeiträume 2025–2030', async () => {
  const e1 = await db.as(E1)
  const holidays = await appHolidays(e1, [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031])
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
  for (let i = 0; i < 120; i++) {
    const start = new Date(Date.UTC(2025, 0, 1) + rnd(6 * 365) * 864e5), end = new Date(start.getTime() + rnd(40) * 864e5)
    const s = iso(start), e = iso(end)
    const app = calculateRequestedDays(s, e, holidays)
    const ins = () => one(e1, `INSERT INTO vacation_requests (employee_id, start_date, end_date, days_count) VALUES ($1, $2, $3, 1) RETURNING days_count`, [EMP(E1), s, e])
    if (app === 0) { assert.match(await err(ins), /vacation_requests_days_positive/, `${s}–${e}: nur Wochenende/Feiertage → auch der Server lehnt ab`); continue }
    assert.equal((await ins()).days_count, app, `${s}–${e}`)
  }
  await db.sys.query(`DELETE FROM vacation_requests WHERE status = 'pending'`)
})

test('Urlaub über Feiertag und Krankheit über Feiertag (App-Logik mit Feiertagen aus der View)', async () => {
  const holidays = await appHolidays(db.sys, [2026, 2027])
  const vac = [{ id: 'v', status: 'approved', start_date: '2026-12-21', end_date: '2027-01-08' }]
  const b26 = getVacationBalance({ vacation_days_per_year: 30 }, vac, [], holidays, 2026)
  assert.equal(b26.used, 8); assert.equal(b26.returned_holiday, 1, '25.12.2026 (Fr) nicht abgezogen')
  const b27 = getVacationBalance({ vacation_days_per_year: 30 }, vac, [], holidays, 2027)
  assert.equal(b27.used, 5); assert.equal(b27.returned_holiday, 1, '01.01.2027 (Fr) nicht abgezogen')
  // krank im Urlaub über Weihnachten (mit Nachweis), 23.–29.12.: Werktage 23., 24., 28., 29. → 4 zurück;
  // der Feiertag 25.12. zählt weder als Urlaub noch als zurückgegebener Kranktag (bestehende Regel, nur mit korrekten Feiertagen)
  const sick = [{ start_date: '2026-12-23', end_date: '2026-12-29', certificate_received: true }]
  const bs = getVacationBalance({ vacation_days_per_year: 30 }, vac, sick, holidays, 2026)
  assert.deepEqual([bs.used, bs.returned_sick, bs.returned_holiday], [4, 4, 1])
  assert.equal(checkSickDuringVacation('2026-12-23', '2026-12-29', vac, holidays).returnedDays, 4)
})

test('Warnung bei abweichendem days_count: nur Anzeige, nur für geladene Jahre, keine Datenänderung', async () => {
  const holidays = await appHolidays(db.sys, [2025, 2026, 2027])
  const years = [2025, 2026, 2027]
  assert.equal(vacationDaysMismatch({ start_date: '2027-03-22', end_date: '2027-03-31', days_count: 8 }, holidays, years), 6, 'vor Migration 31 gezählter 2027-Antrag')
  assert.equal(vacationDaysMismatch({ start_date: '2027-03-22', end_date: '2027-03-31', days_count: 6 }, holidays, years), null)
  assert.equal(vacationDaysMismatch({ start_date: '2028-04-10', end_date: '2028-04-21', days_count: 10 }, holidays, years), null, 'Jahr nicht geladen → kein Fehlalarm')
  assert.equal(vacationDaysMismatch({ start_date: '2026-12-28', end_date: '2027-01-08', days_count: null }, holidays, years), null)
  const snap = await one(db.sys, `SELECT md5(string_agg(v::text, '|' ORDER BY id)) h FROM vacation_requests v`)
  vacationDaysMismatch({ start_date: '2026-12-21', end_date: '2026-12-31', days_count: 9 }, holidays, years)
  assert.deepEqual(await one(db.sys, `SELECT md5(string_agg(v::text, '|' ORDER BY id)) h FROM vacation_requests v`), snap)
})

test('Migration wiederholt ausführbar; Lohnfunktionen lesen keine Feiertage', async () => {
  await db.sys.query(migration('31_hessen_holidays.sql'))
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM public_holidays`)).n, 1110)
  assert.equal((await one(db.sys, `SELECT relkind::text k FROM pg_class WHERE oid = 'public.public_holidays'::regclass`)).k, 'v')
  assert.equal((await one(db.sys, `SELECT count(*)::int n FROM public_holidays_manual_2025_2026`)).n, 21)
  const src = ['src/pages/Payroll.jsx', 'src/lib/compensation.js', 'src/lib/workTimeModels.js'].map(f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')).join('\n')
  assert.doesNotMatch(src, /holiday|public_holidays|Feiertag/i)
})
