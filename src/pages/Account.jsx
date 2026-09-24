import { useState, useEffect, useRef } from 'react'
import { supabase, formatDate, formatCurrency } from '../lib/supabase'
import DeleteAccountCard from '../components/DeleteAccountCard'
import PersonalDataCard, { missingPersonalFields } from '../components/PersonalDataCard'
import { openSignedFile } from '../lib/openFile'
import { logActivity } from '../lib/activityLog'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { getVacationBalance } from '../lib/vacationLogic'
import Avatar from '../components/UI/Avatar'
import PasswordInput from '../components/UI/PasswordInput'
import ImageCropper from '../components/UI/ImageCropper'

// ── Hilfsfunktionen ─────────────────────────────────────────
function checkPw(pw) {
  return {
    length:    pw.length >= 8,
    uppercase: /[A-Z]/.test(pw),
    number:    /[0-9]/.test(pw),
    score:     [pw.length>=8, /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length,
  }
}
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) }

const STRENGTH_COLOR = ['','#DC2626','#D97706','#16A34A','#16A34A']
const STRENGTH_LABEL = ['','Schwach','Mittel','Gut','Stark']
const EMP_TYPE_LABEL = { vollzeit:'Vollzeit', teilzeit:'Teilzeit', minijob:'Minijob', werkstudent:'Werkstudent' }

// ── Wiederverwendbare Datenfeldanzeige ───────────────────────
function DataField({ label, value, icon }) {
  return (
    <div style={{ background:'var(--bg)', borderRadius:8, padding:'10px 12px' }}>
      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:3 }}>
        {icon && <span style={{ marginRight:4 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize:13, fontWeight:500, color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {value || '—'}
      </div>
    </div>
  )
}

export default function Account() {
  const { profile, refetch } = useProfile()
  const toast   = useToast()
  const fileRef = useRef()

  // ── Tab ─────────────────────────────────────────────────────
  const [accountTab,   setAccountTab]   = useState('profil')

  // ── Dokumente ────────────────────────────────────────────────
  const [myDocs,       setMyDocs]       = useState([])
  const [docsLoading,  setDocsLoading]  = useState(false)
  const [docActionId,  setDocActionId]  = useState(null)

  const DOC_TYPES_ACC = {
    employment_contract: 'Arbeitsvertrag',
    contract_addendum:   'Vertragsnachtrag',
    certificate:         'Bescheinigung',
    agreement:           'Vereinbarung',
    personal_document:   'Personalunterlage',
    other:               'Sonstiges',
  }

  async function fetchMyDocs() {
    if (!profile?.employee_id) return
    setDocsLoading(true)
    const { data } = await supabase.from('employee_documents')
      .select('*').eq('employee_id', profile.employee_id).eq('is_active', true)
      .order('uploaded_at', { ascending: false })
    setMyDocs(data || [])
    setDocsLoading(false)
  }

  async function openMyDoc(doc) {
    if (docActionId) return
    setDocActionId(doc.id + ':open')
    try {
      // Kein await vor openSignedFile — sonst blockiert Safari den neuen Tab
      await openSignedFile(async () => {
        const { data, error } = await supabase.storage
          .from('employee-documents').createSignedUrl(doc.file_path, 120)
        if (error) throw error
        return data.signedUrl
      })
    } catch {
      toast.error('Das Dokument konnte nicht geöffnet werden. Bitte erneut versuchen.')
    } finally { setDocActionId(null) }
  }

  async function downloadMyDoc(doc) {
    if (docActionId) return
    setDocActionId(doc.id + ':dl')
    try {
      const typeName = DOC_TYPES_ACC[doc.document_type] || 'Dokument'
      const d = new Date(doc.uploaded_at); const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const lastName = employee?.last_name?.replace(/\s+/g,'_') || 'Mitarbeiter'
      const filename = `${typeName}_${lastName}_${date}.pdf`
      const { data, error } = await supabase.storage
        .from('employee-documents').createSignedUrl(doc.file_path, 60, { download: filename })
      if (error) { toast.error('Download fehlgeschlagen: ' + error.message); return }
      const a = document.createElement('a'); a.href = data.signedUrl; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    } finally { setDocActionId(null) }
  }

  // ── Daten ──────────────────────────────────────────────────
  const [employee,     setEmployee]     = useState(null)
  const [vacBalance,   setVacBalance]   = useState(null)
  const [allVacs,      setAllVacs]      = useState([])
  const [allSick,      setAllSick]      = useState([])
  const [historyTab,   setHistoryTab]   = useState('urlaub')
  const [loading,      setLoading]      = useState(true)
  const [nextShift,    setNextShift]    = useState(null)

  // ── Profilbild ─────────────────────────────────────────────
  const [avatarUrl,    setAvatarUrl]    = useState(null)
  const [uploading,    setUploading]    = useState(false)
  const [cropSrc,      setCropSrc]      = useState(null)

  // ── Persönliche Daten Bearbeiten ────────────────────────────

  // ── E-Mail ändern ───────────────────────────────────────────
  const [changingEmail, setChangingEmail] = useState(false)
  const [newEmail,      setNewEmail]      = useState('')
  const [emailError,    setEmailError]    = useState('')
  const [emailSaving,   setEmailSaving]   = useState(false)

  // ── Passwort ändern ─────────────────────────────────────────
  const [pwCurrent,    setPwCurrent]    = useState('')
  const [pwNew,        setPwNew]        = useState('')
  const [pwConfirm,    setPwConfirm]    = useState('')
  const [pwSaving,     setPwSaving]     = useState(false)
  const [pwError,      setPwError]      = useState('')
  const [pwSuccess,    setPwSuccess]    = useState('')

  useEffect(() => { if (profile?.employee_id) fetchData() }, [profile?.employee_id])

  async function fetchData() {
    setLoading(true)
    try {
      const yr = new Date().getFullYear()
      const [{ data: emp }, { data: vacs }, { data: sick }, { data: holidays }] = await Promise.all([
        supabase.from('employees').select('*').eq('id', profile.employee_id).maybeSingle(),
        supabase.from('vacation_requests').select('*').eq('employee_id', profile.employee_id).order('created_at', { ascending: false }),
        supabase.from('sick_leave').select('*').eq('employee_id', profile.employee_id).order('start_date', { ascending: false }),
        supabase.from('public_holidays').select('date').eq('bundesland','Hessen').in('year',[yr-1,yr,yr+1]),
      ])
      setEmployee(emp)
      setAllVacs(vacs || [])
      setAllSick(sick || [])
      if (emp) {
        setAvatarUrl(emp.avatar_url || profile?.avatar_url || null)
        setVacBalance(getVacationBalance(emp, vacs||[], sick||[], holidays||[]))
      } else {
        // Kein Employee-Eintrag (z.B. Admin) → avatar aus profiles laden
        setAvatarUrl(profile?.avatar_url || null)
      }
      // Nächste geplante Schicht
      const now2 = new Date(); const today = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}-${String(now2.getDate()).padStart(2,'0')}`
      const { data: upcoming } = await supabase.from('shifts')
        .select('date, start_time, end_time, position')
        .eq('employee_id', profile.employee_id)
        .gte('date', today)
        .order('date').order('start_time')
        .limit(1)
      setNextShift(upcoming?.[0] || null)
    } catch (err) { toast.error('Fehler beim Laden: ' + err.message) }
    setLoading(false)
  }

  // ── Profilbild ──────────────────────────────────────────────
  function handleFileSelected(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { toast.warn('Max. 10 MB'); return }
    setCropSrc(URL.createObjectURL(file))
    e.target.value = ''
  }

  function handleCropDone(dataUrl) {
    // Sofort anzeigen — kein async, kein Guard, kann nicht hängen
    setCropSrc(null)
    setAvatarUrl(dataUrl)
    toast.success('✅ Profilbild aktualisiert!')
    // DB-Speicherung im Hintergrund — fire and forget
    supabase.rpc('update_own_avatar', { new_avatar_url: dataUrl }).then(({ error }) => {
      if (error) {
        supabase.from('profiles').update({ avatar_url: dataUrl }).eq('id', profile.id)
        if (profile?.employee_id) {
          supabase.from('employees').update({ avatar_url: dataUrl }).eq('id', profile.employee_id)
        }
      } else {
        refetch()
      }
    })
  }

  async function removeAvatar() {
    await supabase.rpc('update_own_avatar', { new_avatar_url: null })
    setAvatarUrl(null); toast.success('Profilbild entfernt')
  }

  // ── Login E-Mail ändern ─────────────────────────────────────
  async function changeEmail() {
    setEmailError('')
    if (!isValidEmail(newEmail)) { setEmailError('Bitte gültige E-Mail eingeben'); return }
    if (newEmail.trim().toLowerCase() === profile?.email) { setEmailError('Das ist deine aktuelle E-Mail'); return }
    setEmailSaving(true)
    const { error } = await supabase.auth.updateUser({ email: newEmail.trim().toLowerCase() })
    if (error) { setEmailError(error.message); setEmailSaving(false); return }
    toast.success('📧 Bestätigungs-E-Mail gesendet! Prüfe dein Postfach — beide Adressen müssen bestätigen.', 8000)
    setChangingEmail(false); setNewEmail(''); setEmailSaving(false)
  }

  // ── Passwort ändern ─────────────────────────────────────────
  async function changePassword(e) {
    e.preventDefault(); setPwError(''); setPwSuccess('')
    if (!pwCurrent) { setPwError('Aktuelles Passwort eingeben'); return }
    const { score } = checkPw(pwNew)
    if (score < 3) { setPwError('Neues Passwort zu schwach'); return }
    if (pwNew !== pwConfirm) { setPwError('Passwörter stimmen nicht überein'); return }
    if (pwNew === pwCurrent) { setPwError('Neues Passwort muss anders sein'); return }
    setPwSaving(true)
    const { error: authErr } = await supabase.auth.signInWithPassword({ email: profile.email, password: pwCurrent })
    if (authErr) { setPwError('Aktuelles Passwort falsch'); setPwSaving(false); setPwCurrent(''); return }
    const { error } = await supabase.auth.updateUser({ password: pwNew })
    if (error) { setPwError(error.message) }
    else {
      setPwSuccess('✅ Passwort geändert!'); setPwCurrent(''); setPwNew(''); setPwConfirm('')
      logActivity({ action: 'auth.password_changed', category: 'auth', summary: 'hat das Passwort geändert.' })
    }
    setPwSaving(false)
  }

  if (!profile?.employee_id) return (
    <div className="content" style={{ maxWidth:480, margin:'40px auto' }}>
      <div className="card" style={{ padding:28, textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>👤</div>
        <div style={{ fontWeight:600, fontSize:16 }}>Kein Mitarbeiter-Profil verknüpft</div>
        <div style={{ color:'var(--text-secondary)', fontSize:13, marginTop:8 }}>Bitte den Administrator kontaktieren.</div>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding:24 }}>Lädt…</div>

  const { score: pwScore } = checkPw(pwNew)
  const pendingVacs = allVacs.filter(v => v.status === 'pending')

  return (
    <>
      {/* ── Topbar mit Tabs ── */}
      <div className="topbar">
        <div className="topbar-title">Mein Konto</div>
        <div className="topbar-right" style={{ gap:6 }}>
          {[
            ['profil',    '👤 Profil'],
            ['daten',     '✏️ Meine Daten'],
            ['sicherheit','🔐 Sicherheit'],
            ['verlauf',   '📋 Verlauf'],
            ['dokumente', '📁 Dokumente'],
          ].map(([key, label]) => (
            <button key={key}
              className={`btn btn-sm${accountTab===key?' btn-primary':''}`}
              onClick={() => { setAccountTab(key); if (key === 'dokumente') fetchMyDocs() }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="content">

        {/* ══════════════════════════════════════════════════ */}
        {/* TAB 1: PROFIL                                      */}
        {/* ══════════════════════════════════════════════════ */}
        {employee && accountTab !== 'daten' && missingPersonalFields(employee).length > 0 && (
          <div style={{ background:'var(--warn-bg)', border:'1px solid #FDE68A', borderRadius:10, padding:'12px 14px', marginBottom:16, display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
            <div style={{ flex:1, minWidth:200, fontSize:13.5, lineHeight:1.5 }}>
              <strong>📝 Profil vervollständigen</strong><br />
              <span style={{ color:'var(--text-secondary)' }}>Für die Lohnabrechnung fehlen noch Angaben (z. B. Steuer-ID, SV-Nummer, Krankenkasse).</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setAccountTab('daten')}>Jetzt ergänzen</button>
          </div>
        )}

        {accountTab === 'profil' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(340px, 1fr))', gap:16 }}>

            {/* Avatar + Name */}
            <div className="card">
              <div className="card-header"><div className="card-title">Profilbild</div></div>
              <div style={{ padding:'20px 16px', display:'flex', alignItems:'center', gap:20 }}>
                <div style={{ position:'relative', flexShrink:0 }}>
                  <Avatar src={avatarUrl} firstName={employee?.first_name}
                    lastName={employee?.last_name} color={employee?.avatar_color} size={88} />
                  {uploading && (
                    <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.5)', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12 }}>
                      ⏳
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontWeight:700, fontSize:18, marginBottom:2 }}>
                    {employee?.first_name} {employee?.last_name}
                  </div>
                  <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:12 }}>
                    {employee?.position || '—'} · {EMP_TYPE_LABEL[employee?.employment_type] || '—'}
                  </div>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                    <button className="btn btn-sm btn-primary" onClick={() => fileRef.current?.click()} disabled={false}>
                      📷 {avatarUrl ? 'Ändern' : 'Hochladen'}
                    </button>
                    {avatarUrl && <button className="btn btn-sm" onClick={removeAvatar}>✕</button>}
                  </div>
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic"
                    style={{ display:'none' }} onChange={handleFileSelected} />
                </div>
              </div>
            </div>

            {/* Arbeitsdaten (read-only) */}
            <div className="card">
              <div className="card-header">
                <div className="card-title">📋 Arbeitsdaten</div>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>Nur vom Management änderbar</div>
              </div>
              <div style={{ padding:'16px' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  <DataField label="Position"          value={employee?.position} />
                  <DataField label="Beschäftigungsart" value={EMP_TYPE_LABEL[employee?.employment_type]} />
                  <DataField label="Stunden / Woche"   value={employee?.hours_per_week ? `${employee.hours_per_week}h` : null} />
                  <DataField label="Urlaubsanspruch"   value={employee?.vacation_days_per_year ? `${employee.vacation_days_per_year} Tage/Jahr` : null} />
                  <DataField label="Dabei seit"        value={formatDate(employee?.start_date)} />
                  <DataField label="Stundenlohn"       value={employee?.hourly_rate ? `${parseFloat(employee.hourly_rate).toFixed(2)} €/Std` : null} />
                </div>
              </div>
            </div>

            {/* Urlaubskonto */}
            {vacBalance && (
              <div className="card" style={{ gridColumn: '1 / -1' }}>
                <div className="card-header"><div className="card-title">🌴 Urlaubskonto {new Date().getFullYear()}</div></div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:0 }}>
                  {[
                    { label:'Verfügbar',  value:`${vacBalance.remaining} Tage`, color:'var(--accent)', big:true },
                    { label:'Anspruch',   value:`${vacBalance.entitlement} Tage` },
                    { label:'Genutzt',    value:`${vacBalance.used} Tage` },
                    { label:'Ausstehend', value:`${vacBalance.pending} Tage` },
                  ].map(({ label, value, color, big }) => (
                    <div key={label} style={{ padding:'14px 16px', borderRight:'1px solid var(--border)', textAlign:'center' }}>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{label}</div>
                      <div style={{ fontSize: big?24:18, fontWeight:700, color: color||'var(--text-primary)' }}>{value}</div>
                    </div>
                  ))}
                </div>
                {pendingVacs.length > 0 && (
                  <div style={{ padding:'10px 16px', background:'var(--warn-bg)', borderTop:'1px solid var(--border)', fontSize:12, color:'var(--warn)' }}>
                    ⚠️ {pendingVacs.length} ausstehende{pendingVacs.length===1?'r':''} Urlaubsantrag — kann unter "Verlauf" zurückgezogen werden
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════ */}
        {/* TAB 2: MEINE DATEN (editierbar)                   */}
        {/* ══════════════════════════════════════════════════ */}
        {accountTab === 'daten' && (
          <div style={{ maxWidth:600 }}>
            {employee
              ? <PersonalDataCard employee={employee} onSaved={fetchData} />
              : <div className="card"><div className="card-body" style={{ color:'var(--text-muted)', fontSize:13 }}>Kein Mitarbeiter-Profil verknüpft.</div></div>}
          </div>
        )}

        {/* ══════════════════════════════════════════════════ */}
        {/* TAB 3: SICHERHEIT                                  */}
        {/* ══════════════════════════════════════════════════ */}
        {accountTab === 'sicherheit' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(340px, 1fr))', gap:16 }}>

            {/* Login E-Mail ändern */}
            <div className="card">
              <div className="card-header"><div className="card-title">📧 Login-E-Mail</div></div>
              <div style={{ padding:'16px' }}>
                <div style={{ background:'var(--bg)', borderRadius:8, padding:'12px', marginBottom:14 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:3 }}>Aktuelle E-Mail</div>
                  <div style={{ fontWeight:600 }}>{profile?.email}</div>
                </div>

                {!changingEmail ? (
                  <button className="btn btn-sm" onClick={() => setChangingEmail(true)}>
                    ✏️ E-Mail ändern
                  </button>
                ) : (
                  <>
                    {emailError && <div className="alert alert-danger" style={{ marginBottom:10, fontSize:12 }}>{emailError}</div>}
                    <div className="alert alert-warn" style={{ marginBottom:12, fontSize:12 }}>
                      📧 Du erhältst Bestätigungsmails an <strong>beide</strong> Adressen. Erst nach Bestätigung wird die E-Mail gewechselt.
                    </div>
                    <div className="form-group">
                      <label>Neue E-Mail-Adresse</label>
                      <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                        placeholder="neue@email.de" autoFocus />
                    </div>
                    <div style={{ display:'flex', gap:8 }}>
                      <button className="btn btn-primary" onClick={changeEmail} disabled={emailSaving || !newEmail}>
                        {emailSaving ? '⏳…' : '📧 Bestätigung senden'}
                      </button>
                      <button className="btn" onClick={() => { setChangingEmail(false); setNewEmail(''); setEmailError('') }}>
                        Abbrechen
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Passwort ändern */}
            <div className="card">
              <div className="card-header"><div className="card-title">🔐 Passwort ändern</div></div>
              <div style={{ padding:'16px' }}>
                {pwError   && <div className="alert alert-danger"  style={{ marginBottom:10, fontSize:13 }}>{pwError}</div>}
                {pwSuccess && <div className="alert alert-success" style={{ marginBottom:10, fontSize:13 }}>{pwSuccess}</div>}
                <form onSubmit={changePassword}>
                  <div className="form-group">
                    <label>Aktuelles Passwort</label>
                    <PasswordInput value={pwCurrent} onChange={e => setPwCurrent(e.target.value)}
                      autoComplete="current-password" required disabled={pwSaving} />
                  </div>
                  <div className="form-group">
                    <label>Neues Passwort</label>
                    <PasswordInput value={pwNew} onChange={e => setPwNew(e.target.value)}
                      autoComplete="new-password" required disabled={pwSaving} />
                    {pwNew && (
                      <div style={{ marginTop:6 }}>
                        <div style={{ display:'flex', gap:3, marginBottom:3 }}>
                          {[1,2,3,4].map(i => (
                            <div key={i} style={{ flex:1, height:3, borderRadius:2, background: pwScore>=i ? STRENGTH_COLOR[pwScore] : 'var(--border)' }} />
                          ))}
                        </div>
                        <div style={{ fontSize:11, color: STRENGTH_COLOR[pwScore] }}>{STRENGTH_LABEL[pwScore]}</div>
                      </div>
                    )}
                  </div>
                  <div className="form-group">
                    <label>Neues Passwort bestätigen</label>
                    <PasswordInput value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
                      autoComplete="new-password" required disabled={pwSaving}
                      style={{ borderColor: pwConfirm && pwNew !== pwConfirm ? 'var(--danger)' : undefined }} />
                    {pwConfirm && pwNew === pwConfirm && <div style={{ fontSize:11, color:'#16A34A', marginTop:4 }}>✓ Passwörter stimmen überein</div>}
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ width:'100%', justifyContent:'center' }}
                    disabled={pwSaving || (!!pwConfirm && pwNew !== pwConfirm)}>
                    {pwSaving ? '⏳…' : '🔐 Passwort ändern'}
                  </button>
                </form>
              </div>
            </div>

            {/* Konto löschen (App-Store-Pflicht, DSGVO Art. 17) */}
            <div style={{ gridColumn:'1 / -1' }}>
              <DeleteAccountCard email={profile?.email} />
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════ */}
        {/* TAB 4: VERLAUF                                     */}
        {/* ══════════════════════════════════════════════════ */}
        {accountTab === 'verlauf' && (
          <div className="card">
            <div className="card-header">
              <div className="card-title">📋 Mein Verlauf</div>
            </div>
            <div style={{ padding:'12px 16px', display:'flex', gap:8, borderBottom:'1px solid var(--border)' }}>
              {[['urlaub','🌴 Urlaubsanträge'], ['krank','🤒 Krankmeldungen']].map(([k,l]) => (
                <button key={k} className={`btn btn-sm${historyTab===k?' btn-primary':''}`} onClick={() => setHistoryTab(k)}>{l}</button>
              ))}
            </div>

            {historyTab === 'urlaub' && (
              <div className="table-wrap">
                {allVacs.length === 0
                  ? <div className="empty-state"><div className="empty-state-icon">🌴</div><div className="empty-state-text">Noch keine Urlaubsanträge</div></div>
                  : <table>
                      <thead><tr><th>Von</th><th>Bis</th><th>Tage</th><th>Status</th><th>Gestellt am</th><th>Aktion</th></tr></thead>
                      <tbody>
                        {allVacs.map(v => {
                          const badges = {
                            pending:  <span className="badge badge-amber">Ausstehend</span>,
                            approved: <span className="badge badge-green">Genehmigt</span>,
                            rejected: <span className="badge badge-red">Abgelehnt</span>,
                          }
                          return (
                            <tr key={v.id}>
                              <td>{formatDate(v.start_date)}</td>
                              <td>{formatDate(v.end_date)}</td>
                              <td><strong>{v.days_count}</strong></td>
                              <td>{badges[v.status] || v.status}</td>
                              <td style={{ fontSize:12, color:'var(--text-muted)' }}>
                                {v.created_at ? formatDate(v.created_at.split('T')[0]) : '–'}
                              </td>
                              <td>
                                {v.status === 'pending' && (
                                  <button className="btn btn-sm btn-danger" onClick={async () => {
                                    const { error } = await supabase.from('vacation_requests')
                                      .delete().eq('id', v.id).eq('status','pending')
                                    if (error) { toast.error(error.message); return }
                                    toast.success('Urlaubsantrag zurückgezogen')
                                    fetchData()
                                  }}>
                                    ✕ Zurückziehen
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                }
              </div>
            )}

            {historyTab === 'krank' && (
              <div className="table-wrap">
                {allSick.length === 0
                  ? <div className="empty-state"><div className="empty-state-icon">🤒</div><div className="empty-state-text">Keine Krankmeldungen</div></div>
                  : <table>
                      <thead><tr><th>Ab</th><th>Bis</th><th>Attest</th><th>Eingetragen am</th></tr></thead>
                      <tbody>
                        {allSick.map(s => (
                          <tr key={s.id}>
                            <td>{formatDate(s.start_date)}</td>
                            <td>{s.end_date ? formatDate(s.end_date) : <span className="badge badge-red">Laufend</span>}</td>
                            <td>
                              {s.certificate_received
                                ? <span className="badge badge-green">✓ Eingereicht</span>
                                : <span style={{ color:'var(--text-muted)', fontSize:12 }}>Nicht eingereicht</span>
                              }
                            </td>
                            <td style={{ fontSize:12, color:'var(--text-muted)' }}>
                              {s.created_at ? formatDate(s.created_at.split('T')[0]) : '–'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                }
              </div>
            )}
          </div>
        )}
        {/* ══════════════════════════════════════════════════ */}
        {/* TAB 5: DOKUMENTE                                   */}
        {/* ══════════════════════════════════════════════════ */}
        {accountTab === 'dokumente' && (
          <div className="card">
            <div className="card-header">
              <div className="card-title">📁 Meine Dokumente & Verträge</div>
            </div>

            {docsLoading && (
              <div style={{ textAlign:'center', padding:'32px 0', fontSize:13, color:'var(--text-muted)' }}>
                ⏳ Dokumente werden geladen…
              </div>
            )}

            {!docsLoading && myDocs.length === 0 && (
              <div className="empty-state" style={{ padding:'40px 0' }}>
                <div className="empty-state-icon">📁</div>
                <div className="empty-state-text">Es wurden noch keine Dokumente für dich hinterlegt.</div>
                <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:6 }}>
                  Bei Fragen zu deinen Unterlagen bitte an das Management wenden.
                </div>
              </div>
            )}

            {!docsLoading && myDocs.length > 0 && (
              <div style={{ padding:'4px 0' }}>
                {myDocs.map(doc => (
                  <div key={doc.id} style={{
                    display:'flex', alignItems:'flex-start', gap:14, padding:'14px 18px',
                    borderBottom:'1px solid var(--border)',
                  }}>
                    <span style={{ fontSize:28, flexShrink:0, marginTop:2 }}>📄</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:14 }}>{doc.title}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:3 }}>
                        <span style={{ background:'var(--accent-light)', color:'var(--accent)', padding:'1px 6px', borderRadius:4, fontSize:11, marginRight:8 }}>
                          {DOC_TYPES_ACC[doc.document_type] || doc.document_type}
                        </span>
                        {doc.valid_from && `Gültig ab ${formatDate(doc.valid_from)}`}
                        {doc.valid_from && doc.valid_until && ' – '}
                        {doc.valid_until && formatDate(doc.valid_until)}
                      </div>
                      {doc.description && (
                        <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>{doc.description}</div>
                      )}
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>
                        {doc.file_name}
                        {doc.file_size && ` · ${(doc.file_size/1024).toFixed(0)} KB`}
                        {` · Hochgeladen am ${formatDate(doc.uploaded_at?.split('T')[0])}`}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                      <button className="btn btn-sm btn-primary"
                        disabled={!!docActionId}
                        onClick={() => openMyDoc(doc)}>
                        {docActionId===doc.id+':open' ? '⏳' : '📄 Öffnen'}
                      </button>
                      <button className="btn btn-sm"
                        style={{ background:'var(--info-bg)', color:'var(--info)', border:'1px solid var(--info)' }}
                        disabled={!!docActionId}
                        onClick={() => downloadMyDoc(doc)}>
                        {docActionId===doc.id+':dl' ? '⏳' : '⬇ Download'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bild-Cropper Modal ── */}
      {cropSrc && (
        <ImageCropper src={cropSrc} onDone={handleCropDone}
          onCancel={() => { setCropSrc(null); URL.revokeObjectURL(cropSrc) }} />
      )}
    </>
  )
}
