// Byte-Pins mit genau einer, ausdrücklich freigegebenen Ausnahme (Production-Polish Option B, 04.10.2026):
// • Vacation/TimeManagement/PayrollDocuments/UserManagement/Account: ggü. dem Pin darf sich NUR Barrierefreiheit
//   ändern (aria-label, autoComplete="off" – nur Attribute, keine Logik).
// • Shifts.jsx: zusätzlich exakt der Schichttausch-Fix (respondSwap/cancelSwap mit Sperre, „nur offen“, 0 Zeilen ≠ Erfolg)
//   – der neue Block wird hier wörtlich auf den alten zurückgeführt; jede andere Änderung bricht den Pin weiterhin.
// • PayrollDocuments.jsx: zusätzlich der Pagination-Umbau (05.10.2026), siehe PAYROLL_DOCS_FROZEN unten.
// • Payroll.jsx, Timesheet.jsx und alle übrigen Dateien: KEINE Ausnahme, weiter byte-gleich.
const A11Y_ONLY = new Set(['src/pages/Vacation.jsx', 'src/pages/TimeManagement.jsx', 'src/pages/PayrollDocuments.jsx',
  'src/pages/UserManagement.jsx', 'src/pages/Account.jsx', 'src/pages/Shifts.jsx'])

const SWAP_NEW = `  // Nur offene Anfragen; 0 getroffene Zeilen (inzwischen erledigt/entfernt) ist kein Erfolg. Der Server (swap_guard)
  // prüft die Übergänge ohnehin – hier geht es um Doppeltipp und veraltete Ansicht ohne widersprüchliche Meldungen.
  async function updateOwnSwap(id, status, failKey, okKey) {
    if (!respondGuard.begin()) return
    setSwapBusyId(id)
    try {
      const { data, error } = await supabase.from('shift_swap_requests')
        .update({ status }).eq('id', id).eq('status', 'open').select('id')
      if (error) { toast.error(translateSupabaseError(error, appMessage(failKey))); return }
      if (!data?.length) { toast.error(appMessage("error.bd03e1e5cae8")); return }
      toast.success(appMessage(okKey))
    } finally {
      respondGuard.end(); setSwapBusyId(null)
      fetchSwaps()
    }
  }
  const respondSwap = (id, accept) => updateOwnSwap(id, accept ? 'accepted' : 'declined', "ui.14f8a52d95b2", accept ? "ui.996526422813" : "ui.a9148e8654e8")
  const cancelSwap = id => updateOwnSwap(id, 'cancelled', "ui.53b0832683e3", "ui.397fbdd910af")`
const SWAP_OLD = `  async function respondSwap(id, accept) {
    const { error } = await supabase.from('shift_swap_requests')
      .update({ status: accept ? 'accepted' : 'declined' }).eq('id', id)
    if (error) { toast.error(translateSupabaseError(error, appMessage("ui.14f8a52d95b2"))); return }
    toast.success(accept ? (appMessage("ui.996526422813")) : (appMessage("ui.a9148e8654e8")))
    fetchSwaps()
  }

  async function cancelSwap(id) {
    const { error } = await supabase.from('shift_swap_requests')
      .update({ status:'cancelled' }).eq('id', id)
    if (error) { toast.error(translateSupabaseError(error, appMessage("ui.53b0832683e3"))); return }
    toast.success(appMessage("ui.397fbdd910af"))
    fetchSwaps()
  }`
const SWAP_STATE = `  const respondGuard = useSavingGuard()   // Tausch annehmen/ablehnen/zurückziehen: Doppeltipp → nur eine Anfrage
  const [swapBusyId, setSwapBusyId] = useState(null)
`


// Mobile-Uhrzeit-Fix (05.10.2026): exakt der neue onFocus-Block in TimeInput24.jsx (Touch: Wert markieren) und der
// erweiterte Parser in time24.js („915“ → 09:15). Wörtlich zurückgeführt – jede andere Änderung bricht den Pin.
const TIME_FOCUS = "        onFocus={e => {\n          rest.onFocus?.(e)\n          // Touch (Handy/PWA): beim Antippen den ganzen Wert markieren – neue Ziffern ersetzen ihn. Sonst landen Ziffern\n          // in einem vollen „15:15“ (maxLength) im Nichts, und nach Löschen des „:“ entsteht „15315“, das die\n          // Ziffern-Tastatur (ohne „:“) nicht mehr reparieren kann. Erneutes Antippen setzt den Cursor wie gewohnt.\n          const el = e.currentTarget\n          if (el.value && window.matchMedia?.('(pointer: coarse)').matches) setTimeout(() => { if (document.activeElement === el) el.select() }, 0)\n        }}\n"
const TIME_PARSE_NEW = "// Während des Tippens: nur eine VOLLSTÄNDIGE Uhrzeit gilt (Minuten zweistellig angegeben): „18:00“, „8:30“, „8.30“,\n// „0830“ – auch ganz ohne Trenner, weil die Ziffern-Tastatur auf dem Handy (inputMode numeric, iPhone) keinen „:“ hat.\n// Dreistellig nur, wenn die erste Ziffer 3–9 ist („915“ → 09:15, „830“ → 08:30): Daraus kann durch Weitertippen keine\n// andere gültige Uhrzeit mehr werden (Stunde 91/83 gibt es nicht). „123“, „183“, „18“, „8“ bleiben unvollständig –\n// der Nutzer tippt evtl. weiter („18“ → „1830“) –, so erreicht nie ein Zwischenstand wie „01:00“ die Formular-/\n// Validierungs-/ArbZG-Logik. Ungültiges (25:00, 12:60, 9:99) wird nie „korrigiert“.\nexport function parseCompleteTime24(text) {\n  const t = String(text ?? '').trim()\n  return /^\\d{1,2}[:.,hH]\\d{2}$/.test(t) || /^\\d{4}$/.test(t) || /^[3-9]\\d{2}$/.test(t) ? parseTime24(t) : null\n}"
const TIME_PARSE_OLD = "// Während des Tippens: nur eine VOLLSTÄNDIGE Uhrzeit gilt (Minuten zweistellig angegeben): „18:00“, „8:30“, „8.30“,\n// „0830“. Kurzformen („18“, „8“, „830“) sind hier noch unvollständig – der Nutzer tippt evtl. weiter („18“ → „1830“) –\n// und werden erst beim Verlassen des Feldes über parseTime24 normalisiert. So erreicht nie ein Zwischenstand wie\n// „01:00“ (beim Tippen von „18“) die Formular-/Validierungs-/ArbZG-Logik.\nexport function parseCompleteTime24(text) {\n  const t = String(text ?? '').trim()\n  return /^\\d{1,2}[:.,hH]\\d{2}$/.test(t) || /^\\d{4}$/.test(t) ? parseTime24(t) : null\n}"

// Lohndokumente-Pagination (05.10.2026, Pin für genau diesen Umbau freigegeben): Liste, Abfrage, Filter und das Neuladen
// nach dem Löschen dürfen sich ändern (eigene Verhaltenstests: payrollDocumentsPaging). Byte-gleich zum Pin bleiben
// weiterhin Kopfzeile, Upload (Funktion + Formular inkl. Upload-Jahre), Öffnen/Download (Signed URLs), Byte-Format und
// der Lösch-Anfang (Bestätigung + Sperre) – jede Änderung dort bricht den Pin wie bisher.
const PAYROLL_DOCS_FROZEN = [
  ['  async function handleUpload() {', '\n  }\n'], ['  async function handleOpen(doc) {', '\n  }\n'],
  ['  async function handleDownload(doc) {', '\n  }\n'], ['  async function handleDelete(doc) {', 'if (!deleteGuard.begin()) return\n'],
  ['  function formatBytes(b) {', '\n  }\n'], ['      <div className="topbar">', '      <div className="content">'],
  ['        {/* ── Admin: Upload ── */}', '        {/* ── Dokumente Liste'],
]
function payrollDocsFrozen(src) {
  return PAYROLL_DOCS_FROZEN.map(([start, end]) => {
    const i = src.indexOf(start), j = i < 0 ? -1 : src.indexOf(end, i)
    if (i < 0 || j < 0 || src.indexOf(start, i + 1) >= 0) return `FEHLT/MEHRDEUTIG: ${start}`
    return src.slice(i, j + end.length)
  }).join('\n---\n')
}

// Sichtbare HH:MM-Normalisierung (05.10.2026): exakt appendedAtEnd, der neue onChange-Block und maxLength 6 in
// TimeInput24.jsx – wörtlich auf den vorherigen Stand zurückgeführt; jede andere Änderung bricht den Pin weiterhin.
const TIME_VISUAL_FN = "// Eingabe am Ende (Tippen/Einfügen, Cursor danach am Schluss)? Ohne inputType (ältere Browser): Text wurde länger.\nfunction appendedAtEnd(e, prev) {\n  const el = e.target, type = e.nativeEvent?.inputType\n  return (type ? type.startsWith('insert') : el.value.length > prev.length) && el.selectionStart === el.value.length\n}\n\n"
const TIME_VISUAL_NEW = "        onChange={e => {\n          // Eine getippte Ziffer über ein volles Feld hinaus („17:00“ + „5“) bleibt sichtbar und macht die Eingabe\n          // ungültig, statt still verschluckt zu werden (sonst hieße „15315“ plötzlich 15:31). Eingefügtes wie bisher ≤ 5.\n          const chars = e.target.value.replace(/[^0-9:.,]/g, '')\n          const next = e.nativeEvent?.inputType === 'insertText' && e.nativeEvent.data?.length === 1 && chars.length > 5 ? chars.slice(0, 6) : sanitizeTimeDraft(chars)\n          const p = parseCompleteTime24(next)\n          emit(p || '', next !== '' && !p)\n          // Sichtbar sofort HH:MM („1700“ → „17:00“, „815“ → „08:15“) – aber nur, wenn gerade am Ende getippt/eingefügt\n          // wurde und die Uhrzeit vollständig + eindeutig ist. Löschen (auch des „:“) und Bearbeiten in der Mitte bleiben\n          // unangetastet, sonst ließe sich der Doppelpunkt nie entfernen und der Cursor spränge.\n          setDraft(p && appendedAtEnd(e, draft) ? p : next)\n        }}\n"
const TIME_VISUAL_OLD = "        onChange={e => {\n          const next = sanitizeTimeDraft(e.target.value)\n          setDraft(next)\n          const p = parseCompleteTime24(next)\n          emit(p || '', next !== '' && !p)\n        }}\n"

export function pinView(file, src) {
  if (file === 'src/components/UI/TimeInput24.jsx') return src.replace(TIME_FOCUS, '').replace(TIME_VISUAL_FN, '').replace(TIME_VISUAL_NEW, TIME_VISUAL_OLD)
    .replace('maxLength={6} placeholder="HH:MM"', 'maxLength={5} placeholder="HH:MM"')
  if (file === 'src/lib/time24.js') return src.replace(TIME_PARSE_NEW, TIME_PARSE_OLD)
  if (!A11Y_ONLY.has(file)) return src
  if (file === 'src/pages/PayrollDocuments.jsx') src = payrollDocsFrozen(src)
  let s = src.replace(/ aria-label=\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/ aria-label="[^"]*"/g, '').replace(/ autoComplete="off"/g, '')
  if (file === 'src/pages/Shifts.jsx') s = s.replace(SWAP_NEW, SWAP_OLD).replace(SWAP_STATE, '').replace(/ disabled=\{swapBusyId === sw\.id\}/g, '')
  return s
}
