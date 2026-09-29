import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { BrandBadge, BrandWordmark } from '../components/UI/Brand'
import { supabase } from '../lib/supabase'
import PasswordInput from '../components/UI/PasswordInput'
import { boundedRequest } from '../lib/boundedRequest'
import { classifySignup, ONB_TIMEOUT } from '../lib/onboardingFlow'

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
const STRENGTH_LABEL = () => ['', tr("ui.e5ded9770387"), tr("ui.6604277e642c"),  tr("ui.7a26d266bf0c"),    tr("ui.0857c7a77ba1")]

export default function InvitationAccept({ token }) {
  useLocale()
  const [step,     setStep]     = useState('loading') // loading | password | confirm | success | error
  const [info,     setInfo]     = useState(null)
  const [pw,       setPw]       = useState('')
  const [pw2,      setPw2]      = useState('')
  const [errMsg,   setErrMsg]   = useState('')
  const [reason,   setReason]   = useState('')
  const [saving,   setSaving]   = useState(false)
  const [hasSession, setHasSession] = useState(false)
  const busy = useRef(false)   // Doppelklick-Sperre, greift sofort

  useEffect(() => {
    if (!token) { setStep('error'); setErrMsg(appMessage("ui.2cd1bcf73cfd")); return }
    validateToken()
  }, [token])

  // Einladungsstatus vom Server (mit Obergrenze – ohne Antwort endet das Laden trotzdem)
  const fetchInfo = () => boundedRequest(s => supabase.rpc('get_invitation_info', { p_token: token }).abortSignal(s), { ms: ONB_TIMEOUT.read })

  async function showInvalid(data) {
    // Bereits verwendet: mit bestehender Sitzung direkt weiter zur App, sonst zur Anmeldung
    if (data.reason === 'used') {
      try { const { data: s } = await supabase.auth.getSession(); setHasSession(!!s?.session) } catch { setHasSession(false) }
    }
    setReason(data.reason || '')
    setErrMsg(data.error)
    setStep('error')
  }

  async function validateToken() {
    setStep('loading'); setErrMsg(''); setReason('')
    const r = await fetchInfo()
    if (r.status === 0 || r.error || !r.data) {
      setStep('error'); setReason('offline')
      setErrMsg(appMessage(r.status === 0 ? 'invite.checkUnavailable' : "ui.26dda1d2b2e4"))
      return
    }
    if (!r.data.valid) { await showInvalid(r.data); return }
    setInfo(r.data)
    setStep('password')
  }

  async function handleAccept(e) {
    e.preventDefault()
    if (busy.current) return
    setErrMsg('')
    const strength = checkPw(pw)
    if (!strength.length || !strength.uppercase || !strength.number) {
      setErrMsg(appMessage("ui.b6ea3d16f133"))
      return
    }
    if (pw !== pw2) { setErrMsg(appMessage("ui.89780fc834cd")); return }

    busy.current = true
    setSaving(true)
    try {
      // Einladung direkt vor dem Anlegen erneut prüfen – sie kann seit dem Öffnen abgelaufen/zurückgezogen sein
      const pre = await fetchInfo()
      if (pre.status === 0) { setErrMsg(appMessage('invite.checkUnavailable')); return }
      if (!pre.error && pre.data && !pre.data.valid) { await showInvalid(pre.data); return }

      // Account erstellen. Der Einladungs-Token geht als Metadaten mit — die Datenbank prüft ihn beim Anlegen
      // (Token gültig + E-Mail passt) und löst die Einladung in derselben Transaktion ein; ist sie nicht (mehr)
      // gültig, wird gar kein Konto angelegt (Migration 28). Klappt auch mit E-Mail-Bestätigung (dann ohne Session).
      const res = await boundedRequest(() => supabase.auth.signUp({
        email: info.email,
        password: pw,
        options: {
          emailRedirectTo: window.location.origin,
          data: { invite_token: token },
        },
      }), { ms: ONB_TIMEOUT.write })
      const outcome = classifySignup(res)

      if (outcome === 'session') {
        // Keine Bestätigung nötig → direkt in die App (dort startet das Onboarding). replace: „Zurück“ führt nicht
        // wieder auf den eingelösten Link.
        setStep('success')
        setTimeout(() => { window.location.replace('/') }, 2000)
        return
      }
      if (outcome === 'confirm') { setStep('confirm'); return }
      // Supabase meldet bei bereits registrierten Adressen (mit E-Mail-Bestätigung) keinen Fehler, sondern einen User ohne Identitäten.
      if (outcome === 'exists') { setErrMsg(appMessage("ui.09b8e7bf3dfe")); return }
      if (outcome === 'password') { setErrMsg(appMessage("ui.8be6b2ef10b3")); return }
      if (outcome === 'rate') { setErrMsg(appMessage("ui.09fab1faf3d6")); return }

      // Keine Antwort / abgelehnt: Konto anlegen und Einladung einlösen sind EINE Transaktion → der Einladungsstatus
      // zeigt eindeutig, was passiert ist (Teil-Erfolg wird nicht als Fehler gemeldet)
      const post = await fetchInfo()
      if (post.status === 0 || post.error || !post.data) { setErrMsg(appMessage('invite.unclear')); return }
      if (post.data.valid) { setErrMsg(appMessage(outcome === 'noAnswer' ? 'invite.notCreatedRetry' : "ui.93e80a63886d")); return }
      if (post.data.reason === 'used') { setStep('confirm'); return }   // Konto wurde angelegt (nur diese Adresse kann einlösen)
      await showInvalid(post.data)
    } finally {
      busy.current = false
      setSaving(false)
    }
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
          <BrandBadge size={72} style={{ margin:'0 auto 10px' }} />
          <BrandWordmark variant="dark" height={26} style={{ margin:'0 auto 4px' }} />
          <div style={{ fontSize:13, color:'#78716C' }}>{tr("ui.cdaae3cbbe06")}</div>
        </div>

        {/* ── Laden ── */}
        {step === 'loading' && (
          <div style={{ textAlign:'center', color:'#78716C', padding:'20px 0' }}>
            <div style={{ fontSize:32, marginBottom:12 }}>⏳</div>{tr("ui.fc448f6f9942")}</div>
        )}

        {/* ── Fehler ── */}
        {step === 'error' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:40, marginBottom:12 }}>
              {{ revoked:'🚫', expired:'⏱️', used:'✅', offline:'📡' }[reason] || '❌'}
            </div>
            <div style={{ fontWeight:600, fontSize:16, marginBottom:8, color:'#1C1917' }}>
              {{ revoked:tr("ui.211fc9e997fa"), expired:tr("ui.3151da7884f4"), used:tr("ui.d06f7ddecd71"), offline:tr('invite.offlineTitle') }[reason] || tr("ui.c115c98fb3cb")}
            </div>
            <div style={{ color: reason === 'used' ? '#57534E' : '#DC2626', fontSize:13, marginBottom:20, lineHeight:1.6 }}>{localizeMessage(errMsg)}</div>
            {reason === 'used' && !hasSession && <div style={{ color:'#78716C', fontSize:12.5, marginBottom:16, lineHeight:1.6 }}>{tr('invite.usedHint')}</div>}
            {reason === 'offline'
              ? <button type="button" onClick={validateToken} style={{ padding:'9px 20px', background:'#C2793A', color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer' }}>{tr("ui.7df1d235ed7f")}</button>
              : <a href="/" style={{ display:'inline-block', padding:'9px 20px', background:'#C2793A', color:'#fff', borderRadius:8, textDecoration:'none', fontSize:13, fontWeight:600 }}>{reason === 'used' && hasSession ? tr('invite.toApp') : tr("ui.04b6b188d904")}</a>}
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
              {info.new_employee ? (
                <>
                  <div style={{ fontSize:18, fontWeight:700, marginBottom:4 }}>{tr("ui.3b1fd1cdeb3f")}</div>
                  <div style={{ fontSize:13, opacity:0.92, lineHeight:1.55 }}>{tr("ui.1fa0211728e3")}</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize:12, opacity:0.85, marginBottom:4 }}>{tr("ui.a88eb0213285")}</div>
                  <div style={{ fontSize:18, fontWeight:700 }}>{info.employee_name}</div>
                  {info.position && <div style={{ fontSize:13, opacity:0.9 }}>{info.position}</div>}
                </>
              )}
            </div>

            {errMsg && (
              <div style={{ background:'#FEE2E2', color:'#DC2626', borderRadius:8, padding:'10px 14px', fontSize:13, marginBottom:16, lineHeight:1.5 }}>
                {localizeMessage(errMsg)}
              </div>
            )}

            <form onSubmit={handleAccept}>
              {/* E-Mail (read-only) */}
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#78716C', display:'block', marginBottom:4 }}>{tr("ui.92a6983575d9")}</label>
                <input
                  type="email" value={info.email} readOnly
                  style={{ width:'100%', padding:'10px 12px', border:'1px solid #E7E4DF', borderRadius:8, background:'#F5F5F4', color:'#78716C', fontSize:13, boxSizing:'border-box' }}
                />
              </div>

              {/* Passwort */}
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#44403C', display:'block', marginBottom:4 }}>{tr("ui.048f6d828c6b")}</label>
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
                      {STRENGTH_LABEL()[strength.score]}
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 12px' }}>
                      {[
                        { ok: strength.length,    label: tr("ui.3ca3e11a74c1") },
                        { ok: strength.uppercase, label: tr("ui.901ce87b84c6") },
                        { ok: strength.number,    label: tr("ui.654eb4c0a380") },
                        { ok: strength.special,   label: tr("ui.16ef4bb34777") },
                      ].map(({ ok, label }, labelIndex) => (
                        <span key={labelIndex} style={{ fontSize:11, color: ok ? '#16A34A' : '#A8A29E' }}>
                          {ok ? '✓' : '○'} {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Passwort bestätigen */}
              <div style={{ marginBottom:22 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#44403C', display:'block', marginBottom:4 }}>{tr("ui.7d338266c180")}</label>
                  <PasswordInput
                  value={pw2} onChange={e => setPw2(e.target.value)}
                  autoComplete="new-password" required
                  style={{ padding:'10px 12px', fontSize:13, border: `1px solid ${pw2 && pw !== pw2 ? '#DC2626' : '#E7E4DF'}`, borderRadius:8 }}
                />
                {pw2 && pw === pw2 && <div style={{ fontSize:11, color:'#16A34A', marginTop:4 }}>{tr("ui.71c5b9984138")}</div>}
                {pw2 && pw !== pw2 && <div style={{ fontSize:11, color:'#DC2626', marginTop:4 }}>{tr("ui.ba3bac23575f")}</div>}
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
                {saving ? tr("ui.778a86cdfefb") : tr("ui.ed764c373948")}
              </button>
            </form>
          </>
        )}

        {/* ── E-Mail bestätigen ── */}
        {step === 'confirm' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:48, marginBottom:12 }}>📬</div>
            <div style={{ fontWeight:700, fontSize:18, marginBottom:8, color:'#1C1917' }}>{tr("ui.6e69cfe3744d")}</div>
            <div style={{ color:'#57534E', fontSize:14, lineHeight:1.7, marginBottom:12 }}>{tr("ui.7423dace533e")}<strong>{info?.email}</strong>{tr("ui.ad502e9a8db4")}</div>
            <div style={{ color:'#78716C', fontSize:13, lineHeight:1.7, marginBottom:20 }}>{tr("ui.d9d88969b18a")}{info?.new_employee ? tr("ui.17f686c1c5d7") : '.'}
              <br />{tr("ui.4be26730c4dd")}</div>
            <div style={{ marginBottom:16 }}>
              <button type="button" disabled={saving} onClick={async () => {
                  if (saving) return
                  setSaving(true)
                  const r = await boundedRequest(() => supabase.auth.resend({ type:'signup', email: info.email, options:{ emailRedirectTo: window.location.origin } }), { ms: ONB_TIMEOUT.write })
                  setSaving(false)
                  setErrMsg(r.error || r.status === 0 ? (appMessage("ui.a8989ce113bb")) : (appMessage("ui.7464c81a4d07")))
                }}
                style={{ background:'none', border:'1px solid #E7E4DF', borderRadius:8, padding:'8px 14px', fontSize:13, cursor:'pointer', color:'#44403C' }}>
                {saving ? tr("ui.754ed3f63a88") : tr("ui.1c5bb531381f")}
              </button>
              {errMsg && <div style={{ fontSize:12.5, color: localizeMessage(errMsg).startsWith('✓') ? '#16A34A' : '#DC2626', marginTop:8 }}>{localizeMessage(errMsg)}</div>}
            </div>
            <a href="/" style={{ display:'inline-block', padding:'10px 22px', background:'#C2793A', color:'#fff', borderRadius:8, textDecoration:'none', fontSize:14, fontWeight:600 }}>{tr("ui.04b6b188d904")}</a>
          </div>
        )}

        {/* ── Erfolg ── */}
        {step === 'success' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:52, marginBottom:14 }}>🎉</div>
            <div style={{ fontWeight:700, fontSize:18, marginBottom:8, color:'#1C1917' }}>
              {info?.employee_name ? tr("ui.6ebeb7d4ad21", { p1: (info.employee_name.split(' ')[0]) }) : tr("ui.3b1fd1cdeb3f")}
            </div>
            <div style={{ color:'#78716C', fontSize:13, lineHeight:1.7, marginBottom:16 }}>
              {info?.new_employee ? tr("ui.a73a04d46ad2") : tr("ui.60789bb88a97")}
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
