import { t as tr, getIntlLocale, localizeMessage, message as appMessage, errorMessage, messageParts, formatParam } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate } from '../i18n/format.js'
import { openSignedFile } from '../lib/openFile'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { useSavingGuard } from '../lib/savingGuard'
import { logActivity } from '../lib/activityLog'

const getMonths = () => Array.from({ length: 12 }, (_, i) => ({
  v: i + 1,
  l: new Date(2000, i).toLocaleDateString(getIntlLocale(), { month: 'long' }),
}))

export default function PayrollDocuments() {
  useLocale()
  const MONTHS = getMonths()
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
    if (!file) { toast.warn(appMessage("ui.16a70098ba1c")); return }
    if (file.type !== 'application/pdf') { toast.warn(appMessage("ui.8d29dfe2c4fb")); return }
    if (!selEmp) { toast.warn(appMessage("ui.c0f1345f6930")); return }
    if (file.size > 10 * 1024 * 1024) { toast.warn(appMessage("ui.045a756f65c5")); return }

    setUploading(true)
    const monthPad = String(selMonth).padStart(2, '0')
    const filePath = `${selEmp}/${selYear}-${monthPad}-lohnabrechnung.pdf`

    const { error: uploadError } = await supabase.storage
      .from('payroll-docs')
      .upload(filePath, file, { contentType: 'application/pdf', upsert: true })

    if (uploadError) {
      toast.error(messageParts([appMessage("ui.93446336643a"), errorMessage(uploadError)]))
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

    if (dbError) { toast.error(messageParts([appMessage("ui.311318091447"), errorMessage(dbError)])); setUploading(false); return }

    const emp = employees.find(e => e.id === selEmp)
    setMsg(appMessage("ui.2137fc6a781d", { p1: (emp?.first_name), p2: (emp?.last_name), p3: (formatParam('date', new Date(2000, selMonth - 1), {month:'long'})), p4: (selYear) }))

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
      }, appMessage("ui.e6a21234e775"))
    } catch {
      toast.error(appMessage("ui.f1192c9709a0"))
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
      if (error) { toast.error(messageParts([appMessage("ui.322e45a8c6c6"), errorMessage(error)])); return }

      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      toast.success(appMessage("ui.a82b31ba0a0e"))
    } finally { setActionDocId(null) }
  }

  async function handleDelete(doc) {
    const emp = employees.find(e => e.id === doc.employee_id)
    const monthName = MONTHS.find(m => m.v === doc.month)?.l
    const who = emp ? `${emp.first_name} ${emp.last_name}` : tr("ui.e9a753bcc8a5")
    if (!window.confirm(tr("ui.7230af15fa2e", { p1: (monthName || ''), p2: (doc.year || ''), p3: (who) }))) return
    if (!deleteGuard.begin()) return
    try {
      const { error } = await supabase.from('payroll_documents').delete().eq('id', doc.id)
      if (error) { toast.error(appMessage("ui.5bbd80995ec4")); return }
      await supabase.storage.from('payroll-docs').remove([doc.file_path])
      toast.success(appMessage("ui.d01284bfc449"))
    } finally {
      deleteGuard.end()
      fetchAll()
    }
  }

  function formatBytes(b) {
    if (!b) return ''
    if (b < 1024) return `${b} B`
    if (b < 1048576) return `${(b/1024).toLocaleString(getIntlLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 })} KB`
    return `${(b/1048576).toLocaleString(getIntlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
  }

  if (loading) return <div style={{ padding: 24 }}>{tr("ui.7a72dd7b9d46")}</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">
          {isAdmin ? tr("ui.2054022bbc03") : tr("ui.5893138b1479")}
        </div>
        {!isAdmin && (
          <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{tr("ui.a56808511963")}</div>
        )}
      </div>

      <div className="content">
        {msg && <div className="alert alert-success">{localizeMessage(msg)}</div>}

        {/* ── Admin: Upload ── */}
        {isAdmin && (
          <div className="card mb-5">
            <div className="card-header"><div className="card-title">{tr("ui.caf31274883c")}</div></div>
            <div className="card-body">
              <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end' }}>
                <div className="form-group" style={{ marginBottom:0, flex:2, minWidth:180 }}>
                  <label>{tr("ui.f4cb6891b9e5")}</label>
                  <select value={selEmp} onChange={e => setSelEmp(e.target.value)}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom:0 }}>
                  <label>{tr("ui.2933070469a2")}</label>
                  <select value={selMonth} onChange={e => setSelMonth(+e.target.value)} style={{ width:'auto' }}>
                    {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom:0 }}>
                  <label>{tr("ui.ed1ad93b8967")}</label>
                  <select value={selYear} onChange={e => setSelYear(+e.target.value)} style={{ width:90 }}>
                    {[now.getFullYear()-1, now.getFullYear(), now.getFullYear()+1].map(y => <option key={y}>{y}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'flex-end', flexWrap:'wrap' }}>
                <div className="form-group" style={{ marginBottom:0, flex:2, minWidth:200 }}>
                  <label>{tr("ui.5efc8d482bd3")}</label>
                  <input type="file" ref={fileRef} accept="application/pdf" style={{ padding:'6px 10px' }} />
                </div>
                <div className="form-group" style={{ marginBottom:0, flex:2, minWidth:180 }}>
                  <label>{tr("ui.337da4d81ab6")}</label>
                  <input value={selNotes} onChange={e => setSelNotes(e.target.value)} placeholder={tr("ui.18ff0b7672f3")} />
                </div>
                <button className="btn btn-primary" onClick={handleUpload} disabled={uploading} style={{ height:38 }}>
                  {uploading ? tr("ui.d3a1f56371cf") : tr("ui.d9658baabf2e")}
                </button>
              </div>
              <div style={{ marginTop:10, fontSize:12, color:'var(--text-secondary)' }}>{tr("ui.d29ea321d84e")}</div>
            </div>
          </div>
        )}

        {/* ── Dokumente Liste ── */}
        <div className="card">
          <div className="card-header">
            <div className="card-title">
              {isAdmin ? tr("ui.e51fbe65ba0d", { p1: (documents.length) }) : tr("ui.9df4055151ed", { p1: (documents.length) })}
            </div>
          </div>
          {documents.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <div className="empty-state-text">
                {isAdmin
                  ? tr("ui.ede31be770da")
                  : tr("ui.e9b8f9cffca2")
                }
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {isAdmin && <th>{tr("ui.f4cb6891b9e5")}</th>}
                    <th>{tr("ui.2933070469a2")}</th>
                    <th>{tr("ui.ed1ad93b8967")}</th>
                    <th>{tr("ui.9b5378efc9fc")}</th>
                    <th>{tr("ui.aedc3f80989a")}</th>
                    <th>{tr("ui.9ed323d68644")}</th>
                    <th>{tr("ui.5656f92db78d")}</th>
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
                        {new Date(doc.created_at).toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'})}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-sm btn-primary" onClick={() => handleDownload(doc)}>{tr("ui.294dc7c74bf7")}</button>
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
