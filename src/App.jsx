import { useState, useEffect, useCallback, Component } from 'react'
import { useAutoLogout } from './hooks/useAutoLogout'
import { logActivity } from './lib/activityLog'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { ProfileContext } from './context/ProfileContext'
import { DarkModeProvider } from './context/DarkModeContext'
import { ToastProvider } from './components/UI/Toast'
import Login from './components/Auth/Login'
import Sidebar from './components/Layout/Sidebar'
import Dashboard from './pages/Dashboard'
import Employees from './pages/Employees'
import ClockIn from './pages/ClockIn'
import Shifts from './pages/Shifts'
import Vacation from './pages/Vacation'
import Payroll from './pages/Payroll'
import Settings from './pages/Settings'
import LightspeedOAuthCallback from './pages/LightspeedOAuthCallback'
import UserManagement from './pages/UserManagement'
import TimeManagement from './pages/TimeManagement'
import PayrollDocuments from './pages/PayrollDocuments'
import MyHours from './pages/MyHours'
import AbsenceCalendar from './pages/AbsenceCalendar'
import Account        from './pages/Account'
import InvitationAccept from './pages/InvitationAccept'
import ResetPassword    from './pages/ResetPassword'
import AccessDenied    from './pages/AccessDenied'
import ActivityLog     from './pages/ActivityLog'

// ── Passwort-Reset-Link erkennen ──────────────────────────────
const RECOVERY_LINK_DETECTED =
  typeof window !== 'undefined' && window.location.hash.includes('type=recovery')

// ── Auth-Fehler aus URL-Hash abfangen (#error=...) ───────────
function AuthErrorScreen() {
  const hash   = window.location.hash
  const params = new URLSearchParams(hash.replace('#', ''))
  const code   = params.get('error_code') || params.get('error')
  const desc   = params.get('error_description')?.replace(/\+/g, ' ') || 'Unbekannter Fehler'

  const MSG = {
    otp_expired:   { icon:'⏱', title:'Link abgelaufen', text:'Der Bestätigungslink ist abgelaufen. Bitte logge dich erneut ein — ein neuer Link wird bei Bedarf verschickt.' },
    access_denied: { icon:'🔒', title:'Zugriff verweigert', text: desc },
  }
  const m = MSG[code] || { icon:'❌', title:'Fehler beim Einloggen', text: desc }

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  return (
    <DarkModeProvider>
      <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#1C1917' }}>
        <div style={{ background:'#fff', borderRadius:14, padding:'40px 36px', maxWidth:440, textAlign:'center', boxShadow:'0 20px 40px rgba(0,0,0,0.3)' }}>
          <div style={{ fontSize:44, marginBottom:14 }}>{m.icon}</div>
          <h2 style={{ fontSize:20, fontWeight:600, marginBottom:10 }}>{m.title}</h2>
          <p style={{ color:'#78716C', fontSize:14, lineHeight:1.7, marginBottom:24 }}>{m.text}</p>
          <button className="btn btn-primary" onClick={() => { window.location.href = '/' }}>
            Zurück zum Login
          </button>
        </div>
      </div>
    </DarkModeProvider>
  )
}

function PendingScreen({ session, onRetry }) {
  const [retrying, setRetrying] = useState(false)

  async function handleRetry() {
    setRetrying(true)
    await onRetry()
    setRetrying(false)
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#1C1917' }}>
      <div style={{ background:'#fff', borderRadius:14, padding:'40px 36px', maxWidth:440, textAlign:'center', boxShadow:'0 20px 40px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize:44, marginBottom:14 }}>☕</div>
        <h2 style={{ fontSize:20, fontWeight:600, marginBottom:10 }}>Account wartet auf Freigabe</h2>
        <p style={{ color:'#78716C', fontSize:14, lineHeight:1.7, marginBottom:8 }}>
          Dein Account <strong>{session?.user?.email}</strong> wurde erstellt und wartet auf die Genehmigung der Geschäftsführung des Café Buur.
        </p>
        <p style={{ color:'#A8A29E', fontSize:12, marginBottom:24 }}>
          Bitte wende dich an den Chef. Sobald dein Account freigeschaltet ist, klicke auf "Neu laden".
        </p>
        <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
          <button onClick={handleRetry} disabled={retrying}
            style={{ padding:'9px 20px', border:'none', borderRadius:8, background:'#C2793A', color:'#fff', cursor:'pointer', fontSize:14, fontWeight:600 }}>
            {retrying ? '...' : '🔄 Neu laden'}
          </button>
          <button onClick={() => { supabase.auth.signOut(); sessionStorage.removeItem('cafe_session_active'); localStorage.removeItem('cafe_no_remember') }}
            style={{ padding:'9px 20px', border:'1px solid #E7E4DF', borderRadius:8, background:'none', cursor:'pointer', fontSize:14, color:'#78716C' }}>
            Abmelden
          </button>
        </div>
      </div>
    </div>
  )
}

function ErrorScreen({ error, onRetry }) {
  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#1C1917' }}>
      <div style={{ background:'#fff', borderRadius:14, padding:'40px 36px', maxWidth:420, textAlign:'center' }}>
        <div style={{ fontSize:36, marginBottom:12 }}>⚠️</div>
        <h2 style={{ fontSize:18, fontWeight:600, marginBottom:8 }}>Verbindungsfehler</h2>
        <p style={{ color:'#78716C', fontSize:13, marginBottom:20 }}>{error}</p>
        <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
          <button onClick={onRetry} style={{ padding:'9px 20px', border:'none', borderRadius:8, background:'#C2793A', color:'#fff', cursor:'pointer', fontSize:14, fontWeight:600 }}>
            🔄 Erneut versuchen
          </button>
          <button onClick={() => { supabase.auth.signOut(); sessionStorage.removeItem('cafe_session_active'); localStorage.removeItem('cafe_no_remember') }} style={{ padding:'9px 20px', border:'1px solid #E7E4DF', borderRadius:8, background:'none', cursor:'pointer', fontSize:14, color:'#78716C' }}>
            Abmelden
          </button>
        </div>
      </div>
    </div>
  )
}

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{ padding:40, textAlign:'center', fontFamily:'system-ui' }}>
        <div style={{ fontSize:40, marginBottom:16 }}>⚠️</div>
        <h2 style={{ fontSize:18, marginBottom:8 }}>Etwas ist schiefgelaufen</h2>
        <p style={{ color:'#666', marginBottom:20, fontSize:14 }}>{this.state.error.message}</p>
        <button onClick={() => { this.setState({error:null}); window.location.reload() }}
          style={{ padding:'10px 24px', background:'#C2793A', color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>
          🔄 Seite neu laden
        </button>
      </div>
    )
    return this.props.children
  }
}

export default function App() {
  const [session,     setSession]     = useState(null)
  const [profile,     setProfile]     = useState(null)
  const [pending,     setPending]     = useState(0)
  const [vacPending,  setVacPending]  = useState(0)
  const [sickPending, setSickPending] = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [fetchErr,    setFetchErr]    = useState(null)
  const [recoveryDone,setRecoveryDone]= useState(false)
  const [recoveryEvent,setRecoveryEvent] = useState(false)

  const handleAutoLogout = useCallback(async (reason) => {
    try {
      await logActivity({
        action: 'auth.auto_logout', category: 'auth',
        summary: 'wurde nach Inaktivität automatisch abgemeldet.',
      })
    } catch { /* Logging darf Logout nie blockieren */ }
    await supabase.auth.signOut()
    sessionStorage.removeItem('cafe_session_active')
    localStorage.removeItem('cafe_no_remember')
    setSession(null)
    setProfile(null)
    if (reason === 'timeout') {
      sessionStorage.setItem('cafe_timeout_logout', '1')
    }
  }, [])

  const { showWarning, countdown, extendSession, performLogout } =
    useAutoLogout(session, handleAutoLogout)

  const fetchProfile = useCallback(async (uid) => {
    setLoading(true)
    setFetchErr(null)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', uid)
        .maybeSingle()

      if (error) {
        console.error('Profile fetch error:', error)
        setFetchErr('Profil konnte nicht geladen werden: ' + error.message)
        setProfile(null)
        setLoading(false)
        return
      }

      setProfile(data || null)

      if (data?.role === 'admin' || data?.role === 'manager') {
        const [{ count: pCount }, { count: vCount }] = await Promise.all([
          supabase.from('profiles').select('*', { count:'exact', head:true }).eq('status','pending'),
          supabase.from('vacation_requests').select('*', { count:'exact', head:true }).eq('status','pending'),
        ])
        const { count: sCount } = await supabase
          .from('sick_leave').select('*', { count:'exact', head:true }).is('end_date', null)
        setPending(pCount  || 0)
        setVacPending(vCount || 0)
        setSickPending(sCount || 0)
      }
    } catch (err) {
      setFetchErr('Netzwerkfehler: ' + err.message)
      setProfile(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    const noRemember    = localStorage.getItem('cafe_no_remember') === '1'
    const sessionActive = sessionStorage.getItem('cafe_session_active') === '1'
    if (noRemember && !sessionActive) {
      supabase.auth.signOut()
      localStorage.removeItem('cafe_no_remember')
    }
  }, [])

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        supabase.auth.getSession().then(({ data }) => {
          if (!data.session) {
            setSession(null)
            setProfile(null)
            setLoading(false)
          }
        })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryEvent(true)
      }
      if (session) {
        fetchProfile(session.user.id)
      } else {
        setProfile(null)
        setPending(0)
        setLoading(false)
      }
    })
    return () => subscription.unsubscribe()
  }, [fetchProfile])

  if (window.location.hash.includes('error=')) {
    return <AuthErrorScreen />
  }

  if ((RECOVERY_LINK_DETECTED || recoveryEvent) && !recoveryDone) {
    return <ResetPassword onDone={() => setRecoveryDone(true)} />
  }

  const inviteToken = new URLSearchParams(window.location.search).get('invite')
  if (inviteToken) return (
    <DarkModeProvider>
      <ToastProvider>
        <InvitationAccept token={inviteToken} />
      </ToastProvider>
    </DarkModeProvider>
  )

  if (loading && !profile) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'#1C1917', color:'#fff', fontSize:18, gap:10 }}>
      ☕ Café Buur wird geladen…
    </div>
  )

  if (!session) return (
    <DarkModeProvider>
      <ToastProvider>
        <Login />
      </ToastProvider>
    </DarkModeProvider>
  )

  if (fetchErr) return (
    <DarkModeProvider>
      <ErrorScreen error={fetchErr} onRetry={() => fetchProfile(session.user.id)} />
    </DarkModeProvider>
  )

  if (profile?.status === 'disabled') return (
    <DarkModeProvider>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100vh', gap:16, padding:32, textAlign:'center', background:'var(--bg)' }}>
        <div style={{ fontSize:48 }}>🔒</div>
        <h2 style={{ fontSize:20, fontWeight:700, margin:0 }}>Account deaktiviert</h2>
        <p style={{ fontSize:14, color:'var(--text-secondary)', maxWidth:360, margin:0 }}>Dein Account wurde deaktiviert. Bitte wende dich an deinen Administrator.</p>
        <button className="btn" onClick={() => { supabase.auth.signOut(); sessionStorage.removeItem('cafe_session_active'); localStorage.removeItem('cafe_no_remember') }}>Abmelden</button>
      </div>
    </DarkModeProvider>
  )

  if (!profile || profile.status === 'pending') return (
    <DarkModeProvider>
      <PendingScreen session={session} onRetry={() => fetchProfile(session.user.id)} />
    </DarkModeProvider>
  )

  const isAdmin   = profile.role === 'admin'
  const isManager = profile.role === 'manager' || isAdmin
  const ctx = {
    profile, isAdmin, isManager,
    pendingCount:    pending,
    vacPendingCount: vacPending  || 0,
    sickPendingCount:sickPending || 0,
    refetch: () => fetchProfile(session.user.id),
    profileFirstName: profile?.first_name || '',
    profileLastName:  profile?.last_name  || '',
  }

  return (
    <ErrorBoundary>
    <DarkModeProvider>
      <ProfileContext.Provider value={ctx}>
        <ToastProvider>
          <BrowserRouter>
            <div className="app-shell">
              <Sidebar session={session} isAdmin={isAdmin} isManager={isManager} pendingCount={pending} />
              <div className="main">

                {(() => {
                  if (sessionStorage.getItem('cafe_timeout_logout') === '1') {
                    sessionStorage.removeItem('cafe_timeout_logout')
                    setTimeout(() => {
                      const t = document.createElement('div')
                      t.textContent = '🔒 Du wurdest aus Sicherheitsgründen automatisch abgemeldet.'
                      t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 20px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.3)'
                      document.body.appendChild(t)
                      setTimeout(() => t.remove(), 5000)
                    }, 500)
                  }
                  return null
                })()}

                <Routes>
                  <Route path="/"              element={<Dashboard />} />
                  <Route path="/einclocken"    element={<ClockIn session={session} />} />
                  <Route path="/schichten"     element={<Shifts />} />
                  <Route path="/urlaub"        element={<Vacation />} />
                  <Route path="/stunden"       element={<MyHours />} />
                  <Route path="/dokumente"     element={<PayrollDocuments />} />
                  <Route path="/konto"         element={<Account />} />
                  <Route path="/abwesenheit" element={isManager ? <AbsenceCalendar /> : <AccessDenied />} />
                  <Route path="/mitarbeiter"     element={isManager ? <Employees />      : <AccessDenied />} />
                  <Route path="/lohn"            element={isManager ? <Payroll />        : <AccessDenied />} />
                  <Route path="/zeitkorrekturen" element={isAdmin   ? <TimeManagement /> : <AccessDenied />} />
                  <Route path="/benutzer"        element={isAdmin   ? <UserManagement /> : <AccessDenied />} />
                  <Route path="/protokoll"       element={isAdmin   ? <ActivityLog />    : <AccessDenied />} />
                  <Route path="/einstellungen"   element={isAdmin   ? <Settings />       : <AccessDenied />} />
                  <Route path="/einstellungen/integrationen/lightspeed/callback" element={isAdmin ? <LightspeedOAuthCallback /> : <AccessDenied />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </div>
            </div>

            {showWarning && (
              <div style={{
                position:'fixed', inset:0, background:'rgba(0,0,0,0.55)',
                display:'flex', alignItems:'center', justifyContent:'center',
                zIndex:9998, padding:16,
              }}>
                <div style={{
                  background:'var(--card)', borderRadius:16, padding:'32px 28px',
                  maxWidth:420, width:'100%', textAlign:'center',
                  boxShadow:'0 20px 60px rgba(0,0,0,0.4)',
                  border:'1px solid var(--border)',
                }}>
                  <div style={{ fontSize:44, marginBottom:12 }}>🔒</div>
                  <h2 style={{ fontSize:19, fontWeight:700, marginBottom:10, color:'var(--text-primary)' }}>
                    Sitzung läuft bald ab
                  </h2>
                  <p style={{ color:'var(--text-secondary)', fontSize:14, lineHeight:1.65, marginBottom:20 }}>
                    Du warst längere Zeit inaktiv. Aus Sicherheitsgründen wirst du automatisch abgemeldet.
                  </p>
                  <div style={{
                    fontSize:28, fontWeight:700, marginBottom:24,
                    color: countdown <= 30 ? 'var(--danger)' : 'var(--warn)',
                    fontVariantNumeric:'tabular-nums',
                  }}>
                    {String(Math.floor(countdown / 60)).padStart(2,'0')}:{String(countdown % 60).padStart(2,'0')}
                  </div>
                  <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
                    <button className="btn btn-primary" style={{ minWidth:160 }} onClick={extendSession}>
                      ✓ Angemeldet bleiben
                    </button>
                    <button className="btn" style={{ minWidth:140, color:'var(--danger)', border:'1px solid var(--danger)' }} onClick={() => performLogout('manual')}>
                      Jetzt abmelden
                    </button>
                  </div>
                </div>
              </div>
            )}

          </BrowserRouter>
        </ToastProvider>
      </ProfileContext.Provider>
    </DarkModeProvider>
    </ErrorBoundary>
  )
}
