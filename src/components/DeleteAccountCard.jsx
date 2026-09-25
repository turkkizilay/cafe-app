import { t as tr, getIntlLocale, localizeMessage, message as appMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import PasswordInput from './UI/PasswordInput'

/**
 * „Konto löschen" — Pflicht für App Store / Google Play und Recht nach Art. 17 DSGVO.
 *
 * Gelöscht werden: Login, Profil, Profilbild, eine noch nicht abgeschlossene Registrierung.
 * Erhalten bleiben (gesetzliche Aufbewahrungspflicht, Art. 17 Abs. 3 lit. b DSGVO):
 * Arbeitszeiten, Lohn, Urlaub, Krankmeldungen und Personalunterlagen.
 * Die eigentliche Löschung passiert serverseitig in delete_own_account().
 *
 * @param {'employee'|'onboarding'} variant  onboarding = Registrierung noch nicht abgeschlossen
 */
export default function DeleteAccountCard({ email, variant = 'employee', compact = false }) {
  useLocale()
  const [open,    setOpen]    = useState(false)
  const [pw,      setPw]      = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState('')
  const [done,    setDone]    = useState(false)

  const ready = pw.length > 0 && confirm.trim().toUpperCase() === 'LÖSCHEN'

  async function handleDelete() {
    if (busy || !ready) return
    setBusy(true); setError('')
    try {
      // 1. Passwort bestätigen — niemand soll an einem offen liegenden Handy fremde Konten löschen
      const { data: { user } } = await supabase.auth.getUser()
      const loginEmail = user?.email || email
      const { error: authErr } = await supabase.auth.signInWithPassword({ email: loginEmail, password: pw })
      if (authErr) { setError(appMessage("ui.c59f8ebe79e2")); return }
      // 2. Serverseitig löschen
      const { data, error: rpcErr } = await supabase.rpc('delete_own_account')
      if (rpcErr || !data?.success) { setError((data?.error || appMessage("ui.2cee519efa46"))); return }
      setDone(true)
      // 3. Abmelden & lokale Reste entfernen
      try { sessionStorage.removeItem('cafe_session_active'); localStorage.removeItem('cafe_no_remember') } catch { /* egal */ }
      setTimeout(async () => { await supabase.auth.signOut(); window.location.href = '/' }, 2500)
    } catch {
      setError(appMessage("ui.2853bd7844a9"))
    } finally {
      setBusy(false)
    }
  }

  if (done) return (
    <div className="card"><div className="card-body" style={{ textAlign:'center', padding:24 }}>
      <div style={{ fontSize:36, marginBottom:8 }}>👋</div>
      <div style={{ fontWeight:600, marginBottom:6 }}>{tr("ui.b7bfa1c75f9e")}</div>
      <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.646d0f44e449")}</div>
    </div></div>
  )

  if (!open) return compact ? (
    <button type="button" onClick={() => setOpen(true)}
      style={{ background:'none', border:'none', color:'var(--text-muted)', fontSize:12, textDecoration:'underline', cursor:'pointer', padding:4 }}>
      {variant === 'onboarding' ? tr("ui.2b1f920fd133") : tr("ui.205096fdbbc3")}
    </button>
  ) : (
    <div className="card">
      <div className="card-header"><div className="card-title">{tr("ui.065088cc786f")}</div></div>
      <div className="card-body" style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6 }}>{tr("ui.9994f2e57833")}<div style={{ marginTop:10 }}>
          <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>{tr("ui.8c13cf072b45")}</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="card" style={{ borderColor:'var(--danger)' }}>
      <div className="card-header"><div className="card-title" style={{ color:'var(--danger)' }}>{tr("ui.930e55f15e8b")}</div></div>
      <div className="card-body" style={{ fontSize:13, lineHeight:1.6 }}>
        <div style={{ marginBottom:10 }}>
          <strong>{tr("ui.c004f799d759")}</strong>{tr("ui.9c4f39a42830")}{email}{tr("ui.aea524331633")}{variant === 'onboarding' ? tr("ui.e78537608e0f") : '.'}
        </div>
        {variant !== 'onboarding' && (
          <div style={{ marginBottom:10, color:'var(--text-secondary)' }}>
            <strong style={{ color:'var(--text-primary)' }}>{tr("ui.ee03145fcd14")}</strong>{tr("ui.55824f9960d4")}</div>
        )}
        <div style={{ marginBottom:12, color:'var(--text-secondary)' }}>{tr("ui.fc2ae59db771")}</div>

        <div className="form-group">
          <label>{tr("ui.17afcc2323f5")}</label>
          <PasswordInput value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="form-group">
          <label>{tr("ui.a6ed1701369e")}<strong>LÖSCHEN</strong>{tr("ui.aa36cbc03075")}</label>
          <input value={confirm} onChange={e => setConfirm(e.target.value)} autoCapitalize="characters" autoComplete="off" />
        </div>
        {error && <div role="alert" className="alert alert-danger" style={{ fontSize:13 }}>{localizeMessage(error)}</div>}
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <button type="button" className="btn" onClick={() => { setOpen(false); setPw(''); setConfirm(''); setError('') }} disabled={busy}>{tr("ui.f7ff1178af20")}</button>
          <button type="button" className="btn btn-danger" onClick={handleDelete} disabled={!ready || busy}>
            {busy ? tr("ui.2efa15362ea7") : tr("ui.80fa44b2f089")}
          </button>
        </div>
      </div>
    </div>
  )
}
