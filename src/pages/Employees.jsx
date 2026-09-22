import { useState, useEffect, useRef } from 'react'
import Avatar from '../components/UI/Avatar'
import { supabase, getInitials, getAvatarColor, formatDate, formatCurrency, toLocalDateStr } from '../lib/supabase'
import { translateSupabaseError } from '../lib/errorHelper'
import { MINDESTLOHN } from '../lib/constants'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { useProfile } from '../context/ProfileContext'

const EMPTY = {
  first_name: '', last_name: '', email: '', phone: '', birth_date: '',
  position: '', employment_type: 'vollzeit', hours_per_week: 40,
  hourly_rate: '', start_date: (() => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` })(),
  vacation_days_per_year: 28, iban: '', address: '', notes: '',
}

const DOC_TYPES = {
  employment_contract: 'Arbeitsvertrag',
  contract_addendum:   'Vertragsnachtrag',
  certificate:         'Bescheinigung',
  agreement:           'Vereinbarung',
  personal_document:   'Personalunterlage',
  other:               'Sonstiges',
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 100)
}

function getTenure(startDate) {
  if (!startDate) return null
  const years  = Math.floor((Date.now() - new Date(startDate)) / (365.25 * 86400000))
  const months = Math.floor(((Date.now() - new Date(startDate)) % (365.25 * 86400000)) / (30.44 * 86400000))
  if (years > 0) return `${years}J ${months}M`
  return `${months} Mon.`
}

const EMP_TYPE = { vollzeit: 'Vollzeit', teilzeit: 'Teilzeit', werkstudent: 'Werkstudent', minijob: 'Minijob' }

export default function Employees() {
  const [employees, setEmployees] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)
  const [form,      setForm]      = useState(EMPTY)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [search,    setSearch]    = useState('')
  const [confirmDeact,   setConfirmDeact]   = useState(null)
  const [openClockIn,    setOpenClockIn]    = useState(false)
  const [showInactive,  setShowInactive]  = useState(false)

  // ── Dokumente (nur im Edit-Modal, Admin only) ──────────────
  const [empDocs,     setEmpDocs]     = useState([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [docForm,     setDocForm]     = useState({ document_type:'employment_contract', title:'', description:'', valid_from:'', valid_until:'' })
  const [docFile,     setDocFile]     = useState(null)
  const [docUploading, setDocUploading] = useState(false)
  const [docActionId,  setDocActionId]  = useState(null)  // 'id:open' | 'id:dl' | 'id:arch'
  const docFileRef = useRef(null)

  useEffect(() => { fetchEmployees() }, [showInactive])

  // ── Dokument-Funktionen (Admin only) ─────────────────────────
  async function fetchDocs(employeeId) {
    if (!employeeId) return
    setDocsLoading(true)
    const { data } = await supabase.from('employee_documents')
      .select('*').eq('employee_id', employeeId).order('uploaded_at', { ascending: false })
    setEmpDocs(data || [])
    setDocsLoading(false)
  }

  async function uploadDoc() {
    if (docUploading || !docFile || !docForm.title.trim() || !form.id) return
    setDocUploading(true)
    try {
      const docId   = crypto.randomUUID()
      const safeName = sanitizeFileName(docFile.name)
      const filePath = `${form.id}/${docForm.document_type}/${docId}/${safeName}`

      const { error: storErr } = await supabase.storage
        .from('employee-documents').upload(filePath, docFile, { cacheControl:'3600', upsert:false })
      if (storErr) { toast.error('Upload fehlgeschlagen: ' + storErr.message); return }

      const { error: dbErr } = await supabase.from('employee_documents').insert([{
        id: docId,
        employee_id:      form.id,
        document_type:    docForm.document_type,
        title:            docForm.title.trim(),
        description:      docForm.description.trim() || null,
        file_path:        filePath,
        file_name:        docFile.name,
        file_size:        docFile.size,
        mime_type:        docFile.type,
        uploaded_by:      profile?.id || null,
        uploaded_by_name: profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : null,
        uploaded_at:      new Date().toISOString(),
        valid_from:       docForm.valid_from || null,
        valid_until:      docForm.valid_until || null,
        is_active:        true,
      }])
      if (dbErr) {
        // Rollback Storage
        await supabase.storage.from('employee-documents').remove([filePath])
        toast.error('Dokument konnte nicht gespeichert werden: ' + dbErr.message)
        return
      }
      toast.success('✅ Dokument hochgeladen')
      setDocForm({ document_type:'employment_contract', title:'', description:'', valid_from:'', valid_until:'' })
      setDocFile(null)
      if (docFileRef.current) docFileRef.current.value = ''
      fetchDocs(form.id)
    } finally { setDocUploading(false) }
  }

  async function openDoc(doc) {
    if (docActionId) return
    setDocActionId(doc.id + ':open')
    try {
      const { data, error } = await supabase.storage
        .from('employee-documents').createSignedUrl(doc.file_path, 120)
      if (error) { toast.error('Fehler beim Öffnen: ' + error.message); return }
      window.open(data.signedUrl, '_blank')
    } finally { setDocActionId(null) }
  }

  async function downloadDoc(doc, employee) {
    if (docActionId) return
    setDocActionId(doc.id + ':dl')
    try {
      const typeName = DOC_TYPES[doc.document_type] || 'Dokument'
      const lastName = employee?.last_name?.replace(/\s+/g,'_') || 'Mitarbeiter'
      const date = toLocalDateStr(new Date(doc.uploaded_at))
      const filename = `${typeName}_${lastName}_${date}.pdf`
      const { data, error } = await supabase.storage
        .from('employee-documents').createSignedUrl(doc.file_path, 60, { download: filename })
      if (error) { toast.error('Download fehlgeschlagen: ' + error.message); return }
      const a = document.createElement('a'); a.href = data.signedUrl; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    } finally { setDocActionId(null) }
  }

  async function archiveDoc(doc) {
    if (docActionId) return
    if (!window.confirm(`"${doc.title}" archivieren?\n\nDas Dokument wird für den Mitarbeiter nicht mehr sichtbar sein. Der Eintrag bleibt für Admin-Zwecke erhalten.\n\nDiese Aktion kann nicht rückgängig gemacht werden.`)) return
    setDocActionId(doc.id + ':arch')
    try {
      const { error } = await supabase.from('employee_documents').update({
        is_active:   false,
        archived_at: new Date().toISOString(),
      }).eq('id', doc.id)
      if (error) { toast.error('Archivieren fehlgeschlagen: ' + error.message); return }
      toast.success('Dokument archiviert')
      fetchDocs(form.id)
    } finally { setDocActionId(null) }
  }

  const toast   = useToast()
  const { profile } = useProfile()
  const saveGuard = useSavingGuard()
  const deactGuard = useSavingGuard()
  const [fetchError, setFetchError] = useState('')

  async function fetchEmployees() {
    setLoading(true)
    setFetchError('')
    const q = supabase.from('employees').select('*').order('last_name')
    const { data, error } = showInactive ? await q : await q.eq('is_active', true)
    if (error) {
      console.error('Employees fetch error:', error)
      setFetchError(translateSupabaseError(error, 'Mitarbeiter laden'))
    }
    setEmployees(data || [])
    setLoading(false)
  }

  function openAdd() { setForm({ ...EMPTY }); setError(''); setEmpDocs([]); setModal('add') }
  function openEdit(emp) { setForm({ ...emp, _origVac: emp.vacation_days_per_year }); setError(''); setModal('edit'); fetchDocs(emp.id) }

  async function handleSave() {
    if (!saveGuard.begin()) return
    // ── WICHTIG: try/finally stellt sicher, dass saveGuard.end() und setSaving(false)
    // bei JEDEM Ausgang aufgerufen werden — egal ob Validierungsfehler, Speicherfehler
    // oder Erfolg. Vorher blieb der Guard nach dem ersten Klick für den Rest der
    // Seiten-Session hängen und der "Speichern"-Button reagierte danach gar nicht mehr. ──
    try {
      // ── Pflichtfelder validieren ──
      if (!form.first_name?.trim()) { setError('Vorname fehlt'); return }
      if (!form.last_name?.trim())  { setError('Nachname fehlt'); return }
      if (!form.email?.trim())      { setError('E-Mail fehlt'); return }
      if (!form.start_date)         { setError('Eintrittsdatum fehlt'); return }
      const rate = parseFloat(form.hourly_rate)
      if (!form.hourly_rate || isNaN(rate) || rate <= 0) { setError('Stundenlohn ungültig'); return }

      // ── Gesetzliche Warnungen ──
      if (rate < MINDESTLOHN) {
        setError(`⚠️ Mindestlohn-Warnung: Der Stundenlohn (${rate.toFixed(2)} €) liegt unter dem gesetzlichen Mindestlohn 2026 (${MINDESTLOHN} €/Std). Bitte korrigieren.`)
        return
      }
      if (form.employment_type === 'werkstudent' && parseFloat(form.hours_per_week) > 20) {
        setError('⚠️ Werkstudenten-Warnung: Max. 20h/Woche während Vorlesungszeit (§20 SGB IV). Bitte Stunden anpassen oder Beschäftigungsart prüfen.')
        return
      }

      // ── Urlaubstage-Prüfung: nicht unter bereits genehmigte Tage reduzieren ──
      if (modal === 'edit' && parseInt(form.vacation_days_per_year) < 28) {
        const { data: approvedVacs } = await supabase
          .from('vacation_requests')
          .select('days_count')
          .eq('employee_id', form.id)
          .eq('status', 'approved')
          .gte('start_date', `${new Date().getFullYear()}-01-01`)
        const usedDays = (approvedVacs || []).reduce((s, v) => s + (v.days_count || 0), 0)
        if (usedDays > parseInt(form.vacation_days_per_year)) {
          setError(`⚠️ Achtung: ${form.first_name} hat bereits ${usedDays} Urlaubstage in ${new Date().getFullYear()} genehmigt. Neue Anzahl (${form.vacation_days_per_year}) würde ein negatives Urlaubssaldo erzeugen. Bitte zuerst genehmigte Anträge anpassen.`)
          return
        }
      }

      setSaving(true)
      setError('')

      // ── FIX: Leere Strings → null (PostgreSQL akzeptiert "" nicht für optionale Felder) ──
      const n = v => (v === '' || v === undefined || v === null) ? null : v

      const payload = {
        first_name:             form.first_name.trim(),
        last_name:              form.last_name.trim(),
        email:                  form.email.trim().toLowerCase(),
        phone:                  n(form.phone),
        birth_date:             n(form.birth_date),
        address:                n(form.address),
        position:               n(form.position),
        employment_type:        form.employment_type,
        hours_per_week:         parseFloat(form.hours_per_week),
        hourly_rate:            rate,
        start_date:             form.start_date,
        end_date:               n(form.end_date),
        vacation_days_per_year: parseInt(form.vacation_days_per_year),
        iban:                   n(form.iban),
        notes:                  n(form.notes),
        avatar_initials:        getInitials(form.first_name, form.last_name),
        avatar_color:           getAvatarColor(form.first_name),
        ...(modal === 'add' && { is_active: true }),
      }

      const { error: err } = modal === 'add'
        ? await supabase.from('employees').insert([payload])
        : await supabase.from('employees').update(payload).eq('id', form.id)

      if (err) {
        setError(translateSupabaseError(err, 'Mitarbeiter speichern'))
        return
      }
      setModal(null)
      fetchEmployees()
    } finally {
      setSaving(false)
      saveGuard.end()
    }
  }

  async function handleDeactivate(id, name) {
    // Prüfen ob Mitarbeiter aktuell eingeclockt ist
    const { data: openEntry } = await supabase
      .from('time_entries')
      .select('id, clock_in')
      .eq('employee_id', id)
      .is('clock_out', null)
      .maybeSingle()
    setOpenClockIn(!!openEntry)
    setConfirmDeact({ id, name, openEntry })
  }

  async function doDeactivate() {
    if (!deactGuard.begin()) return
    if (!confirmDeact) { deactGuard.end(); return }
    await supabase.from('employees').update({ is_active: false, end_date: toLocalDateStr(new Date()) }).eq('id', confirmDeact.id)
    setConfirmDeact(null)
    deactGuard.end()
    fetchEmployees()
  }

  async function doReactivate(id, name) {
    if (!saveGuard.begin()) return
    await supabase.from('employees').update({ is_active: true, end_date: null }).eq('id', id)
    toast.success(`✅ ${name} wurde reaktiviert`)
    saveGuard.end(); fetchEmployees()
  }

  function f(k, v) { setForm(x => ({ ...x, [k]: v })) }

  const filtered = employees.filter(e =>
    `${e.first_name} ${e.last_name} ${e.email} ${e.position || ''}`.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Mitarbeiter</div>
        <div className="topbar-right">
          <input style={{ width: 200 }} placeholder="🔍 Suchen..." value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setShowInactive(x => !x)}
            style={{ borderColor: showInactive ? 'var(--accent)' : undefined, color: showInactive ? 'var(--accent)' : undefined }}>
            {showInactive ? '👥 Alle' : '📦 Archiv anzeigen'}
          </button>
          <button className="btn btn-primary" onClick={openAdd}>+ Neuer Mitarbeiter</button>
        </div>
      </div>

      <div className="content">
        {loading ? <div className="text-muted">Lädt...</div> : fetchError ? (
          <div className="alert alert-danger">{fetchError}<br/><small>Bitte update_v5.sql in Supabase ausführen falls noch nicht geschehen.</small></div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">👤</div>
                  <div className="empty-state-text">{search ? 'Keine Treffer' : 'Noch keine Mitarbeiter — leg den ersten an!'}</div>
                </div>
              ) : (
                <table>
                  <thead>
                    <tr><th>Name</th><th>Position</th><th>Art</th><th>Std/Wo</th><th>Stundenlohn</th><th>Urlaub</th><th>Dabei seit</th><th>Aktionen</th></tr>
                  </thead>
                  <tbody>
                    {filtered.map(emp => (
                      <tr key={emp.id}>
                        <td>
                          <div className="name-cell">
                            <Avatar src={emp.avatar_url} firstName={emp.first_name} lastName={emp.last_name} color={emp.avatar_color} size={32} />
                            <div>
                              <div style={{ fontWeight: 500 }}>{emp.first_name} {emp.last_name}{!emp.is_active && <span style={{ marginLeft:6, fontSize:10, background:'var(--border)', borderRadius:10, padding:'1px 6px', color:'var(--text-muted)' }}>Inaktiv</span>}</div>
                              <div className="text-sm text-muted">{emp.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>{emp.position || <span className="text-muted">–</span>}</td>
                        <td>
                          <span className={`badge ${emp.employment_type === 'minijob' ? 'badge-amber' : emp.employment_type === 'werkstudent' ? 'badge-blue' : 'badge-gray'}`}>
                            {EMP_TYPE[emp.employment_type] || emp.employment_type}
                          </span>
                        </td>
                        <td>{emp.hours_per_week}h</td>
                        <td>
                          {formatCurrency(emp.hourly_rate)}/h
                          {emp.hourly_rate < MINDESTLOHN && <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>⚠️ Unter Mindestlohn</span>}
                        </td>
                        <td>{emp.vacation_days_per_year} Tage</td>
                        <td className="text-muted">{formatDate(emp.start_date)}</td>
                        <td>
                          <div className="flex gap-2">
                            <button className="btn btn-sm" onClick={() => openEdit(emp)}>✏️ Bearbeiten</button>
                            {emp.is_active
                              ? <button className="btn btn-sm btn-danger" onClick={() => handleDeactivate(emp.id, `${emp.first_name} ${emp.last_name}`)}>Deaktivieren</button>
                              : <button className="btn btn-sm" style={{ border:'1px solid #16A34A', color:'#16A34A' }} onClick={() => doReactivate(emp.id, `${emp.first_name} ${emp.last_name}`)}>Reaktivieren</button>
                            }
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Inline Bestätigungsdialog */}
      {confirmDeact && (
        <div className="modal-overlay" onClick={() => { setConfirmDeact(null); setOpenClockIn(false) }}>
          <div className="modal" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">Mitarbeiter deaktivieren</div><button className="btn btn-sm" onClick={() => { setConfirmDeact(null); setOpenClockIn(false) }}>✕</button></div>
            <div className="modal-body">
              {openClockIn && (
                <div className="alert" style={{ background:'#FEF3C7', border:'1px solid #F59E0B', color:'#92400E', marginBottom:12, borderRadius:8, padding:'12px 14px' }}>
                  ⚠️ <strong>{confirmDeact.name} ist aktuell eingeclockt!</strong><br/>
                  <span style={{ fontSize:12, lineHeight:1.5, display:'block', marginTop:4 }}>
                    Nach der Deaktivierung bleibt der offene Zeiteintrag bestehen. 
                    Bitte danach unter <strong>Zeitkorrekturen</strong> den Eintrag manuell abschließen.
                  </span>
                </div>
              )}
              <div className="alert alert-danger">
                {confirmDeact.name} wirklich deaktivieren?{openClockIn ? ' Trotz offenem Clock-In?' : ''} Der Eintrag bleibt im Archiv erhalten.
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => { setConfirmDeact(null); setOpenClockIn(false) }}>Abbrechen</button>
              <button className="btn btn-danger" onClick={doDeactivate}>Ja, deaktivieren</button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModal(null)}>
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <div className="modal-title">{modal === 'add' ? '+ Neuer Mitarbeiter' : '✏️ Mitarbeiter bearbeiten'}</div>
              <button className="btn btn-sm" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
              {error && <div className="alert alert-danger">❌ {error}</div>}
              <div className="two-col">
                <div className="form-group"><label>Vorname *</label><input value={form.first_name} onChange={e => f('first_name', e.target.value)} placeholder="Max" /></div>
                <div className="form-group"><label>Nachname *</label><input value={form.last_name}  onChange={e => f('last_name', e.target.value)} placeholder="Mustermann" /></div>
              </div>
              <div className="form-group">
                <label>
                  {modal === 'edit' ? 'Kontakt-E-Mail' : 'E-Mail *'}
                  {modal === 'edit' && <span style={{ fontSize:10, fontWeight:400, color:'var(--text-muted)', marginLeft:6 }}>
                    (Login-E-Mail kann nur der Mitarbeiter selbst ändern)
                  </span>}
                </label>
                <input type="email" value={form.email} onChange={e => f('email', e.target.value)} placeholder="max@cafebuur.de" />
              </div>
              <div className="two-col">
                <div className="form-group"><label>Telefon</label><input value={form.phone || ''} onChange={e => f('phone', e.target.value)} placeholder="+49 170 1234567" /></div>
                <div className="form-group"><label>Geburtsdatum</label><input type="date" value={form.birth_date || ''} onChange={e => f('birth_date', e.target.value)} /></div>
              </div>
              <div className="two-col">
                <div className="form-group"><label>Position</label><input value={form.position || ''} onChange={e => f('position', e.target.value)} placeholder="Barista, Service, Küche..." /></div>
                <div className="form-group">
                  <label>Beschäftigung</label>
                  <select value={form.employment_type} onChange={e => {
                      const type = e.target.value
                      f('employment_type', type)
                      const defaults = { vollzeit: 40, teilzeit: 20, werkstudent: 20, minijob: 10 }
                      if (defaults[type] !== undefined) f('hours_per_week', defaults[type])
                    }}>
                    <option value="vollzeit">Vollzeit</option>
                    <option value="teilzeit">Teilzeit</option>
                    <option value="werkstudent">Werkstudent</option>
                    <option value="minijob">Minijob</option>
                  </select>
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>Stunden/Woche *</label>
                  <input type="number" value={form.hours_per_week} onChange={e => f('hours_per_week', e.target.value)} min="1" max="60" />
                  {form.employment_type === 'werkstudent' && parseFloat(form.hours_per_week) > 20 && (
                    <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 3 }}>⚠️ Max. 20h/Woche für Werkstudenten</div>
                  )}
                </div>
                <div className="form-group">
                  <label>Stundenlohn (€) *</label>
                  <input type="number" step="0.01" value={form.hourly_rate} onChange={e => f('hourly_rate', e.target.value)} placeholder="12.41" />
                  {form.hourly_rate && parseFloat(form.hourly_rate) < MINDESTLOHN && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>⚠️ Unter Mindestlohn ({MINDESTLOHN} €/Std)</div>
                  )}
                  {modal === 'edit' && form.hourly_rate && parseFloat(form.hourly_rate) >= MINDESTLOHN && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>ℹ️ Gilt sofort — beeinflusst aktuelle Lohn&Stunden Berechnung</div>
                  )}
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>Urlaubstage/Jahr</label>
                  <input type="number" min="0" max="365" value={form.vacation_days_per_year} onChange={e => f('vacation_days_per_year', e.target.value)} />
                  {modal === 'edit' && parseInt(form.vacation_days_per_year) !== form._origVac && (
                    <div style={{ fontSize:10, color:'var(--warn)', marginTop:3 }}>⚠️ Systemprüfung beim Speichern: bereits genehmigte Tage werden überprüft</div>
                  )}
                </div>
                <div className="form-group"><label>Eintrittsdatum *</label><input type="date" value={form.start_date || ''} onChange={e => f('start_date', e.target.value)} /></div>
              </div>
              <div className="form-group"><label>IBAN</label><input value={form.iban || ''} onChange={e => f('iban', e.target.value)} placeholder="DE89 3704 0044 0532 0130 00" /></div>
              <div className="form-group"><label>Adresse</label><input value={form.address || ''} onChange={e => f('address', e.target.value)} placeholder="Musterstr. 1, 60000 Frankfurt" /></div>
              <div className="form-group"><label>Interne Notizen</label><textarea rows="2" value={form.notes || ''} onChange={e => f('notes', e.target.value)} /></div>

              {/* ── Dokumente (nur im Edit-Modus) ────────────────── */}
              {modal === 'edit' && (
                <div style={{ marginTop:20, paddingTop:16, borderTop:'2px solid var(--border)' }}>
                  <div style={{ fontWeight:700, fontSize:14, marginBottom:12 }}>📁 Dokumente & Verträge</div>

                  {/* Dokument hochladen */}
                  <div style={{ background:'var(--bg)', borderRadius:10, border:'1px solid var(--border)', padding:14, marginBottom:14 }}>
                    <div style={{ fontWeight:600, fontSize:12, color:'var(--text-secondary)', marginBottom:10, letterSpacing:'.04em', textTransform:'uppercase' }}>Neues Dokument hochladen</div>
                    <div className="two-col">
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>Dokumenttyp</label>
                        <select value={docForm.document_type} onChange={e => setDocForm(p=>({...p, document_type:e.target.value}))}>
                          {Object.entries(DOC_TYPES).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>Titel *</label>
                        <input placeholder="z.B. Arbeitsvertrag 2026" value={docForm.title} onChange={e => setDocForm(p=>({...p, title:e.target.value}))} />
                      </div>
                    </div>
                    <div className="two-col">
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>Gültig ab</label>
                        <input type="date" value={docForm.valid_from} onChange={e => setDocForm(p=>({...p, valid_from:e.target.value}))} />
                      </div>
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>Gültig bis</label>
                        <input type="date" value={docForm.valid_until} onChange={e => setDocForm(p=>({...p, valid_until:e.target.value}))} />
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom:10 }}>
                      <label style={{ fontSize:12 }}>Beschreibung (optional)</label>
                      <input placeholder="z.B. Ergänzung § 3 Arbeitszeit" value={docForm.description} onChange={e => setDocForm(p=>({...p, description:e.target.value}))} />
                    </div>
                    {/* Datei-Upload */}
                    {docFile ? (
                      <div style={{ border:'2px solid var(--success)', borderRadius:8, padding:'10px 14px', background:'var(--success-bg)', display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                        <span style={{ fontSize:20 }}>📄</span>
                        <div style={{ flex:1 }}>
                          <div style={{ fontWeight:600, fontSize:12, color:'var(--success)' }}>✅ {docFile.name}</div>
                          <div style={{ fontSize:11, color:'var(--text-muted)' }}>{(docFile.size/1024).toFixed(0)} KB · bereit zum Hochladen</div>
                        </div>
                        <button className="btn btn-sm" onClick={() => { setDocFile(null); if(docFileRef.current) docFileRef.current.value='' }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ border:'2px dashed var(--border)', borderRadius:8, padding:'12px', textAlign:'center', cursor:'pointer', marginBottom:10 }}
                        onClick={() => docFileRef.current?.click()}>
                        <div style={{ fontSize:20, marginBottom:4 }}>📎</div>
                        <div style={{ fontSize:12 }}>Datei auswählen oder hier ablegen</div>
                        <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>PDF, max. 20 MB</div>
                      </div>
                    )}
                    <input ref={docFileRef} type="file" accept="application/pdf" style={{ display:'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        if (file.size > 20971520) { toast.warn('Datei zu groß — max. 20 MB'); e.target.value=''; return }
                        if (file.type !== 'application/pdf') { toast.warn('Nur PDF-Dateien erlaubt'); e.target.value=''; return }
                        setDocFile(file)
                        if (!docForm.title) setDocForm(p=>({...p, title: DOC_TYPES[p.document_type]}))
                      }} />
                    <button
                      className="btn btn-primary" style={{ width:'100%' }}
                      disabled={docUploading || !docFile || !docForm.title.trim()}
                      onClick={uploadDoc}>
                      {docUploading ? '⏳ Wird hochgeladen…' : '📤 Dokument hochladen'}
                    </button>
                  </div>

                  {/* Dokument-Liste */}
                  {docsLoading ? (
                    <div style={{ textAlign:'center', padding:16, fontSize:13, color:'var(--text-muted)' }}>⏳ Dokumente werden geladen…</div>
                  ) : empDocs.length === 0 ? (
                    <div style={{ textAlign:'center', padding:16, fontSize:13, color:'var(--text-muted)' }}>Noch keine Dokumente für diesen Mitarbeiter hinterlegt.</div>
                  ) : (
                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                      {empDocs.map(doc => (
                        <div key={doc.id} style={{
                          border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px',
                          background: doc.is_active ? 'var(--card)' : 'var(--bg)',
                          opacity: doc.is_active ? 1 : 0.55,
                        }}>
                          <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
                            <span style={{ fontSize:22, marginTop:2 }}>📄</span>
                            <div style={{ flex:1, minWidth:0 }}>
                              <div style={{ fontWeight:600, fontSize:13 }}>
                                {doc.title}
                                {!doc.is_active && <span style={{ marginLeft:8, fontSize:10, background:'#F3F4F6', color:'#6B7280', padding:'1px 5px', borderRadius:3 }}>Archiviert</span>}
                              </div>
                              <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                                {DOC_TYPES[doc.document_type] || doc.document_type}
                                {doc.valid_from && ` · ab ${formatDate(doc.valid_from)}`}
                                {doc.valid_until && ` bis ${formatDate(doc.valid_until)}`}
                              </div>
                              <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:1 }}>
                                {doc.file_name} · {doc.file_size ? `${(doc.file_size/1024).toFixed(0)} KB` : ''} · hochgeladen {formatDate(doc.uploaded_at?.split('T')[0])}
                                {doc.uploaded_by_name && ` von ${doc.uploaded_by_name}`}
                              </div>
                              {doc.description && <div style={{ fontSize:11, marginTop:2, color:'var(--text-secondary)' }}>{doc.description}</div>}
                            </div>
                            <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                              <button className="btn btn-sm" disabled={!!docActionId} onClick={() => openDoc(doc)} title="Öffnen">
                                {docActionId===doc.id+':open' ? '⏳' : '📄'}
                              </button>
                              <button className="btn btn-sm" style={{ background:'var(--info-bg)', color:'var(--info)', border:'1px solid var(--info)' }}
                                disabled={!!docActionId} onClick={() => downloadDoc(doc, form)} title="Herunterladen">
                                {docActionId===doc.id+':dl' ? '⏳' : '⬇'}
                              </button>
                              {doc.is_active && (
                                <button className="btn btn-sm" style={{ background:'#FEF3C7', color:'#D97706', border:'1px solid #FDE68A' }}
                                  disabled={!!docActionId} onClick={() => archiveDoc(doc)} title="Archivieren">
                                  {docActionId===doc.id+':arch' ? '⏳' : '🗄'}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(null)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Speichern...' : '💾 Speichern'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
