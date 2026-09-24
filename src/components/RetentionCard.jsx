import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from './UI/Toast'
import { openSignedFile } from '../lib/openFile'

/**
 * Admin: Aufbewahrungsfristen & Löschung (Art. 5 Abs. 1 e, Art. 17 DSGVO).
 * Fristen und Prüfung liegen serverseitig (Migrationen 11, 14, 15).
 * Ablauf beim Löschen: Probelauf → Dateien (Storage-API) → Datensätze + Protokoll mit Dateiliste.
 */
const fmtDate = d => d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }) : '–'
const fmtSize = b => b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`
const unitLabel = (c) => c.key === 'verwaist' ? 'Datei(en)' : c.key === 'ehemalige' ? 'Person(en)' : 'Einträge'

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
  const [open, setOpen] = useState(false)
  const breakdown = Object.entries(c.breakdown || {}).filter(([, v]) => Number(v) > 0)
  const files = c.files || []
  if (!breakdown.length && !files.length && !(c.names?.length)) return null
  return (
    <div style={{ marginTop:6 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ background:'none', border:'none', padding:0, color:'var(--accent)', fontSize:12.5, cursor:'pointer', fontWeight:600 }}>
        {open ? '▾ Details ausblenden' : '▸ Was genau wird gelöscht?'}
      </button>
      {open && (
        <div style={{ marginTop:6, fontSize:12.5, lineHeight:1.6 }}>
          {breakdown.length > 0 && <div>{breakdown.map(([k, v]) => `${v} ${k}`).join(' · ')}</div>}
          {c.names?.length > 0 && <div>Personen: {c.names.join(', ')}</div>}
          {files.length > 0 && (
            <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:4 }}>
              {files.map(f => (
                <div key={f.bucket + f.name} style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', padding:'4px 8px', background:'var(--bg)', borderRadius:6 }}>
                  <span style={{ flex:1, minWidth:200 }}>
                    <strong>{f.kind}</strong> · {f.employee} · hochgeladen {fmtDate(f.uploaded_at)}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => openSignedFile(async () => {
                    const { data, error } = await supabase.storage.from(f.bucket).createSignedUrl(f.name, 120)
                    if (error || !data?.signedUrl) throw new Error('Datei konnte nicht geöffnet werden.')
                    return data.signedUrl
                  }, `${f.kind} öffnen`).catch(() => {})}>Ansehen</button>
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
      if (error || !data?.success) throw new Error(data?.error || 'Konnte nicht geladen werden.')
      setInfo(data)
    } catch (e) { setError(e.message || 'Konnte nicht geladen werden.') }
  }
  useEffect(() => { load() }, [])

  async function purge() {
    if (busy || !confirm || !backupOk) return
    setBusy(true)
    try {
      // 1. Probelauf: prüft, ob das Löschen der Datensätze klappen würde – erst dann Dateien anfassen
      const { data: dry, error: dryErr } = await supabase.rpc('retention_purge', { p_cat: confirm.key, p_dry_run: true })
      if (dryErr || !dry?.success) throw new Error(dry?.error || 'Löschen ist gerade nicht möglich. Es wurde nichts gelöscht.')
      // 2. Dateien, 3. Datensätze (+ Protokoll mit der Liste der gelöschten Dateien)
      const files = confirm.files || []
      const removed = files.length ? await removeFiles(files) : []
      const { data, error } = await supabase.rpc('retention_purge', {
        p_cat: confirm.key,
        p_deleted_files: removed.map(f => ({ kind: f.kind, employee: f.employee, uploaded_at: f.uploaded_at, size: f.size })),
      })
      if (error || !data?.success) throw new Error(data?.error || 'Löschen fehlgeschlagen.')
      const parts = []
      if (data.deleted) parts.push(`${data.deleted} Einträge`)
      if (removed.length) parts.push(`${removed.length} Dateien`)
      if (removed.length < files.length) {
        toast.warn(`Teilweise gelöscht${parts.length ? ` (${parts.join(', ')})` : ''}. ${files.length - removed.length} Datei(en) konnten nicht entfernt werden – bitte später erneut versuchen.`, 9000)
      } else {
        toast.success(`🗑️ Gelöscht: ${parts.join(', ') || 'nichts mehr fällig'}. Details stehen im Protokoll.`, 7000)
      }
      setConfirm(null); setBackupOk(false)
      await load()
    } catch (e) {
      toast.error(e.message || 'Löschen fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setBusy(false)
    }
  }

  const cats = info?.categories || []
  const former = cats.find(c => c.key === 'ehemalige')

  return (
    <div className="card" style={{ marginTop:16 }} id="aufbewahrung">
      <div className="card-header"><div className="card-title">🗂️ Aufbewahrung & Löschfristen</div></div>
      <div className="card-body">
        <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:12 }}>
          Personaldaten dürfen nur so lange gespeichert werden, wie sie gebraucht werden oder das Gesetz es verlangt.
          Hier siehst du, was die Frist erreicht hat – mit „Was genau wird gelöscht?“ auch jede einzelne Datei. Gelöscht wird erst, wenn du es bestätigst.
          Was gelöscht wurde, steht danach im <strong>Protokoll</strong>.
        </div>
        {error && <div className="alert alert-danger" style={{ fontSize:13 }}>{error} <button className="btn btn-sm" onClick={load}>Erneut</button></div>}
        {!info && !error && <div style={{ fontSize:13, color:'var(--text-secondary)' }}>Lädt…</div>}

        {former?.missing_end_date > 0 && (
          <div className="alert alert-warn" style={{ fontSize:12.5 }}>
            ⚠️ {former.missing_end_date} ehemalige{former.missing_end_date === 1 ? 'r' : ''} Mitarbeiter ohne Austrittsdatum – bitte unter „Mitarbeiter“ eintragen, sonst kann die Frist nicht berechnet werden.
          </div>
        )}

        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {cats.map(c => (
            <div key={c.key} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 12px', border:'1px solid var(--border)', borderRadius:10, flexWrap:'wrap', background: c.due > 0 ? 'var(--warn-light, #FFF7ED)' : 'transparent' }}>
              <div style={{ flex:1, minWidth:220 }}>
                <div style={{ fontWeight:600, fontSize:13.5 }}>{c.title}</div>
                <div style={{ fontSize:12, color:'var(--text-muted)' }}>Frist: {c.rule}</div>
                <div style={{ fontSize:12, marginTop:2, color: c.due > 0 ? 'var(--warn)' : 'var(--text-secondary)' }}>
                  {c.due > 0 ? `${c.due} ${unitLabel(c)} fällig` : c.next_due ? `Nichts fällig – frühestens ab ${fmtDate(c.next_due)}` : 'Nichts fällig'}
                </div>
                {c.due > 0 && <Details c={c} />}
              </div>
              {c.due > 0 && <button className="btn btn-sm btn-danger" onClick={() => { setConfirm(c); setBackupOk(false) }}>Löschen …</button>}
            </div>
          ))}
        </div>
        {info && (
          <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:10, lineHeight:1.5 }}>
            Die Fristen sind bewusst vorsichtig gewählt (Arbeitszeit: § 17 MiLoG / § 16 ArbZG, Lohn: § 147 AO / § 41 EStG). Bitte einmal mit der Steuerberatung abstimmen.
            In den automatischen Server-Sicherungen verschwinden gelöschte Daten spätestens nach 8 Wochen.
          </div>
        )}
      </div>

      {confirm && (
        <div className="modal-overlay" onClick={() => !busy && setConfirm(null)}>
          <div className="modal" style={{ maxWidth:520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><div className="modal-title">🗑️ Endgültig löschen?</div><button className="btn btn-sm" onClick={() => setConfirm(null)} disabled={busy}>✕</button></div>
            <div className="modal-body" style={{ fontSize:13.5, lineHeight:1.6 }}>
              <div><strong>{confirm.title}</strong> – {confirm.due} {unitLabel(confirm)}</div>
              <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:4 }}>Grund: {confirm.rule}.</div>
              <div style={{ maxHeight:220, overflowY:'auto', marginTop:8, border:'1px solid var(--border)', borderRadius:8, padding:'6px 10px', fontSize:12.5 }}>
                {Object.entries(confirm.breakdown || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => <div key={k}>• {v} {k}</div>)}
                {(confirm.names || []).map(n => <div key={n}>• {n} – alle Daten</div>)}
                {(confirm.files || []).map(f => (
                  <div key={f.bucket + f.name}>• {f.kind} · {f.employee} · hochgeladen {fmtDate(f.uploaded_at)}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}</div>
                ))}
              </div>
              <div style={{ fontSize:12.5, color:'var(--text-secondary)', marginTop:8 }}>Das lässt sich nicht rückgängig machen. Die Liste wird im Protokoll festgehalten.</div>
              <label style={{ display:'flex', gap:10, alignItems:'flex-start', marginTop:12, cursor:'pointer' }}>
                <input type="checkbox" checked={backupOk} onChange={e => setBackupOk(e.target.checked)} style={{ marginTop:3 }} />
                <span>Ich habe vorher eine aktuelle Datensicherung <strong>mit Dokumenten</strong> heruntergeladen (oder brauche die Daten sicher nicht mehr).</span>
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setConfirm(null)} disabled={busy}>Abbrechen</button>
              <button className="btn btn-danger" onClick={purge} disabled={busy || !backupOk}>{busy ? 'Wird gelöscht …' : 'Endgültig löschen'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
