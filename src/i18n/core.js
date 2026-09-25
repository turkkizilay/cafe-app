import { de, en } from './catalogs.js'

export const LOCALE_KEY = 'cafe-buur-locale'
export const LOCALES = Object.freeze(['de', 'en'])
export const normalizeLocale = value => LOCALES.includes(value) ? value : 'de'
export const intlLocale = locale => normalizeLocale(locale) === 'en' ? 'en-GB' : 'de-DE'
export const catalogs = { de, en }

export function readLocale(storage) {
  try { return normalizeLocale((storage ?? globalThis.localStorage)?.getItem(LOCALE_KEY)) }
  catch { return 'de' }
}

export function writeLocale(locale, storage) {
  const next = normalizeLocale(locale)
  try { (storage ?? globalThis.localStorage)?.setItem(LOCALE_KEY, next) } catch { /* In-memory selection still works. */ }
  return next
}

export function localeFromStorageEvent(event) {
  if (event.key !== LOCALE_KEY && event.key !== null) return undefined
  return normalizeLocale(event.newValue)
}

export function interpolate(message, values = {}) {
  return message.replace(/\{([A-Za-z]\w*)\}/g, (placeholder, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : placeholder)
}

export function translate(locale, key, values = {}, dictionaries = catalogs) {
  const language = normalizeLocale(locale)
  const own = (object, name) => Object.prototype.hasOwnProperty.call(object || {}, name) ? object[name] : undefined
  let message = own(dictionaries[language], key) ?? own(dictionaries.de, key) ?? key
  if (message && typeof message === 'object') {
    const category = new Intl.PluralRules(intlLocale(language)).select(Number(values.count ?? 0))
    message = message[category] ?? message.other ?? own(dictionaries.de, key)?.other ?? key
  }
  return interpolate(String(message), values)
}

// Every formatter changes presentation only. Callers retain their existing Date
// construction, explicit timeZone, precision and business calculations.
export function createFormatters(locale) {
  const language = intlLocale(locale)
  return {
    number: (value, options = {}) => value == null ? '–' : new Intl.NumberFormat(language, options).format(value),
    currency: (value, options = {}) => value == null ? '–' : new Intl.NumberFormat(language, { ...options, style: 'currency', currency: 'EUR' }).format(value),
    date: (value, options = {}) => value == null ? '–' : new Intl.DateTimeFormat(language, options).format(value),
    time: (value, options = {}) => value == null ? '–' : new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', ...options }).format(value),
  }
}
