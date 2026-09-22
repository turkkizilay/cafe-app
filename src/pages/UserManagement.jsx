import { useState, useEffect } from 'react'
import { supabase, formatDate } from '../lib/supabase'
import Avatar from '../components/UI/Avatar'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { logActivity } from '../lib/activityLog'

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
  const [loading,      setLoading]      = useState(true)
  const [working,      setWorking]      = useState(null)
  const [pendingForms, setPendingForms] = useState({})
  const [editState,    setEditState]    = useState({})
  const [confirmDel,        setConfirmDel]        = useState(null)
  const [confirmDelActive, setConfirmDelActive] = useState(null)

  // Einladungs-Modal
  const [inviteModal,  setInviteModal]  = useState(null) // { employee } | null
  const [inviteForm,   setInviteForm]   = useState({ email:'', role:'employee' })
  const [inviteResult, setInviteResult] = useState(null) // generierter Link
  const [inviteSaving, setInviteSaving] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    try {
    const [{ data: profiles }, { data: emps }, { data: invs }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('employees').select('id, first_name, last_name, email, position, avatar_url, avatar_color').order('last_name'),
      supabase.from('invitations').select('*, employees!employee_id(first_name, last_name)').is('used_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }),
    ])
    setPending((profiles  || []).filter(p => p.status === 'pending'))
    setApproved((profiles || []).filter(p => p.status === 'approved'))
    setEmployees(emps || [])
    setInvitations(invs || [])
    } catch(err) { toast.error('Fehler beim Laden: ' + err.message) }
    setLoading(false)
  }

  // ── Einladung erstellen ─────────────────────────────────────
  function openInvite(emp) {
    setInviteModal(emp)
    setInviteForm({ email: emp.email || '', role: 'employee' })
    setInviteResult(null)
  }

  async function createInvitation() {
    if (!inviteGuard.begin()) return
    if (!inviteForm.email?.trim()) { toast.warn('Bitte E-Mail eingeben'); inviteGuard.end(); return }
    setInviteSaving(true)

    const { data: inv, error } = await supabase.from('invitations').insert([{
      employee_id: inviteModal.id,
      email:       inviteForm.email.trim().toLowerCase(),
      role:        inviteForm.role,
      created_by:  profile?.id,
    }]).select().maybeSingle()

    if (error) {
      toast.error('Fehler: ' + error.message)
      setInviteSaving(false)
      return
    }

    const link = `${window.location.origin}/?invite=${inv.token}`
    setInviteResult({ link, name: `${inviteModal.first_name} ${inviteModal.last_name}`, email: inviteForm.email })
    setInviteSaving(false)
    fetchAll()
  }

  async function copyLink(link) {
    try {
      await navigator.clipboard.writeText(link)
      toast.success('✅ Link kopiert!')
    } catch {
      toast.warn('Bitte Link manuell kopieren.')
    }
  }

  function whatsappLink(link, name) {
    const msg = encodeURIComponent(`Hallo ${name}! 👋\n\nDu wurdest zum Café Buur Personalverwaltungssystem eingeladen.\n\nBitte klicke auf diesen Link und setze dein Passwort:\n${link}\n\nDer Link ist 7 Tage gültig. ☕`)
    return `https://wa.me/?text=${msg}`
  }

  async function revokeInvitation(id) {
    if (!revokeGuard.begin()) return
    await supabase.from('invitations').update({ used_at: new Date().toISOString() }).eq('id', id)
    toast.info('Einladung widerrufen.')
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
  const employeesWithoutAccount = employees.filter(emp =>
    !approved.find(p => p.employee_id === emp.id) &&
    !pending.find(p => p.employee_id === emp.id)
  )

  if (loading) return <div style={{ padding: 24 }}>Lädt...</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Benutzerverwaltung</div>
        <div className="topbar-right" style={{ fontSize:12, color:'var(--text-secondary)' }}>
          Nur der Admin kann hier Änderungen vornehmen
        </div>
      </div>

      <div className="content">

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
                <div className="modal-title">📨 Mitarbeiter einladen</div>
                <button className="btn btn-sm" onClick={() => { setInviteModal(null); setInviteResult(null) }}>✕</button>
              </div>
              <div className="modal-body">
                {!inviteResult ? (
                  <>
                    <div style={{ background:'var(--accent-light)', borderRadius:10, padding:'12px 16px', marginBottom:16 }}>
                      <div style={{ fontWeight:600 }}>{inviteModal.first_name} {inviteModal.last_name}</div>
                      {inviteModal.position && <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{inviteModal.position}</div>}
                    </div>

                    <div className="form-group">
                      <label>E-Mail des Mitarbeiters</label>
                      <input type="email" value={inviteForm.email} onChange={e => setInviteForm(f => ({...f, email: e.target.value}))}
                        placeholder="mitarbeiter@email.de" />
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>
                        Mit dieser E-Mail wird sich der Mitarbeiter einloggen.
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Rolle</label>
                      <select value={inviteForm.role} onChange={e => setInviteForm(f => ({...f, role: e.target.value}))}>
                        {ROLES.filter(r => r.value !== 'admin').map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>

                    <div className="alert alert-info" style={{ fontSize:12 }}>
                      📋 Der Einladungslink ist <strong>7 Tage gültig</strong>. Der Mitarbeiter klickt den Link und setzt sein Passwort — er ist danach sofort eingeloggt und mit seinem Profil verknüpft.
                    </div>
                  </>
                ) : (
                  /* ── Einladungslink anzeigen ── */
                  <div>
                    <div style={{ textAlign:'center', marginBottom:20 }}>
                      <div style={{ fontSize:36, marginBottom:8 }}>✅</div>
                      <div style={{ fontWeight:600, fontSize:15 }}>Einladungslink erstellt!</div>
                      <div style={{ fontSize:13, color:'var(--text-secondary)', marginTop:4 }}>
                        Für: <strong>{inviteResult.name}</strong> ({inviteResult.email})
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
                        href={whatsappLink(inviteResult.link, inviteResult.name)}
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

      {/* ── 1. Mitarbeiter ohne Account ── */}
        {employeesWithoutAccount.length > 0 && (
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
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ fontSize:11, color:'#D97706', background:'#FEF3C7', borderRadius:99, padding:'3px 10px', fontWeight:600 }}>⏳ Einladung ausstehend</span>
                        <button className="btn btn-sm" onClick={() => openInvite(emp)}>Erneut einladen</button>
                      </div>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => openInvite(emp)}>
                        📨 Einladen
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ padding:'10px 16px', fontSize:12, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
              💡 Diese Mitarbeiter haben noch keinen App-Zugang. Klicke "Einladen" um einen Link zu generieren.
            </div>
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
                      <td><strong>{inv.employees?.first_name} {inv.employees?.last_name}</strong></td>
                      <td>{inv.email}</td>
                      <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        {formatDate(inv.expires_at.split('T')[0])}
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
                          <button className="btn btn-sm btn-danger" onClick={() => revokeInvitation(inv.id)}>✗ Widerrufen</button>
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
                              <button className="btn btn-sm" style={{ fontSize:10, padding:'2px 8px' }} onClick={() => setEditState(e => ({...e, [p.id]: p.employee_id||''}))}>✏️</button>
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
            💡 ✏️ = Mitarbeiter-Verknüpfung ändern · ⚠️ Rot = kein Mitarbeiter verknüpft
          </div>
        </div>
      </div>
    </>
  )
}
