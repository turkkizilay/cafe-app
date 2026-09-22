import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import PasswordInput from '../components/UI/PasswordInput'

// ── Passwort-Stärke ──────────────────────────────────────────
function checkPw(pw) {
  return {
    length:    pw.length >= 8,
    uppercase: /[A-Z]/.test(pw),
    number:    /[0-9]/.test(pw),
    special:   /[^A-Za-z0-9]/.test(pw),
    score:     [pw.length>=8, /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length,
  }
}
const STRENGTH_COLOR = ['', '#DC2626', '#D97706', '#16A34A', '#16A34A']
const STRENGTH_LABEL = ['', 'Schwach', 'Mittel',  'Gut',    'Stark']

export default function InvitationAccept({ token }) {
  const [step,     setStep]     = useState('loading') // loading | valid | password | success | error
  const [info,     setInfo]     = useState(null)
  const [pw,       setPw]       = useState('')
  const [pw2,      setPw2]      = useState('')
  const [errMsg,   setErrMsg]   = useState('')
  const [saving,   setSaving]   = useState(false)

  useEffect(() => {
    if (!token) { setStep('error'); setErrMsg('Kein Einladungstoken gefunden.'); return }
    validateToken()
  }, [token])

  async function validateToken() {
    const { data, error } = await supabase.rpc('get_invitation_info', { p_token: token })
    if (error || !data) { setStep('error'); setErrMsg('Verbindungsfehler. Bitte nochmal versuchen.'); return }
    if (!data.valid) { setStep('error'); setErrMsg(data.error); return }
    setInfo(data)
    setStep('password')
  }

  async function handleAccept(e) {
    e.preventDefault()
    if (loading) return
    setErrMsg('')
    const strength = checkPw(pw)
    if (!strength.length || !strength.uppercase || !strength.number) {
      setErrMsg('Passwort zu schwach. Bitte Großbuchstabe + Zahl verwenden (mind. 8 Zeichen).')
      return
    }
    if (pw !== pw2) { setErrMsg('Passwörter stimmen nicht überein.'); return }

    setSaving(true)

    // 1. Supabase Auth Account erstellen
    const { data: authData, error: signUpErr } = await supabase.auth.signUp({
      email: info.email,
      password: pw,
      options: { emailRedirectTo: window.location.origin }
    })

    if (signUpErr) {
      setSaving(false)
      if (signUpErr.message.toLowerCase().includes('already registered')) {
        setErrMsg('Diese E-Mail ist bereits registriert. Bitte direkt anmelden.')
      } else {
        setErrMsg('Fehler beim Erstellen: ' + signUpErr.message)
      }
      return
    }

    // 2. Einladung annehmen & Profil verknüpfen
    const { data: acceptData, error: acceptErr } = await supabase.rpc('accept_invitation', { p_token: token })

    if (acceptErr || !acceptData?.success) {
      setSaving(false)
      setErrMsg('Account erstellt, aber Verknüpfung fehlgeschlagen. Bitte Administrator kontaktieren.')
      return
    }

    // 3. Erfolg
    setStep('success')
    setSaving(false)
    // Kurz warten, dann App neu laden → direkt eingeloggt
    setTimeout(() => { window.location.href = '/' }, 2500)
  }

  const strength = checkPw(pw)

  // ── Layout ───────────────────────────────────────────────
  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'linear-gradient(135deg, #1C1917 0%, #292524 100%)',
      padding:20,
    }}>
      <div style={{
        background:'#FAFAF9', borderRadius:20, padding:'40px 36px',
        maxWidth:420, width:'100%', boxShadow:'0 32px 64px rgba(0,0,0,0.4)',
      }}>
        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ fontSize:48, marginBottom:8 }}>☕</div>
          <div style={{ fontSize:20, fontWeight:700, color:'#1C1917' }}>Café Buur</div>
          <div style={{ fontSize:13, color:'#78716C' }}>Frankfurt · Personalverwaltung</div>
        </div>

        {/* ── Laden ── */}
        {step === 'loading' && (
          <div style={{ textAlign:'center', color:'#78716C', padding:'20px 0' }}>
            <div style={{ fontSize:32, marginBottom:12 }}>⏳</div>
            Einladung wird geprüft…
          </div>
        )}

        {/* ── Fehler ── */}
        {step === 'error' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:40, marginBottom:12 }}>❌</div>
            <div style={{ fontWeight:600, fontSize:16, marginBottom:8, color:'#1C1917' }}>Einladung ungültig</div>
            <div style={{ color:'#DC2626', fontSize:13, marginBottom:20, lineHeight:1.6 }}>{errMsg}</div>
            <a href="/" style={{ display:'inline-block', padding:'9px 20px', background:'#C2793A', color:'#fff', borderRadius:8, textDecoration:'none', fontSize:13, fontWeight:600 }}>
              → Zur Anmeldung
            </a>
          </div>
        )}

        {/* ── Passwort setzen ── */}
        {step === 'password' && info && (
          <>
            {/* Willkommen-Box */}
            <div style={{
              background:'linear-gradient(135deg, #C2793A, #9A5E2D)',
              borderRadius:12, padding:'16px 18px', marginBottom:24, color:'#fff',
            }}>
              <div style={{ fontSize:12, opacity:0.85, marginBottom:4 }}>Du wurdest eingeladen als</div>
              <div style={{ fontSize:18, fontWeight:700 }}>{info.employee_name}</div>
              {info.position && <div style={{ fontSize:13, opacity:0.9 }}>{info.position}</div>}
            </div>

            {errMsg && (
              <div style={{ background:'#FEE2E2', color:'#DC2626', borderRadius:8, padding:'10px 14px', fontSize:13, marginBottom:16, lineHeight:1.5 }}>
                {errMsg}
              </div>
            )}

            <form onSubmit={handleAccept}>
              {/* E-Mail (read-only) */}
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#78716C', display:'block', marginBottom:4 }}>
                  E-Mail (festgelegt vom Administrator)
                </label>
                <input
                  type="email" value={info.email} readOnly
                  style={{ width:'100%', padding:'10px 12px', border:'1px solid #E7E4DF', borderRadius:8, background:'#F5F5F4', color:'#78716C', fontSize:13, boxSizing:'border-box' }}
                />
              </div>

              {/* Passwort */}
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#44403C', display:'block', marginBottom:4 }}>
                  Passwort wählen
                </label>
                <PasswordInput
                  value={pw} onChange={e => setPw(e.target.value)}
                  autoComplete="new-password" required
                  style={{ padding:'10px 12px', border:'1px solid #E7E4DF', borderRadius:8, fontSize:13 }}
                />
                {pw && (
                  <div style={{ marginTop:8 }}>
                    <div style={{ display:'flex', gap:3, marginBottom:4 }}>
                      {[1,2,3,4].map(i => (
                        <div key={i} style={{ flex:1, height:3, borderRadius:2, background: strength.score >= i ? STRENGTH_COLOR[strength.score] : '#E7E4DF' }} />
                      ))}
                    </div>
                    <div style={{ fontSize:11, color: STRENGTH_COLOR[strength.score], fontWeight:500, marginBottom:4 }}>
                      {STRENGTH_LABEL[strength.score]}
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 12px' }}>
                      {[
                        { ok: strength.length,    label: 'Min. 8 Zeichen' },
                        { ok: strength.uppercase, label: 'Großbuchstabe' },
                        { ok: strength.number,    label: 'Zahl' },
                        { ok: strength.special,   label: 'Sonderzeichen (empfohlen)' },
                      ].map(({ ok, label }) => (
                        <span key={label} style={{ fontSize:11, color: ok ? '#16A34A' : '#A8A29E' }}>
                          {ok ? '✓' : '○'} {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Passwort bestätigen */}
              <div style={{ marginBottom:22 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#44403C', display:'block', marginBottom:4 }}>
                  Passwort bestätigen
                </label>
                  <PasswordInput
                  value={pw2} onChange={e => setPw2(e.target.value)}
                  autoComplete="new-password" required
                  style={{ padding:'10px 12px', fontSize:13, border: `1px solid ${pw2 && pw !== pw2 ? '#DC2626' : '#E7E4DF'}`, borderRadius:8 }}
                />
                {pw2 && pw === pw2 && <div style={{ fontSize:11, color:'#16A34A', marginTop:4 }}>✓ Passwörter stimmen überein</div>}
                {pw2 && pw !== pw2 && <div style={{ fontSize:11, color:'#DC2626', marginTop:4 }}>✗ Passwörter stimmen nicht überein</div>}
              </div>

              <button
                type="submit"
                disabled={saving || pw !== pw2 || !pw2}
                style={{
                  width:'100%', padding:'12px', border:'none', borderRadius:10,
                  background: saving ? '#A8A29E' : '#C2793A', color:'#fff',
                  fontSize:15, fontWeight:700, cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                {saving ? '⏳ Account wird erstellt…' : '🚀 Account erstellen & einloggen'}
              </button>
            </form>
          </>
        )}

        {/* ── Erfolg ── */}
        {step === 'success' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:52, marginBottom:14 }}>🎉</div>
            <div style={{ fontWeight:700, fontSize:18, marginBottom:8, color:'#1C1917' }}>
              Willkommen im Team, {info?.employee_name?.split(' ')[0]}!
            </div>
            <div style={{ color:'#78716C', fontSize:13, lineHeight:1.7, marginBottom:16 }}>
              Dein Account ist fertig. Du wirst jetzt zur App weitergeleitet…
            </div>
            <div style={{ display:'flex', justifyContent:'center' }}>
              <div style={{ width:40, height:40, border:'3px solid #C2793A', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
      `}</style>
    </div>
  )
}
