import { useState, useEffect, useRef } from 'react'
import { supabase, formatDate } from '../lib/supabase'
import { openSignedFile } from '../lib/openFile'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { logActivity } from '../lib/activityLog'

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  v: i + 1,
  l: new Date(2000, i).toLocaleDateString('de-DE', { month: 'long' }),
}))

export default function PayrollDocuments() {
  const { isAdmin, profile } = useProfile()
  const toast = useToast()
  const deleteGuard = useSavingGuard()
  const [employees,  setEmployees]  = useState([])
  const [documents,  setDocuments]  = useState([])
  const [loading,    setLoading]    = useState(true)
  const [actionDocId, setActionDocId] = useState(null)  // 'id:open' | 'id:dl' | null
  const [uploading,  setUploading]  = useState(false)
  const [selEmp,     setSelEmp]     = useState('')
  const [selYear,    setSelYear]    = useState(new Date().getFullYear())
  const [selMonth,   setSelMonth]   = useState(new Date().getMonth() + 1)
  const [selNotes,   setSelNotes]   = useState('')
  const [msg,        setMsg]        = useState('')
  const fileRef = useRef()

  const now = new Date()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    try {
    if (isAdmin) {
      const [{ data: emps }, { data: docs }] = await Promise.all([
        supabase.from('employees').select('id, first_name, last_name').eq('is_active', true).order('last_name'),
        supabase.from('payroll_documents').select('*, employees!employee_id(first_name, last_name)').order('year', { ascending: false }).order('month', { ascending: false }),
      ])
      setEmployees(emps || [])
      setDocuments(docs || [])
      if (emps?.length && !selEmp) setSelEmp(emps[0].id)
    } else {
      // Mitarbeiter sieht nur eigene Dokumente
      const myEmpId = profile.employee_id
      if (!myEmpId) { setDocuments([]); setLoading(false); return }
      const { data: docs } = await supabase
        .from('payroll_documents')
        .select('*')
        .eq('employee_id', myEmpId)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
      setDocuments(docs || [])
    }
    } catch (err) {
      console.error('PayrollDocuments fetch error:', err)
    }
    setLoading(false)
  }

  async function handleUpload() {
    const file = fileRef.current?.files?.[0]
    if (!file) { toast.warn('Bitte eine PDF-Datei auswählen!'); return }
    if (file.type !== 'application/pdf') { toast.warn('Nur PDF-Dateien erlaubt! (.pdf)'); return }
    if (!selEmp) { toast.warn('Bitte einen Mitarbeiter auswählen!'); return }
    if (file.size > 10 * 1024 * 1024) { toast.warn('Datei zu groß — max. 10 MB erlaubt.'); return }

    setUploading(true)
    const monthPad = String(selMonth).padStart(2, '0')
    const filePath = `${selEmp}/${selYear}-${monthPad}-lohnabrechnung.pdf`

    const { error: uploadError } = await supabase.storage
      .from('payroll-docs')
      .upload(filePath, file, { contentType: 'application/pdf', upsert: true })

    if (uploadError) {
      toast.error('Upload-Fehler: ' + uploadError.message)
      setUploading(false)
      return
    }

    const { error: dbError } = await supabase.from('payroll_documents').upsert([{
      employee_id: selEmp,
      year:        selYear,
      month:       selMonth,
      file_name:   file.name,
      file_path:   filePath,
      file_size:   file.size,
      uploaded_by: profile.id,
      notes:       selNotes || null,
    }], { onConflict: 'employee_id,year,month' })

    if (dbError) { toast.error('Datenbankfehler: ' + dbError.message); setUploading(false); return }

    const emp = employees.find(e => e.id === selEmp)
    setMsg(`✅ Lohnabrechnung für ${emp?.first_name} ${emp?.last_name} (${MONTHS.find(m=>m.v===selMonth)?.l} ${selYear}) hochgeladen!`)

    // Protokoll (nur DASS ein Dokument hochgeladen wurde, kein Betrag)
    const docEmpName = emp ? `${emp.first_name} ${emp.last_name}` : 'einen Mitarbeiter'
    logActivity({
      action: 'payroll.document_uploaded', category: 'payroll',
      summary: `hat eine Lohnabrechnung für ${docEmpName} hochgeladen.`,
      targetType: 'payroll_document', targetId: selEmp, targetName: docEmpName,
      metadata: { year: selYear, month: selMonth },
    })

    setTimeout(() => setMsg(''), 5000)
    fileRef.current.value = ''
    setSelNotes('')
    setUploading(false)
    fetchAll()
  }

  async function handleOpen(doc) {
    if (actionDocId) return
    setActionDocId(doc.id + ':open')
    try {
      // Kein await vor openSignedFile — sonst blockiert Safari den neuen Tab
      await openSignedFile(async () => {
        const { data, error } = await supabase.storage
          .from('payroll-docs').createSignedUrl(doc.file_path, 120)
        if (error) throw error
        return data.signedUrl
      }, 'Lohnabrechnung öffnen')
    } catch {
      toast.error('Die Lohnabrechnung konnte nicht geöffnet werden. Bitte erneut versuchen.')
    } finally { setActionDocId(null) }
  }

  async function handleDownload(doc) {
    if (actionDocId) return
    setActionDocId(doc.id + ':dl')
    try {
      const emp      = employees.find(e => e.id === doc.employee_id)
      const lastName = emp?.last_name?.replace(/\s+/g, '_') || 'Mitarbeiter'
      const year     = doc.year  || new Date().getFullYear()
      const month    = String(doc.month || 1).padStart(2, '0')
      const filename = `Lohnabrechnung_${lastName}_${year}-${month}.pdf`

      const { data, error } = await supabase.storage
        .from('payroll-docs').createSignedUrl(doc.file_path, 60, { download: filename })
      if (error) { toast.error('Download fehlgeschlagen: ' + error.message); return }

      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      toast.success('✅ Download gestartet')
    } finally { setActionDocId(null) }
  }

  async function handleDelete(doc) {
    if (!deleteGuard.begin()) return
    const emp = employees.find(e => e.id === doc.employee_id)
    const monthName = MONTHS.find(m => m.v === doc.month)?.l
    // confirm replaced
    await supabase.storage.from('payroll-docs').remove([doc.file_path])
    await supabase.from('payroll_documents').delete().eq('id', doc.id)
    fetchAll()
  }

  function formatBytes(b) {
    if (!b) return ''
    if (b < 1024) return `${b} B`
    if (b < 1048576) return `${(b/1024).toFixed(0)} KB`
    return `${(b/1048576).toFixed(1)} MB`
  }

  if (loading) return <div style={{ padding: 24 }}>Lädt...</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">
          {isAdmin ? 'Lohnabrechnungen verwalten' : 'Meine Lohnabrechnungen'}
        </div>
        {!isAdmin && (
          <div style={{ fontSize:12, color:'var(--text-secondary)' }}>
            Hochgeladen von Frau Todt · Café Buur
          </div>
        )}
      </div>

      <div className="content">
        {msg && <div className="alert alert-success">{msg}</div>}

        {/* ── Admin: Upload ── */}
        {isAdmin && (
          <div className="card mb-5">
            <div className="card-header"><div className="card-title">📤 Lohnabrechnung hochladen</div></div>
            <div className="card-body">
              <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end' }}>
                <div className="form-group" style={{ marginBottom:0, flex:2, minWidth:180 }}>
                  <label>Mitarbeiter</label>
                  <select value={selEmp} onChange={e => setSelEmp(e.target.value)}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom:0 }}>
                  <label>Monat</label>
                  <select value={selMonth} onChange={e => setSelMonth(+e.target.value)} style={{ width:'auto' }}>
                    {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom:0 }}>
                  <label>Jahr</label>
                  <select value={selYear} onChange={e => setSelYear(+e.target.value)} style={{ width:90 }}>
                    {[now.getFullYear()-1, now.getFullYear(), now.getFullYear()+1].map(y => <option key={y}>{y}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'flex-end', flexWrap:'wrap' }}>
                <div className="form-group" style={{ marginBottom:0, flex:2, minWidth:200 }}>
                  <label>PDF-Datei (von Frau Todt)</label>
                  <input type="file" ref={fileRef} accept="application/pdf" style={{ padding:'6px 10px' }} />
                </div>
                <div className="form-group" style={{ marginBottom:0, flex:2, minWidth:180 }}>
                  <label>Notiz (optional)</label>
                  <input value={selNotes} onChange={e => setSelNotes(e.target.value)} placeholder="z.B. inkl. Urlaubsgeld" />
                </div>
                <button className="btn btn-primary" onClick={handleUpload} disabled={uploading} style={{ height:38 }}>
                  {uploading ? '⏳ Lädt hoch...' : '📤 Hochladen'}
                </button>
              </div>
              <div style={{ marginTop:10, fontSize:12, color:'var(--text-secondary)' }}>
                📋 Nur PDF · Max. 10 MB · Mitarbeiter sehen ausschließlich ihre eigenen Dokumente
              </div>
            </div>
          </div>
        )}

        {/* ── Dokumente Liste ── */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              {isAdmin ? `Alle Lohnabrechnungen (${documents.length})` : `Meine Lohnabrechnungen (${documents.length})`}
            </div>
          </div>
          {documents.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <div className="empty-state-text">
                {isAdmin
                  ? 'Noch keine Lohnabrechnungen hochgeladen'
                  : 'Noch keine Lohnabrechnungen verfügbar — du wirst benachrichtigt sobald neue vorhanden sind'
                }
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {isAdmin && <th>Mitarbeiter</th>}
                    <th>Monat</th>
                    <th>Jahr</th>
                    <th>Dateiname</th>
                    <th>Größe</th>
                    <th>Hochgeladen</th>
                    <th>Aktionen</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map(doc => (
                    <tr key={doc.id}>
                      {isAdmin && (
                        <td>
                          <strong>{doc.employees?.first_name} {doc.employees?.last_name}</strong>
                        </td>
                      )}
                      <td>{MONTHS.find(m => m.v === doc.month)?.l}</td>
                      <td>{doc.year}</td>
                      <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        📄 {doc.file_name}
                        {doc.notes && <div style={{ color:'var(--text-muted)' }}>{doc.notes}</div>}
                      </td>
                      <td style={{ fontSize:12 }}>{formatBytes(doc.file_size)}</td>
                      <td style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        {new Date(doc.created_at).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-primary" onClick={() => handleDownload(doc)}>
                            📥 Öffnen
                          </button>
                          {isAdmin && (
                            <button className="btn btn-sm btn-danger" onClick={() => handleDelete(doc)}>
                              🗑
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
