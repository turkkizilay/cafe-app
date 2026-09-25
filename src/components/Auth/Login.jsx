import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../../i18n/runtime.js'
import { useLocale } from '../../context/LocaleContext.jsx'
import { useState, useMemo, useEffect, useRef } from 'react'
import { BrandBadge, BrandWordmark } from '../UI/Brand'
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
const STRENGTH_LABEL = () => ['', tr("ui.e5ded9770387"), tr("ui.6604277e642c"), tr("ui.7a26d266bf0c"), tr("ui.0857c7a77ba1")]

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function translateError(msg = '') {
  const m = msg.toLowerCase()
  if (m.includes('invalid login credentials'))    return appMessage("ui.528708713f77")
  if (m.includes('email not confirmed'))          return appMessage("ui.7848027ee8dc")
  if (m.includes('email rate limit exceeded'))    return appMessage("ui.a762af5d35d8")
  if (m.includes('user already registered'))      return appMessage("ui.87230c6ca327")
  if (m.includes('already been registered'))      return appMessage("ui.87230c6ca327")
  if (m.includes('password should be at least'))  return appMessage("ui.e57e73cb1ff6")
  if (m.includes('too many requests'))            return appMessage("ui.35bd89251439")
  if (m.includes('signup is disabled'))           return appMessage("ui.4a588c162c39")
  return appMessage("ui.653f008b3b98")
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
  useLocale()
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
        {STRENGTH_LABEL()[score]}
      </div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 12px' }}>
        {[
          { ok: checks.length,    label: tr("ui.54337aef3205", { p1: (password.length) }) },
          { ok: checks.uppercase, label: tr("ui.901ce87b84c6") },
          { ok: checks.number,    label: tr("ui.654eb4c0a380") },
          { ok: checks.special,   label: tr("ui.16ef4bb34777") },
        ].map(({ ok, label }, labelIndex) => (
          <span key={labelIndex} style={{ fontSize:11, color: ok ? '#16A34A' : 'var(--text-muted)', transition:'color 0.2s' }}>
            {ok ? '✓' : '○'} {label}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function Login() {
  useLocale()
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
  const [unconfirmed, setUnconfirmed] = useState('')   // E-Mail, deren Bestätigung noch fehlt
  const [resending,   setResending]   = useState(false)
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
      setErrorWithShake(appMessage("ui.d0787e7210a3"))
      emailRef.current?.focus(); return
    }
    if (!isValidEmail(email)) {
      setErrorWithShake(appMessage("ui.8846e1250e08"))
      emailRef.current?.focus(); return
    }
    if (!password) {
      setErrorWithShake(appMessage("ui.1416725ed5f7"))
      passwordRef.current?.querySelector('input')?.focus(); return
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(), password,
    })
    if (error) {
      setPassword('')
      const notConfirmed = (error.message || '').toLowerCase().includes('email not confirmed')
      setUnconfirmed(notConfirmed ? email.trim().toLowerCase() : '')
      setErrorWithShake(translateError(error.message))
    } else {
      setUnconfirmed('')
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
    if (!firstName.trim())     { setErrorWithShake(appMessage("ui.b8a90f690438")); return }
    if (!lastName.trim())      { setErrorWithShake(appMessage("ui.754d169a0d5a")); return }
    if (!isValidEmail(email))  { setErrorWithShake(appMessage("ui.8846e1250e08")); return }
    const { valid } = checkPasswordStrength(password)
    if (!valid) { setPassword(''); setPassword2(''); setErrorWithShake(appMessage("ui.95ea5bf4a359")); return }
    if (password !== password2) { setPassword2(''); setErrorWithShake(appMessage("ui.0b96cfcc88e1")); return }

    const emailCheck = await emailIsRegistered(email)
    if (emailCheck?.exists) {
      setPassword(''); setPassword2('')
      if (emailCheck.reason === 'employee') {
        setErrorWithShake(appMessage("ui.44f83dfbf62b"))
      } else {
        setErrorWithShake(appMessage("ui.0b23911039f7"))
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
        setErrorWithShake(appMessage("ui.0c8a06b7c865"))
        switchMode('login')
      } else {
        setErrorWithShake(translateError(error.message))
      }
      return
    }
    if (!data?.user?.identities?.length) {
      setErrorWithShake(appMessage("ui.0c8a06b7c865"))
      switchMode('login'); return
    }
    setMode('pending')
  }

  // ── Passwort vergessen ───────────────────────────────────────────────
  async function handleForgot() {
    if (!email.trim()) { setErrorWithShake(appMessage("ui.d0787e7210a3")); return }
    if (!isValidEmail(email)) { setErrorWithShake(appMessage("ui.8846e1250e08")); return }
    const { error } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(), { redirectTo: window.location.origin }
    )
    if (error) setErrorWithShake(translateError(error.message))
    else setInfo(appMessage("ui.6df68349dfc7"))
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
          <BrandBadge size={64} style={{ margin:'0 auto 12px' }} />
          <h2 style={{ fontSize:18, fontWeight:700, marginBottom:10 }}>{tr("ui.341811675742")}{firstName}!</h2>
          <p style={{ color:'var(--text-secondary)', fontSize:14, lineHeight:1.7, marginBottom:8 }}>{tr("ui.1bcc30ebe6f1")}</p>
          <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'14px 16px', marginBottom:20, textAlign:'left' }}>
            <div style={{ fontSize:13, fontWeight:600, marginBottom:6, color:'var(--accent-text)' }}>{tr("ui.91f9dc15e1d9")}</div>
            <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.8 }}>{tr("ui.20d52051ad96")}<br/>{tr("ui.93447e129491")}<br/>{tr("ui.c59c4c1ded83")}</div>
          </div>
          <button
            onClick={() => supabase.auth.signOut().then(() => switchMode('login'))}
            style={{ padding:'10px 24px', border:'1px solid var(--border)', borderRadius:8, background:'none', cursor:'pointer', fontSize:13, color:'var(--text-secondary)' }}
          >{tr("ui.24e1219492b4")}</button>
        </div>
      </div>
    )
  }

  const BTN = {
    login:  loading ? tr("ui.5d25e65bf44b") : tr("ui.a329a32263a4"),
    signup: loading ? tr("ui.79b5baee2b17") : tr("ui.a862634ebf36"),
    forgot: loading ? tr("ui.8a64d4768e1a") : tr("ui.ebe030931182"),
  }

  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth:400 }}>
        {/* Logo */}
        <div className="login-logo">
          <BrandBadge size={76} style={{ margin:'0 auto 12px' }} />
          <BrandWordmark height={30} style={{ margin:'0 auto' }} />
          <div className="login-logo-sub" style={{ marginTop:8 }}>{tr("ui.cdaae3cbbe06")}</div>
        </div>

        {/* Mode-Überschrift */}
        <h2 style={{ fontSize:14, fontWeight:600, textAlign:'center', marginBottom:16, color:'var(--text-secondary)' }}>
          {mode === 'login'  ? tr("ui.a329a32263a4") : ''}
          {mode === 'signup' ? tr("ui.cbe0ee2b1c75") : ''}
          {mode === 'forgot' ? tr("ui.6c616ac63f2a")   : ''}
        </h2>

        {/* Fehlermeldung mit Animation */}
        {error && (
          <div
            key={localizeMessage(error)}
            className="alert alert-danger login-error-animate"
            role="alert"
            aria-live="polite"
            style={{ marginBottom:14, fontSize:13 }}
          >
            {localizeMessage(error)}
            {unconfirmed && (
              <div style={{ marginTop:8 }}>
                <button type="button" className="btn btn-sm" disabled={resending}
                  onClick={async () => {
                    if (resending) return
                    setResending(true)
                    const { error: rErr } = await supabase.auth.resend({
                      type: 'signup', email: unconfirmed, options: { emailRedirectTo: window.location.origin },
                    })
                    setResending(false)
                    setError('')
                    if (rErr) setErrorWithShake(appMessage("ui.b6dc066c0381"))
                    else { setUnconfirmed(''); setInfo(appMessage("ui.3af076295354")) }
                  }}>
                  {resending ? tr("ui.754ed3f63a88") : tr("ui.6af6edbc1012")}
                </button>
              </div>
            )}
          </div>
        )}
        {info && (
          <div className="alert alert-success login-error-animate" style={{ marginBottom:14, fontSize:13 }}>
            {localizeMessage(info)}
          </div>
        )}

        <form onSubmit={handleSubmit} autoComplete="on" noValidate>

          {/* Name — nur Registrierung */}
          {mode === 'signup' && (
            <div className="two-col" style={{ gap:10 }}>
              <div className="form-group">
                <label htmlFor="signup-first">{tr("ui.d2d77b6ffa70")}</label>
                <input id="signup-first" type="text" value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  placeholder={tr("ui.a1a5936d3b0f")} autoComplete="given-name" required disabled={loading} />
              </div>
              <div className="form-group">
                <label htmlFor="signup-last">{tr("ui.b25358edd497")}</label>
                <input id="signup-last" type="text" value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  placeholder={tr("ui.c9ff763e960d")} autoComplete="family-name" required disabled={loading} />
              </div>
            </div>
          )}

          {/* E-Mail */}
          <div className="form-group">
            <label htmlFor="login-email">{tr("ui.c2f9765ad5ce")}</label>
            <input
              id="login-email" ref={emailRef}
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              onBlur={e => setEmail(e.target.value.trim().toLowerCase())}
              placeholder={tr("ui.3757dcfb2130")}
              autoComplete="email" autoFocus={mode === 'login'} required disabled={loading}
            />
          </div>

          {/* Passwort */}
          {mode !== 'forgot' && (
            <div className="form-group">
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                <label htmlFor="login-password" style={{ margin:0 }}>{tr("ui.a36c101570cc")}</label>
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
                  >{tr("ui.78ef93e2ec17")}</button>
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
              <label htmlFor="login-password2">{tr("ui.7d338266c180")}</label>
              <PasswordInput
                id="login-password2"
                value={password2}
                onChange={e => setPassword2(e.target.value)}
                autoComplete="new-password" required disabled={loading}
                style={{ borderColor: password2 && password !== password2 ? 'var(--danger)' : undefined }}
              />
              {password2 && password !== password2 && (
                <div style={{ fontSize:11, color:'var(--danger)', marginTop:4 }}>{tr("ui.ba3bac23575f")}</div>
              )}
              {password2 && password === password2 && (
                <div style={{ fontSize:11, color:'#16A34A', marginTop:4 }}>{tr("ui.71c5b9984138")}</div>
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
              <span style={{ color:'var(--text-secondary)' }}>{tr("ui.2d1ae386210b")}</span>
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
            <p style={{ fontSize:12, color:'var(--text-muted)', margin:0, lineHeight:1.6 }}>{tr("ui.4ae343ff9c2b")}<br />{tr("ui.4f972e0e18b7")}</p>
          )}
          {mode === 'signup' && (
            <span style={{ fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.4723a80e7564")}{' '}
              <button onClick={() => switchMode('login')} style={{ background:'none', border:'none', color:'var(--accent)', cursor:'pointer', fontSize:13, fontWeight:600 }}>{tr("ui.a329a32263a4")}</button>
            </span>
          )}
          {mode === 'forgot' && (
            <button onClick={() => switchMode('login')} style={{ background:'none', border:'none', color:'var(--accent)', cursor:'pointer', fontSize:13 }}>{tr("ui.afce3f3cb9de")}</button>
          )}
        </div>
      </div>
    </div>
  )
}
