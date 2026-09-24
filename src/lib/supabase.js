import { createClient } from '@supabase/supabase-js'

// ── Supabase Konfiguration ──────────────────────────────────
// Supabase Konfiguration
// Lokal: .env Datei im Projektordner anlegen (siehe .env.example)
// Produktion: Vercel Dashboard → Settings → Environment Variables
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('⛔ .env Datei fehlt. Bitte .env.example als .env kopieren und ausfüllen.')
}

// ── Uhrzeit-Versatz zwischen Supabase-Servern abfangen ──────
// Direkt nach dem Login / Token-Erneuern lehnt die Datenbank-Schnittstelle
// manchmal für Bruchteile einer Sekunde das neue Token ab („JWT issued at future"),
// weil ihre Uhr minimal hinter der des Login-Servers liegt. Die Anfrage wurde
// dabei NICHT ausgeführt — sie kann also gefahrlos wiederholt werden.
async function isClockSkew401(res) {
  if (res.status !== 401) return false
  try {
    const txt = await res.clone().text()
    return /issued at future|PGRST303/i.test(txt)
  } catch { return false }
}

export async function fetchWithSkewRetry(input, init) {
  let res = await fetch(input, init)
  for (const wait of [400, 900, 1600]) {
    if (!(await isClockSkew401(res))) return res
    await new Promise(r => setTimeout(r, wait))
    res = await fetch(input, init)
  }
  return res
}

export const supabase = createClient(
  SUPABASE_URL      || 'missing-url',
  SUPABASE_ANON_KEY || 'missing-key',
  { global: { fetch: (...args) => fetchWithSkewRetry(...args) } }
)

// ── Hilfsfunktionen ─────────────────────────────────────────
export function getInitials(first, last) {
  return `${(first||'').charAt(0)}${(last||'').charAt(0)}`.toUpperCase()
}

export function getAvatarColor(name) {
  const colors = ['blue','green','purple','orange','red','teal','pink','indigo']
  let hash = 0
  for (let c of (name||'')) hash = c.charCodeAt(0) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

// ── Zentrale Datums-Helpers (KEIN amerikanisches Format irgendwo) ──
export function formatDate(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' })
}

export function formatDateLong(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('de-DE', { weekday:'long', day:'numeric', month:'long', year:'numeric' })
}

export function formatDateShort(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('de-DE', { day:'numeric', month:'short' })
}

export function formatDateTime(isoStr) {
  if (!isoStr) return '–'
  return new Date(isoStr).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
}

export function formatMonthYear(year, month) {
  return new Date(year, month).toLocaleDateString('de-DE', { month:'long', year:'numeric' })
}

// Lokales Datum als YYYY-MM-DD — KEIN toISOString() (verschiebt in DE um 1 Tag durch UTC)
export function toLocalDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
}

export function todayISO() {
  return toLocalDateStr(new Date())
}

export function parseISODate(dateStr) {
  if (!dateStr) return null
  return new Date(dateStr + 'T00:00:00')
}

export function formatTime(isoStr) {
  if (!isoStr) return '–'
  return new Date(isoStr).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })
}

export function formatCurrency(amount) {
  if (amount == null) return '–'
  return new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR' }).format(amount)
}

export function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
