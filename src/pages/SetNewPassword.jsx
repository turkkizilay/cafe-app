import { useRef, useState } from 'react'
import { t as tr, message as appMessage, localizeMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { supabase } from '../lib/supabase'
import { DarkModeProvider } from '../context/DarkModeContext'
import PasswordInput from '../components/UI/PasswordInput'
import { BrandBadge } from '../components/UI/Brand'
import { completePasswordChange, changeReasonKey, passwordPolicyProblem } from '../lib/accessReset'

// Pflichtseite nach einem Admin-Reset (Migration 38). Gesperrt ist serverseitig (Pre-Request + Storage-Policy);
// diese Seite ist nur die Oberfläche dazu. Erfolg erst, wenn Auth UND Server bestätigt haben – sonst bleibt die
// Pflicht bestehen und „Erneut versuchen“ ist jederzeit möglich (auch nach Neuladen oder Neuanmeldung).
export default function SetNewPassword({ onDone, onSignOut }) {
  useLocale()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const busyRef = useRef(false)

  async function submit(e) {
    e.preventDefault()
    if (busyRef.current) return
    setError('')
    const problem = passwordPolicyProblem(pw)
    if (problem) { setError(appMessage(changeReasonKey(problem))); return }
    if (pw !== pw2) { setError(appMessage("pwChange.mismatch")); return }
    busyRef.current = true; setSaving(true)
    const r = await completePasswordChange(supabase, pw)
    busyRef.current = false; setSaving(false)
    if (r.ok) { setPw(''); setPw2(''); onDone(); return }
    if (r.reason === 'unauthenticated') { onSignOut(); return }
    if (r.reason === 'not_required') { onDone(); return }
    setError(appMessage(changeReasonKey(r.reason)))
  }

  return (
    <DarkModeProvider>
      <div className="login-page">
        <div className="login-card" style={{ maxWidth: 420 }} data-testid="set-new-password">
          <BrandBadge size={56} style={{ margin: '0 auto 12px' }} />
          <h2 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 6px', textAlign: 'center' }}>{tr("pwChange.title")}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, textAlign: 'center', margin: '0 0 18px', lineHeight: 1.6 }}>{tr("pwChange.intro")}</p>
          {error && <div className="alert alert-danger" style={{ marginBottom: 14, fontSize: 13 }} role="alert">{localizeMessage(error)}</div>}
          <form onSubmit={submit} noValidate>
            <div className="form-group">
              <label htmlFor="new-pw">{tr("pwChange.new")}</label>
              <PasswordInput id="new-pw" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" required disabled={saving} />
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>{tr("pwChange.rule")}</div>
            </div>
            <div className="form-group">
              <label htmlFor="new-pw2">{tr("pwChange.repeat")}</label>
              <PasswordInput id="new-pw2" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" required disabled={saving} />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', minHeight: 44, marginTop: 6 }} disabled={saving}>
              {saving ? tr("pwChange.saving") : tr("pwChange.submit")}
            </button>
          </form>
          <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} onClick={onSignOut} disabled={saving}>{tr("pwChange.signOut")}</button>
        </div>
      </div>
    </DarkModeProvider>
  )
}
