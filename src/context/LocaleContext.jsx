import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createFormatters, intlLocale, localeFromStorageEvent, readLocale, translate, writeLocale } from '../i18n/core.js'
import { setRuntimeLocale } from '../i18n/runtime.js'

export const LocaleContext = createContext(null)

export function LocaleProvider({ children }) {
  const [locale, updateLocale] = useState(() => {
    const initial = readLocale()
    setRuntimeLocale(initial)
    return initial
  })
  const applyLocale = useCallback(next => {
    setRuntimeLocale(next)
    updateLocale(next)
  }, [])
  const setLocale = useCallback(next => applyLocale(writeLocale(next)), [applyLocale])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = translate(locale, 'app.title')
  }, [locale])
  useEffect(() => {
    const synchronize = event => {
      // Ignore sessionStorage events. Access itself can throw in restricted browsers.
      try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
      const next = localeFromStorageEvent(event)
      if (next !== undefined) applyLocale(next)
    }
    window.addEventListener('storage', synchronize)
    return () => window.removeEventListener('storage', synchronize)
  }, [applyLocale])

  const value = useMemo(() => ({
    locale, setLocale, intlLocale: intlLocale(locale),
    t: (key, values) => translate(locale, key, values),
    ...createFormatters(locale),
  }), [locale, setLocale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale requires LocaleProvider')
  return value
}
