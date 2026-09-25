import { t as tr, getIntlLocale, localizeMessage, message as appMessage, errorMessage, messageParts, formatParam } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Avatar from '../components/UI/Avatar'
import { supabase, getInitials, getAvatarColor, toLocalDateStr } from '../lib/supabase'
import { formatDate, formatCurrency } from '../i18n/format.js'
import { openSignedFile } from '../lib/openFile'
import { translateSupabaseError } from '../lib/errorHelper'
import { MINDESTLOHN } from '../lib/constants'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { useProfile } from '../context/ProfileContext'
import { logActivity } from '../lib/activityLog'
import { monthlyTargetHours, STUDENT_MONTHLY_LIMIT_H } from '../lib/workTimeModels'
import { validatePersonal, formatIBAN, cleanIBAN, cleanTaxId, cleanSV, FIELD_LABELS, FIELD_MESSAGES } from '../lib/personalData'

const EMPTY = {
  first_name: '', last_name: '', email: '', phone: '', birth_date: '',
  position: '', employment_type: 'vollzeit', hours_per_week: 40,
  hourly_rate: '', start_date: (() => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` })(),
  vacation_days_per_year: 28, iban: '', address: '', notes: '',
  birth_name: '', birth_place: '', nationality: '', street: '', house_number: '', postal_code: '', city: '',
  account_holder: '', tax_id: '', social_security_number: '', health_insurance: '',
  other_employment: null, other_employment_note: '', emergency_contact_name: '', emergency_contact_phone: '',
}
// Personaldaten, die bei Validierung/Speichern gesondert behandelt werden
const PERSONAL_CHECK = ['birth_date','postal_code','iban','tax_id','social_security_number','phone','emergency_contact_phone']

const DOC_TYPES = {
  get employment_contract() { return tr("ui.7c2a6c84ba98") },
  get contract_addendum() { return tr("ui.5d4a21030716") },
  get certificate() { return tr("ui.fe1020b37611") },
  get agreement() { return tr("ui.139fb05af4f2") },
  get personal_document() { return tr("ui.841be075bc36") },
  get other() { return tr("ui.9f3d5f8d94cf") },
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 100)
}

function getTenure(startDate) {
  if (!startDate) return null
  const years  = Math.floor((Date.now() - new Date(startDate)) / (365.25 * 86400000))
  const months = Math.floor(((Date.now() - new Date(startDate)) % (365.25 * 86400000)) / (30.44 * 86400000))
  if (years > 0) return `${years}J ${months}M`
  return tr("ui.64ec1995134b", { p1: (months) })
}

const EMP_TYPE = { get vollzeit() { return tr("ui.49dbe1b0b4b3") }, get teilzeit() { return tr("ui.df763b1cc689") }, get werkstudent() { return tr("ui.fa23b3bc413a") }, get minijob() { return tr("ui.b3fc8da9deb1") } }

export default function Employees() {
  useLocale()
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
  const [access,        setAccess]        = useState({})     // employee_id → 'active' | 'invited' | 'disabled' | 'pending'
  const [addChoice,     setAddChoice]     = useState(false)  // Auswahl: einladen oder selbst anlegen
  const [justCreated,   setJustCreated]   = useState(null)   // nach „Selbst anlegen“: App-Zugang anbieten
  const [lockLogin,     setLockLogin]     = useState(true)   // beim Deaktivieren auch App-Zugang sperren
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

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
      if (storErr) { toast.error(messageParts([appMessage("ui.69d9669978d1"), errorMessage(storErr)])); return }

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
        toast.error(messageParts([appMessage("ui.d5711a0bb238"), errorMessage(dbErr)]))
        return
      }
      toast.success(appMessage("ui.4688296e9058"))
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

  async function downloadDoc(doc, employee) {
    if (docActionId) return
    setDocActionId(doc.id + ':dl')
    try {
      const typeName = DOC_TYPES[doc.document_type] || tr("ui.836ae9356297")
      const lastName = employee?.last_name?.replace(/\s+/g,'_') || tr("ui.f4cb6891b9e5")
      const date = toLocalDateStr(new Date(doc.uploaded_at))
      const filename = `${typeName}_${lastName}_${date}.pdf`
      const { data, error } = await supabase.storage
        .from('employee-documents').createSignedUrl(doc.file_path, 60, { download: filename })
      if (error) { toast.error(messageParts([appMessage("ui.322e45a8c6c6"), errorMessage(error)])); return }
      const a = document.createElement('a'); a.href = data.signedUrl; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    } finally { setDocActionId(null) }
  }

  async function archiveDoc(doc) {
    if (docActionId) return
    if (!window.confirm(tr("ui.d161262b9c31", { p1: (doc.title) }))) return
    setDocActionId(doc.id + ':arch')
    try {
      const { error } = await supabase.from('employee_documents').update({
        is_active:   false,
        archived_at: new Date().toISOString(),
      }).eq('id', doc.id)
      if (error) { toast.error(messageParts([appMessage("ui.921fd12e062e"), errorMessage(error)])); return }
      toast.success(appMessage("ui.4dba11c3080f"))
      fetchDocs(form.id)
    } finally { setDocActionId(null) }
  }

  const toast   = useToast()
  const { profile, isAdmin } = useProfile()
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
      setFetchError(translateSupabaseError(error, appMessage("ui.25a52375f2de")))
    }
    setEmployees(data || [])
    setLoading(false)
    if (isAdmin) fetchAccess()
    // Direktsprung aus der Benutzerverwaltung: /mitarbeiter?edit=<id>
    const editId = searchParams.get('edit')
    if (editId) {
      searchParams.delete('edit'); setSearchParams(searchParams, { replace: true })
      let emp = (data || []).find(e => e.id === editId)
      if (!emp) {   // evtl. archiviert → direkt laden
        const { data: one } = await supabase.from('employees').select('*').eq('id', editId).maybeSingle()
        emp = one
      }
      if (emp) openEdit(emp)
    }
  }

  // App-Zugang je Mitarbeiter (nur Admin darf Logins/Einladungen sehen)
  async function fetchAccess() {
    const [{ data: profs }, { data: invs }] = await Promise.all([
      supabase.from('profiles').select('employee_id, status').not('employee_id', 'is', null),
      supabase.from('invitations').select('employee_id').is('used_at', null).is('revoked_at', null)
        .gt('expires_at', new Date().toISOString()).not('employee_id', 'is', null),
    ])
    const map = {}
    for (const i of invs || []) map[i.employee_id] = 'invited'
    for (const p of profs || []) map[p.employee_id] = p.status === 'approved' ? 'active' : p.status === 'disabled' ? 'disabled' : 'pending'
    setAccess(map)
  }

  function openAdd() { setForm({ ...EMPTY }); setError(''); setEmpDocs([]); setModal('add') }
  function openEdit(emp) { setForm({ ...emp, _origVac: emp.vacation_days_per_year }); setError(''); setModal('edit'); fetchDocs(emp.id) }

  async function handleSave() {
    if (!isAdmin) return
    if (!saveGuard.begin()) return
    // ── WICHTIG: try/finally stellt sicher, dass saveGuard.end() und setSaving(false)
    // bei JEDEM Ausgang aufgerufen werden — egal ob Validierungsfehler, Speicherfehler
    // oder Erfolg. Vorher blieb der Guard nach dem ersten Klick für den Rest der
    // Seiten-Session hängen und der "Speichern"-Button reagierte danach gar nicht mehr. ──
    try {
      // ── Pflichtfelder validieren ──
      if (!form.first_name?.trim()) { setError(appMessage("ui.b76679096430")); return }
      if (!form.last_name?.trim())  { setError(appMessage("ui.473f6c626760")); return }
      if (!form.email?.trim())      { setError(appMessage("ui.0753440cb1d0")); return }
      if (!form.start_date)         { setError(appMessage("ui.d0c35bf70bc0")); return }
      const rate = parseFloat(form.hourly_rate)
      if (!form.hourly_rate || isNaN(rate) || rate <= 0) { setError(appMessage("ui.9ec91c2ee981")); return }

      // ── Gesetzliche Warnungen ──
      if (rate < MINDESTLOHN) {
        setError(appMessage("ui.e464f6564209", { p1: (formatParam("number", rate, { minimumFractionDigits: 2, maximumFractionDigits: 2 })), p2: (MINDESTLOHN) }))
        return
      }
      if (form.employment_type === 'werkstudent' && parseFloat(form.hours_per_week) > 20) {
        setError(appMessage("ui.fafbdfa4b2dc"))
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
          setError(appMessage("ui.4656cc80f01f", { p1: (form.first_name), p2: (usedDays), p3: (new Date().getFullYear()), p4: (form.vacation_days_per_year) }))
          return
        }
      }

      // ── Personaldaten: Format nur prüfen, wenn etwas eingetragen ist ──
      const filled = PERSONAL_CHECK.filter(k => form[k] !== null && form[k] !== undefined && String(form[k]).trim() !== '')
      const pErr = validatePersonal(form, filled)
      if (form.other_employment === true && !String(form.other_employment_note || '').trim()) pErr.other_employment_note = appMessage("ui.e82ab6425a11")
      if (Object.keys(pErr).length) {
        const k = Object.keys(pErr)[0]
        setError(messageParts([(FIELD_MESSAGES[k] || k), ": ", pErr[k]]))
        return
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
        address:                (form.street && form.house_number && form.postal_code && form.city)
                                  ? `${form.street.trim()} ${form.house_number.trim()}, ${form.postal_code.trim()} ${form.city.trim()}`
                                  : n(form.address),
        position:               n(form.position),
        employment_type:        form.employment_type,
        hours_per_week:         parseFloat(form.hours_per_week),
        hourly_rate:            rate,
        start_date:             form.start_date,
        end_date:               n(form.end_date),
        vacation_days_per_year: parseInt(form.vacation_days_per_year),
        iban:                   form.iban ? cleanIBAN(form.iban) : null,
        notes:                  n(form.notes),
        birth_name:             n(form.birth_name?.trim()),
        birth_place:            n(form.birth_place?.trim()),
        nationality:            n(form.nationality?.trim()),
        street:                 n(form.street?.trim()),
        house_number:           n(form.house_number?.trim()),
        postal_code:            n(form.postal_code?.trim()),
        city:                   n(form.city?.trim()),
        account_holder:         n(form.account_holder?.trim()),
        tax_id:                 form.tax_id ? cleanTaxId(form.tax_id) : null,
        social_security_number: form.social_security_number ? cleanSV(form.social_security_number) : null,
        health_insurance:       n(form.health_insurance?.trim()),
        other_employment:       form.other_employment === true ? true : form.other_employment === false ? false : null,
        other_employment_note:  form.other_employment === true ? n(form.other_employment_note?.trim()) : null,
        emergency_contact_name: n(form.emergency_contact_name?.trim()),
        emergency_contact_phone:n(form.emergency_contact_phone?.trim()),
        avatar_initials:        getInitials(form.first_name, form.last_name),
        avatar_color:           getAvatarColor(form.first_name),
        ...(modal === 'add' && { is_active: true }),
      }

      const { data: saved, error: err } = modal === 'add'
        ? await supabase.from('employees').insert([payload]).select('id, first_name, last_name, email').maybeSingle()
        : await supabase.from('employees').update(payload).eq('id', form.id).select('id').maybeSingle()

      if (err) {
        setError(translateSupabaseError(err, appMessage("ui.84853b348826")))
        return
      }
      if (modal === 'add' && saved) setJustCreated(saved)
      else toast.success(appMessage("ui.4424bc9901a8"))
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
    try {
      const { error } = await supabase.from('employees').update({ is_active: false, end_date: toLocalDateStr(new Date()) }).eq('id', confirmDeact.id)
      if (error) { toast.error(translateSupabaseError(error, appMessage("ui.7a86e994b5dd"))); return }
      // Ehemalige sollen sich nicht mehr anmelden können (eigener Admin-Zugang wird nie gesperrt)
      if (lockLogin && access[confirmDeact.id]) {
        await supabase.from('profiles').update({ status: 'disabled' })
          .eq('employee_id', confirmDeact.id).neq('id', profile?.id || '')
      }
      toast.success(appMessage("ui.3f5e698f6aca", { p1: (confirmDeact.name), p2: (lockLogin && access[confirmDeact.id] ? (appMessage("ui.4478a1db6960")) : ('')) }))
      logActivity({
        action: 'employee.deactivated', category: 'employee',
        summary: `hat ${confirmDeact.name} deaktiviert${lockLogin && access[confirmDeact.id] ? ' und den App-Zugang gesperrt' : ''}.`,
        targetType: 'employee', targetId: confirmDeact.id, targetName: confirmDeact.name,
      })
    } finally {
      setConfirmDeact(null)
      setLockLogin(true)
      deactGuard.end()
      fetchEmployees()
    }
  }

  async function doReactivate(id, name) {
    if (!saveGuard.begin()) return
    try {
      const { error } = await supabase.from('employees').update({ is_active: true, end_date: null }).eq('id', id)
      if (error) { toast.error(translateSupabaseError(error, appMessage("ui.b2f1e0b4fec7"))); return }
      // War der App-Zugang beim Deaktivieren gesperrt worden → wieder freigeben
      let unlocked = false
      if (access[id] === 'disabled') {
        const { error: pErr } = await supabase.from('profiles').update({ status: 'approved' }).eq('employee_id', id).eq('status', 'disabled')
        unlocked = !pErr
      }
      toast.success(appMessage("ui.b827c18bb5a2", { p1: (name), p2: (unlocked ? (appMessage("ui.0e068e1733b1")) : ('')) }))
      logActivity({
        action: 'employee.reactivated', category: 'employee',
        summary: `hat ${name} reaktiviert${unlocked ? ' und den App-Zugang wieder freigegeben' : ''}.`,
        targetType: 'employee', targetId: id, targetName: name,
      })
    } finally { saveGuard.end(); fetchEmployees() }
  }

  function f(k, v) { setForm(x => ({ ...x, [k]: v })) }

  const filtered = employees.filter(e =>
    `${e.first_name} ${e.last_name} ${e.email} ${e.position || ''}`.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.f4cb6891b9e5")}</div>
        <div className="topbar-right">
          <input style={{ width: 200 }} placeholder={tr("ui.7f7211cd472d")} value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setShowInactive(x => !x)}
            style={{ borderColor: showInactive ? 'var(--accent)' : undefined, color: showInactive ? 'var(--accent)' : undefined }}>
            {showInactive ? tr("ui.625cdcf52e80") : tr("ui.f37c3c02afe6")}
          </button>
          {isAdmin && <button className="btn btn-primary" onClick={() => setAddChoice(true)}>{tr("ui.8b96938fac5b")}</button>}
        </div>
      </div>

      <div className="content">
        {loading ? <div className="text-muted">{tr("ui.7a72dd7b9d46")}</div> : fetchError ? (
          <div className="alert alert-danger">{localizeMessage(fetchError)}</div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">👤</div>
                  <div className="empty-state-text">{search ? tr("ui.6df7e9f71b5f") : tr("ui.64b9da529810")}</div>
                </div>
              ) : (
                <table>
                  <thead>
                    <tr><th>{tr("ui.dcd1d5223f73")}</th><th>{tr("ui.6d031af10da7")}</th><th>{tr("ui.75df3579c730")}</th><th>{tr("ui.4b2cec6773ea")}</th><th>{tr("ui.68c8ec0f16c7")}</th><th>{tr("ui.35d3a889824d")}</th><th>{tr("ui.b3acb8cb53f2")}</th>{isAdmin && <th>{tr("ui.eb1cc4e89bc4")}</th>}<th>{tr("ui.5656f92db78d")}</th></tr>
                  </thead>
                  <tbody>
                    {filtered.map(emp => (
                      <tr key={emp.id}>
                        <td>
                          <div className="name-cell">
                            <Avatar src={emp.avatar_url} firstName={emp.first_name} lastName={emp.last_name} color={emp.avatar_color} size={32} />
                            <div>
                              <div style={{ fontWeight: 500 }}>{emp.first_name} {emp.last_name}{!emp.is_active && <span style={{ marginLeft:6, fontSize:10, background:'var(--border)', borderRadius:10, padding:'1px 6px', color:'var(--text-muted)' }}>{tr("ui.bf7c9171cb49")}</span>}</div>
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
                        <td>{emp.hours_per_week}{tr("ui.aaa9402664f1")}</td>
                        <td>
                          {formatCurrency(emp.hourly_rate)}{tr("ui.141582aa3785")}{emp.hourly_rate < MINDESTLOHN && <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>{tr("ui.73d8e2d2f8fd")}</span>}
                        </td>
                        <td>{emp.vacation_days_per_year}{tr("ui.d00de448b9e2")}</td>
                        <td className="text-muted">{formatDate(emp.start_date)}</td>
                        {isAdmin && (
                          <td>
                            {access[emp.id] === 'active'   && <span className="badge badge-green">{tr("ui.e293a477e7a2")}</span>}
                            {access[emp.id] === 'pending'  && <span className="badge badge-amber">{tr("ui.08fae8eb0ce7")}</span>}
                            {access[emp.id] === 'disabled' && <span className="badge badge-red">{tr("ui.a9dba4d3545f")}</span>}
                            {access[emp.id] === 'invited'  && <span className="badge badge-blue">{tr("ui.cf1375be0028")}</span>}
                            {!access[emp.id] && emp.is_active && (
                              <button className="btn btn-sm" onClick={() => navigate(`/benutzer?invite=${emp.id}`)}
                                title={tr("ui.d958a0dc77d7")}>{tr("ui.09b04b14c98a")}</button>
                            )}
                            {!access[emp.id] && !emp.is_active && <span className="text-muted">–</span>}
                          </td>
                        )}
                        <td>
                          <div className="flex gap-2">
                            <button className="btn btn-sm" onClick={() => openEdit(emp)}>{isAdmin ? tr("ui.10b85209d6db") : tr("ui.52be03d9b363")}</button>
                            {!isAdmin ? null : emp.is_active
                              ? <button className="btn btn-sm btn-danger" onClick={() => handleDeactivate(emp.id, `${emp.first_name} ${emp.last_name}`)}>{tr("ui.7a86e994b5dd")}</button>
                              : <button className="btn btn-sm" style={{ border:'1px solid #16A34A', color:'#16A34A' }} onClick={() => doReactivate(emp.id, `${emp.first_name} ${emp.last_name}`)}>{tr("ui.b2f1e0b4fec7")}</button>
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

      {/* ── Neuer Mitarbeiter: Weg wählen ── */}
      {addChoice && (
        <div className="modal-overlay" onClick={() => setAddChoice(false)}>
          <div className="modal" style={{ maxWidth:460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">{tr("ui.5c5bb03cfd8e")}</div>
              <button className="btn btn-sm" onClick={() => setAddChoice(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <button className="btn" style={{ justifyContent:'flex-start', textAlign:'left', padding:'14px 16px', height:'auto', whiteSpace:'normal' }}
                onClick={() => { setAddChoice(false); navigate('/benutzer?new=1') }}>
                <div>
                  <div style={{ fontWeight:600, fontSize:14 }}>{tr("ui.a99194c457d5")}<span className="badge badge-accent" style={{ marginLeft:6 }}>{tr("ui.ab8b5fe6ab84")}</span></div>
                  <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4, lineHeight:1.5 }}>{tr("ui.c63e621f60b6")}</div>
                </div>
              </button>
              <button className="btn" style={{ justifyContent:'flex-start', textAlign:'left', padding:'14px 16px', height:'auto', whiteSpace:'normal' }}
                onClick={() => { setAddChoice(false); openAdd() }}>
                <div>
                  <div style={{ fontWeight:600, fontSize:14 }}>{tr("ui.d456a1e202fd")}</div>
                  <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4, lineHeight:1.5 }}>{tr("ui.ec794756e6e6")}</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Nach „Selbst anlegen“: App-Zugang anbieten ── */}
      {justCreated && (
        <div className="modal-overlay" onClick={() => setJustCreated(null)}>
          <div className="modal" style={{ maxWidth:420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">✅ {justCreated.first_name} {justCreated.last_name}{tr("ui.ab2b451b4d2f")}</div></div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>{tr("ui.137bdbfc3648")}{justCreated.first_name}{tr("ui.17009dff6de1")}<strong>{justCreated.email}</strong>.
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setJustCreated(null)}>{tr("ui.c47401bce409")}</button>
              <button className="btn btn-primary" onClick={() => { const id = justCreated.id; setJustCreated(null); navigate(`/benutzer?invite=${id}`) }}>{tr("ui.7983b7810bb1")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Inline Bestätigungsdialog */}
      {confirmDeact && (
        <div className="modal-overlay" onClick={() => { setConfirmDeact(null); setOpenClockIn(false) }}>
          <div className="modal" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">{tr("ui.3d275245a375")}</div><button className="btn btn-sm" onClick={() => { setConfirmDeact(null); setOpenClockIn(false) }}>✕</button></div>
            <div className="modal-body">
              {openClockIn && (
                <div className="alert" style={{ background:'#FEF3C7', border:'1px solid #F59E0B', color:'#92400E', marginBottom:12, borderRadius:8, padding:'12px 14px' }}>
                  ⚠️ <strong>{confirmDeact.name}{tr("ui.5a05a013899c")}</strong><br/>
                  <span style={{ fontSize:12, lineHeight:1.5, display:'block', marginTop:4 }}>{tr("ui.b63b3c2ba8b2")}<strong>{tr("ui.1ba6ae4c4865")}</strong>{tr("ui.ab7c3aaa7bfa")}</span>
                </div>
              )}
              <div className="alert alert-danger">
                {confirmDeact.name}{tr("ui.0fc1cc79ccd9")}{openClockIn ? tr("ui.d7fa805a7f5a") : ''}{tr("ui.dd7b3f33115f")}</div>
              {access[confirmDeact.id] && access[confirmDeact.id] !== 'invited' && (
                <label style={{ display:'flex', gap:8, alignItems:'flex-start', fontSize:13, cursor:'pointer', marginTop:4 }}>
                  <input type="checkbox" checked={lockLogin} onChange={e => setLockLogin(e.target.checked)} style={{ width:16, height:16, marginTop:2 }} />
                  <span>{tr("ui.46fda77bf7b3")}<span style={{ color:'var(--text-muted)' }}>{tr("ui.4a39b7d6cdb8")}</span></span>
                </label>
              )}
              {access[confirmDeact.id] === 'invited' && (
                <div style={{ fontSize:12.5, color:'var(--text-secondary)' }}>{tr("ui.cf19713957ef")}</div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => { setConfirmDeact(null); setOpenClockIn(false) }}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-danger" onClick={doDeactivate}>{tr("ui.6c5538190bd0")}</button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setModal(null)}>
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-header">
              <div className="modal-title">{modal === 'add' ? tr("ui.8b96938fac5b") : isAdmin ? tr("ui.4de5a5b9b16e") : tr("ui.4b108417160e")}</div>
              <button className="btn btn-sm" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
              {error && <div className="alert alert-danger">❌ {localizeMessage(error)}</div>}
              {!isAdmin && <div className="alert alert-info" style={{ fontSize:12 }}>{tr("ui.74a716ea0751")}</div>}
              {isAdmin && modal === 'edit' && (
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', background:'var(--bg)', borderRadius:8, padding:'8px 12px', marginBottom:14, fontSize:12.5 }}>
                  <span style={{ color:'var(--text-secondary)' }}>{tr("ui.2673adcedbb0")}</span>
                  <strong>{{ active:tr("ui.e293a477e7a2"), pending:tr("ui.e1041ba52468"), disabled:tr("ui.a9dba4d3545f"), invited:tr("ui.cf1375be0028") }[access[form.id]] || tr("access.none")}</strong>
                  <button type="button" className="btn btn-sm" style={{ marginLeft:'auto' }}
                    onClick={() => { const id = form.id; setModal(null); navigate(access[id] ? '/benutzer' : `/benutzer?invite=${id}`) }}>
                    {access[form.id] ? tr("ui.4d914f496dcd") : tr("ui.09c4b067fdbe")}
                  </button>
                </div>
              )}
              <fieldset disabled={!isAdmin} style={{ border:'none', padding:0, margin:0, minWidth:0 }}>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.5e3182902258")}</label><input value={form.first_name} onChange={e => f('first_name', e.target.value)} placeholder={tr("ui.a1a5936d3b0f")} /></div>
                <div className="form-group"><label>{tr("ui.20b2178fa509")}</label><input value={form.last_name}  onChange={e => f('last_name', e.target.value)} placeholder={tr("ui.c9ff763e960d")} /></div>
              </div>
              <div className="form-group">
                <label>
                  {modal === 'edit' ? tr("ui.1fdaca2f9659") : tr("ui.7368dce2f90e")}
                  {modal === 'edit' && <span style={{ fontSize:10, fontWeight:400, color:'var(--text-muted)', marginLeft:6 }}>{tr("ui.03adc8ca59f7")}</span>}
                </label>
                <input type="email" value={form.email} onChange={e => f('email', e.target.value)} placeholder={tr("ui.aa71e8319ba4")} />
              </div>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.fa6906d76ee9")}</label><input value={form.phone || ''} onChange={e => f('phone', e.target.value)} placeholder="+49 170 1234567" /></div>
                <div className="form-group"><label>{tr("ui.6882904da71a")}</label><input type="date" value={form.birth_date || ''} onChange={e => f('birth_date', e.target.value)} /></div>
              </div>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.6d031af10da7")}</label><input value={form.position || ''} onChange={e => f('position', e.target.value)} placeholder={tr("ui.183e568d81e8")} /></div>
                <div className="form-group">
                  <label>{tr("ui.50614a65c54c")}</label>
                  <select value={form.employment_type} onChange={e => {
                      const type = e.target.value
                      f('employment_type', type)
                      const defaults = { vollzeit: 40, teilzeit: 20, werkstudent: 20, minijob: 10 }
                      if (defaults[type] !== undefined) f('hours_per_week', defaults[type])
                    }}>
                    <option value="vollzeit">{tr("ui.49dbe1b0b4b3")}</option>
                    <option value="teilzeit">{tr("ui.df763b1cc689")}</option>
                    <option value="werkstudent">{tr("ui.fa23b3bc413a")}</option>
                    <option value="minijob">{tr("ui.b3fc8da9deb1")}</option>
                  </select>
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.b8139666f8ca")}</label>
                  <input type="number" value={form.hours_per_week} onChange={e => f('hours_per_week', e.target.value)} min="1" max="60" />
                  {form.employment_type === 'werkstudent' && parseFloat(form.hours_per_week) > 20 && (
                    <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 3 }}>{tr("ui.c4f2372a2379")}</div>
                  )}
                  {form.employment_type !== 'minijob' && (
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                      {form.employment_type === 'werkstudent'
                        ? tr("workModel.studentLimitLabel", { limit: STUDENT_MONTHLY_LIMIT_H })
                        : tr("workModel.targetHint", { target: monthlyTargetHours({ employment_type: form.employment_type, hours_per_week: parseFloat(String(form.hours_per_week).replace(',', '.')) }).toLocaleString(getIntlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>{tr("ui.04d8b7c7a102")}</label>
                  <input type="number" step="0.01" value={form.hourly_rate} onChange={e => f('hourly_rate', e.target.value)} placeholder="12.41" />
                  {form.hourly_rate && parseFloat(form.hourly_rate) < MINDESTLOHN && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>{tr("ui.beb41500da12")}{MINDESTLOHN}{tr("ui.2e48fc993743")}</div>
                  )}
                  {modal === 'edit' && form.hourly_rate && parseFloat(form.hourly_rate) >= MINDESTLOHN && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{tr("ui.a3b0277ec83e")}</div>
                  )}
                </div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.0ba856e3d3d8")}</label>
                  <input type="number" min="0" max="365" value={form.vacation_days_per_year} onChange={e => f('vacation_days_per_year', e.target.value)} />
                  {modal === 'edit' && parseInt(form.vacation_days_per_year) !== form._origVac && (
                    <div style={{ fontSize:10, color:'var(--warn)', marginTop:3 }}>{tr("ui.3cd3af9b9ef7")}</div>
                  )}
                </div>
                <div className="form-group"><label>{tr("ui.5de567a16489")}</label><input type="date" value={form.start_date || ''} onChange={e => f('start_date', e.target.value)} /></div>
              </div>
              <div style={{ fontWeight:700, fontSize:13, margin:'18px 0 10px', paddingTop:14, borderTop:'1px solid var(--border)' }}>{tr("ui.c89f3b303b04")}{form.onboarding_completed_at && <span style={{ fontWeight:400, fontSize:11, color:'var(--text-muted)', marginLeft:8 }}>{tr("ui.b3915789c10b")}</span>}
              </div>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.807b1204e06c")}</label><input value={form.birth_name || ''} onChange={e => f('birth_name', e.target.value)} /></div>
                <div className="form-group"><label>{tr("ui.590571d3da6b")}</label><input value={form.birth_place || ''} onChange={e => f('birth_place', e.target.value)} /></div>
              </div>
              <div className="form-group"><label>{tr("ui.3e3a47041a87")}</label><input value={form.nationality || ''} onChange={e => f('nationality', e.target.value)} /></div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 90px', gap:12 }}>
                <div className="form-group"><label>{tr("ui.58a3778c18c4")}</label><input value={form.street || ''} onChange={e => f('street', e.target.value)} /></div>
                <div className="form-group"><label>{tr("ui.318ca5480cb8")}</label><input value={form.house_number || ''} onChange={e => f('house_number', e.target.value)} /></div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'90px 1fr', gap:12 }}>
                <div className="form-group"><label>{tr("ui.c6127fd4465d")}</label><input inputMode="numeric" maxLength={5} value={form.postal_code || ''} onChange={e => f('postal_code', e.target.value.replace(/\D/g, ''))} /></div>
                <div className="form-group"><label>{tr("ui.30fb259129e5")}</label><input value={form.city || ''} onChange={e => f('city', e.target.value)} /></div>
              </div>
              {!form.street && (
                <div className="form-group"><label>{tr("ui.bc815da9b21b")}</label><input value={form.address || ''} onChange={e => f('address', e.target.value)} placeholder={tr("ui.01fd2c11ba5c")} /></div>
              )}
              <div className="form-group"><label>IBAN</label><input value={form.iban ? formatIBAN(form.iban) : ''} onChange={e => f('iban', e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} placeholder={tr("ui.7f377fd57c25")} style={{ fontFamily:'monospace' }} /></div>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.e2ddc853f6c8")}</label><input value={form.account_holder || ''} onChange={e => f('account_holder', e.target.value)} /></div>
                <div className="form-group"><label>{tr("ui.500348e73c9e")}</label><input value={form.health_insurance || ''} onChange={e => f('health_insurance', e.target.value)} /></div>
              </div>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.45239f930c27")}</label><input inputMode="numeric" value={form.tax_id || ''} onChange={e => f('tax_id', e.target.value.replace(/[^0-9 ]/g, ''))} style={{ fontFamily:'monospace' }} /></div>
                <div className="form-group"><label>{tr("ui.019891f68f41")}</label><input value={form.social_security_number || ''} onChange={e => f('social_security_number', e.target.value.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase())} placeholder={tr("ui.ac2e02feab3d")} style={{ fontFamily:'monospace' }} /></div>
              </div>
              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.ec918980364d")}</label>
                  <select value={form.other_employment === true ? 'ja' : form.other_employment === false ? 'nein' : ''}
                    onChange={e => f('other_employment', e.target.value === 'ja' ? true : e.target.value === 'nein' ? false : null)}>
                    <option value="">{tr("ui.0c3b3b84e6b6")}</option>
                    <option value="nein">{tr("ui.90ebc1bde6f3")}</option>
                    <option value="ja">{tr("ui.cde9e58a9a4e")}</option>
                  </select>
                </div>
                {form.other_employment === true && (
                  <div className="form-group"><label>{tr("ui.e55bff7f9626")}</label><input value={form.other_employment_note || ''} onChange={e => f('other_employment_note', e.target.value)} /></div>
                )}
              </div>
              <div className="two-col">
                <div className="form-group"><label>{tr("ui.b285b3cd6355")}</label><input value={form.emergency_contact_name || ''} onChange={e => f('emergency_contact_name', e.target.value)} /></div>
                <div className="form-group"><label>{tr("ui.0d21914d5fd4")}</label><input value={form.emergency_contact_phone || ''} onChange={e => f('emergency_contact_phone', e.target.value)} /></div>
              </div>
              <div className="form-group"><label>{tr("ui.74c060e64273")}</label><textarea rows="2" value={form.notes || ''} onChange={e => f('notes', e.target.value)} /></div>
              </fieldset>

              {/* ── Dokumente (nur im Edit-Modus) ────────────────── */}
              {modal === 'edit' && (
                <div style={{ marginTop:20, paddingTop:16, borderTop:'2px solid var(--border)' }}>
                  <div style={{ fontWeight:700, fontSize:14, marginBottom:12 }}>{tr("ui.34fe9717933a")}</div>

                  {/* Dokument hochladen */}
                  <div style={{ background:'var(--bg)', borderRadius:10, border:'1px solid var(--border)', padding:14, marginBottom:14 }}>
                    <div style={{ fontWeight:600, fontSize:12, color:'var(--text-secondary)', marginBottom:10, letterSpacing:'.04em', textTransform:'uppercase' }}>{tr("ui.2ef0f41d7589")}</div>
                    <div className="two-col">
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>{tr("ui.d34fdfab4164")}</label>
                        <select value={docForm.document_type} onChange={e => setDocForm(p=>({...p, document_type:e.target.value}))}>
                          {Object.entries(DOC_TYPES).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>{tr("ui.fe0fc68dab2d")}</label>
                        <input placeholder={tr("ui.0380d18a5633")} value={docForm.title} onChange={e => setDocForm(p=>({...p, title:e.target.value}))} />
                      </div>
                    </div>
                    <div className="two-col">
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>{tr("ui.c30bc49049b9")}</label>
                        <input type="date" value={docForm.valid_from} onChange={e => setDocForm(p=>({...p, valid_from:e.target.value}))} />
                      </div>
                      <div className="form-group" style={{ marginBottom:10 }}>
                        <label style={{ fontSize:12 }}>{tr("ui.ad350696ac38")}</label>
                        <input type="date" value={docForm.valid_until} onChange={e => setDocForm(p=>({...p, valid_until:e.target.value}))} />
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom:10 }}>
                      <label style={{ fontSize:12 }}>{tr("ui.5a3c9c535f09")}</label>
                      <input placeholder={tr("ui.a3a53e8f27a4")} value={docForm.description} onChange={e => setDocForm(p=>({...p, description:e.target.value}))} />
                    </div>
                    {/* Datei-Upload */}
                    {docFile ? (
                      <div style={{ border:'2px solid var(--success)', borderRadius:8, padding:'10px 14px', background:'var(--success-bg)', display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                        <span style={{ fontSize:20 }}>📄</span>
                        <div style={{ flex:1 }}>
                          <div style={{ fontWeight:600, fontSize:12, color:'var(--success)' }}>✅ {docFile.name}</div>
                          <div style={{ fontSize:11, color:'var(--text-muted)' }}>{(docFile.size/1024).toLocaleString(getIntlLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })}{tr("ui.0efab8e1457f")}</div>
                        </div>
                        <button className="btn btn-sm" onClick={() => { setDocFile(null); if(docFileRef.current) docFileRef.current.value='' }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ border:'2px dashed var(--border)', borderRadius:8, padding:'12px', textAlign:'center', cursor:'pointer', marginBottom:10 }}
                        onClick={() => docFileRef.current?.click()}>
                        <div style={{ fontSize:20, marginBottom:4 }}>📎</div>
                        <div style={{ fontSize:12 }}>{tr("ui.674c84fa9a3b")}</div>
                        <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{tr("ui.aa60f073a46e")}</div>
                      </div>
                    )}
                    <input ref={docFileRef} type="file" accept="application/pdf" style={{ display:'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        if (file.size > 20971520) { toast.warn(appMessage("ui.4c2aef50a6c1")); e.target.value=''; return }
                        if (file.type !== 'application/pdf') { toast.warn(appMessage("ui.1d26c75e57a5")); e.target.value=''; return }
                        setDocFile(file)
                        if (!docForm.title) setDocForm(p=>({...p, title: DOC_TYPES[p.document_type]}))
                      }} />
                    <button
                      className="btn btn-primary" style={{ width:'100%' }}
                      disabled={docUploading || !docFile || !docForm.title.trim()}
                      onClick={uploadDoc}>
                      {docUploading ? tr("ui.0d2d5e917311") : tr("ui.0336c4d4a1f3")}
                    </button>
                  </div>

                  {/* Dokument-Liste */}
                  {docsLoading ? (
                    <div style={{ textAlign:'center', padding:16, fontSize:13, color:'var(--text-muted)' }}>{tr("ui.a28b8a0f4826")}</div>
                  ) : empDocs.length === 0 ? (
                    <div style={{ textAlign:'center', padding:16, fontSize:13, color:'var(--text-muted)' }}>{tr("ui.0f11c7238346")}</div>
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
                                {!doc.is_active && <span style={{ marginLeft:8, fontSize:10, background:'#F3F4F6', color:'#6B7280', padding:'1px 5px', borderRadius:3 }}>{tr("ui.e28232fa256a")}</span>}
                              </div>
                              <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                                {DOC_TYPES[doc.document_type] || doc.document_type}
                                {doc.valid_from && tr("ui.aa00ad8eb7cc", { p1: (formatDate(doc.valid_from)) })}
                                {doc.valid_until && tr("ui.75a2ca4efd47", { p1: (formatDate(doc.valid_until)) })}
                              </div>
                              <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:1 }}>
                                {doc.file_name} · {doc.file_size ? `${(doc.file_size/1024).toLocaleString(getIntlLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })} KB` : ''}{tr("ui.754718ecefb8")}{formatDate(doc.uploaded_at?.split('T')[0])}
                                {doc.uploaded_by_name && tr("ui.7e82fadcda3d", { p1: (doc.uploaded_by_name) })}
                              </div>
                              {doc.description && <div style={{ fontSize:11, marginTop:2, color:'var(--text-secondary)' }}>{doc.description}</div>}
                            </div>
                            <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                              <button className="btn btn-sm" disabled={!!docActionId} onClick={() => openDoc(doc)} title={tr("ui.bc385a30b537")}>
                                {docActionId===doc.id+':open' ? '⏳' : '📄'}
                              </button>
                              <button className="btn btn-sm" style={{ background:'var(--info-bg)', color:'var(--info)', border:'1px solid var(--info)' }}
                                disabled={!!docActionId} onClick={() => downloadDoc(doc, form)} title={tr("ui.b3025b16bfa6")}>
                                {docActionId===doc.id+':dl' ? '⏳' : '⬇'}
                              </button>
                              {doc.is_active && (
                                <button className="btn btn-sm" style={{ background:'#FEF3C7', color:'#D97706', border:'1px solid #FDE68A' }}
                                  disabled={!!docActionId} onClick={() => archiveDoc(doc)} title={tr("ui.a54c8debab88")}>
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
              <button className="btn" onClick={() => setModal(null)}>{tr("ui.f7ff1178af20")}</button>
              {isAdmin && <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? tr("ui.cbebb66c9d26") : tr("ui.22158eab4b10")}</button>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
