import { useEffect, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'
import { supabase, formatDateTime, toLocalDateStr } from '../lib/supabase'
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
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('de-DE')} KB`
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`
}

export default function BackupCard() {
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
      if (error || !data?.success) throw new Error(data?.error || 'Konnte nicht geladen werden.')
      setList(data.backups || []); setLastDl(data.last_download_at || null)
    } catch (e) { setLoadErr(e.message || 'Konnte nicht geladen werden.') }
  }
  useEffect(() => { load() }, [])

  async function buildAndDownload(id, includeDocs) {
    setProgress('Daten werden geladen …')
    const { data: res, error } = await supabase.rpc('backup_get', { p_id: id })
    if (error || !res?.success) throw new Error(res?.error || 'Sicherung konnte nicht geladen werden.')
    const stand = `${formatDateTime(res.created_at)} Uhr`
    const files = {
      'LIESMICH.txt': [strToU8(README(stand)), { level: 6 }],
      'daten.json':   [strToU8(JSON.stringify(res.data, null, 2)), { level: 6 }],
    }
    const missing = []
    if (includeDocs) {
      const docs = res.data?.files || []
      for (let i = 0; i < docs.length; i++) {
        const f = docs[i]
        setProgress(`Dokumente ${i + 1} von ${docs.length} …`)
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
    setProgress('ZIP wird erstellt …')
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
      setProgress('Sicherung wird erstellt …')
      const { data, error } = await supabase.rpc('backup_create_now')
      if (error || !data?.success) throw new Error(data?.error || 'Sicherung fehlgeschlagen.')
      const r = await buildAndDownload(data.id, withDocs)
      const missing = r < 0 ? -1 - r : r
      if (r < 0 && !missing) toast.success('Sicherung ist fertig – jetzt auf „Sichern“ tippen.')
      else if (missing) toast.warn(`Sicherung heruntergeladen – ${missing} Datei(en) fehlten (siehe FEHLENDE-DATEIEN.txt).`, 9000)
      else toast.success('✅ Sicherung heruntergeladen')
      await load()
    } catch (e) {
      toast.error(e.message || 'Sicherung fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setBusy(false); setProgress('')
    }
  }

  async function downloadOld(id) {
    if (busy) return
    setBusy(true)
    try {
      const r = await buildAndDownload(id, false)
      toast.success(r < 0 ? 'Sicherung ist fertig – jetzt auf „Sichern“ tippen.' : '✅ Sicherung heruntergeladen')
      await load()
    } catch (e) {
      toast.error(e.message || 'Download fehlgeschlagen.')
    } finally {
      setBusy(false); setProgress('')
    }
  }

  const daysSince = lastDl ? Math.floor((Date.now() - new Date(lastDl)) / 86400000) : null
  const overdue = daysSince === null || daysSince >= BACKUP_REMIND_DAYS

  return (
    <div className="card" style={{ marginTop:16 }} id="datensicherung">
      <div className="card-header"><div className="card-title">💾 Datensicherung</div></div>
      <div className="card-body">
        <div style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:12 }}>
          Die App sichert <strong>jeden Sonntag automatisch</strong> alle Daten auf dem Server (die letzten 8 Wochen bleiben).
          Zusätzlich solltest du <strong>einmal im Monat</strong> eine Sicherung herunterladen und sicher aufbewahren –
          falls der Server selbst ausfällt.
        </div>

        {lastDl !== undefined && list && (
          <div className={`alert ${overdue ? 'alert-warn' : 'alert-success'}`} style={{ fontSize:13 }}>
            {daysSince === null
              ? '⚠️ Es wurde noch nie eine Sicherung heruntergeladen.'
              : overdue
                ? `⚠️ Deine neueste heruntergeladene Sicherung ist ${daysSince} Tage alt (Stand ${formatDateTime(lastDl)} Uhr) – bitte neu sichern.`
                : `✅ Neueste heruntergeladene Sicherung: Stand ${formatDateTime(lastDl)} Uhr`}
          </div>
        )}

        <label style={{ display:'flex', gap:10, alignItems:'center', fontSize:13.5, margin:'4px 0 12px', cursor:'pointer' }}>
          <input type="checkbox" checked={withDocs} onChange={e => setWithDocs(e.target.checked)} disabled={busy} />
          <span>Mit Dokumenten (Krankmeldungen, Lohnabrechnungen, Unterlagen, Profilbilder)</span>
        </label>
        <button className="btn btn-primary" onClick={backupNow} disabled={busy} style={{ width:'100%', justifyContent:'center' }}>
          {busy && progress ? `⏳ ${progress}` : '💾 Sicherung jetzt herunterladen'}
        </button>
        <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8, lineHeight:1.5 }}>
          🔒 Die Datei enthält sensible Personaldaten (IBAN, Steuer-ID, Krankmeldungen). Sicher aufbewahren, nicht per E-Mail verschicken.
        </div>

        {shareFile && (
          <div className="alert alert-success" style={{ fontSize:13, marginTop:12, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ flex:1 }}>Sicherung ist fertig.</span>
            <button className="btn btn-primary btn-sm" onClick={async () => {
              try { await navigator.share({ files: [shareFile], title: shareFile.name }); setShareFile(null) }
              catch (e) { if (e?.name !== 'AbortError') toast.error('Teilen fehlgeschlagen. Bitte am Computer herunterladen.') }
            }}>📤 Sichern („In Dateien sichern“)</button>
          </div>
        )}

        {loadErr && <div className="alert alert-danger" style={{ fontSize:13, marginTop:12 }}>{loadErr}</div>}

        {list && list.length > 0 && (
          <details style={{ marginTop:14 }}>
            <summary style={{ cursor:'pointer', fontSize:13, fontWeight:600 }}>Gespeicherte Sicherungen auf dem Server ({list.length})</summary>
            <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:10 }}>
              {list.map(b => (
                <div key={b.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, flexWrap:'wrap', fontSize:13 }}>
                  <div style={{ flex:1, minWidth:180 }}>
                    <div style={{ fontWeight:600 }}>{formatDateTime(b.created_at)} Uhr</div>
                    <div style={{ fontSize:12, color:'var(--text-muted)' }}>
                      {b.kind === 'auto' ? 'automatisch' : 'manuell'} · {sizeLabel(b.size_bytes)} · {b.counts?.employees ?? 0} Mitarbeiter · {b.counts?.time_entries ?? 0} Zeiteinträge
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => downloadOld(b.id)} disabled={busy}>⬇️ Daten</button>
                </div>
              ))}
            </div>
            <div style={{ fontSize:11.5, color:'var(--text-muted)', marginTop:6 }}>Ältere Stände enthalten nur die Daten; Dokumente gibt es immer im aktuellen Stand.</div>
          </details>
        )}
      </div>
    </div>
  )
}
