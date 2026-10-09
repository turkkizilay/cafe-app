import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { message as appMessage } from '../i18n/runtime.js'
import { showToast } from '../components/UI/Toast'
import { createRefreshController } from '../lib/refreshController'
import { createResumeTrigger } from '../lib/resumeRefresh'
import { checkForNewVersion } from '../lib/versionCheck'

// Zentraler Daten-Refresh (kein Seiten-Reload): Jede Seite meldet ihre bestehende Ladefunktion an,
// der Aktualisieren-Button ruft refreshData() auf (keine eigene Pull-Geste).
const RefreshContext = createContext(null)

// Rückmeldungen der Refresh-Steuerung (feste Schlüssel → i18n-Prüfung findet sie)
const NOTICE = {
  get failed()  { return [appMessage('refresh.failed'), 'error', 7000] },
  get offline() { return [appMessage('refresh.offline'), 'warn', 5000] },
  get blocked() { return [appMessage('refresh.blocked'), 'info', 4000] },
}

// Refresh nicht, solange ein Dialog offen ist oder gerade ein Feld bearbeitet wird (Eingaben schützen)
export function refreshBlocked(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return false
  if (doc.querySelector('.modal-overlay')) return true
  const a = doc.activeElement
  return !!(a && (a.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)))
}

export function RefreshProvider({ children }) {
  const handlerRef = useRef(null)
  const [hasHandler, setHasHandler] = useState(false)
  const [status, setStatus] = useState('idle')   // idle | refreshing

  // stabil über Renderings: sonst entstünde bei jedem Rendern eine neue Sperre → Doppel-Refresh möglich
  const controller = useMemo(() => createRefreshController({
    getHandler: () => handlerRef.current,
    isBlocked: () => refreshBlocked(),
    isAutoBlocked: () => autoRefreshBlocked(),
    isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
    setStatus,
    notify: kind => showToast(...NOTICE[kind]),
  }), [])

  const refreshData = useCallback(() => controller.refresh(), [controller])

  // Rückkehr in die App / wieder online / Tageswechsel → derselbe zentrale Lauf (still, Schutzregeln wie oben).
  // Genau eine Bindung je Provider; beim Abbau werden alle Listener und Timer entfernt (lib/resumeRefresh.js).
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    // Gleiche Ereignisse prüfen auch, ob eine neue App-Version ausgeliefert wurde (nur Hinweis, nie Neuladen – F8)
    const trigger = createResumeTrigger({ doc: document, win: window, onTrigger: () => { checkForNewVersion(); return controller.refresh({ auto: true }) } })
    return () => trigger.dispose()
  }, [controller])

  const register = useCallback((fn) => {
    handlerRef.current = fn; setHasHandler(true)
    return () => { if (handlerRef.current === fn) { handlerRef.current = null; setHasHandler(false) } }
  }, [])

  const value = useMemo(() => ({ refreshData, status, hasHandler, register }), [refreshData, status, hasHandler, register])
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
}

export function useRefresh() {
  return useContext(RefreshContext) || { refreshData: () => Promise.resolve(), status: 'idle', hasHandler: false, register: () => () => {} }
}

// Seite meldet ihre Ladefunktion an. Die jeweils aktuelle Funktion wird verwendet (kein veralteter Zustand).
export function useRefreshHandler(fn) {
  const { register } = useRefresh()
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    const stable = () => latest.current?.()
    return register(stable)
  }, [register])
}

// Automatischer Refresh (Rückkehr in die App, wieder online) zusätzlich NICHT, solange ein Textfeld Inhalt hat – auch
// ohne Fokus: Seiten wie „Konto“ bearbeiten inline (ohne Dialog), und nach der Rückkehr aus einer anderen App ist das
// Feld auf dem Handy meist nicht mehr fokussiert. Ein Neuladen würde ungespeicherte Eingaben verwerfen. Der ↻-Button
// (bewusste Handlung) bleibt unverändert bei refreshBlocked.
const TEXT_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="password"], input[type="url"], input[type="search"]'
export function autoRefreshBlocked(doc = typeof document !== 'undefined' ? document : null) {
  if (refreshBlocked(doc)) return true
  if (!doc?.querySelectorAll) return false
  for (const el of doc.querySelectorAll(TEXT_FIELDS)) if (!el.disabled && !el.readOnly && String(el.value ?? '').trim() !== '') return true
  return false
}
