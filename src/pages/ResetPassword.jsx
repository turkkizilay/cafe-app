import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { logActivity } from '../lib/activityLog'
import { DarkModeProvider } from '../context/DarkModeContext'
import PasswordInput from '../components/UI/PasswordInput'

function checkPw(pw) {
  return {
    score: [pw.length >= 8, /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length,
  }
}
const STRENGTH_COLOR = ['', '#DC2626', '#D97706', '#16A34A', '#16A34A']
const STRENGTH_LABEL = ['', 'Schwach', 'Mittel', 'Gut', 'Stark']

/**
 * Wird angezeigt, wenn der Nutzer über einen "Passwort vergessen"-Link
 * ankommt (URL enthält #...type=recovery...). Supabase hat zu diesem
 * Zeitpunkt bereits automatisch eine gültige Session aus dem Link erstellt —
 * hier wird NUR das neue Passwort abgefragt (kein aktuelles Passwort nötig).
 */
export default function ResetPassword({ onDone }) {
  const [pwNew,     setPwNew]     = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const { score } = checkPw(pwNew)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (score < 3) { setError('Passwort zu schwach — mind. 8 Zeichen, Großbuchstabe und Zahl'); return }
    if (pwNew !== pwConfirm) { setError('Passwörter stimmen nicht überein'); return }

    setSaving(true)
    const { error: updateErr } = await supabase.auth.updateUser({ password: pwNew })
    if (updateErr) {
      setError(updateErr.message)
      setSaving(false)
      return
    }
    try {
      await logActivity({ action: 'auth.password_reset', category: 'auth', summary: 'hat das Passwort per Reset-Link zurückgesetzt.' })
    } catch { /* Logging darf Flow nie blockieren */ }

    // Recovery-Hash aus der URL entfernen, damit ein Reload nicht wieder hier landet
    window.history.replaceState(null, '', window.location.pathname)
    setSaving(false)
    onDone()
  }

  return (
    <DarkModeProvider>
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1C1917', padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: 14, padding: '40px 36px', maxWidth: 420, width: '100%', boxShadow: '0 20px 40px rgba(0,0,0,0.3)' }}>
          <div style={{ fontSize: 40, textAlign: 'center', marginBottom: 12 }}>🔐</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>Neues Passwort festlegen</h2>
          <p style={{ color: '#78716C', fontSize: 13, textAlign: 'center', marginBottom: 24, lineHeight: 1.6 }}>
            Bitte lege ein neues Passwort für dein Café-Buur-Konto fest.
          </p>

          {error && <div className="alert alert-danger" style={{ marginBottom: 14, fontSize: 13 }}>{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Neues Passwort</label>
              <PasswordInput value={pwNew} onChange={e => setPwNew(e.target.value)}
                autoComplete="new-password" required disabled={saving} autoFocus />
              {pwNew && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: score >= i ? STRENGTH_COLOR[score] : '#E7E4DF' }} />
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: STRENGTH_COLOR[score] }}>{STRENGTH_LABEL[score]}</div>
                </div>
              )}
            </div>
            <div className="form-group">
              <label>Neues Passwort bestätigen</label>
              <PasswordInput value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
                autoComplete="new-password" required disabled={saving}
                style={{ borderColor: pwConfirm && pwNew !== pwConfirm ? '#DC2626' : undefined }} />
              {pwConfirm && pwNew === pwConfirm && <div style={{ fontSize: 11, color: '#16A34A', marginTop: 4 }}>✓ Passwörter stimmen überein</div>}
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
              disabled={saving || (!!pwConfirm && pwNew !== pwConfirm)}>
              {saving ? '⏳…' : '🔐 Passwort speichern & einloggen'}
            </button>
          </form>
        </div>
      </div>
    </DarkModeProvider>
  )
}
