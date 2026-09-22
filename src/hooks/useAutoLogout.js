/**
 * useAutoLogout — Automatische Abmeldung nach Inaktivität
 * 
 * Timeout-Werte:
 *   Ohne "Angemeldet bleiben": 30 Minuten
 *   Mit "Angemeldet bleiben":   8 Stunden
 *   Warnung vorher:             2 Minuten
 *
 * Verwendet echte Date.now() Zeitstempel statt nur setInterval,
 * da Browser im Hintergrund Timer drosseln können.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

export const AUTO_LOGOUT_MS = {
  noRemember:  30 * 60 * 1000,      // 30 Minuten
  withRemember: 8 * 60 * 60 * 1000, // 8 Stunden
  warning:      2 * 60 * 1000,       // 2 Minuten Warnung
  check:       10 * 1000,            // Alle 10s prüfen
}

const ACTIVITY_EVENTS = ['mousemove','mousedown','keydown','touchstart','scroll']

export function useAutoLogout(session, onLogout) {
  const [showWarning, setShowWarning] = useState(false)
  const [countdown,   setCountdown]   = useState(AUTO_LOGOUT_MS.warning / 1000)

  const lastActivityRef   = useRef(Date.now())
  const isLoggingOutRef   = useRef(false)
  const lastThrottleRef   = useRef(0)
  const checkIntervalRef  = useRef(null)
  const countdownRef      = useRef(null)
  const showWarningRef    = useRef(false)  // Ref-Kopie für Callbacks ohne stale closure

  const getTimeout = useCallback(() =>
    localStorage.getItem('cafe_no_remember') === '1'
      ? AUTO_LOGOUT_MS.noRemember
      : AUTO_LOGOUT_MS.withRemember
  , [])

  const performLogout = useCallback(async (reason = 'auto') => {
    if (isLoggingOutRef.current) return
    isLoggingOutRef.current = true
    if (countdownRef.current)    { clearInterval(countdownRef.current);    countdownRef.current   = null }
    if (checkIntervalRef.current){ clearInterval(checkIntervalRef.current); checkIntervalRef.current = null }
    setShowWarning(false)
    showWarningRef.current = false
    await onLogout(reason)
  }, [onLogout])

  const extendSession = useCallback(() => {
    lastActivityRef.current = Date.now()
    setShowWarning(false)
    showWarningRef.current = false
    setCountdown(AUTO_LOGOUT_MS.warning / 1000)
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
  }, [])

  const startCountdown = useCallback(() => {
    if (countdownRef.current) return
    setCountdown(Math.round(AUTO_LOGOUT_MS.warning / 1000))
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current)
          countdownRef.current = null
          performLogout('timeout')
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [performLogout])

  const recordActivity = useCallback(() => {
    const now = Date.now()
    if (now - lastThrottleRef.current < 1000) return
    lastThrottleRef.current = now
    lastActivityRef.current = now
    if (showWarningRef.current) {
      extendSession()
    }
  }, [extendSession])

  const checkInactivity = useCallback(() => {
    if (!session || isLoggingOutRef.current) return
    const idleMs  = Date.now() - lastActivityRef.current
    const timeout = getTimeout()
    if (idleMs >= timeout) {
      performLogout('timeout')
    } else if (idleMs >= timeout - AUTO_LOGOUT_MS.warning && !showWarningRef.current) {
      showWarningRef.current = true
      setShowWarning(true)
      startCountdown()
    }
  }, [session, getTimeout, performLogout, startCountdown])

  useEffect(() => {
    if (!session) return
    lastActivityRef.current = Date.now()
    isLoggingOutRef.current = false

    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, recordActivity, { passive: true }))
    checkIntervalRef.current = setInterval(checkInactivity, AUTO_LOGOUT_MS.check)

    return () => {
      ACTIVITY_EVENTS.forEach(ev => window.removeEventListener(ev, recordActivity))
      if (checkIntervalRef.current) { clearInterval(checkIntervalRef.current); checkIntervalRef.current = null }
      if (countdownRef.current)     { clearInterval(countdownRef.current);    countdownRef.current = null }
    }
  }, [session, recordActivity, checkInactivity])

  useEffect(() => {
    if (!session) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkInactivity()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [session, checkInactivity])

  return { showWarning, countdown, extendSession, performLogout }
}
