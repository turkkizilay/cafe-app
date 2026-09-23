import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MINDESTLOHN } from '../lib/constants'
import { supabase, formatDate, toLocalDateStr } from '../lib/supabase'
import Avatar from '../components/UI/Avatar'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { logActivity } from '../lib/activityLog'
import OnboardingReview, { ONB_STATUS } from '../components/OnboardingReview'

const ROLES = [
  { value: 'employee', label: '👤 Mitarbeiter' },
  { value: 'manager',  label: '🔧 Manager' },
  { value: 'admin',    label: '👑 Admin' },
]

export default function UserManagement() {
  const { refetch, profile } = useProfile()
  const toast       = useToast()
  const inviteGuard  = useSavingGuard()
  const approveGuard = useSavingGuard()
  const revokeGuard  = useSavingGuard()
  const rejectGuard  = useSavingGuard()
  const deleteGuard  = useSavingGuard()

  const [pending,      setPending]      = useState([])
  const [approved,     setApproved]     = useState([])
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
    } catch(err) { toast.error('Fehler beim Laden: ' + err.message) }
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
    if (!email) { toast.warn('Bitte E-Mail eingeben'); inviteGuard.end(); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast.warn('Bitte eine gültige E-Mail-Adresse eingeben.'); inviteGuard.end(); return }
    const isNew = !!inviteModal.isNew
    let job = null
    if (isNew && inviteJob) {
      const rate = parseFloat(String(inviteJob.hourly_rate || '').replace(',', '.'))
      const hours = parseFloat(String(inviteJob.hours_per_week || '').replace(',', '.'))
      if (inviteJob.hourly_rate && (!rate || rate <= 0)) { toast.warn('Bitte einen gültigen Stundenlohn eingeben (oder leer lassen).'); inviteGuard.end(); return }
      if (inviteJob.hours_per_week && (!hours || hours <= 0 || hours > 60)) { toast.warn('Bitte die Wochenstunden prüfen (1–60).'); inviteGuard.end(); return }
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
          toast.warn(reg.reason === 'auth'
            ? 'Mit dieser E-Mail gibt es bereits einen Login.'
            : 'Diese E-Mail gehört bereits zu einem Mitarbeiter. Bitte dort unter „Mitarbeiter ohne Account" einladen.')
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

      if (error || !inv) { toast.error('Einladung konnte nicht erstellt werden. Bitte erneut versuchen.'); return }

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
      toast.success('✅ Link kopiert!')
    } catch {
      toast.warn('Bitte Link manuell kopieren.')
    }
  }

  function whatsappLink(link, name, isNew) {
    const msg = encodeURIComponent(isNew
      ? `Hallo! 👋\n\nWillkommen bei Café Buur! Über diesen Link legst du deinen Zugang zur Personal-App an und trägst deine Daten für die Lohnabrechnung ein (IBAN, Steuer-ID, Sozialversicherungsnummer, Krankenkasse):\n${link}\n\nDer Link ist 7 Tage gültig. ☕`
      : `Hallo ${name}! 👋\n\nDu wurdest zum Café Buur Personalverwaltungssystem eingeladen.\n\nBitte klicke auf diesen Link und setze dein Passwort:\n${link}\n\nDer Link ist 7 Tage gültig. ☕`)
    return `https://wa.me/?text=${msg}`
  }

  // Einladung zurückziehen: Link wird sofort ungültig. Öffnet die Person ihn trotzdem,
  // sieht sie „Diese Einladung wurde zurückgezogen“. Protokoll schreibt die Datenbank.
  async function revokeInvitation(inv) {
    if (!revokeGuard.begin()) return
    try {
      const { data, error } = await supabase.rpc('revoke_invitation', { p_id: inv.id })
      if (error || !data?.success) {
        toast.error(data?.error || 'Die Einladung konnte nicht zurückgezogen werden. Bitte erneut versuchen.', 9000)
      } else {
        toast.success('Einladung zurückgezogen. Der Link funktioniert nicht mehr.')
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
    if (error) { toast.error('Das hat nicht geklappt. Bitte erneut versuchen.'); return }
    toast.info(hidden ? `${emp.first_name} ${emp.last_name} ausgeblendet.` : `${emp.first_name} ${emp.last_name} wieder eingeblendet.`)
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
    toast.info('⏳ Freischalten wird gestartet...')
    if (!approveGuard.begin()) {
      toast.error('❌ Guard blockiert — bitte Seite neu laden')
      return
    }
    const form = pendingForms[p.id] || { role: 'employee', employee_id: '' }
    if (!form.employee_id) {
      toast.warn('⚠️ Bitte zuerst einen Mitarbeiter aus der Liste zuweisen!')
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
        toast.error('❌ Fehler: ' + error.message)
      } else {
        toast.success(`✅ ${p.email} freigeschaltet!`)
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
      toast.error('❌ Exception: ' + err.message)
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
    toast.info('Account abgelehnt und gelöscht.')
    rejectGuard.end()
    setConfirmDel(null); fetchAll(); setWorking(null)
  }

  async function deleteActiveUser(p) {
    if (!deleteGuard.begin()) return
    setWorking(p.id)
    const { error } = await supabase.from('profiles').delete().eq('id', p.id)
    if (error) {
      toast.error('Fehler: ' + error.message)
    } else {
      deleteGuard.end()
    toast.success(`Account "${p.email}" gelöscht. Bitte auch in Supabase → Authentication → Users entfernen.`, 8000)
      logActivity({
        action: 'employee.deleted', category: 'employee',
        summary: `hat den Account ${p.email} gelöscht.`,
        targetType: 'profile', targetId: p.id, targetName: p.email,
      })
      fetchAll(); refetch()
    }
    setConfirmDelActive(null)
    setWorking(null)
  }

  async function changeRole(profileId, role) {
    if (profileId === profile?.id) { toast.error('Eigene Rolle kann nicht geändert werden!'); return }
    const { error } = await supabase.from('profiles').update({ role }).eq('id', profileId)
    if (error) toast.error('Fehler: ' + error.message)
    else {
      toast.success('Rolle aktualisiert ✅')
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
    if (error) toast.error('Fehler: ' + error.message)
    else {
      toast.success('Verknüpfung aktualisiert ✅')
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

  if (loading) return <div style={{ padding: 24 }}>Lädt...</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Benutzerverwaltung</div>
        <div className="topbar-right">
          <button className="btn btn-primary btn-sm" onClick={() => openInvite(null)}>➕ Neuen Mitarbeiter einladen</button>
        </div>
      </div>

      <div className="content">
        <div style={{ fontSize:12.5, color:'var(--text-secondary)', background:'var(--bg-white)', border:'1px solid var(--border)', borderRadius:10, padding:'10px 14px', marginBottom:16, lineHeight:1.6 }}>
          🔑 <strong>Hier:</strong> Logins, Einladungen, Freischaltung und Rollen.
          💶 <strong>Lohn, Stunden, Urlaub, Adresse, Bank:</strong> unter <a href="/mitarbeiter" onClick={e => { e.preventDefault(); navigate('/mitarbeiter') }}>Mitarbeiter</a> — oder direkt über „Stammdaten“ in der Liste unten.
        </div>

        {/* ── Inline Bestätigungsdialog ── */}
        {confirmDel && (
          <div className="modal-overlay" onClick={() => setConfirmDel(null)}>
            <div className="modal" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header"><div className="modal-title">Account ablehnen</div><button className="btn btn-sm" onClick={() => setConfirmDel(null)}>✕</button></div>
              <div className="modal-body"><div className="alert alert-danger">Account <strong>{confirmDel.email}</strong> wirklich ablehnen und löschen?</div></div>
              <div className="modal-footer">
                <button className="btn" onClick={() => setConfirmDel(null)}>Abbrechen</button>
                <button className="btn btn-danger" onClick={confirmReject}>✗ Ablehnen & löschen</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Einladungs-Modal ── */}
        {inviteModal && (
          <div className="modal-overlay" onClick={() => { setInviteModal(null); setInviteResult(null) }}>
            <div className="modal" style={{ maxWidth:460 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-title">{inviteModal.isNew ? '📨 Neuen Mitarbeiter einladen' : '📨 Mitarbeiter einladen'}</div>
                <button className="btn btn-sm" onClick={() => { setInviteModal(null); setInviteResult(null) }}>✕</button>
              </div>
              <div className="modal-body">
                {!inviteResult ? (
                  <>
                    {inviteModal.isNew ? (
                      <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:13, lineHeight:1.6 }}>
                        Der neue Mitarbeiter legt über den Link selbst seinen Zugang an und trägt seine
                        Personaldaten ein. Danach prüfst du alles hier und legst Stundenlohn, Rolle und
                        Beschäftigungsart fest.
                      </div>
                    ) : (
                      <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'12px 16px', marginBottom:16 }}>
                        <div style={{ fontWeight:600 }}>{inviteModal.first_name} {inviteModal.last_name}</div>
                        {inviteModal.position && <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{inviteModal.position}</div>}
                      </div>
                    )}

                    <div className="form-group">
                      <label>E-Mail des Mitarbeiters</label>
                      <input type="email" value={inviteForm.email} onChange={e => setInviteForm(f => ({...f, email: e.target.value}))}
                        placeholder="mitarbeiter@email.de" />
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>
                        Mit dieser E-Mail wird sich der Mitarbeiter einloggen.
                      </div>
                    </div>

                    {!inviteModal.isNew && <div className="form-group">
                      <label>Rolle</label>
                      <select value={inviteForm.role} onChange={e => setInviteForm(f => ({...f, role: e.target.value}))}>
                        {ROLES.filter(r => r.value !== 'admin').map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>}

                    {inviteModal.isNew && (
                      <div style={{ border:'1px solid var(--border)', borderRadius:10, padding:'10px 12px', marginBottom:14 }}>
                        {!inviteJob ? (
                          <button type="button" className="btn btn-sm" onClick={() => setInviteJob({ role:'employee', position:'', employment_type:'minijob', hours_per_week:10, hourly_rate:'', start_date: toLocalDateStr(), vacation_days:28 })}>
                            💶 Lohn & Stunden schon jetzt festlegen (optional)
                          </button>
                        ) : (
                          <>
                            <div style={{ fontWeight:600, fontSize:13, marginBottom:8 }}>💶 Arbeitsvertrag (wird beim Freischalten vorausgefüllt)</div>
                            <div className="two-col">
                              <div className="form-group"><label>Beschäftigung</label>
                                <select value={inviteJob.employment_type} onChange={e => { const t = e.target.value; setInviteJob(j => ({ ...j, employment_type:t, hours_per_week:{ vollzeit:40, teilzeit:20, werkstudent:20, minijob:10 }[t] })) }}>
                                  <option value="vollzeit">Vollzeit</option><option value="teilzeit">Teilzeit</option>
                                  <option value="werkstudent">Werkstudent</option><option value="minijob">Minijob</option>
                                </select></div>
                              <div className="form-group"><label>Stunden/Woche</label>
                                <input type="number" min="1" max="60" value={inviteJob.hours_per_week} onChange={e => setInviteJob(j => ({ ...j, hours_per_week:e.target.value }))} /></div>
                            </div>
                            <div className="two-col">
                              <div className="form-group"><label>Stundenlohn (€)</label>
                                <input inputMode="decimal" value={inviteJob.hourly_rate} placeholder={String(MINDESTLOHN).replace('.', ',')}
                                  onChange={e => setInviteJob(j => ({ ...j, hourly_rate:e.target.value.replace(/[^0-9.,]/g, '') }))} />
                                {parseFloat(String(inviteJob.hourly_rate).replace(',', '.')) < MINDESTLOHN && (
                                  <div style={{ fontSize:11.5, color:'var(--danger)', marginTop:3 }}>⚠️ Unter Mindestlohn</div>)}
                              </div>
                              <div className="form-group"><label>Eintrittsdatum</label>
                                <input type="date" value={inviteJob.start_date} onChange={e => setInviteJob(j => ({ ...j, start_date:e.target.value }))} /></div>
                            </div>
                            <div className="two-col">
                              <div className="form-group"><label>Position</label>
                                <input value={inviteJob.position} placeholder="Barista, Service, Küche…" onChange={e => setInviteJob(j => ({ ...j, position:e.target.value }))} /></div>
                              <div className="form-group"><label>Rolle in der App</label>
                                <select value={inviteJob.role} onChange={e => setInviteJob(j => ({ ...j, role:e.target.value }))}>
                                  <option value="employee">👤 Mitarbeiter</option><option value="manager">🔧 Manager</option>
                                </select></div>
                            </div>
                            <button type="button" className="btn btn-sm" onClick={() => setInviteJob(null)}>Doch erst beim Freischalten festlegen</button>
                          </>
                        )}
                      </div>
                    )}

                    <div className="alert alert-info" style={{ fontSize:12 }}>
                      📋 Der Einladungslink ist <strong>7 Tage gültig</strong> und funktioniert nur mit dieser E-Mail-Adresse. {inviteModal.isNew
                        ? 'Nach dem Passwort bestätigt der Mitarbeiter seine E-Mail und füllt dann seine Personaldaten aus.'
                        : 'Der Mitarbeiter setzt sein Passwort, bestätigt seine E-Mail und ist danach mit seinem Profil verknüpft.'}
                    </div>
                  </>
                ) : (
                  /* ── Einladungslink anzeigen ── */
                  <div>
                    <div style={{ textAlign:'center', marginBottom:20 }}>
                      <div style={{ fontSize:36, marginBottom:8 }}>✅</div>
                      <div style={{ fontWeight:600, fontSize:15 }}>Einladungslink erstellt!</div>
                      <div style={{ fontSize:13, color:'var(--text-secondary)', marginTop:4 }}>
                        Für: {inviteResult.name ? <><strong>{inviteResult.name}</strong> ({inviteResult.email})</> : <strong>{inviteResult.email}</strong>}
                      </div>
                    </div>

                    <div style={{ background:'var(--bg)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px', marginBottom:14 }}>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:6, fontWeight:600 }}>EINLADUNGSLINK (7 Tage gültig):</div>
                      <div style={{ fontSize:12, wordBreak:'break-all', color:'var(--accent)', fontFamily:'monospace' }}>
                        {inviteResult.link}
                      </div>
                    </div>

                    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                      <button className="btn btn-primary" style={{ flex:1 }} onClick={() => copyLink(inviteResult.link)}>
                        📋 Link kopieren
                      </button>
                      <a
                        href={whatsappLink(inviteResult.link, inviteResult.name, inviteResult.isNew)}
                        target="_blank" rel="noreferrer"
                        style={{ flex:1, background:'#25D366', color:'#fff', border:'none', borderRadius:8, padding:'9px 16px', textAlign:'center', textDecoration:'none', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}
                      >
                        💬 Per WhatsApp senden
                      </a>
                    </div>
                    <div style={{ marginTop:12, fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>
                      Tipp: Schick den Link auch per iMessage oder E-Mail
                    </div>
                  </div>
                )}
              </div>
              {!inviteResult && (
                <div className="modal-footer">
                  <button className="btn" onClick={() => setInviteModal(null)}>Abbrechen</button>
                  <button className="btn btn-primary" onClick={createInvitation} disabled={inviteSaving}>
                    {inviteSaving ? '⏳ Wird erstellt…' : '📨 Einladungslink erstellen'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Lösch-Modal für aktive Accounts ── */}
      {confirmDelActive && (
        <div className="modal-overlay" onClick={() => setConfirmDelActive(null)}>
          <div className="modal" style={{ maxWidth:400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">🗑 Account löschen</div>
              <button className="btn btn-sm" onClick={() => setConfirmDelActive(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="alert alert-danger" style={{ marginBottom:12 }}>
                Account <strong>{confirmDelActive.first_name} {confirmDelActive.last_name}</strong><br/>
                <small style={{ color:'var(--text-muted)' }}>{confirmDelActive.email}</small><br/><br/>
                wirklich löschen?
              </div>
              <div style={{ fontSize:12, color:'var(--text-secondary)', background:'var(--bg)', borderRadius:8, padding:'10px 12px' }}>
                ⚠️ Der Login-Account bleibt in Supabase bestehen. Für vollständige Löschung bitte zusätzlich unter:<br/>
                <strong>Supabase → Authentication → Users</strong> entfernen.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirmDelActive(null)}>Abbrechen</button>
              <button className="btn btn-danger" onClick={() => deleteActiveUser(confirmDelActive)}>
                🗑 Ja, löschen
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRevoke && (
        <div className="modal-overlay" onClick={() => setConfirmRevoke(null)}>
          <div className="modal" style={{ maxWidth:420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Einladung zurückziehen?</div>
              <button className="btn btn-sm" onClick={() => setConfirmRevoke(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>
              Die Einladung für <strong>{confirmRevoke._name || confirmRevoke.email}</strong>
              {confirmRevoke._name ? <> ({confirmRevoke.email})</> : null} wird sofort ungültig.
              Öffnet die Person den Link trotzdem, sieht sie: <em>„Diese Einladung wurde zurückgezogen.“</em>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>
                Du kannst jederzeit eine neue Einladung verschicken.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirmRevoke(null)}>Abbrechen</button>
              <button className="btn btn-danger" onClick={() => revokeInvitation(confirmRevoke)}>Zurückziehen</button>
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
              <div className="card-title">
                🧾 Neue Mitarbeiter
                {toReview > 0 && <span style={{ background:'#C2793A', color:'#fff', borderRadius:10, fontSize:11, fontWeight:700, padding:'2px 8px', marginLeft:8 }}>{toReview} zu prüfen</span>}
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
                      <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{nm ? o.email : 'Hat noch keine Daten eingetragen'}</div>
                    </div>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {o.status === 'submitted'
                      ? <button className="btn btn-primary btn-sm" onClick={() => setReviewRow(o)}>Prüfen</button>
                      : <button className="btn btn-sm" onClick={() => setReviewRow(o)}>Ansehen</button>}
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
              <div className="card-title">
                👤 Mitarbeiter ohne Account
                <span style={{ background:'#DC2626', color:'#fff', borderRadius:10, fontSize:11, fontWeight:700, padding:'2px 8px', marginLeft:8 }}>
                  {employeesWithoutAccount.length}
                </span>
              </div>
            </div>
            <div style={{ padding:'0 4px' }}>
              {employeesWithoutAccount.map(emp => {
                const hasInvite = invitations.find(i => i.employee_id === emp.id)
                return (
                  <div key={emp.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--border)' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:500, fontSize:13 }}>{emp.first_name} {emp.last_name}</div>
                      <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{emp.email || 'Keine E-Mail'}{emp.position ? ` · ${emp.position}` : ''}</div>
                    </div>
                    {hasInvite ? (
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', justifyContent:'flex-end' }}>
                        <span style={{ fontSize:11, color:'#D97706', background:'#FEF3C7', borderRadius:99, padding:'3px 10px', fontWeight:600 }}>⏳ Einladung ausstehend</span>
                        <button className="btn btn-sm" onClick={() => openInvite(emp)}>Neuer Link</button>
                        <button className="btn btn-sm btn-danger" onClick={() => setConfirmRevoke({ ...hasInvite, _name: `${emp.first_name} ${emp.last_name}` })}>Zurückziehen</button>
                      </div>
                    ) : (
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', justifyContent:'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => setAccessHidden(emp, true)}
                          title="Für Mitarbeiter, die die App nicht nutzen. Sie bleiben im Schichtplan und in der Lohnabrechnung.">
                          Kein Zugang nötig
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={() => openInvite(emp)}>
                          📨 Einladen
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ padding:'10px 16px', fontSize:12, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
              💡 Diese Mitarbeiter haben noch keinen App-Zugang. „Einladen“ erzeugt einen Link. „Kein Zugang nötig“ blendet sie hier aus —
              sie bleiben aktiv im Schichtplan und in der Lohnabrechnung. Ehemalige Mitarbeiter bitte unter <strong>Mitarbeiter → Deaktivieren</strong> archivieren.
              {hiddenNoAccount.length > 0 && (
                <button className="btn btn-sm" style={{ marginLeft:8 }} onClick={() => setShowHidden(v => !v)}>
                  {showHidden ? 'Ausgeblendete verbergen' : `Ausgeblendete anzeigen (${hiddenNoAccount.length})`}
                </button>
              )}
            </div>
            {showHidden && hiddenNoAccount.map(emp => (
              <div key={emp.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderTop:'1px solid var(--border)', opacity:0.75 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:500, fontSize:13 }}>{emp.first_name} {emp.last_name} <span className="badge badge-gray" style={{ marginLeft:6 }}>kein Zugang nötig</span></div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{emp.email || 'Keine E-Mail'}</div>
                </div>
                <button className="btn btn-sm" onClick={() => setAccessHidden(emp, false)}>Wieder einblenden</button>
              </div>
            ))}
          </div>
        )}

        {/* ── 2. Aktive Einladungen ── */}
        {invitations.length > 0 && (
          <div className="card" style={{ marginBottom:20 }}>
            <div className="card-header">
              <div className="card-title">📨 Aktive Einladungen ({invitations.length})</div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Mitarbeiter</th><th>E-Mail (Einladung)</th><th>Läuft ab</th><th>Aktionen</th></tr></thead>
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id}>
                      <td>{inv.employee_id
                        ? <strong>{inv.employees?.first_name} {inv.employees?.last_name}</strong>
                        : <span className="badge badge-accent">Neuer Mitarbeiter</span>}</td>
                      <td>{inv.email}</td>
                      <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        {new Date(inv.expires_at).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' })}
                        {(new Date(inv.expires_at).getTime() - Date.now()) < 86400000 * 2 && (
                          <span style={{ color:'#DC2626', marginLeft:6, fontSize:11 }}>⚠️ Bald</span>
                        )}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-sm" onClick={() => {
                            const link = `${window.location.origin}/?invite=${inv.token}`
                            copyLink(link)
                          }}>📋 Link kopieren</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setConfirmRevoke({ ...inv, _name: inv.employee_id ? `${inv.employees?.first_name || ''} ${inv.employees?.last_name || ''}`.trim() : '' })}>✗ Zurückziehen</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 3. Ausstehende Genehmigungen ── */}
        <div className="card" style={{ marginBottom:20 }}>
          <div className="card-header">
            <div className="card-title">
              ⏳ Ausstehende Genehmigungen
              {pending.length > 0 && (
                <span style={{ background:'#C2793A', color:'#fff', borderRadius:10, fontSize:11, fontWeight:700, padding:'2px 8px', marginLeft:8 }}>{pending.length}</span>
              )}
            </div>
          </div>
          {pending.length === 0 ? (
            <div className="empty-state"><div className="empty-state-icon">✅</div><div className="empty-state-text">Keine ausstehenden Anfragen</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>E-Mail</th><th>Registriert</th><th>Mitarbeiter zuweisen</th><th>Rolle</th><th>Aktion</th></tr></thead>
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
                            <option value="">— Mitarbeiter wählen —</option>
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
                              {working===p.id?'...':'✓ Freischalten'}
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
        </div>

        {/* ── 4. Aktive Benutzer ── */}
        <div className="card">
          <div className="card-header"><div className="card-title">✅ Aktive Benutzer ({approved.length})</div></div>
          <div className="table-wrap">
            {approved.length === 0 ? (
              <div className="empty-state"><div className="empty-state-text">Noch keine freigeschalteten Benutzer</div></div>
            ) : (
              <table>
                <thead><tr><th>E-Mail</th><th>Mitarbeiter</th><th>Rolle</th><th>Freigeschaltet</th><th></th></tr></thead>
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
                          {isMe && <span style={{ marginLeft:6, fontSize:10, color:'var(--accent)', fontWeight:600 }}>← Du</span>}
                        </td>
                        <td>
                          {isEdit ? (
                            <div className="flex gap-2">
                              <select value={selEmpId} onChange={e => setEditState(prev => ({...prev, [p.id]: e.target.value}))} style={{ fontSize:12 }}>
                                <option value="">— Kein Mitarbeiter —</option>
                                {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                              </select>
                              <button className="btn btn-sm btn-success" onClick={() => changeEmployeeLink(p.id, editState[p.id])}>✓</button>
                              <button className="btn btn-sm" onClick={() => setEditState(e => { const n={...e}; delete n[p.id]; return n })}>✕</button>
                            </div>
                          ) : (
                            <div className="flex gap-2" style={{ alignItems:'center' }}>
                              {emp
                                ? <span style={{ fontSize:13 }}>{emp.first_name} {emp.last_name}</span>
                                : <span style={{ fontSize:12, color:'#DC2626', fontWeight:500 }}>⚠️ Nicht verknüpft</span>
                              }
                              {emp && (
                                <button className="btn btn-sm" style={{ fontSize:11, padding:'2px 8px' }}
                                  onClick={() => navigate(`/mitarbeiter?edit=${emp.id}`)}
                                  title="Lohn, Stunden, Urlaub, Adresse, Bank bearbeiten">💶 Stammdaten</button>
                              )}
                              <button className="btn btn-sm" style={{ fontSize:10, padding:'2px 8px' }}
                                title="Login mit einem anderen Mitarbeiter-Datensatz verknüpfen"
                                onClick={() => setEditState(e => ({...e, [p.id]: p.employee_id||''}))}>🔗</button>
                            </div>
                          )}
                        </td>
                        <td>
                          {isMe ? (
                            <span className="badge badge-red">👑 Admin (du)</span>
                          ) : (
                            <select value={p.role} onChange={e => changeRole(p.id, e.target.value)} style={{ fontSize:12, width:'auto' }}>
                              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          )}
                        </td>
                        <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                          {p.approved_at ? new Date(p.approved_at).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–'}
                        </td>
                        <td>
                          {!isMe && (
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => setConfirmDelActive(p)}
                              title="Account löschen"
                              style={{ fontSize:11 }}
                            >
                              🗑
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ padding:'10px 16px', fontSize:12, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
            💡 💶 Stammdaten = Lohn & persönliche Daten bearbeiten · 🔗 = Login mit anderem Mitarbeiter verknüpfen · ⚠️ Rot = kein Mitarbeiter verknüpft
          </div>
        </div>
      </div>
    </>
  )
}
