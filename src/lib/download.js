// Zentraler Datei-Download für im Browser erzeugte Dateien (PDF, CSV).
// • Desktop/Android: <a download> im Dokument, klicken, entfernen; URL erst später freigeben
//   (sofortiges revokeObjectURL bricht Downloads in Safari/Firefox ab).
// • iPhone/iPad: Teilen-Menü („In Dateien sichern“) – Blob-Downloads sind in installierten
//   iOS-Web-Apps unzuverlässig. Muss direkt im Klick-Handler (Nutzeraktion) aufgerufen werden.
export const isIOSDevice = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// Liefert 'shared' | 'downloaded' | 'cancelled'
export async function saveFile(bytes, filename, mimeType) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mimeType })
  if (isIOSDevice() && typeof File !== 'undefined' && navigator.canShare) {
    const file = new File([blob], filename, { type: mimeType })
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return 'shared' }
      catch (e) { if (e?.name === 'AbortError') return 'cancelled' }   // sonst: normaler Download als Rückfall
    }
  }
  downloadBlob(blob, filename)
  return 'downloaded'
}
