// Live-Personalkosten (Dashboard, nur Admin) – reine Logik ohne Datenbank/React.
// Der Server (labor_cost_today, Migration 35) liefert die maßgebliche Tagesbasis zum Zeitpunkt server_now:
// Netto-Sekunden, Kosten (nur Stundenlohn), Anzahl gerade Arbeitender und die Summe ihrer Stundensätze.
// Zwischen zwei Abfragen wird nur fortgeschrieben: Kosten += Summe Sätze × verstrichene Zeit, Stunden += Anzahl ×
// verstrichene Zeit. Die verstrichene Zeit misst der Client monoton (performance.now) – die Uhrzeit des Geräts und
// seine Zeitzone spielen keine Rolle. Am Tagesende (Europe/Berlin, vom Server geliefert) wird nicht weitergezählt.

export const TICK_MS = 1000                 // Anzeige fortschreiben (rein lokal, keine Abfrage)
export const SAFETY_REFRESH_MS = 60 * 1000  // Sicherheitsabgleich mit dem Server, nur bei sichtbarer Seite
export const COALESCE_MS = 400              // mehrere Auslöser kurz hintereinander (focus + visibilitychange + pageshow) = 1 Abfrage

const n = v => Number(v) || 0

// Verstrichene Zeit ab server_now, begrenzt auf das Tagesende (danach neue Basis nötig)
export function cappedElapsedMs(base, elapsedMs) {
  const room = Date.parse(base.day_end) - Date.parse(base.server_now)
  return Math.max(0, Math.min(n(elapsedMs), Math.max(0, room)))
}
export function msUntilDayEnd(base, elapsedMs) {
  return Math.max(0, Date.parse(base.day_end) - Date.parse(base.server_now) - n(elapsedMs))
}

// → { cost, hours, hoursHourly, week, planned, usage, running, runningHourly, onBreak, fixedWorking, fixedShifts }
export function liveFigures(base, elapsedMs) {
  const sec = cappedElapsedMs(base, elapsedMs) / 1000
  const t = base.today || {}, p = base.planned || {}
  const rate = n(t.running_rate)
  const cost = n(t.cost) + rate * sec / 3600
  const planned = n(p.cost)
  return {
    cost,
    hours: (n(t.net_seconds) + n(t.running) * sec) / 3600,
    hoursHourly: (n(t.net_seconds_hourly) + n(t.running_hourly) * sec) / 3600,
    week: n(base.week?.cost) + rate * sec / 3600,
    planned,
    usage: planUsage(cost, planned),
    running: n(t.running), runningHourly: n(t.running_hourly), onBreak: n(t.on_break),
    fixedWorking: n(t.fixed_working), fixedShifts: n(p.fixed_shifts),
  }
}

// Planverbrauch in % (Live-Kosten / heute geplant). Kein Plan → null (Anzeige „–“); > 100 % ist erlaubt.
export function planUsage(cost, planned) {
  return n(planned) > 0 ? (n(cost) / n(planned)) * 100 : null
}

// Abgleich mit dem Server: veraltete/überholte Antworten werden verworfen (laufende Nummer + server_now
// monoton), mehrere Auslöser während einer laufenden Abfrage führen zu genau einer Folgeabfrage.
const URGENT = new Set(['manual', 'time-data', 'midnight', 'followup'])
export function createLaborSync({ load, onData, onError, now = () => Date.now(), isOffline = () => false }) {
  let seq = 0, applied = 0, lastServerNow = -Infinity, inFlight = false, again = false, lastStart = -Infinity, disposed = false
  async function run(reason) {
    if (disposed) return
    if (isOffline()) { onError?.({ kind: 'offline', reason }); return }
    // Echte Änderungen/↻/Tageswechsel nie verwerfen; Sichtbarkeit/Fokus/Laden kurz hintereinander zusammenfassen
    const urgent = URGENT.has(reason)
    if (!urgent && now() - lastStart < COALESCE_MS) return
    if (inFlight) { again = true; return }
    inFlight = true; lastStart = now()
    const my = ++seq
    try {
      const res = await load()
      if (disposed || my < applied) return
      if (res?.error || !res?.data) { onError?.({ kind: 'error', error: res?.error, reason }); return }
      const ts = Date.parse(res.data.server_now)
      if (!(ts >= lastServerNow)) return            // ältere Serverzeit als die angezeigte → verwerfen
      applied = my; lastServerNow = ts
      onData(res.data, now())
    } catch (error) {
      if (!disposed) onError?.({ kind: 'error', error, reason })
    } finally {
      inFlight = false
      if (again && !disposed) { again = false; lastStart = -Infinity; run('followup') }
    }
  }
  return { revalidate: run, dispose() { disposed = true } }
}

// Auslöser für eine neue Basis: App wieder sichtbar, Fokus, Rückkehr aus dem Seiten-Cache, wieder online,
// Zeitdaten in diesem oder einem anderen Tab geändert (Ein-/Ausstempeln, Pause, Korrektur, Schichtplan).
export const TIME_DATA_EVENT = 'cafe:time-data-changed'
export const TIME_DATA_CHANNEL = 'cafe-time-data'
export function bindLaborRevalidation({ win, doc, trigger, Channel = typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null }) {
  const onVisible = () => { if (doc.visibilityState === 'visible') trigger('visible') }
  const onFocus = () => trigger('focus'), onShow = () => trigger('pageshow'), onOnline = () => trigger('online'), onData = () => trigger('time-data')
  doc.addEventListener('visibilitychange', onVisible)
  win.addEventListener('focus', onFocus); win.addEventListener('pageshow', onShow); win.addEventListener('online', onOnline)
  win.addEventListener(TIME_DATA_EVENT, onData)
  let ch = null
  try { if (Channel) { ch = new Channel(TIME_DATA_CHANNEL); ch.onmessage = onData } } catch { ch = null }
  return () => {
    doc.removeEventListener('visibilitychange', onVisible)
    win.removeEventListener('focus', onFocus); win.removeEventListener('pageshow', onShow); win.removeEventListener('online', onOnline)
    win.removeEventListener(TIME_DATA_EVENT, onData)
    try { ch?.close() } catch { /* bereits geschlossen */ }
  }
}

// Nach einer erfolgreichen Änderung an Zeitdaten aufrufen (gleicher Tab + andere Tabs desselben Geräts)
export function notifyTimeDataChanged(win = typeof window !== 'undefined' ? window : null, Channel = typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null) {
  if (!win) return
  try { win.dispatchEvent(new CustomEvent(TIME_DATA_EVENT)) } catch { /* ohne CustomEvent: nur andere Tabs */ }
  try { if (Channel) { const ch = new Channel(TIME_DATA_CHANNEL); ch.postMessage('changed'); ch.close() } } catch { /* optional */ }
}
