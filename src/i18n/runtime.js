import { normalizeLocale, intlLocale, translate, createFormatters } from './core.js'
import { translateSource } from './messages.js'

// Presentation only: descriptors belong to the caller, never to a global history.
let currentLocale = 'de'
export function setRuntimeLocale(locale) { currentLocale = normalizeLocale(locale) }
export function getLocale() { return currentLocale }
export function getIntlLocale() { return intlLocale(currentLocale) }
const descriptor = Symbol('app message')
const tagged = fields => Object.freeze({ [descriptor]: true, ...fields })

export function message(key, values = {}) {
  return tagged({ kind: 'translation', key, values: Object.freeze({ ...values }) })
}
export function messageParts(parts, separator = '') {
  return tagged({ kind: 'parts', parts: Object.freeze([...parts]), separator })
}
export function formatParam(format, value, options = {}) {
  // Copy dates/options so a later form edit cannot mutate an existing message.
  return tagged({ kind: 'format', format, value: value instanceof Date ? value.getTime() : value, options: Object.freeze({ ...options }) })
}
export function localizeMessage(value, locale = currentLocale) {
  // Strings are literal, including names, backend details and catalog lookalikes.
  if (!value || value[descriptor] !== true) return value
  if (value.kind === 'parts') return value.parts.map(part => localizeMessage(part, locale) ?? '').join(value.separator)
  if (value.kind === 'format') return createFormatters(locale)[value.format](value.value, value.options)
  const values = Object.fromEntries(Object.entries(value.values).map(([key, param]) => [key, localizeMessage(param, locale)]))
  return translate(locale, value.key, values)
}
// Immediate labels stay strings. Stored UI messages must use message().
export function t(key, values) { return localizeMessage(message(key, values)) }
export function messageError(value) {
  const error = new Error(localizeMessage(value))
  error.displayMessage = value
  return error
}
export function errorMessage(error) { return error?.displayMessage ?? error?.message }
export function sourceLabel(source, values) { return translateSource(currentLocale, source, values) }
export function formatters() { return createFormatters(currentLocale) }
