import { t as tr, getIntlLocale, message as appMessage, errorMessage, messageParts } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate, formatCurrency } from '../i18n/format.js'
import DeleteAccountCard from '../components/DeleteAccountCard'
import AppSetupCard from '../components/AppSetupCard'
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
const STRENGTH_LABEL = () => ['',tr("ui.e5ded9770387"),tr("ui.6604277e642c"),tr("ui.7a26d266bf0c"),tr("ui.0857c7a77ba1")]
const EMP_TYPE_LABEL = { get vollzeit() { return tr("ui.49dbe1b0b4b3") }, get teilzeit() { return tr("ui.df763b1cc689") }, get minijob() { return tr("ui.b3fc8da9deb1") }, get werkstudent() { return tr("ui.fa23b3bc413a") } }

// ── Wiederverwendbare Datenfeldanzeige ───────────────────────
function DataField({ label, value, icon }) {
  useLocale()
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
  useLocale()
  const { profile, refetch } = useProfile()
  const toast   = useToast()
  const fileRef = useRef()

  // ── Tab ─────────────────────────────────────────────────────
  const [accountTab,   setAccountTab]   = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    return ['profil','daten','sicherheit','app','verlauf','dokumente'].includes(t) ? t : 'profil'
  })

  // ── Dokumente ────────────────────────────────────────────────
  const [myDocs,       setMyDocs]       = useState([])
  const [docsLoading,  setDocsLoading]  = useState(false)
  const [docActionId,  setDocActionId]  = useState(null)

  const DOC_TYPES_ACC = {
    employment_contract: tr("ui.7c2a6c84ba98"),
    contract_addendum:   tr("ui.5d4a21030716"),
    certificate:         tr("ui.fe1020b37611"),
    agreement:           tr("ui.139fb05af4f2"),
    personal_document:   tr("ui.841be075bc36"),
    other:               tr("ui.9f3d5f8d94cf"),
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
      toast.error(appMessage("ui.0709a3b7a0d0"))
    } finally { setDocActionId(null) }
  }

  async function downloadMyDoc(doc) {
    if (docActionId) return
    setDocActionId(doc.id + ':dl')
    try {
      const typeName = DOC_TYPES_ACC[doc.document_type] || tr("ui.836ae9356297")
      const d = new Date(doc.uploaded_at); const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      const lastName = employee?.last_name?.replace(/\s+/g,'_') || tr("ui.f4cb6891b9e5")
      const filename = `${typeName}_${lastName}_${date}.pdf`
      const { data, error } = await supabase.storage
        .from('employee-documents').createSignedUrl(doc.file_path, 60, { download: filename })
      if (error) { toast.error(messageParts([appMessage("ui.322e45a8c6c6"), errorMessage(error)])); return }
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
    } catch (err) { toast.error(messageParts([appMessage("ui.f1abd7e4336c"), errorMessage(err)])) }
    setLoading(false)
  }

  // ── Profilbild ──────────────────────────────────────────────
  function handleFileSelected(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { toast.warn(appMessage("ui.ce6e0e48223f")); return }
    setCropSrc(URL.createObjectURL(file))
    e.target.value = ''
  }

  function handleCropDone(dataUrl) {
    // Sofort anzeigen — kein async, kein Guard, kann nicht hängen
    setCropSrc(null)
    setAvatarUrl(dataUrl)
    toast.success(appMessage("ui.5888a48ff1c0"))
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
    setAvatarUrl(null); toast.success(appMessage("ui.cfb7a46547ba"))
  }

  // ── Login E-Mail ändern ─────────────────────────────────────
  async function changeEmail() {
    setEmailError('')
    if (!isValidEmail(newEmail)) { setEmailError(appMessage("ui.76b11fef592c")); return }
    if (newEmail.trim().toLowerCase() === profile?.email) { setEmailError(appMessage("ui.44795eb77b95")); return }
    setEmailSaving(true)
    const { error } = await supabase.auth.updateUser({ email: newEmail.trim().toLowerCase() })
    if (error) { setEmailError(errorMessage(error)); setEmailSaving(false); return }
    toast.success(appMessage("ui.e0e40cbc8558"), 8000)
    setChangingEmail(false); setNewEmail(''); setEmailSaving(false)
  }

  // ── Passwort ändern ─────────────────────────────────────────
  async function changePassword(e) {
    e.preventDefault(); setPwError(''); setPwSuccess('')
    if (!pwCurrent) { setPwError(appMessage("ui.257b990afc75")); return }
    const { score } = checkPw(pwNew)
    if (score < 3) { setPwError(appMessage("ui.a2bd3b8ee3e5")); return }
    if (pwNew !== pwConfirm) { setPwError(appMessage("ui.943de6dfe431")); return }
    if (pwNew === pwCurrent) { setPwError(appMessage("ui.9a3650e0c75d")); return }
    setPwSaving(true)
    const { error: authErr } = await supabase.auth.signInWithPassword({ email: profile.email, password: pwCurrent })
    if (authErr) { setPwError(appMessage("ui.b29d97fc32a7")); setPwSaving(false); setPwCurrent(''); return }
    const { error } = await supabase.auth.updateUser({ password: pwNew })
    if (error) { setPwError(errorMessage(error)) }
    else {
      setPwSuccess(appMessage("ui.67e7b7ff46b2")); setPwCurrent(''); setPwNew(''); setPwConfirm('')
      logActivity({ action: 'auth.password_changed', category: 'auth', summary: 'hat das Passwort geändert.' })
    }
    setPwSaving(false)
  }

  if (!profile?.employee_id) return (
    <div className="content" style={{ maxWidth:480, margin:'40px auto' }}>
      <div className="card" style={{ padding:28, textAlign:'center' }}>
        <div style={{ fontSize:40, marginBottom:12 }}>👤</div>
        <div style={{ fontWeight:600, fontSize:16 }}>{tr("ui.737044ed5877")}</div>
        <div style={{ color:'var(--text-secondary)', fontSize:13, marginTop:8 }}>{tr("ui.7438bc2432cb")}</div>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding:24 }}>{tr("ui.ebbb1d1f265f")}</div>

  const { score: pwScore } = checkPw(pwNew)
  const pendingVacs = allVacs.filter(v => v.status === 'pending')

  return (
    <>
      {/* ── Topbar mit Tabs ── */}
      <div className="topbar">
        <div className="topbar-title">{tr("ui.5cf21c63b3d6")}</div>
        <div className="topbar-right" style={{ gap:6 }}>
          {[
            ['profil',    tr("ui.fc35e15196fc")],
            ['daten',     tr("ui.076d2cc285e3")],
            ['sicherheit',tr("ui.879adc878404")],
            ['app',       tr("ui.9ec7a0de5b6d")],
            ['verlauf',   tr("ui.6520b672b1fe")],
            ['dokumente', tr("ui.d03408a81e13")],
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
              <strong>{tr("ui.b3d12074d7be")}</strong><br />
              <span style={{ color:'var(--text-secondary)' }}>{tr("ui.f6b07c8c34b5")}</span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setAccountTab('daten')}>{tr("ui.011b5e732b49")}</button>
          </div>
        )}

        {accountTab === 'profil' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(340px, 1fr))', gap:16 }}>

            {/* Avatar + Name */}
            <div className="card">
              <div className="card-header"><div className="card-title">{tr("ui.f7e3ae42f24e")}</div></div>
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
                      📷 {avatarUrl ? tr("ui.ea5e3417aabc") : tr("ui.6638ef84fb9e")}
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
                <div className="card-title">{tr("ui.c3e7bf267c5f")}</div>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>{tr("ui.c152e9a003c7")}</div>
              </div>
              <div style={{ padding:'16px' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  <DataField label={tr("ui.6d031af10da7")}          value={employee?.position} />
                  <DataField label={tr("ui.b185de16cc87")} value={EMP_TYPE_LABEL[employee?.employment_type]} />
                  <DataField label={tr("ui.48905a1115a7")}   value={employee?.hours_per_week ? `${employee.hours_per_week}h` : null} />
                  <DataField label={tr("ui.1b810a812b2c")}   value={employee?.vacation_days_per_year ? tr("ui.d708fcfe7811", { p1: (employee.vacation_days_per_year) }) : null} />
                  <DataField label={tr("ui.b3acb8cb53f2")}        value={formatDate(employee?.start_date)} />
                  <DataField label={tr("ui.68c8ec0f16c7")}       value={employee?.hourly_rate ? tr("ui.623f6d1b7a65", { p1: (parseFloat(employee.hourly_rate).toLocaleString(getIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })) }) : null} />
                </div>
              </div>
            </div>

            {/* Urlaubskonto */}
            {vacBalance && (
              <div className="card" style={{ gridColumn: '1 / -1' }}>
                <div className="card-header"><div className="card-title">{tr("ui.6160b156e2c5")}{new Date().getFullYear()}</div></div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:0 }}>
                  {[
                    { label:tr("ui.3aa55273aef4"),  value:tr("count.days", { count: vacBalance.remaining }), color:'var(--accent)', big:true },
                    { label:tr("ui.e37d6b697aa3"),   value:tr("count.days", { count: vacBalance.entitlement }) },
                    { label:tr("ui.5eb4bee51357"),    value:tr("count.days", { count: vacBalance.used }) },
                    { label:tr("ui.0b5e85dd2508"), value:tr("count.days", { count: vacBalance.pending }) },
                  ].map(({ label, value, color, big }, labelIndex) => (
                    <div key={labelIndex} style={{ padding:'14px 16px', borderRight:'1px solid var(--border)', textAlign:'center' }}>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{label}</div>
                      <div style={{ fontSize: big?24:18, fontWeight:700, color: color||'var(--text-primary)' }}>{value}</div>
                    </div>
                  ))}
                </div>
                {pendingVacs.length > 0 && (
                  <div style={{ padding:'10px 16px', background:'var(--warn-bg)', borderTop:'1px solid var(--border)', fontSize:12, color:'var(--warn)' }}>
                    ⚠️ {tr("account.pendingLeave", { count: pendingVacs.length })}</div>
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
              : <div className="card"><div className="card-body" style={{ color:'var(--text-muted)', fontSize:13 }}>{tr("ui.0ab2ca46e83b")}</div></div>}
          </div>
        )}

        {/* ══════════════════════════════════════════════════ */}
        {/* TAB 3: SICHERHEIT                                  */}
        {/* ══════════════════════════════════════════════════ */}
        {accountTab === 'app' && (
          <div style={{ maxWidth:640 }}>
            <AppSetupCard />
          </div>
        )}

        {accountTab === 'sicherheit' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(340px, 1fr))', gap:16 }}>

            {/* Login E-Mail ändern */}
            <div className="card">
              <div className="card-header"><div className="card-title">{tr("ui.0e4babb74df6")}</div></div>
              <div style={{ padding:'16px' }}>
                <div style={{ background:'var(--bg)', borderRadius:8, padding:'12px', marginBottom:14 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:3 }}>{tr("ui.fbd82bf41149")}</div>
                  <div style={{ fontWeight:600 }}>{profile?.email}</div>
                </div>

                {!changingEmail ? (
                  <button className="btn btn-sm" onClick={() => setChangingEmail(true)}>{tr("ui.ce91adb7980d")}</button>
                ) : (
                  <>
                    {emailError && <div className="alert alert-danger" style={{ marginBottom:10, fontSize:12 }}>{localizeMessage(emailError)}</div>}
                    <div className="alert alert-warn" style={{ marginBottom:12, fontSize:12 }}>{tr("ui.ecef9930606e")}<strong>{tr("ui.f634c721db95")}</strong>{tr("ui.9b66f73d75ca")}</div>
                    <div className="form-group">
                      <label>{tr("ui.f77f5364d26c")}</label>
                      <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                        placeholder={tr("ui.f197a950741e")} autoFocus />
                    </div>
                    <div style={{ display:'flex', gap:8 }}>
                      <button className="btn btn-primary" onClick={changeEmail} disabled={emailSaving || !newEmail}>
                        {emailSaving ? '⏳…' : tr("ui.57f221c91e7e")}
                      </button>
                      <button className="btn" onClick={() => { setChangingEmail(false); setNewEmail(''); setEmailError('') }}>{tr("ui.f7ff1178af20")}</button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Passwort ändern */}
            <div className="card">
              <div className="card-header"><div className="card-title">{tr("ui.b4bbca68f30c")}</div></div>
              <div style={{ padding:'16px' }}>
                {pwError   && <div className="alert alert-danger"  style={{ marginBottom:10, fontSize:13 }}>{localizeMessage(pwError)}</div>}
                {pwSuccess && <div className="alert alert-success" style={{ marginBottom:10, fontSize:13 }}>{localizeMessage(pwSuccess)}</div>}
                <form onSubmit={changePassword}>
                  <div className="form-group">
                    <label>{tr("ui.7bdf6e89701c")}</label>
                    <PasswordInput value={pwCurrent} onChange={e => setPwCurrent(e.target.value)}
                      autoComplete="current-password" required disabled={pwSaving} />
                  </div>
                  <div className="form-group">
                    <label>{tr("ui.88bba54d70a5")}</label>
                    <PasswordInput value={pwNew} onChange={e => setPwNew(e.target.value)}
                      autoComplete="new-password" required disabled={pwSaving} />
                    {pwNew && (
                      <div style={{ marginTop:6 }}>
                        <div style={{ display:'flex', gap:3, marginBottom:3 }}>
                          {[1,2,3,4].map(i => (
                            <div key={i} style={{ flex:1, height:3, borderRadius:2, background: pwScore>=i ? STRENGTH_COLOR[pwScore] : 'var(--border)' }} />
                          ))}
                        </div>
                        <div style={{ fontSize:11, color: STRENGTH_COLOR[pwScore] }}>{STRENGTH_LABEL()[pwScore]}</div>
                      </div>
                    )}
                  </div>
                  <div className="form-group">
                    <label>{tr("ui.8f99b8341f93")}</label>
                    <PasswordInput value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
                      autoComplete="new-password" required disabled={pwSaving}
                      style={{ borderColor: pwConfirm && pwNew !== pwConfirm ? 'var(--danger)' : undefined }} />
                    {pwConfirm && pwNew === pwConfirm && <div style={{ fontSize:11, color:'#16A34A', marginTop:4 }}>{tr("ui.71c5b9984138")}</div>}
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ width:'100%', justifyContent:'center' }}
                    disabled={pwSaving || (!!pwConfirm && pwNew !== pwConfirm)}>
                    {pwSaving ? '⏳…' : tr("ui.b4bbca68f30c")}
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
              <div className="card-title">{tr("ui.12e0b5644546")}</div>
            </div>
            <div style={{ padding:'12px 16px', display:'flex', gap:8, borderBottom:'1px solid var(--border)' }}>
              {[['urlaub',tr("ui.33eb3a95746b")], ['krank',tr("ui.aa681bca6636")]].map(([k,l]) => (
                <button key={k} className={`btn btn-sm${historyTab===k?' btn-primary':''}`} onClick={() => setHistoryTab(k)}>{l}</button>
              ))}
            </div>

            {historyTab === 'urlaub' && (
              <div className="table-wrap">
                {allVacs.length === 0
                  ? <div className="empty-state"><div className="empty-state-icon">🌴</div><div className="empty-state-text">{tr("ui.bf20fed25c5b")}</div></div>
                  : <table>
                      <thead><tr><th>{tr("ui.640e86cbc244")}</th><th>{tr("ui.078a815372af")}</th><th>{tr("ui.6770c319ff7b")}</th><th>{tr("ui.920e413c7d41")}</th><th>{tr("ui.e01523636474")}</th><th>{tr("ui.a4ad259e71cb")}</th></tr></thead>
                      <tbody>
                        {allVacs.map(v => {
                          const badges = {
                            pending:  <span className="badge badge-amber">{tr("ui.0b5e85dd2508")}</span>,
                            approved: <span className="badge badge-green">{tr("ui.9b3015a9dbf0")}</span>,
                            rejected: <span className="badge badge-red">{tr("ui.a9148e8654e8")}</span>,
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
                                    if (error) { toast.error(errorMessage(error)); return }
                                    toast.success(appMessage("ui.2bfb2b5588b9"))
                                    fetchData()
                                  }}>{tr("ui.6e104aece86a")}</button>
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
                  ? <div className="empty-state"><div className="empty-state-icon">🤒</div><div className="empty-state-text">{tr("ui.7f0c943892ac")}</div></div>
                  : <table>
                      <thead><tr><th>{tr("ui.025b5573cb68")}</th><th>{tr("ui.078a815372af")}</th><th>{tr("ui.c81da7e67a9d")}</th><th>{tr("ui.0860310ca35c")}</th></tr></thead>
                      <tbody>
                        {allSick.map(s => (
                          <tr key={s.id}>
                            <td>{formatDate(s.start_date)}</td>
                            <td>{s.end_date ? formatDate(s.end_date) : <span className="badge badge-red">{tr("ui.1fe6a7f6e8a2")}</span>}</td>
                            <td>
                              {s.certificate_received
                                ? <span className="badge badge-green">{tr("ui.b21510f8a1ac")}</span>
                                : <span style={{ color:'var(--text-muted)', fontSize:12 }}>{tr("ui.f5a3f57e19d8")}</span>
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
              <div className="card-title">{tr("ui.6c5058f47223")}</div>
            </div>

            {docsLoading && (
              <div style={{ textAlign:'center', padding:'32px 0', fontSize:13, color:'var(--text-muted)' }}>{tr("ui.a28b8a0f4826")}</div>
            )}

            {!docsLoading && myDocs.length === 0 && (
              <div className="empty-state" style={{ padding:'40px 0' }}>
                <div className="empty-state-icon">📁</div>
                <div className="empty-state-text">{tr("ui.2bba02d81ef8")}</div>
                <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:6 }}>{tr("ui.e1f9c6d84a5d")}</div>
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
                        {doc.valid_from && tr("ui.560db4347448", { p1: (formatDate(doc.valid_from)) })}
                        {doc.valid_from && doc.valid_until && ' – '}
                        {doc.valid_until && formatDate(doc.valid_until)}
                      </div>
                      {doc.description && (
                        <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>{doc.description}</div>
                      )}
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>
                        {doc.file_name}
                        {doc.file_size && ` · ${(doc.file_size/1024).toLocaleString(getIntlLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })} KB`}
                        {tr("ui.3be6aa8681d4", { p1: (formatDate(doc.uploaded_at?.split('T')[0])) })}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                      <button className="btn btn-sm btn-primary"
                        disabled={!!docActionId}
                        onClick={() => openMyDoc(doc)}>
                        {docActionId===doc.id+':open' ? '⏳' : tr("ui.ced8ed5a3dca")}
                      </button>
                      <button className="btn btn-sm"
                        style={{ background:'var(--info-bg)', color:'var(--info)', border:'1px solid var(--info)' }}
                        disabled={!!docActionId}
                        onClick={() => downloadMyDoc(doc)}>
                        {docActionId===doc.id+':dl' ? '⏳' : tr("ui.fee265346c65")}
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
