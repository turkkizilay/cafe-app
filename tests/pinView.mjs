// Byte-Pins mit genau einer, ausdrücklich freigegebenen Ausnahme (Production-Polish Option B, 04.10.2026):
// • Vacation/TimeManagement/PayrollDocuments/UserManagement/Account: ggü. dem Pin darf sich NUR Barrierefreiheit
//   ändern (aria-label, autoComplete="off" – nur Attribute, keine Logik).
// • Shifts.jsx: zusätzlich exakt der Schichttausch-Fix (respondSwap/cancelSwap mit Sperre, „nur offen“, 0 Zeilen ≠ Erfolg)
//   – der neue Block wird hier wörtlich auf den alten zurückgeführt; jede andere Änderung bricht den Pin weiterhin.
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

export function pinView(file, src) {
  if (file === 'src/components/UI/TimeInput24.jsx') return src.replace(TIME_FOCUS, '')
  if (file === 'src/lib/time24.js') return src.replace(TIME_PARSE_NEW, TIME_PARSE_OLD)
  if (!A11Y_ONLY.has(file)) return src
  let s = src.replace(/ aria-label=\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/ aria-label="[^"]*"/g, '').replace(/ autoComplete="off"/g, '')
  if (file === 'src/pages/Shifts.jsx') s = s.replace(SWAP_NEW, SWAP_OLD).replace(SWAP_STATE, '').replace(/ disabled=\{swapBusyId === sw\.id\}/g, '')
  return s
}
