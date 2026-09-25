import { catalogs, translate } from './core.js'

// Finite catalog lookup for explicitly application-owned legacy labels only.
// Retained messages carry their own descriptors; arbitrary strings are literal.
const sourceKeys = new Map()
for (const [key, value] of Object.entries(catalogs.de)) {
  if (typeof value === 'string') sourceKeys.set(value, key)
}

export function translateSource(locale, source, values) {
  return translate(locale, sourceKeys.get(source) ?? source, values)
}
