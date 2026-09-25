import { t as tr, getIntlLocale, localizeMessage, message as appMessage, errorMessage, messageParts } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MINDESTLOHN } from '../lib/constants'
import { supabase, toLocalDateStr } from '../lib/supabase'
import { formatDate } from '../i18n/format.js'
import Avatar from '../components/UI/Avatar'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { logActivity } from '../lib/activityLog'
import { translateSupabaseError } from '../lib/errorHelper'
import OnboardingReview, { ONB_STATUS } from '../components/OnboardingReview'

const ROLES = [
  { value: 'employee', get label() { return tr("ui.d422e9b832d6") } },
  { value: 'manager',  get label() { return tr("ui.0e60bc79039b") } },
  { value: 'admin',    get label() { return tr("ui.25201cafd7b9") } },
]

export default function UserManagement() {
  useLocale()
  const { refetch, profile } = useProfile()
  const toast       = useToast()
  const inviteGuard  = useSavingGuard()
  const approveGuard = useSavingGuard()
  const revokeGuard  = useSavingGuard()
  const rejectGuard  = useSavingGuard()
  const deleteGuard  = useSavingGuard()

  const [pending,      setPending]      = useState([])
  const [approved,     setApproved]     = useState([])
  const [disabledUsers, setDisabledUsers] = useState([])
  const [showDisabled, setShowDisabled] = useState(false)
  const [employees,    setEmployees]    = useState([])
  const [invitations,  setInvitations]  = useState([])
  const [onboardings,  setOnboardings]  = useState([])
  const [reviewRow,    setReviewRow]    = useState(null)
  const [confirmRevoke, setConfirmRevoke] = useState(null) // Einladung, die zurückgezogen werden soll
  const [showHidden,   setShowHidden]   = useState(false)
  const [loading,      setLoading]      = useState(true)
  const [working,      setWorking]      = useState(null)
  const [pendingForms, setPendingForms] = useState({})
  const [editState,    setEditState]    = useState({})
  const [confirmDel,        setConfirmDel]        = useState(null)
  const [confirmDelActive, setConfirmDelActive] = useState(null)
  const [roleConfirm, setRoleConfirm] = useState(null)   // { p, role } bei Admin-Rechten

  // Einladungs-Modal
  const [inviteModal,  setInviteModal]  = useState(null) // { employee } | null
  const [inviteForm,   setInviteForm]   = useState({ email:'', role:'employee' })
  const [inviteJob,    setInviteJob]    = useState(null)   // optionaler Arbeitsvertrag bei neuer Einladung
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [inviteResult, setInviteResult] = useState(null) // generierter Link
  const [inviteSaving, setInviteSaving] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    try {
    const [{ data: profiles }, { data: emps }, { data: invs }, { data: onbs }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('employees').select('id, first_name, last_name, email, position, avatar_url, avatar_color, is_active, app_access_hidden').order('last_name'),
      supabase.from('invitations').select('*, employees!employee_id(first_name, last_name)').is('used_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }),
      supabase.from('employee_onboarding').select('*').order('created_at', { ascending: false }),
    ])
    const onbIds = new Set((onbs || []).map(o => o.profile_id))
    setOnboardings(onbs || [])
    // Accounts mit Onboarding erscheinen im Bereich "Neue Mitarbeiter", nicht hier
    setPending((profiles  || []).filter(p => p.status === 'pending' && !onbIds.has(p.id)))
    setApproved((profiles || []).filter(p => p.status === 'approved'))
    setDisabledUsers((profiles || []).filter(p => p.status === 'disabled'))
    setEmployees(emps || [])
    setInvitations(invs || [])
    // Direktsprünge aus „Mitarbeiter“: ?invite=<employee_id> oder ?new=1
    const invId = searchParams.get('invite'), isNewParam = searchParams.get('new')
    if (invId || isNewParam) {
      searchParams.delete('invite'); searchParams.delete('new'); setSearchParams(searchParams, { replace: true })
      if (isNewParam) openInvite(null)
      else {
        const emp = (emps || []).find(e => e.id === invId)
        if (emp) openInvite(emp)
      }
    }
    } catch(err) { toast.error(messageParts([appMessage("ui.f1abd7e4336c"), errorMessage(err)])) }
    setLoading(false)
  }

  // ── Einladung erstellen ─────────────────────────────────────
  // emp = bestehender Mitarbeiter-Datensatz (alter Weg) oder null = neuer Mitarbeiter (Onboarding)
  function openInvite(emp) {
    setInviteModal(emp || { isNew: true })
    setInviteForm({ email: emp?.email || '', role: 'employee' })
    setInviteJob(null)
    setInviteResult(null)
  }

  async function createInvitation() {
    if (!inviteGuard.begin()) return
    const email = inviteForm.email?.trim().toLowerCase()
    if (!email) { toast.warn(appMessage("ui.f3248c61cef6")); inviteGuard.end(); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast.warn(appMessage("ui.05548be8e4dc")); inviteGuard.end(); return }
    const isNew = !!inviteModal.isNew
    let job = null
    if (isNew && inviteJob) {
      const rate = parseFloat(String(inviteJob.hourly_rate || '').replace(',', '.'))
      const hours = parseFloat(String(inviteJob.hours_per_week || '').replace(',', '.'))
      if (inviteJob.hourly_rate && (!rate || rate <= 0)) { toast.warn(appMessage("ui.6aa12287a389")); inviteGuard.end(); return }
      if (inviteJob.hours_per_week && (!hours || hours <= 0 || hours > 60)) { toast.warn(appMessage("ui.d69fa185470a")); inviteGuard.end(); return }
      job = {
        role: inviteJob.role || 'employee',
        position: (inviteJob.position || '').trim(),
        employment_type: inviteJob.employment_type || 'minijob',
        hours_per_week: hours || null,
        hourly_rate: rate || null,
        start_date: inviteJob.start_date || null,
        vacation_days: inviteJob.vacation_days === '' || inviteJob.vacation_days == null ? 28 : parseInt(inviteJob.vacation_days, 10),
      }
    }
    setInviteSaving(true)

    try {
      if (isNew) {
        // Doppelte Accounts vermeiden: gibt es die Adresse schon als Login oder Mitarbeiter?
        const { data: reg } = await supabase.rpc('check_email_registered', { p_email: email })
        if (reg?.exists) {
          toast.warn(reg.reason === 'auth' ? (appMessage("ui.588c94127f4c")) : (appMessage("ui.07b54feedb71")))
          return
        }
      }
      // Nur EIN gültiger Link pro Person: ältere offene Einladungen zurückziehen
      // (danach zeigt der alte Link „Einladung wurde zurückgezogen“)
      const old = invitations.filter(i => isNew
        ? (!i.employee_id && (i.email || '').toLowerCase() === email)
        : i.employee_id === inviteModal.id)
      for (const o of old) await supabase.rpc('revoke_invitation', { p_id: o.id })

      const { data: inv, error } = await supabase.from('invitations').insert([{
        employee_id: isNew ? null : inviteModal.id,
        email,
        role:        isNew ? 'employee' : inviteForm.role,
        created_by:  profile?.id,
        job,
      }]).select().maybeSingle()

      if (error || !inv) { toast.error(appMessage("ui.535cccb34776")); return }

      const link = `${window.location.origin}/?invite=${inv.token}`
      setInviteResult({ link, isNew, name: isNew ? '' : `${inviteModal.first_name} ${inviteModal.last_name}`, email })
      logActivity({
        action: 'employee.invited', category: 'employee',
        summary: isNew ? `hat ${email} als neuen Mitarbeiter eingeladen.` : `hat ${inviteModal.first_name} ${inviteModal.last_name} eingeladen.`,
        targetType: 'invitation', targetId: inv.id, targetName: email,
      })
      fetchAll()
    } finally {
      setInviteSaving(false)
      inviteGuard.end()
    }
  }

  async function copyLink(link) {
    try {
      await navigator.clipboard.writeText(link)
      toast.success(appMessage("ui.35d99dfcbce6"))
    } catch {
      toast.warn(appMessage("ui.83ed8a239580"))
    }
  }

  function whatsappLink(link, name, isNew) {
    const msg = encodeURIComponent(isNew
      ? tr("ui.c3d665313cae", { p1: (link) })
      : tr("ui.3454ad2c43b3", { p1: (name), p2: (link) }))
    return `https://wa.me/?text=${localizeMessage(msg)}`
  }

  // Einladung zurückziehen: Link wird sofort ungültig. Öffnet die Person ihn trotzdem,
  // sieht sie „Diese Einladung wurde zurückgezogen“. Protokoll schreibt die Datenbank.
  async function revokeInvitation(inv) {
    if (!revokeGuard.begin()) return
    try {
      const { data, error } = await supabase.rpc('revoke_invitation', { p_id: inv.id })
      if (error || !data?.success) {
        toast.error((data?.error || appMessage("ui.0646a3081a2b")), 9000)
      } else {
        toast.success(appMessage("ui.296ee2f11c5c"))
      }
    } finally {
      revokeGuard.end()
      setConfirmRevoke(null)
      fetchAll()
    }
  }

  // Mitarbeiter ohne App-Zugang aus der Liste ausblenden (z. B. Aushilfe ohne Smartphone).
  // Der Mitarbeiter bleibt aktiv — Schichtplan, Stunden und Lohn sind davon unberührt.
  async function setAccessHidden(emp, hidden) {
    const { error } = await supabase.from('employees').update({ app_access_hidden: hidden }).eq('id', emp.id)
    if (error) { toast.error(appMessage("ui.6632d80bc657")); return }
    toast.info(appMessage(hidden ? "users.hidden" : "users.shown", { first: emp.first_name, last: emp.last_name }))
    logActivity({
      action: hidden ? 'employee.app_access_hidden' : 'employee.app_access_shown', category: 'employee',
      summary: hidden ? `hat ${emp.first_name} ${emp.last_name} als „kein App-Zugang nötig“ markiert.`
                      : `hat ${emp.first_name} ${emp.last_name} wieder zur Einladungsliste hinzugefügt.`,
      targetType: 'employee', targetId: emp.id, targetName: `${emp.first_name} ${emp.last_name}`,
    })
    fetchAll()
  }

  // ── Pending genehmigen ───────────────────────────────────────
  function setPendingForm(id, k, v) {
    setPendingForms(f => ({ ...f, [id]: { ...(f[id] || { role: 'employee' }), [k]: v } }))
  }

  async function approvePending(p) {
    toast.info(appMessage("ui.032bbd5d59fc"))
    if (!approveGuard.begin()) {
      toast.error(appMessage("ui.c782ff6aeb48"))
      return
    }
    const form = pendingForms[p.id] || { role: 'employee', employee_id: '' }
    if (!form.employee_id) {
      toast.warn(appMessage("ui.c4b15063c00c"))
      approveGuard.end()
      return
    }
    setWorking(p.id)
    try {
      const { error } = await supabase.rpc('approve_user', {
        p_profile_id:  p.id,
        p_role:        form.role,
        p_employee_id: form.employee_id,
      })
      if (error) {
        console.error('approvePending error:', error)
        toast.error(messageParts([appMessage("ui.11f0fb59178c"), errorMessage(error)]))
      } else {
        toast.success(appMessage("users.enabled", { email: p.email }))
        logActivity({
          action: 'employee.approved', category: 'employee',
          summary: `hat ${p.email} freigeschaltet.`,
          targetType: 'profile', targetId: p.id, targetName: p.email,
        })
        fetchAll()
        refetch()
      }
    } catch (err) {
      console.error('approvePending exception:', err)
      toast.error(messageParts([appMessage("ui.c9bfd3734ac6"), errorMessage(err)]))
    } finally {
      approveGuard.end()
      setWorking(null)
    }
  }

  async function confirmReject() {
    if (!rejectGuard.begin()) return
    if (!confirmDel) { rejectGuard.end(); return }
    setWorking(confirmDel.id)
    await supabase.from('profiles').delete().eq('id', confirmDel.id)
    toast.info(appMessage("ui.57da62558e87"))
    rejectGuard.end()
    setConfirmDel(null); fetchAll(); setWorking(null)
  }

  // Zugang sperren statt löschen: Daten & Protokoll bleiben erhalten, jederzeit umkehrbar
  async function setUserLocked(p, locked) {
    if (!deleteGuard.begin()) return
    if (p.id === profile?.id) { toast.error(appMessage("ui.3cfbe114cd45")); deleteGuard.end(); return }
    setWorking(p.id)
    try {
      const { error } = await supabase.from('profiles').update({ status: locked ? 'disabled' : 'approved' }).eq('id', p.id)
      if (error) { toast.error(appMessage("ui.6632d80bc657")); return }
      const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email
      toast.success(locked ? (appMessage("ui.6160cb4b567e", { p1: (name) })) : (appMessage("ui.d28ef50b9958", { p1: (name) })))
      logActivity({
        action: locked ? 'employee.access_locked' : 'employee.access_unlocked', category: 'employee',
        summary: locked ? `hat den App-Zugang von ${name} gesperrt.` : `hat den App-Zugang von ${name} wieder freigegeben.`,
        targetType: 'profile', targetId: p.id, targetName: name,
      })
      fetchAll(); refetch()
    } finally {
      deleteGuard.end()
      setConfirmDelActive(null)
      setWorking(null)
    }
  }

  function requestRoleChange(p, role) {
    if (role === p.role) return
    // Admin-Rechte vergeben oder entziehen immer mit Rückfrage
    if (role === 'admin' || p.role === 'admin') { setRoleConfirm({ p, role }); return }
    changeRole(p.id, role)
  }

  async function changeRole(profileId, role) {
    setRoleConfirm(null)
    if (profileId === profile?.id) { toast.error(appMessage("ui.b06df01f1540")); return }
    const { error } = await supabase.from('profiles').update({ role }).eq('id', profileId)
    if (error) toast.error(translateSupabaseError(error, appMessage("ui.0038a9cf8661")))
    else {
      toast.success(appMessage("ui.9e746ba9ca80"))
      const target = [...approved, ...pending].find(u => u.id === profileId)
      const roleLabel = role === 'admin' ? 'Administrator' : role === 'manager' ? 'Manager' : 'Mitarbeiter'
      logActivity({
        action: 'employee.role_changed', category: 'employee',
        summary: `hat die Rolle von ${target?.email || 'einem Nutzer'} zu ${roleLabel} geändert.`,
        targetType: 'profile', targetId: profileId, targetName: target?.email,
      })
      fetchAll(); refetch()
    }
  }

  async function changeEmployeeLink(profileId, employeeId) {
    const { error } = await supabase.from('profiles').update({ employee_id: employeeId || null }).eq('id', profileId)
    if (error) toast.error(messageParts([appMessage("ui.60efe70adb51"), errorMessage(error)]))
    else {
      toast.success(appMessage("ui.df6f43f7d894"))
      setEditState(e => { const n={...e}; delete n[profileId]; return n })
      fetchAll(); refetch()
    }
  }

  // Mitarbeiter ohne Account
  // Archivierte (inaktive) Mitarbeiter brauchen keinen Zugang → nicht anzeigen
  const noAccountAll = employees.filter(emp =>
    emp.is_active !== false &&
    !approved.find(p => p.employee_id === emp.id) &&
    !pending.find(p => p.employee_id === emp.id)
  )
  const employeesWithoutAccount = noAccountAll.filter(e => !e.app_access_hidden)
  const hiddenNoAccount         = noAccountAll.filter(e =>  e.app_access_hidden)

  if (loading) return <div style={{ padding: 24 }}>{tr("ui.7a72dd7b9d46")}</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.3249b70702f2")}</div>
        <div className="topbar-right">
          <button className="btn btn-primary btn-sm" onClick={() => openInvite(null)}>{tr("ui.3fc66c73a5d9")}</button>
        </div>
      </div>

      <div className="content">
        <div style={{ fontSize:12.5, color:'var(--text-secondary)', background:'var(--bg-white)', border:'1px solid var(--border)', borderRadius:10, padding:'10px 14px', marginBottom:16, lineHeight:1.6 }}>
          🔑 <strong>{tr("ui.6de60ed849d5")}</strong>{tr("ui.aad9a51de869")}<strong>{tr("ui.29978313af04")}</strong>{tr("ui.3992b5a200c7")}<a href="/mitarbeiter" onClick={e => { e.preventDefault(); navigate('/mitarbeiter') }}>{tr("ui.f4cb6891b9e5")}</a>{tr("ui.71f598a44a75")}</div>

        {/* ── Inline Bestätigungsdialog ── */}
        {confirmDel && (
          <div className="modal-overlay" onClick={() => setConfirmDel(null)}>
            <div className="modal" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header"><div className="modal-title">{tr("ui.8684fa78f100")}</div><button className="btn btn-sm" onClick={() => setConfirmDel(null)}>✕</button></div>
              <div className="modal-body"><div className="alert alert-danger">{tr("ui.63d122d94372")}<strong>{confirmDel.email}</strong>{tr("ui.e41958841181")}</div></div>
              <div className="modal-footer">
                <button className="btn" onClick={() => setConfirmDel(null)}>{tr("ui.f7ff1178af20")}</button>
                <button className="btn btn-danger" onClick={confirmReject}>{tr("ui.edaa7de6a979")}</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Einladungs-Modal ── */}
        {inviteModal && (
          <div className="modal-overlay" onClick={() => { setInviteModal(null); setInviteResult(null) }}>
            <div className="modal" style={{ maxWidth:460 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-title">{inviteModal.isNew ? tr("ui.c21aa413ff3c") : tr("ui.bd4b210a4249")}</div>
                <button className="btn btn-sm" onClick={() => { setInviteModal(null); setInviteResult(null) }}>✕</button>
              </div>
              <div className="modal-body">
                {!inviteResult ? (
                  <>
                    {inviteModal.isNew ? (
                      <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:13, lineHeight:1.6 }}>{tr("ui.6bd74c5f6189")}</div>
                    ) : (
                      <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'12px 16px', marginBottom:16 }}>
                        <div style={{ fontWeight:600 }}>{inviteModal.first_name} {inviteModal.last_name}</div>
                        {inviteModal.position && <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{inviteModal.position}</div>}
                      </div>
                    )}

                    <div className="form-group">
                      <label>{tr("ui.3aa94d6b25ac")}</label>
                      <input type="email" value={inviteForm.email} onChange={e => setInviteForm(f => ({...f, email: e.target.value}))}
                        placeholder={tr("ui.3cb2486e1691")} />
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{tr("ui.0b4996890ea1")}</div>
                    </div>

                    {!inviteModal.isNew && <div className="form-group">
                      <label>{tr("ui.0038a9cf8661")}</label>
                      <select value={inviteForm.role} onChange={e => setInviteForm(f => ({...f, role: e.target.value}))}>
                        {ROLES.filter(r => r.value !== 'admin').map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>}

                    {inviteModal.isNew && (
                      <div style={{ border:'1px solid var(--border)', borderRadius:10, padding:'10px 12px', marginBottom:14 }}>
                        {!inviteJob ? (
                          <button type="button" className="btn btn-sm" onClick={() => setInviteJob({ role:'employee', position:'', employment_type:'minijob', hours_per_week:10, hourly_rate:'', start_date: toLocalDateStr(), vacation_days:28 })}>{tr("ui.938284ca6f6a")}</button>
                        ) : (
                          <>
                            <div style={{ fontWeight:600, fontSize:13, marginBottom:8 }}>{tr("ui.6f5b9aaab942")}</div>
                            <div className="two-col">
                              <div className="form-group"><label>{tr("ui.50614a65c54c")}</label>
                                <select value={inviteJob.employment_type} onChange={e => { const t = e.target.value; setInviteJob(j => ({ ...j, employment_type:t, hours_per_week:{ vollzeit:40, teilzeit:20, werkstudent:20, minijob:10 }[t] })) }}>
                                  <option value="vollzeit">{tr("ui.49dbe1b0b4b3")}</option><option value="teilzeit">{tr("ui.df763b1cc689")}</option>
                                  <option value="werkstudent">{tr("ui.fa23b3bc413a")}</option><option value="minijob">{tr("ui.b3fc8da9deb1")}</option>
                                </select></div>
                              <div className="form-group"><label>{tr("ui.e214a5535edd")}</label>
                                <input type="number" min="1" max="60" value={inviteJob.hours_per_week} onChange={e => setInviteJob(j => ({ ...j, hours_per_week:e.target.value }))} /></div>
                            </div>
                            <div className="two-col">
                              <div className="form-group"><label>{tr("ui.015cd60df3a4")}</label>
                                <input inputMode="decimal" value={inviteJob.hourly_rate} placeholder={MINDESTLOHN.toLocaleString(getIntlLocale())}
                                  onChange={e => setInviteJob(j => ({ ...j, hourly_rate:e.target.value.replace(/[^0-9.,]/g, '') }))} />
                                {parseFloat(String(inviteJob.hourly_rate).replace(',', '.')) < MINDESTLOHN && (
                                  <div style={{ fontSize:11.5, color:'var(--danger)', marginTop:3 }}>{tr("ui.73d8e2d2f8fd")}</div>)}
                              </div>
                              <div className="form-group"><label>{tr("ui.a64008756943")}</label>
                                <input type="date" value={inviteJob.start_date} onChange={e => setInviteJob(j => ({ ...j, start_date:e.target.value }))} /></div>
                            </div>
                            <div className="two-col">
                              <div className="form-group"><label>{tr("ui.6d031af10da7")}</label>
                                <input value={inviteJob.position} placeholder={tr("ui.fccc61c8a5e6")} onChange={e => setInviteJob(j => ({ ...j, position:e.target.value }))} /></div>
                              <div className="form-group"><label>{tr("ui.f8b1ee737baf")}</label>
                                <select value={inviteJob.role} onChange={e => setInviteJob(j => ({ ...j, role:e.target.value }))}>
                                  <option value="employee">{tr("ui.d422e9b832d6")}</option><option value="manager">{tr("ui.0e60bc79039b")}</option>
                                </select></div>
                            </div>
                            <button type="button" className="btn btn-sm" onClick={() => setInviteJob(null)}>{tr("ui.aac3caf54542")}</button>
                          </>
                        )}
                      </div>
                    )}

                    <div className="alert alert-info" style={{ fontSize:12 }}>{tr("ui.10d3b51f09e6")}<strong>{tr("ui.b6d3b7a7cdb2")}</strong>{tr("ui.404bc11dd4d6")}{inviteModal.isNew
                        ? tr("ui.b676e8f23b4c")
                        : tr("ui.1e7378b4ebbd")}
                    </div>
                  </>
                ) : (
                  /* ── Einladungslink anzeigen ── */
                  <div>
                    <div style={{ textAlign:'center', marginBottom:20 }}>
                      <div style={{ fontSize:36, marginBottom:8 }}>✅</div>
                      <div style={{ fontWeight:600, fontSize:15 }}>{tr("ui.0977db7ba39e")}</div>
                      <div style={{ fontSize:13, color:'var(--text-secondary)', marginTop:4 }}>{tr("ui.2400f1d4e7a0")}{inviteResult.name ? <><strong>{inviteResult.name}</strong> ({inviteResult.email})</> : <strong>{inviteResult.email}</strong>}
                      </div>
                    </div>

                    <div style={{ background:'var(--bg)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px', marginBottom:14 }}>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:6, fontWeight:600 }}>{tr("ui.b384a0966e88")}</div>
                      <div style={{ fontSize:12, wordBreak:'break-all', color:'var(--accent)', fontFamily:'monospace' }}>
                        {inviteResult.link}
                      </div>
                    </div>

                    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                      <button className="btn btn-primary" style={{ flex:1 }} onClick={() => copyLink(inviteResult.link)}>{tr("ui.485a59faede5")}</button>
                      <a
                        href={whatsappLink(inviteResult.link, inviteResult.name, inviteResult.isNew)}
                        target="_blank" rel="noreferrer"
                        style={{ flex:1, background:'#25D366', color:'#fff', border:'none', borderRadius:8, padding:'9px 16px', textAlign:'center', textDecoration:'none', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}
                      >{tr("ui.675c3e374d06")}</a>
                    </div>
                    <div style={{ marginTop:12, fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>{tr("ui.b5c9ac67245e")}</div>
                  </div>
                )}
              </div>
              {!inviteResult && (
                <div className="modal-footer">
                  <button className="btn" onClick={() => setInviteModal(null)}>{tr("ui.f7ff1178af20")}</button>
                  <button className="btn btn-primary" onClick={createInvitation} disabled={inviteSaving}>
                    {inviteSaving ? tr("ui.2ec008516cee") : tr("ui.84596a7ec505")}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Zugang sperren ── */}
      {confirmDelActive && (
        <div className="modal-overlay" onClick={() => setConfirmDelActive(null)}>
          <div className="modal" style={{ maxWidth:420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{tr("ui.c9544328f44f")}</div>
              <button className="btn btn-sm" onClick={() => setConfirmDelActive(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>
              <strong>{confirmDelActive.first_name} {confirmDelActive.last_name}</strong> ({confirmDelActive.email}{tr("ui.88cd72890353")}<div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:8 }}>{tr("ui.530ce066fc36")}<strong>{tr("ui.f4cb6891b9e5")}</strong>.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirmDelActive(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-danger" onClick={() => setUserLocked(confirmDelActive, true)}>{tr("ui.a5bc472c57c3")}</button>
            </div>
          </div>
        </div>
      )}

      {roleConfirm && (
        <div className="modal-overlay" onClick={() => setRoleConfirm(null)}>
          <div className="modal" style={{ maxWidth:440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{roleConfirm.role === 'admin' ? tr("ui.cce2d65684a2") : tr("ui.906d8673add3")}</div>
              <button className="btn btn-sm" onClick={() => setRoleConfirm(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>
              <strong>{`${roleConfirm.p.first_name || ''} ${roleConfirm.p.last_name || ''}`.trim() || roleConfirm.p.email}</strong>
              {roleConfirm.role === 'admin' ? (
                <>
                  {' '}{tr("ui.0bdce1b4298a")}<div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:8 }}>{tr("ui.27f7f402477f")}</div>
                </>
              ) : (
                <>{tr("ui.0d348d936199")}{roleConfirm.role === 'manager' ? tr("ui.8b2085f74dfa") : tr("ui.f4cb6891b9e5")}.</>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setRoleConfirm(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className={`btn ${roleConfirm.role === 'admin' ? 'btn-primary' : 'btn-danger'}`} onClick={() => changeRole(roleConfirm.p.id, roleConfirm.role)}>
                {roleConfirm.role === 'admin' ? tr("ui.88f439250d2c") : tr("ui.982504b40012")}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRevoke && (
        <div className="modal-overlay" onClick={() => setConfirmRevoke(null)}>
          <div className="modal" style={{ maxWidth:420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{tr("ui.7bde82621548")}</div>
              <button className="btn btn-sm" onClick={() => setConfirmRevoke(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>{tr("ui.749a17d7ca56")}<strong>{confirmRevoke._name || confirmRevoke.email}</strong>
              {confirmRevoke._name ? <> ({confirmRevoke.email})</> : null}{tr("ui.e560e8577e34")}<em>{tr("ui.199f179164d1")}</em>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>{tr("ui.c1a4b0ab35a5")}</div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirmRevoke(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-danger" onClick={() => revokeInvitation(confirmRevoke)}>{tr("ui.53b0832683e3")}</button>
            </div>
          </div>
        </div>
      )}

      {reviewRow && (
        <OnboardingReview
          row={reviewRow} isAdmin={profile?.role === 'admin'}
          onClose={() => setReviewRow(null)}
          onDone={() => { setReviewRow(null); fetchAll(); refetch() }}
        />
      )}

      {/* ── 0. Neue Mitarbeiter (Selbst-Registrierung per Einladung) ── */}
      {(() => {
        const open = onboardings.filter(o => o.status !== 'approved' && o.status !== 'rejected')
          .sort((a, b) => (a.status === 'submitted' ? 0 : 1) - (b.status === 'submitted' ? 0 : 1))
        const toReview = open.filter(o => o.status === 'submitted').length
        if (!open.length) return null
        return (
          <div className="card" style={{ marginBottom:20 }}>
            <div className="card-header">
              <div className="card-title">{tr("ui.bda718ed2a41")}{toReview > 0 && <span style={{ background:'#C2793A', color:'#fff', borderRadius:10, fontSize:11, fontWeight:700, padding:'2px 8px', marginLeft:8 }}>{toReview}{tr("ui.4611166aec2a")}</span>}
              </div>
            </div>
            <div style={{ padding:'0 4px' }}>
              {open.map(o => {
                const st = ONB_STATUS[o.status] || { label:o.status, cls:'badge-gray' }
                const nm = `${o.first_name || ''} ${o.last_name || ''}`.trim()
                return (
                  <div key={o.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--border)', flexWrap:'wrap' }}>
                    <div style={{ flex:1, minWidth:180 }}>
                      <div style={{ fontWeight:500, fontSize:13 }}>{nm || o.email}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{nm ? o.email : tr("ui.060012a79ae3")}</div>
                    </div>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {o.status === 'submitted'
                      ? <button className="btn btn-primary btn-sm" onClick={() => setReviewRow(o)}>{tr("ui.a1ca13575987")}</button>
                      : <button className="btn btn-sm" onClick={() => setReviewRow(o)}>{tr("ui.8e31363947a6")}</button>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* ── 1. Mitarbeiter ohne Account ── */}
        {(employeesWithoutAccount.length > 0 || hiddenNoAccount.length > 0) && (
          <div className="card" style={{ marginBottom:20 }}>
            <div className="card-header">
              <div className="card-title">{tr("ui.0ceff9763210")}{employeesWithoutAccount.length > 0 && (
                  <span style={{ background:'#DC2626', color:'#fff', borderRadius:10, fontSize:11, fontWeight:700, padding:'2px 8px', marginLeft:8 }}>
                    {employeesWithoutAccount.length}
                  </span>
                )}
              </div>
            </div>
            <div style={{ padding:'0 4px' }}>
              {employeesWithoutAccount.map(emp => {
                const hasInvite = invitations.find(i => i.employee_id === emp.id)
                return (
                  <div key={emp.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--border)' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:500, fontSize:13 }}>{emp.first_name} {emp.last_name}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{emp.email || tr("ui.ee2c44a92028")}{emp.position ? ` · ${emp.position}` : ''}</div>
                    </div>
                    {hasInvite ? (
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', justifyContent:'flex-end' }}>
                        <span style={{ fontSize:11, color:'#D97706', background:'#FEF3C7', borderRadius:99, padding:'3px 10px', fontWeight:600 }}>{tr("ui.5070fbd2de5e")}</span>
                        <button className="btn btn-sm" onClick={() => openInvite(emp)}>{tr("ui.138f79b619c9")}</button>
                        <button className="btn btn-sm btn-danger" onClick={() => setConfirmRevoke({ ...hasInvite, _name: `${emp.first_name} ${emp.last_name}` })}>{tr("ui.53b0832683e3")}</button>
                      </div>
                    ) : (
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', justifyContent:'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => setAccessHidden(emp, true)}
                          title={tr("ui.c73816974b26")}>{tr("ui.0f8fc1d1ac83")}</button>
                        <button className="btn btn-primary btn-sm" onClick={() => openInvite(emp)}>{tr("ui.09b04b14c98a")}</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ padding:'10px 16px', fontSize:12, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>{tr("ui.afc0d8ce0dc9")}<strong>{tr("ui.0bc7d423fd4f")}</strong>{tr("ui.d61bffd0633b")}{hiddenNoAccount.length > 0 && (
                <button className="btn btn-sm" style={{ marginLeft:8 }} onClick={() => setShowHidden(v => !v)}>
                  {showHidden ? tr("ui.7b74aaf8958f") : tr("ui.40b305ca73b9", { p1: (hiddenNoAccount.length) })}
                </button>
              )}
            </div>
            {showHidden && hiddenNoAccount.map(emp => (
              <div key={emp.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderTop:'1px solid var(--border)', opacity:0.75 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:500, fontSize:13 }}>{emp.first_name} {emp.last_name} <span className="badge badge-gray" style={{ marginLeft:6 }}>{tr("ui.41dd4d209364")}</span></div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{emp.email || tr("ui.ee2c44a92028")}</div>
                </div>
                <button className="btn btn-sm" onClick={() => setAccessHidden(emp, false)}>{tr("ui.68ba7612d5c1")}</button>
              </div>
            ))}
          </div>
        )}

        {/* ── 2. Aktive Einladungen ── */}
        {invitations.length > 0 && (
          <div className="card" style={{ marginBottom:20 }}>
            <div className="card-header">
              <div className="card-title">{tr("ui.1e0b736fcd7e")}{invitations.length})</div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{tr("ui.f4cb6891b9e5")}</th><th>{tr("ui.9b27905f51b6")}</th><th>{tr("ui.0ac11a209702")}</th><th>{tr("ui.5656f92db78d")}</th></tr></thead>
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id}>
                      <td>{inv.employee_id
                        ? <strong>{inv.employees?.first_name} {inv.employees?.last_name}</strong>
                        : <span className="badge badge-accent">{tr("ui.b287790d200e")}</span>}</td>
                      <td>{inv.email}</td>
                      <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        {new Date(inv.expires_at).toLocaleDateString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric' })}
                        {(new Date(inv.expires_at).getTime() - Date.now()) < 86400000 * 2 && (
                          <span style={{ color:'#DC2626', marginLeft:6, fontSize:11 }}>{tr("ui.8d7e42e354a5")}</span>
                        )}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-sm" onClick={() => {
                            const link = `${window.location.origin}/?invite=${inv.token}`
                            copyLink(link)
                          }}>{tr("ui.485a59faede5")}</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setConfirmRevoke({ ...inv, _name: inv.employee_id ? `${inv.employees?.first_name || ''} ${inv.employees?.last_name || ''}`.trim() : '' })}>{tr("ui.2bd73709d0c7")}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 3. Ausstehende Genehmigungen (nur alte Registrierungen ohne Einladung) ── */}
        {pending.length > 0 && <div className="card" style={{ marginBottom:20 }}>
          <div className="card-header">
            <div className="card-title">{tr("ui.174777176b82")}{pending.length > 0 && (
                <span style={{ background:'#C2793A', color:'#fff', borderRadius:10, fontSize:11, fontWeight:700, padding:'2px 8px', marginLeft:8 }}>{pending.length}</span>
              )}
            </div>
          </div>
          {pending.length === 0 ? (
            <div className="empty-state"><div className="empty-state-icon">✅</div><div className="empty-state-text">{tr("ui.71fa660a69f7")}</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>{tr("ui.2fae6fb30b0d")}</th><th>{tr("ui.35c88d0cd1a7")}</th><th>{tr("ui.99b0d54d304a")}</th><th>{tr("ui.0038a9cf8661")}</th><th>{tr("ui.a4ad259e71cb")}</th></tr></thead>
                <tbody>
                  {pending.map(p => {
                    const form = pendingForms[p.id] || { role: 'employee', employee_id: '' }
                    return (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.first_name} {p.last_name}</strong>
                          <div style={{ fontSize:11, color:'var(--text-muted)' }}>{p.email}</div>
                        </td>
                        <td style={{ fontSize:12, color:'var(--text-secondary)' }}>{formatDate(p.created_at.split('T')[0])}</td>
                        <td>
                          <select value={form.employee_id||''} onChange={e => setPendingForm(p.id,'employee_id',e.target.value)} style={{ fontSize:13 }}>
                            <option value="">{tr("ui.ad8b6612ef74")}</option>
                            {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                          </select>
                        </td>
                        <td>
                          <select value={form.role||'employee'} onChange={e => setPendingForm(p.id,'role',e.target.value)} style={{ fontSize:13, width:'auto' }}>
                            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        </td>
                        <td>
                          <div className="flex gap-2">
                            <button className="btn btn-sm btn-success" disabled={working===p.id||!form.employee_id} onClick={() => approvePending(p)}>
                              {working===p.id?'...':tr("ui.d8ee0df1b99c")}
                            </button>
                            <button className="btn btn-sm btn-danger" onClick={() => setConfirmDel(p)}>✗</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>}

        {/* ── 4. Aktive Benutzer ── */}
        <div className="card">
          <div className="card-header"><div className="card-title">{tr("ui.59ba638d5437")}{approved.length})</div></div>
          <div className="table-wrap">
            {approved.length === 0 ? (
              <div className="empty-state"><div className="empty-state-text">{tr("ui.28693e7cfb0b")}</div></div>
            ) : (
              <table>
                <thead><tr><th>{tr("ui.2fae6fb30b0d")}</th><th>{tr("ui.f4cb6891b9e5")}</th><th>{tr("ui.0038a9cf8661")}</th><th>{tr("ui.0c40b32205a7")}</th><th></th></tr></thead>
                <tbody>
                  {approved.map(p => {
                    const emp      = employees.find(e => e.id === p.employee_id)
                    const isMe     = p.id === profile?.id
                    const isEdit   = editState[p.id] !== undefined
                    const selEmpId = isEdit ? editState[p.id] : (p.employee_id || '')
                    return (
                      <tr key={p.id} style={{ background: isMe ? 'var(--accent-light)' : undefined }}>
                        <td>
                          <div style={{ fontWeight:500, fontSize:13 }}>{p.first_name} {p.last_name}</div>
                          <div style={{ fontSize:11, color:'var(--text-muted)' }}>{p.email}</div>
                          {isMe && <span style={{ marginLeft:6, fontSize:10, color:'var(--accent)', fontWeight:600 }}>{tr("ui.26c2dd4bb013")}</span>}
                        </td>
                        <td>
                          {isEdit ? (
                            <div className="flex gap-2">
                              <select value={selEmpId} onChange={e => setEditState(prev => ({...prev, [p.id]: e.target.value}))} style={{ fontSize:12 }}>
                                <option value="">{tr("ui.2df680d72fec")}</option>
                                {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                              </select>
                              <button className="btn btn-sm btn-success" onClick={() => changeEmployeeLink(p.id, editState[p.id])}>✓</button>
                              <button className="btn btn-sm" onClick={() => setEditState(e => { const n={...e}; delete n[p.id]; return n })}>✕</button>
                            </div>
                          ) : (
                            <div className="flex gap-2" style={{ alignItems:'center' }}>
                              {emp
                                ? <span style={{ fontSize:13 }}>{emp.first_name} {emp.last_name}</span>
                                : <span style={{ fontSize:12, color:'#DC2626', fontWeight:500 }}>{tr("ui.f1f3286a7534")}</span>
                              }
                              {emp && (
                                <button className="btn btn-sm" style={{ fontSize:11, padding:'2px 8px' }}
                                  onClick={() => navigate(`/mitarbeiter?edit=${emp.id}`)}
                                  title={tr("ui.6b20e13e489f")}>{tr("ui.d94dcfb9f781")}</button>
                              )}
                              <button className="btn btn-sm" style={{ fontSize:10, padding:'2px 8px' }}
                                title={tr("ui.e51a13146efc")}
                                onClick={() => setEditState(e => ({...e, [p.id]: p.employee_id||''}))}>🔗</button>
                            </div>
                          )}
                        </td>
                        <td>
                          {isMe ? (
                            <span className="badge badge-red">👑 {p.is_owner ? tr("ui.32902b2c2759") : tr("ui.c1c224b03cd9")}{tr("ui.610d8f14304d")}</span>
                          ) : p.is_owner ? (
                            <span className="badge badge-red" title={tr("ui.9ae9dd92b093")}>{tr("ui.0ec3ebb416da")}</span>
                          ) : (
                            <select value={p.role} onChange={e => requestRoleChange(p, e.target.value)} style={{ fontSize:12, width:'auto' }}>
                              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          )}
                        </td>
                        <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                          {p.approved_at ? new Date(p.approved_at).toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'}) : '–'}
                        </td>
                        <td>
                          {!isMe && !p.is_owner && (
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => setConfirmDelActive(p)}
                              title={tr("ui.28c25402df55")}
                              style={{ fontSize:11 }}
                            >{tr("ui.a5bc472c57c3")}</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ padding:'10px 16px', fontSize:12, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>{tr("ui.a629fd998638")}{disabledUsers.length > 0 && (
              <button className="btn btn-sm" style={{ marginLeft:8 }} onClick={() => setShowDisabled(v => !v)}>
                {showDisabled ? tr("ui.7187c4352fdf") : tr("ui.f73b247b6c81", { p1: (disabledUsers.length) })}
              </button>
            )}
          </div>
          {showDisabled && disabledUsers.map(p => {
            const emp = employees.find(e => e.id === p.employee_id)
            return (
              <div key={p.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderTop:'1px solid var(--border)', flexWrap:'wrap' }}>
                <div style={{ flex:1, minWidth:180 }}>
                  <div style={{ fontWeight:500, fontSize:13 }}>
                    {`${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email}
                    <span className="badge badge-red" style={{ marginLeft:6 }}>{tr("ui.013c07bca5c7")}</span>
                  </div>
                  <div style={{ fontSize:12, color:'var(--text-muted)' }}>
                    {p.email}{emp ? tr("ui.164eedcd4fa2", { p1: (emp.first_name), p2: (emp.last_name), p3: (emp.is_active === false ? tr("employee.archivedSuffix") : '') }) : tr("ui.db2d4f68d7b9")}
                  </div>
                </div>
                {p.employee_id && (
                  <button className="btn btn-sm" disabled={working === p.id} onClick={() => setUserLocked(p, false)}>{tr("ui.63cc8acdcb73")}</button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
