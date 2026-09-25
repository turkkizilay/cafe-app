import { t as tr, getIntlLocale, localizeMessage, sourceLabel, message as appMessage, messageError, errorMessage, messageParts } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from './UI/Toast'
import { openSignedFile } from '../lib/openFile'

/**
 * Admin: Aufbewahrungsfristen & Löschung (Art. 5 Abs. 1 e, Art. 17 DSGVO).
 * Fristen und Prüfung liegen serverseitig (Migrationen 11, 14, 15).
 * Ablauf beim Löschen: Probelauf → Dateien (Storage-API) → Datensätze + Protokoll mit Dateiliste.
 */
const fmtDate = d => d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(getIntlLocale(), { day:'2-digit', month:'2-digit', year:'numeric' }) : '–'
const fmtSize = b => b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toLocaleString(getIntlLocale(), { maximumFractionDigits: 1 })} MB`
const unitLabel = (c) => c.key === 'verwaist' ? tr("ui.d6a05fa07a80") : c.key === 'ehemalige' ? tr("ui.b52ce048da27") : tr("ui.b46a6b65c674")

async function removeFiles(files) {
  const byBucket = {}
  files.forEach(f => { (byBucket[f.bucket] = byBucket[f.bucket] || []).push(f) })
  const removed = []
  for (const [bucket, list] of Object.entries(byBucket)) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100)
      const { data, error } = await supabase.storage.from(bucket).remove(chunk.map(f => f.name))
      if (error) continue
      const ok = new Set((data || []).map(o => o.name))
      chunk.forEach(f => { if (ok.has(f.name)) removed.push(f) })
    }
  }
  return removed
}

function Details({ c }) {
  useLocale()
  const [open, setOpen] = useState(false)
  const breakdown = Object.entries(c.breakdown || {}).filter(([, v]) => Number(v) > 0)
  const files = c.files || []
  if (!breakdown.length && !files.length && !(c.names?.length)) return null
  return (
    <div style={{ marginTop:6 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ background:'none', border:'none', padding:0, color:'var(--accent)', fontSize:12.5, cursor:'pointer', fontWeight:600 }}>
        {open ? tr("ui.6b4be28efe37") : tr("ui.7c7e9cef9c91")}
      </button>
      {open && (
        <div style={{ marginTop:6, fontSize:12.5, lineHeight:1.6 }}>
          {breakdown.length > 0 && <div>{breakdown.map(([k, v]) => `${v} ${k}`).join(' · ')}</div>}
          {c.names?.length > 0 && <div>{tr("ui.1e1dee1e627d")}{c.names.join(', ')}</div>}
          {files.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:4 }}>
              {files.map(f => (
                <div key={f.bucket + f.name} style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', padding:'4px 8px', background:'var(--bg)', borderRadius:6 }}>
                  <span style={{ flex:1, minWidth:200 }}>
                    <strong>{f.kind}</strong> · {f.employee}{tr("ui.754718ecefb8")}{fmtDate(f.uploaded_at)}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => openSignedFile(async () => {
                    const { data, error } = await supabase.storage.from(f.bucket).createSignedUrl(f.name, 120)
                    if (error || !data?.signedUrl) throw messageError(appMessage("ui.f4b4aba29984"))
                    return data.signedUrl
                  }, appMessage("ui.a9b9b5609491", { p1: (f.kind) })).catch(() => {})}>{tr("ui.8e31363947a6")}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function RetentionCard() {
  useLocale()
  const toast = useToast()
  const [info, setInfo]     = useState(null)
  const [error, setError]   = useState('')
  const [confirm, setConfirm] = useState(null)
  const [backupOk, setBackupOk] = useState(false)
  const [busy, setBusy]     = useState(false)

  async function load() {
    setError('')
    try {
      const { data, error } = await supabase.rpc('retention_overview')
      if (error || !data?.success) throw messageError((data?.error || appMessage("ui.a7293b48321a")))
      setInfo(data)
    } catch (e) { setError((errorMessage(e) || appMessage("ui.a7293b48321a"))) }
  }
  useEffect(() => { load() }, [])

  async function purge() {
    if (busy || !confirm || !backupOk) return
    setBusy(true)
    try {
      // 1. Probelauf: prüft, ob das Löschen der Datensätze klappen würde – erst dann Dateien anfassen
      const { data: dry, error: dryErr } = await supabase.rpc('retention_purge', { p_cat: confirm.key, p_dry_run: true })
      if (dryErr || !dry?.success) throw messageError((dry?.error || appMessage("ui.5f9bd1fd1f95")))
      // 2. Dateien, 3. Datensätze (+ Protokoll mit der Liste der gelöschten Dateien)
      const files = confirm.files || []
      const removed = files.length ? await removeFiles(files) : []
      const { data, error } = await supabase.rpc('retention_purge', {
        p_cat: confirm.key,
        p_deleted_files: removed.map(f => ({ kind: f.kind, employee: f.employee, uploaded_at: f.uploaded_at, size: f.size })),
      })
      if (error || !data?.success) throw messageError((data?.error || appMessage("ui.df3db3f204c8")))
      const parts = []
      if (data.deleted) parts.push(appMessage("count.entries", { count: data.deleted }))
      if (removed.length) parts.push(appMessage("count.files", { count: removed.length }))
      if (removed.length < files.length) {
        toast.warn(appMessage("ui.8663a5d4e1e0", { p1: (parts.length ? (messageParts([" (", messageParts(parts, ', '), ")"])) : ('')), p2: (files.length - removed.length) }), 9000)
      } else {
        toast.success(appMessage("ui.b0bfbe8485b9", { p1: ((parts.length ? messageParts(parts, ', ') : appMessage("ui.0a2c28b18a25"))) }), 7000)
      }
      setConfirm(null); setBackupOk(false)
      await load()
    } catch (e) {
      toast.error((errorMessage(e) || appMessage("ui.5bbd80995ec4")))
    } finally {
      setBusy(false)
    }
  }

  const cats = info?.categories || []
  const former = cats.find(c => c.key === 'ehemalige')

  return (
    <div className="card" style={{ marginTop:16 }} id="aufbewahrung">
      <div className="card-header"><div className="card-title">{tr("ui.fe41440e13f2")}</div></div>
      <div className="card-body">
        <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:12 }}>{tr("ui.6a61d7073a4a")}<strong>{tr("ui.9c8cc5cff19d")}</strong>.
        </div>
        {error && <div className="alert alert-danger" style={{ fontSize:13 }}>{localizeMessage(error)} <button className="btn btn-sm" onClick={load}>{tr("ui.d46b0c9eebd9")}</button></div>}
        {!info && !error && <div style={{ fontSize:13, color:'var(--text-secondary)' }}>{tr("ui.ebbb1d1f265f")}</div>}

        {former?.missing_end_date > 0 && (
          <div className="alert alert-warn" style={{ fontSize:12.5 }}>
            ⚠️ {tr("retention.missingDate", { count: former.missing_end_date })}</div>
        )}

        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {cats.map(c => (
            <div key={c.key} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 12px', border:'1px solid var(--border)', borderRadius:10, flexWrap:'wrap', background: c.due > 0 ? 'var(--warn-light, #FFF7ED)' : 'transparent' }}>
              <div style={{ flex:1, minWidth:220 }}>
                <div style={{ fontWeight:600, fontSize:13.5 }}>{sourceLabel(c.title)}</div>
                <div style={{ fontSize:12, color:'var(--text-muted)' }}>{tr("ui.aa861cd97b54")}{sourceLabel(c.rule)}</div>
                <div style={{ fontSize:12, marginTop:2, color: c.due > 0 ? 'var(--warn)' : 'var(--text-secondary)' }}>
                  {c.due > 0 ? tr("ui.c17dfd28be82", { p1: (c.due), p2: (unitLabel(c)) }) : c.next_due ? tr("ui.6ab2459cf087", { p1: (fmtDate(c.next_due)) }) : tr("ui.be95db22a6c5")}
                </div>
                {c.due > 0 && <Details c={c} />}
              </div>
              {c.due > 0 && <button className="btn btn-sm btn-danger" onClick={() => { setConfirm(c); setBackupOk(false) }}>{tr("ui.161929fed42a")}</button>}
            </div>
          ))}
        </div>
        {info && (
          <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:10, lineHeight:1.5 }}>{tr("ui.b8fc04fc980e")}</div>
        )}
      </div>

      {confirm && (
        <div className="modal-overlay" onClick={() => !busy && setConfirm(null)}>
          <div className="modal" style={{ maxWidth:520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">{tr("ui.be9632b5a2ad")}</div><button className="btn btn-sm" onClick={() => setConfirm(null)} disabled={busy}>✕</button></div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>
              <div><strong>{sourceLabel(confirm.title)}</strong> – {confirm.due} {unitLabel(confirm)}</div>
              <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4 }}>{tr("ui.8446867dbbc4")}{confirm.rule}.</div>
              <div style={{ maxHeight:220, overflowY:'auto', marginTop:8, border:'1px solid var(--border)', borderRadius:8, padding:'6px 10px', fontSize:12.5 }}>
                {Object.entries(confirm.breakdown || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => <div key={k}>• {v} {k}</div>)}
                {(confirm.names || []).map(n => <div key={n}>• {n}{tr("ui.77204fe134ce")}</div>)}
                {(confirm.files || []).map(f => (
                  <div key={f.bucket + f.name}>• {f.kind} · {f.employee}{tr("ui.754718ecefb8")}{fmtDate(f.uploaded_at)}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}</div>
                ))}
              </div>
              <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:8 }}>{tr("ui.ab3873e10fe0")}</div>
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', marginTop:12, cursor:'pointer' }}>
                <input type="checkbox" checked={backupOk} onChange={e => setBackupOk(e.target.checked)} style={{ marginTop:3 }} />
                <span>{tr("ui.103cb962a873")}<strong>{tr("ui.e958d839f007")}</strong>{tr("ui.e365ea5d93b5")}</span>
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirm(null)} disabled={busy}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-danger" onClick={purge} disabled={busy || !backupOk}>{busy ? tr("ui.2efa15362ea7") : tr("ui.6c1fd39216fe")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
