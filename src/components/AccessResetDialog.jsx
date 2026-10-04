import { useEffect, useRef, useState } from 'react'
import { t as tr } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { supabase } from '../lib/supabase'
import { loadAccessResetState, requestAccessReset, resetReasonKey, maskPassword } from '../lib/accessReset'

// Admin: „Zugang zurücksetzen“ (Migration 38). Der Server prüft Admin, Ziel und Generation; das temporäre Passwort
// steht nur in diesem Dialog-State und ist nach dem Schließen weg (kein Storage, kein Log, kein Protokolltext).
export default function AccessResetDialog({ employeeId, name, onClose }) {
  useLocale()
  const [phase, setPhase] = useState('loading')   // loading | blocked | confirm | working | result | error
  const [info, setInfo] = useState(null)
  const [reason, setReason] = useState(null)
  const [password, setPassword] = useState(null)
  const [warning, setWarning] = useState(null)
  const [reveal, setReveal] = useState(false)
  const [copied, setCopied] = useState(null)       // null | 'ok' | 'failed'
  const busyRef = useRef(false)                    // Doppeltipp-Sperre (synchron)

  useEffect(() => {
    let alive = true
    loadAccessResetState(supabase, employeeId).then(st => {
      if (!alive) return
      if (!st.ok) { setReason(st.reason); setPhase('error'); return }
      setInfo(st)
      if (!st.eligible) { setReason(st.reason); setPhase('blocked') } else setPhase(st.in_progress ? 'blocked' : 'confirm')
      if (st.eligible && st.in_progress) setReason('in_progress')
    })
    return () => { alive = false }
  }, [employeeId])

  // Passwort beim Schließen/Verlassen verwerfen
  useEffect(() => () => { setPassword(null) }, [])
  function close() { setPassword(null); setReveal(false); onClose() }

  async function confirm() {
    if (busyRef.current || phase !== 'confirm') return
    busyRef.current = true; setPhase('working')
    const r = await requestAccessReset(supabase, employeeId, info.generation)
    busyRef.current = false
    if (r.ok && r.temp_password) { setPassword(r.temp_password); setWarning(r.warning || null); setPhase('result'); return }
    setReason(r.reason); setPhase('error')
  }

  async function copy() {
    try { await navigator.clipboard.writeText(password); setCopied('ok') }
    catch { setCopied('failed'); setReveal(true) }   // ohne Zwischenablage: zum Abschreiben anzeigen
  }

  const result = phase === 'result'
  return (
    <div className="modal-overlay" onClick={e => { if (!result && e.target === e.currentTarget && phase !== 'working') close() }}>
      <div className="modal" style={{ maxWidth: 420 }} role="dialog" aria-modal="true" data-testid="access-reset-dialog">
        <div className="modal-header">
          <div className="modal-title">{result ? tr("accessReset.resultTitle") : tr("accessReset.title")}</div>
          {!result && phase !== 'working' && <button className="btn btn-sm" onClick={close} aria-label={tr("accessReset.cancel")}>✕</button>}
        </div>
        <div className="modal-body" style={{ fontSize: 14, lineHeight: 1.6 }}>
          {phase === 'loading' && <div className="text-muted">{tr("accessReset.loading")}</div>}
          {(phase === 'confirm' || phase === 'working') && (
            <p style={{ margin: 0 }} data-testid="access-reset-confirm-text">{tr("accessReset.confirm", { name })}</p>
          )}
          {(phase === 'blocked' || phase === 'error') && (
            <div className={phase === 'error' ? 'alert alert-danger' : 'alert alert-info'} data-testid="access-reset-reason">{tr(resetReasonKey(reason))}</div>
          )}
          {result && (<>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <code data-testid="access-reset-password" style={{ fontSize: 17, letterSpacing: 1, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2, rgba(127,127,127,.12))', wordBreak: 'break-all', flex: '1 1 200px' }}>
                {reveal ? password : maskPassword(password)}
              </code>
              <button type="button" className="btn btn-sm" onClick={() => setReveal(v => !v)}>{reveal ? tr("accessReset.hide") : tr("accessReset.show")}</button>
            </div>
            <button type="button" className="btn btn-primary" style={{ width: '100%', marginTop: 12, minHeight: 44, justifyContent: 'center' }} onClick={copy} data-testid="access-reset-copy">
              {copied === 'ok' ? tr("accessReset.copied") : tr("accessReset.copy")}
            </button>
            {copied === 'failed' && <div className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>{tr("accessReset.copyFailed")}</div>}
            <div className="alert alert-warn" style={{ marginTop: 12, fontSize: 13 }}>{tr("accessReset.onceHint")}</div>
            {warning && <div className="alert alert-info" style={{ marginTop: 8, fontSize: 12.5 }}>{tr("accessReset.finishUnconfirmed")}</div>}
          </>)}
        </div>
        <div className="modal-footer">
          {(phase === 'confirm' || phase === 'working') && (<>
            <button className="btn" onClick={close} disabled={phase === 'working'}>{tr("accessReset.cancel")}</button>
            <button className="btn btn-danger" onClick={confirm} disabled={phase === 'working'} data-testid="access-reset-submit">
              {phase === 'working' ? tr("accessReset.working") : tr("accessReset.submit")}
            </button>
          </>)}
          {(phase === 'blocked' || phase === 'error' || phase === 'loading') && <button className="btn" onClick={close}>{tr("accessReset.close")}</button>}
          {result && <button className="btn" onClick={close} data-testid="access-reset-done">{tr("accessReset.done")}</button>}
        </div>
      </div>
    </div>
  )
}
