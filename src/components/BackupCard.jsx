import { formatDateTime as exportDateTime } from '../lib/supabase'
import { t as tr, getIntlLocale, localizeMessage, message as appMessage, messageError, errorMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useEffect, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'
import { supabase, toLocalDateStr } from '../lib/supabase'
import { formatDateTime } from '../i18n/format.js'
import { useToast } from './UI/Toast'

/**
 * Admin: Datensicherung.
 * - Automatisch jede Woche (Server, siehe Migration 10_backups).
 * - Download als ZIP: alle Tabellen (daten.json) + optional alle Dokumente
 *   (Krankmeldungen, Lohnabrechnungen, Personalunterlagen, Profilbilder).
 */
import { BACKUP_REMIND_DAYS } from '../lib/backup'

const README = (stand) => `Café Buur – Datensicherung
Stand: ${stand}

INHALT
- daten.json: alle Daten der App (Mitarbeiter, Arbeitszeiten, Schichten, Urlaub,
  Krankmeldungen, Lohn-Einträge, Einladungen, Protokoll, Einstellungen).
- dokumente/: hochgeladene Dateien (Krankmeldungen, Lohnabrechnungen,
  Personalunterlagen, Profilbilder) – nur wenn „mit Dokumenten“ gewählt wurde.

NICHT ENTHALTEN
- Passwörter (liegen verschlüsselt nur beim Anmeldedienst).
- Zugangsschlüssel von Kassen-Integrationen.

WICHTIG – DATENSCHUTZ
Diese Datei enthält sensible Personaldaten (z. B. IBAN, Steuer-ID,
Sozialversicherungsnummer, Krankmeldungen).
- Sicher aufbewahren: z. B. auf einem verschlüsselten USB-Stick oder in einem
  geschützten Ordner. Nicht per E-Mail oder Messenger verschicken.
- Alte Sicherungen löschen, wenn sie nicht mehr gebraucht werden.

WIEDERHERSTELLEN
Die Datei wird nur im Notfall gebraucht (z. B. wenn Daten versehentlich gelöscht
wurden oder der Server ausfällt). Die Wiederherstellung übernimmt die technische
Betreuung der App anhand dieser Datei.
`

const isIOSDevice = () => /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.rel = 'noopener'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

function sizeLabel(bytes) {
  if (!bytes && bytes !== 0) return '–'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(getIntlLocale())} KB`
  return `${(bytes / 1024 / 1024).toLocaleString(getIntlLocale(), { maximumFractionDigits: 1 })} MB`
}

export default function BackupCard() {
  useLocale()
  const toast = useToast()
  const [list, setList]       = useState(null)
  const [lastDl, setLastDl]   = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy]       = useState(false)
  const [progress, setProgress] = useState('')
  const [withDocs, setWithDocs] = useState(true)
  const [shareFile, setShareFile] = useState(null)   // iPhone: fertige Datei, per Tipp teilen

  async function load() {
    setLoadErr('')
    try {
      const { data, error } = await supabase.rpc('backup_list')
      if (error || !data?.success) throw messageError((data?.error || appMessage("ui.a7293b48321a")))
      setList(data.backups || []); setLastDl(data.last_download_at || null)
    } catch (e) { setLoadErr((errorMessage(e) || appMessage("ui.a7293b48321a"))) }
  }
  useEffect(() => { load() }, [])

  async function buildAndDownload(id, includeDocs) {
    setProgress(appMessage("ui.c798b59b4187"))
    const { data: res, error } = await supabase.rpc('backup_get', { p_id: id })
    if (error || !res?.success) throw messageError((res?.error || appMessage("ui.82ff9a344c25")))
    const stand = `${exportDateTime(res.created_at)} Uhr`
    const files = {
      'LIESMICH.txt': [strToU8(README(stand)), { level: 6 }],
      'daten.json':   [strToU8(JSON.stringify(res.data, null, 2)), { level: 6 }],
    }
    const missing = []
    if (includeDocs) {
      const docs = res.data?.files || []
      for (let i = 0; i < docs.length; i++) {
        const f = docs[i]
        setProgress(appMessage("ui.e8bc2774d369", { p1: (i + 1), p2: (docs.length) }))
        try {
          const { data: blob, error: dErr } = await supabase.storage.from(f.bucket).download(f.name)
          if (dErr || !blob) throw new Error('x')
          files[`dokumente/${f.bucket}/${f.name}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]
        } catch {
          missing.push(`${f.bucket}/${f.name}`)
        }
      }
      if (missing.length) files['FEHLENDE-DATEIEN.txt'] = [strToU8('Diese Dateien konnten nicht geladen werden:\n' + missing.join('\n') + '\n'), { level: 6 }]
    }
    setProgress(appMessage("ui.655aaf636e28"))
    const zipped = zipSync(files)
    const day = toLocalDateStr(new Date(res.created_at))
    const fname = `Cafe-Buur-Sicherung-${day}${includeDocs ? '' : '-nur-Daten'}.zip`
    // iPhone: Teilen braucht einen frischen Tipp → Datei bereitlegen, Knopf anzeigen
    if (isIOSDevice() && navigator.canShare) {
      const file = new File([zipped], fname, { type: 'application/zip' })
      if (navigator.canShare({ files: [file] })) { setShareFile(file); return -1 - missing.length }
    }
    download(zipped, fname)
    return missing.length
  }

  async function backupNow() {
    if (busy) return
    setBusy(true)
    try {
      setProgress(appMessage("ui.36fdc6b45b03"))
      const { data, error } = await supabase.rpc('backup_create_now')
      if (error || !data?.success) throw messageError((data?.error || appMessage("ui.30ea1b5d507b")))
      const r = await buildAndDownload(data.id, withDocs)
      const missing = r < 0 ? -1 - r : r
      if (r < 0 && !missing) toast.success(appMessage("ui.947febb56619"))
      else if (missing) toast.warn(appMessage("ui.3310b92cc20b", { p1: (missing) }), 9000)
      else toast.success(appMessage("ui.9678d9311923"))
      await load()
    } catch (e) {
      toast.error((errorMessage(e) || appMessage("ui.2afbcf86131c")))
    } finally {
      setBusy(false); setProgress('')
    }
  }

  async function downloadOld(id) {
    if (busy) return
    setBusy(true)
    try {
      const r = await buildAndDownload(id, false)
      toast.success(r < 0 ? (appMessage("ui.947febb56619")) : (appMessage("ui.9678d9311923")))
      await load()
    } catch (e) {
      toast.error((errorMessage(e) || appMessage("ui.5643d003b6c5")))
    } finally {
      setBusy(false); setProgress('')
    }
  }

  const daysSince = lastDl ? Math.floor((Date.now() - new Date(lastDl)) / 86400000) : null
  const overdue = daysSince === null || daysSince >= BACKUP_REMIND_DAYS

  return (
    <div className="card" style={{ marginTop:16 }} id="datensicherung">
      <div className="card-header"><div className="card-title">{tr("ui.b16ff038ba72")}</div></div>
      <div className="card-body">
        <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:12 }}>{tr("ui.caa9a19e8e8b")}<strong>{tr("ui.4b455f1bbe83")}</strong>{tr("ui.0f011f2bc42d")}<strong>{tr("ui.26aed443565b")}</strong>{tr("ui.34b7f052f9b1")}</div>

        {lastDl !== undefined && list && (
          <div className={`alert ${overdue ? 'alert-warn' : 'alert-success'}`} style={{ fontSize:13 }}>
            {daysSince === null
              ? tr("ui.0f113ae7ac03")
              : overdue
                ? tr("ui.80061f119c47", { p1: (daysSince), p2: (formatDateTime(lastDl)) })
                : tr("ui.0f219ef97195", { p1: (formatDateTime(lastDl)) })}
          </div>
        )}

        <label style={{ display:'flex', gap:10, alignItems:'center', fontSize:13.5, margin:'4px 0 12px', cursor:'pointer' }}>
          <input type="checkbox" checked={withDocs} onChange={e => setWithDocs(e.target.checked)} disabled={busy} />
          <span>{tr("ui.770fc2d2195b")}</span>
        </label>
        <button className="btn btn-primary" onClick={backupNow} disabled={busy} style={{ width:'100%', justifyContent:'center' }}>
          {busy && progress ? `⏳ ${localizeMessage(progress)}` : tr("ui.138b54f3a33d")}
        </button>
        <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8, lineHeight:1.5 }}>{tr("ui.da5f71b32483")}</div>

        {shareFile && (
          <div className="alert alert-success" style={{ fontSize:13, marginTop:12, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ flex:1 }}>{tr("ui.f16b58721439")}</span>
            <button className="btn btn-primary btn-sm" onClick={async () => {
              try { await navigator.share({ files: [shareFile], title: shareFile.name }); setShareFile(null) }
              catch (e) { if (e?.name !== 'AbortError') toast.error(appMessage("ui.a6792efed5b6")) }
            }}>{tr("ui.bbd70eb273e6")}</button>
          </div>
        )}

        {loadErr && <div className="alert alert-danger" style={{ fontSize:13, marginTop:12 }}>{localizeMessage(loadErr)}</div>}

        {list && list.length > 0 && (
          <details style={{ marginTop:14 }}>
            <summary style={{ cursor:'pointer', fontSize:13, fontWeight:600 }}>{tr("ui.757a7387dd8f")}{list.length})</summary>
            <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:10 }}>
              {list.map(b => (
                <div key={b.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, flexWrap:'wrap', fontSize:13 }}>
                  <div style={{ flex:1, minWidth:180 }}>
                    <div style={{ fontWeight:600 }}>{formatDateTime(b.created_at)}{tr("ui.4e2866d1f2b9")}</div>
                    <div style={{ fontSize:12, color:'var(--text-muted)' }}>
                      {b.kind === 'auto' ? 'automatisch' : 'manuell'} · {sizeLabel(b.size_bytes)} · {b.counts?.employees ?? 0}{tr("ui.84026e42c641")}{b.counts?.time_entries ?? 0}{tr("ui.14df65407928")}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => downloadOld(b.id)} disabled={busy}>{tr("ui.b193f6e02258")}</button>
                </div>
              ))}
            </div>
            <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:6 }}>{tr("ui.0d290587746a")}</div>
          </details>
        )}
      </div>
    </div>
  )
}
