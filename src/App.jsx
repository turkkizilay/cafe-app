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
    <div style={{ minHeight:'100vh',
