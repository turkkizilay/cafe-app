import { useState, useMemo, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import PasswordInput from '../UI/PasswordInput'
import { logActivity } from '../../lib/activityLog'

// ── Passwort-Stärke ───────────────────────────────────────────────────────
function checkPasswordStrength(pw) {
  const checks = {
    length:    pw.length >= 8,
    uppercase: /[A-Z]/.test(pw),
    number:    /[0-9]/.test(pw),
    special:   /[^A-Za-z0-9]/.test(pw),
  }
  const score = Object.values(checks).filter(Boolean).length
  return { checks, score, valid: checks.length && checks.uppercase && checks.number }
}
const STRENGTH_COLOR = ['', '#DC2626', '#D97706', '#16A34A', '#16A34A']
const STRENGTH_LABEL = ['', 'Schwach', 'Mittel', 'Gut', 'Stark']

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function translateError(msg = '') {
  const m = msg.toLowerCase()
  if (m.includes('invalid login credentials'))    return 'Die eingegebenen Zugangsdaten sind nicht korrekt.'
  if (m.includes('email not confirmed'))          return 'E-Mail noch nicht bestätigt. Bitte Postfach prüfen.'
  if (m.includes('email rate limit exceeded'))    return 'Zu viele Versuche. Bitte kurze Zeit warten.'
  if (m.includes('user already registered'))      return 'Diese E-Mail ist bereits registriert. Bitte anmelden.'
  if (m.includes('already been registered'))      return 'Diese E-Mail ist bereits registriert. Bitte anmelden.'
  if (m.includes('password should be at least'))  return 'Passwort muss mindestens 8 Zeichen lang sein.'
  if (m.includes('too many requests'))            return 'Zu viele Anfragen. Bitte kurz warten.'
  if (m.includes('signup is disabled'))           return 'Registrierung deaktiviert. Bitte Administrator kontaktieren.'
  return 'Ein Fehler ist aufgetreten. Bitte erneut versuchen.'
}

async function emailIsRegistered(email) {
  try {
    const { data } = await supabase.rpc('check_email_registered', {
      p_email: email.trim().toLowerCase()
    })
    return !!data
  } catch { return null }
}

function PasswordStrengthBar({ password }) {
  const { checks, score } = useMemo(() => checkPasswordStrength(password), [password])
  if (!password) return null
  return (
    <div style={{ marginTop:8 }}>
      <div style={{ display:'flex', gap:3, marginBottom:4 }}>
        {[1,2,3,4].map(i => (
          <div key={i} style={{
            flex:1, height:3, borderRadius:2,
            background: score >= i ? STRENGTH_COLOR[score] : 'var(--border)',
            transition:'background 0.3s ease',
          }} />
        ))}
      </div>
      <div style={{ fontSize:11, color: STRENGTH_COLOR[score], fontWeight:500, marginBottom:4 }}>
        {STRENGTH_LABEL[score]}
      </div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 12px' }}>
        {[
          { ok: checks.length,    label: `Min. 8 Zeichen (${password.length})` },
          { ok: checks.uppercase, label: 'Großbuchstabe' },
          { ok: checks.number,    label: 'Zahl' },
          { ok: checks.special,   label: 'Sonderzeichen (empfohlen)' },
        ].map(({ ok, label }) => (
          <span key={label} style={{ fontSize:11, color: ok ? '#16A34A' : 'var(--text-muted)', transition:'color 0.2s' }}>
            {ok ? '✓' : '○'} {label}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function Login() {
  const [mode,       setMode]       = useState('login')
  const [firstName,  setFirstName]  = useState('')
  const [lastName,   setLastName]   = useState('')
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [password2,  setPassword2]  = useState('')
  const [loading,    setLoading]    = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [error,      setError]      = useState('')
  const [info,       setInfo]       = useState('')
  const emailRef    = useRef(null)
  const passwordRef = useRef(null)

  // Autofill-Farbe korrigieren (Browser-spezifisch)
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `
      input:-webkit-autofill,
      input:-webkit-autofill:hover,
      input:-webkit-autofill:focus {
        -webkit-box-shadow: 0 0 0 1000px var(--bg-input, #fff) inset !important;
        -webkit-text-fill-color: var(--text-primary) !important;
        transition: background-color 9999s ease-in-out 0s;
        caret-color: var(--text-primary);
      }
      @keyframes login-shake {
        0%, 100% { transform: translateX(0); }
        20%       { transform: translateX(-6px); }
        40%       { transform: translateX(6px); }
        60%       { transform: translateX(-4px); }
        80%       { transform: translateX(4px); }
      }
      @keyframes login-fadein {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .login-error-animate { animation: login-fadein 0.22s ease; }
      .login-shake         { animation: login-shake 0.35s ease; }
    `
    document.head.appendChild(style)
    return () => document.head.removeChild(style)
  }, [])

  function switchMode(m) {
    setMode(m); setError(''); setInfo('')
    setPassword(''); setPassword2('')
    setFirstName(''); setLastName('')
  }

  function setErrorWithShake(msg) {
    setError('')
    setTimeout(() => setError(msg), 10)  // force re-render für Animation
  }

  // ── Login ─────────────────────────────────────────────────────────────
  async function handleLogin() {
    if (!email.trim()) {
      setErrorWithShake('Bitte gib deine E-Mail-Adresse ein.')
      emailRef.current?.focus(); return
    }
    if (!isValidEmail(email)) {
      setErrorWithShake('Bitte gib eine gültige E-Mail-Adresse ein.')
      emailRef.current?.focus(); return
    }
    if (!password) {
      setErrorWithShake('Bitte gib dein Passwort ein.')
      passwordRef.current?.querySelector('input')?.focus(); return
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(), password,
    })
    if (error) {
      setPassword('')
      setErrorWithShake(translateError(error.message))
    } else {
      sessionStorage.setItem('cafe_session_active', '1')
      if (rememberMe) {
        localStorage.removeItem('cafe_no_remember')
      } else {
        localStorage.setItem('cafe_no_remember', '1')
      }
      // Protokoll — actor_name/role setzt die Serverfunktion aus dem Profil
      logActivity({ action: 'auth.login', category: 'auth', summary: 'hat sich angemeldet.' })
    }
  }

  // ── Registrierung ─────────────────────────────────────────────────────
  async function handleSignup() {
    if (!firstName.trim())     { setErrorWithShake('Bitte gib deinen Vornamen ein.'); return }
    if (!lastName.trim())      { setErrorWithShake('Bitte gib deinen Nachnamen ein.'); return }
    if (!isValidEmail(email))  { setErrorWithShake('Bitte gib eine gültige E-Mail-Adresse ein.'); return }
    const { valid } = checkPasswordStrength(password)
    if (!valid) { setPassword(''); setPassword2(''); setErrorWithShake('Passwort zu schwach. Min. 8 Zeichen, Großbuchstabe und Zahl.'); return }
    if (password !== password2) { setPassword2(''); setErrorWithShake('Die Passwörter stimmen nicht überein.'); return }

    const emailCheck = await emailIsRegistered(email)
    if (emailCheck?.exists) {
      setPassword(''); setPassword2('')
      if (emailCheck.reason === 'employee') {
        setErrorWithShake('Diese E-Mail ist bereits einem Mitarbeiter zugewiesen. Bitte nutze deinen Einladungslink oder wende dich an den Administrator.')
      } else {
        setErrorWithShake('Diese E-Mail ist bereits registriert.')
        switchMode('login')
      }
      return
    }

    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(), password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { first_name: firstName.trim(), last_name: lastName.trim() }
      }
    })
    setPassword(''); setPassword2('')

    if (error) {
      if (error.message.toLowerCase().includes('already') || error.status === 422) {
        setErrorWithShake('Diese E-Mail ist bereits registriert. Bitte melde dich an.')
        switchMode('login')
      } else {
        setErrorWithShake(translateError(error.message))
      }
      return
    }
    if (!data?.user?.identities?.length) {
      setErrorWithShake('Diese E-Mail ist bereits registriert. Bitte melde dich an.')
      switchMode('login'); return
    }
    setMode('pending')
  }

  // ── Passwort vergessen ───────────────────────────────────────────────
  async function handleForgot() {
    if (!email.trim()) { setErrorWithShake('Bitte gib deine E-Mail-Adresse ein.'); return }
    if (!isValidEmail(email)) { setErrorWithShake('Bitte gib eine gültige E-Mail-Adresse ein.'); return }
    const { error } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(), { redirectTo: window.location.origin }
    )
    if (error) setErrorWithShake(translateError(error.message))
    else setInfo('📧 Sofern diese E-Mail registriert ist, erhältst du einen Reset-Link. Bitte auch den Spam-Ordner prüfen.')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setInfo('')
    setLoading(true)
    try {
      if (mode === 'login')  await handleLogin()
      if (mode === 'signup') await handleSignup()
      if (mode === 'forgot') await handleForgot()
    } finally {
      setLoading(false)
    }
  }

  // ── Registrierung erfolgt ────────────────────────────────────────────
  if (mode === 'pending') {
    return (
      <div className="login-page">
        <div className="login-card" style={{ maxWidth:400, textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:12 }}>☕</div>
          <h2 style={{ fontSize:18, fontWeight:700, marginBottom:10 }}>Willkommen, {firstName}!</h2>
          <p style={{ color:'var(--text-secondary)', fontSize:14, lineHeight:1.7, marginBottom:8 }}>
            Dein Account wurde erfolgreich erstellt.
          </p>
          <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'14px 16px', marginBottom:20, textAlign:'left' }}>
            <div style={{ fontSize:13, fontWeight:600, marginBottom:6, color:'var(--accent-text)' }}>Was passiert als nächstes?</div>
            <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.8 }}>
              📋 Das Management wurde informiert.<br/>
              ✅ Sobald dein Account freigegeben ist, kannst du dich einloggen.<br/>
              💬 Bei Fragen bitte direkt beim Management melden.
            </div>
          </div>
          <button
            onClick={() => supabase.auth.signOut().then(() => switchMode('login'))}
            style={{ padding:'10px 24px', border:'1px solid var(--border)', borderRadius:8, background:'none', cursor:'pointer', fontSize:13, color:'var(--text-secondary)' }}
          >
            Zurück zur Anmeldung
          </button>
        </div>
      </div>
    )
  }

  const BTN = {
    login:  loading ? 'Anmeldung läuft…' : 'Anmelden',
    signup: loading ? 'Account wird erstellt…' : 'Account erstellen',
    forgot: loading ? 'Link wird gesendet…' : 'Reset-Link senden',
  }

  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth:400 }}>
        {/* Logo */}
        <div className="login-logo">
          <span className="login-logo-icon">☕</span>
          <div className="login-logo-name">Café Buur</div>
          <div className="login-logo-sub">Frankfurt · Personalverwaltung</div>
        </div>

        {/* Mode-Überschrift */}
        <h2 style={{ fontSize:14, fontWeight:600, textAlign:'center', marginBottom:16, color:'var(--text-secondary)' }}>
          {mode === 'login'  ? 'Anmelden' : ''}
          {mode === 'signup' ? 'Neuen Account erstellen' : ''}
          {mode === 'forgot' ? 'Passwort zurücksetzen'   : ''}
        </h2>

        {/* Fehlermeldung mit Animation */}
        {error && (
          <div
            key={error}
            className="alert alert-danger login-error-animate"
            role="alert"
            aria-live="polite"
            style={{ marginBottom:14, fontSize:13 }}
          >
            {error}
          </div>
        )}
        {info && (
          <div className="alert alert-success login-error-animate" style={{ marginBottom:14, fontSize:13 }}>
            {info}
          </div>
        )}

        <form onSubmit={handleSubmit} autoComplete="on" noValidate>

          {/* Name — nur Registrierung */}
          {mode === 'signup' && (
            <div className="two-col" style={{ gap:10 }}>
              <div className="form-group">
                <label htmlFor="signup-first">Vorname</label>
                <input id="signup-first" type="text" value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  placeholder="Max" autoComplete="given-name" required disabled={loading} />
              </div>
              <div className="form-group">
                <label htmlFor="signup-last">Nachname</label>
                <input id="signup-last" type="text" value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  placeholder="Mustermann" autoComplete="family-name" required disabled={loading} />
              </div>
            </div>
          )}

          {/* E-Mail */}
          <div className="form-group">
            <label htmlFor="login-email">E-Mail-Adresse</label>
            <input
              id="login-email" ref={emailRef}
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              onBlur={e => setEmail(e.target.value.trim().toLowerCase())}
              placeholder="deine@email.de"
              autoComplete="email" autoFocus={mode === 'login'} required disabled={loading}
            />
          </div>

          {/* Passwort */}
          {mode !== 'forgot' && (
            <div className="form-group">
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                <label htmlFor="login-password" style={{ margin:0 }}>Passwort</label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    style={{
                      background:'none', border:'none', cursor:'pointer',
                      fontSize:12, color:'var(--text-secondary)',
                      padding:'0 2px',
                      transition:'color 0.15s',
                    }}
                    onMouseEnter={e => e.target.style.color = 'var(--accent)'}
                    onMouseLeave={e => e.target.style.color = 'var(--text-secondary)'}
                  >
                    Passwort vergessen?
                  </button>
                )}
              </div>
              <div ref={passwordRef}>
                <PasswordInput
                  id="login-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required disabled={loading}
                />
              </div>
              {mode === 'signup' && <PasswordStrengthBar password={password} />}
            </div>
          )}

          {/* Passwort bestätigen */}
          {mode === 'signup' && (
            <div className="form-group">
              <label htmlFor="login-password2">Passwort bestätigen</label>
              <PasswordInput
                id="login-password2"
                value={password2}
                onChange={e => setPassword2(e.target.value)}
                autoComplete="new-password" required disabled={loading}
                style={{ borderColor: password2 && password !== password2 ? 'var(--danger)' : undefined }}
              />
              {password2 && password !== password2 && (
                <div style={{ fontSize:11, color:'var(--danger)', marginTop:4 }}>✗ Passwörter stimmen nicht überein</div>
              )}
              {password2 && password === password2 && (
                <div style={{ fontSize:11, color:'#16A34A', marginTop:4 }}>✓ Passwörter stimmen überein</div>
              )}
            </div>
          )}

          {/* Angemeldet bleiben */}
          {mode === 'login' && (
            <label style={{ display:'flex', alignItems:'center', gap:10, fontSize:13, cursor:'pointer', userSelect:'none', margin:'10px 0 8px' }}>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                style={{ width:16, height:16, accentColor:'var(--accent)', cursor:'pointer', flexShrink:0 }}
              />
              <span style={{ color:'var(--text-secondary)' }}>Angemeldet bleiben</span>
            </label>
          )}

          {/* Submit-Button */}
          <button
            type="submit"
            className="btn btn-primary"
            style={{
              width:'100%', justifyContent:'center',
              padding:'12px 0', marginTop:4, fontSize:14, fontWeight:600,
              display:'flex', alignItems:'center', gap:8,
              transition:'opacity 0.15s, transform 0.1s',
              opacity: loading ? 0.8 : 1,
            }}
            disabled={loading || (mode === 'signup' && !!password2 && password !== password2)}
          >
            {loading && (
              <span style={{
                width:14, height:14, border:'2px solid rgba(255,255,255,0.4)',
                borderTopColor:'#fff', borderRadius:'50%',
                display:'inline-block', animation:'spin 0.7s linear infinite',
              }} />
            )}
            {BTN[mode]}
          </button>
        </form>

        {/* Spinner-Keyframe */}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

        {/* Navigation */}
        <div style={{ textAlign:'center', marginTop:20, display:'flex', flexDirection:'column', gap:10 }}>
          {mode === 'login' && (
            <p style={{ fontSize:12, color:'var(--text-muted)', margin:0, lineHeight:1.6 }}>
              Zugang benötigt? Bitte wende dich an dein Management.
              <br />
              <button
                onClick={() => switchMode('signup')}
                style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:12, textDecoration:'underline', padding:'2px 0' }}
              >
                Einladungslink erhalten?
              </button>
            </p>
          )}
          {mode === 'signup' && (
            <span style={{ fontSize:13, color:'var(--text-secondary)' }}>
              Bereits registriert?{' '}
              <button onClick={() => switchMode('login')} style={{ background:'none', border:'none', color:'var(--accent)', cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Anmelden
              </button>
            </span>
          )}
          {mode === 'forgot' && (
            <button onClick={() => switchMode('login')} style={{ background:'none', border:'none', color:'var(--accent)', cursor:'pointer', fontSize:13 }}>
              ← Zurück zur Anmeldung
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
