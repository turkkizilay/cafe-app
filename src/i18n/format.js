import { getIntlLocale } from './runtime.js'

// Presentation only: date construction and time zones match the existing helpers.
export function formatDate(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric' })
}

export function formatDateLong(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(getIntlLocale(), { weekday:'long', day:'numeric', month:'long', year:'numeric' })
}

export function formatDateShort(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(getIntlLocale(), { day:'numeric', month:'short' })
}

export function formatDateTime(isoStr) {
  if (!isoStr) return '–'
  return new Date(isoStr).toLocaleDateString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
}

export function formatMonthYear(year, month) {
  return new Date(year, month).toLocaleDateString(getIntlLocale(), { month:'long', year:'numeric' })
}

export function formatTime(isoStr) {
  if (!isoStr) return '–'
  return new Date(isoStr).toLocaleTimeString(getIntlLocale(), { hour:'2-digit', minute:'2-digit' })
}

export function formatCurrency(amount) {
  if (amount == null) return '–'
  return new Intl.NumberFormat(getIntlLocale(), { style:'currency', currency:'EUR' }).format(amount)
}
