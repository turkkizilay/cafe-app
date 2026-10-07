// Handlungsbedarf (Dashboard, nur Admin/Manager) – reine Ableitung aus Daten, die das Dashboard ohnehin lädt.
// Freigegebener MVP (07.10.2026), Regeln exakt wie abgestimmt – keine eigenen Schwellen, nichts gespeichert:
//  1 CRITICAL  Eintrag seit über 12 h offen          (beide)   – 12 h = bestehende Regel Migration 07 (danach 0 Std.)
//  2 ACTION    „Ausstempeln vergessen“                (Admin)   – Vermerk FORGOT_CLOCKOUT_MARK, Korrektur nur Admin
//  3 ACTION    Urlaubsanträge beantragt               (beide)   – Zusatz frühester Beginn, falls in ≤ 7 Tagen
//  4 ACTION    Schichttausch angenommen, Freigabe fehlt (beide) – nur Status „accepted“ (nicht „open“)
//  5 ACTION    Registrierung eingereicht              (Admin)   – employee_onboarding.status = 'submitted'
//  6 ACTION    Datensicherung überfällig              (Admin)   – bestehende Regel BACKUP_REMIND_DAYS bzw. „noch nie“
//  7 INFO      Pause seit über 90 min                 (beide)   – bestehende Schwelle BREAK_WARNING_MINUTES
//  8 INFO      Löschfristen fällig                    (Admin)   – bestehende retention_overview
// Bewusst NICHT: Krankmeldungen/Gesundheitsdaten, Personalnummer, Profile, Lohn/Kosten. Ergebnis enthält nur Namen,
// Zeitpunkte und Anzahlen – nie Notizen, Beträge oder IDs zur Anzeige.
import { BREAK_WARNING_MINUTES, openBreak } from './workHours.js'
import { BACKUP_REMIND_DAYS } from './backup.js'

export const LONG_OPEN_HOURS = 12        // Migration 07 (prevent_time_entry_backdating): > 12 h offen → 0 Std. + Vermerk
export const VACATION_SOON_DAYS = 7

const dayStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const nameOf = row => [row?.employees?.first_name, row?.employees?.last_name].filter(Boolean).join(' ')

/**
 * @param {object} d
 * @param {'admin'|'manager'|'employee'} d.role
 * @param {Date}   d.now
 * @param {Array}  d.liveClockIns   offene Zeiteinträge (clock_out IS NULL) inkl. employees{first_name,last_name}
 * @param {Object} d.liveBreaks     { entryId: [breaks] } der offenen Einträge
 * @param {number} d.forgottenCount Einträge mit „Ausstempeln vergessen“ (nur Admin geladen)
 * @param {Array}  d.pendingVacations beantragte Urlaube (start_date)
 * @param {number} d.swapsAccepted  Tauschanfragen mit Status „accepted“
 * @param {number} d.onboardingSubmitted eingereichte Registrierungen (nur Admin geladen)
 * @param {number|null} d.backupDays Tage seit letztem Sicherungs-Download, -1 = noch nie, null = unbekannt
 * @param {Array|0} d.retentionDue  fällige Löschkategorien [{ key, due, title }] oder 0
 * @returns {Array<{id,level,kind,params,to?,live?}>} in Prioritätsreihenfolge: CRITICAL → ACTION → INFO
 * (die Hinweise werden genau in dieser Reihenfolge erzeugt – 1 kritisch, 2–6 zu erledigen, 7–8 Info)
 */
export function deriveAttentionItems(d) {
  const role = d?.role
  if (role !== 'admin' && role !== 'manager') return []   // Mitarbeiter: nie
  const isAdmin = role === 'admin'
  const now = d.now instanceof Date ? d.now : new Date()
  const items = []

  // 1 · seit über 12 h eingestempelt (ältester zuerst)
  const longOpenMs = LONG_OPEN_HOURS * 3600e3
  const longOpen = (d.liveClockIns || [])
    .filter(e => e && !e.clock_out && e.clock_in && now - new Date(e.clock_in) > longOpenMs)
    .sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in))
  for (const e of longOpen) {
    items.push({ id: `long-open:${e.id}`, level: 'critical', kind: 'longOpen', params: { name: nameOf(e), since: e.clock_in },
      ...(isAdmin ? { to: '/zeitkorrekturen' } : { live: { employeeId: e.employee_id, name: nameOf(e) } }) })
  }

  // 2 · „Ausstempeln vergessen“ (nur Admin)
  if (isAdmin && d.forgottenCount > 0) items.push({ id: 'forgotten', level: 'action', kind: 'forgotten', params: { count: d.forgottenCount }, to: '/zeitkorrekturen' })

  // 3 · Urlaubsanträge warten (frühester Beginn nur, wenn in ≤ 7 Tagen)
  const vac = (d.pendingVacations || []).filter(v => v && v.status !== 'approved' && v.status !== 'rejected')
  if (vac.length > 0) {
    const soonLimit = new Date(now); soonLimit.setDate(soonLimit.getDate() + VACATION_SOON_DAYS)
    const earliest = vac.map(v => v.start_date).filter(Boolean).sort()[0]
    const soon = earliest && earliest <= dayStr(soonLimit) ? earliest : null
    items.push({ id: 'vacation', level: 'action', kind: 'vacation', params: { count: vac.length, soon }, to: '/urlaub?tab=urlaub' })
  }

  // 4 · Schichttausch angenommen, Freigabe fehlt
  if (d.swapsAccepted > 0) items.push({ id: 'swaps', level: 'action', kind: 'swaps', params: { count: d.swapsAccepted }, to: '/schichten' })

  // 5 · Registrierung eingereicht (nur Admin)
  if (isAdmin && d.onboardingSubmitted > 0) items.push({ id: 'onboarding', level: 'action', kind: 'onboarding', params: { count: d.onboardingSubmitted }, to: '/benutzer' })

  // 6 · Datensicherung überfällig (nur Admin) – bestehende Regel
  if (isAdmin && d.backupDays !== null && d.backupDays !== undefined && (d.backupDays === -1 || d.backupDays >= BACKUP_REMIND_DAYS))
    items.push({ id: 'backup', level: 'action', kind: 'backup', params: { days: d.backupDays }, to: '/einstellungen#datensicherung' })

  // 7 · Pause seit über 90 min (ältester zuerst)
  const breakMs = BREAK_WARNING_MINUTES * 60e3
  const longBreaks = (d.liveClockIns || [])
    .map(e => ({ e, b: openBreak((d.liveBreaks || {})[e?.id]) }))
    .filter(x => x.e && x.b && now - new Date(x.b.break_start) > breakMs)
    .sort((x, y) => new Date(x.b.break_start) - new Date(y.b.break_start))
  for (const { e, b } of longBreaks)
    items.push({ id: `long-break:${e.id}`, level: 'info', kind: 'longBreak', params: { name: nameOf(e), since: b.break_start, minutes: BREAK_WARNING_MINUTES },
      live: { employeeId: e.employee_id, name: nameOf(e) } })

  // 8 · Löschfristen fällig (nur Admin) – bestehende retention_overview
  if (isAdmin && Array.isArray(d.retentionDue) && d.retentionDue.length > 0)
    items.push({ id: 'retention', level: 'info', kind: 'retention', params: { categories: d.retentionDue.map(({ key, due, title }) => ({ key, due, title })) }, to: '/einstellungen#aufbewahrung' })

  return items
}
