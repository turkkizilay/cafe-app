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

export function pinView(file, src) {
  if (!A11Y_ONLY.has(file)) return src
  let s = src.replace(/ aria-label=\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/ aria-label="[^"]*"/g, '').replace(/ autoComplete="off"/g, '')
  if (file === 'src/pages/Shifts.jsx') s = s.replace(SWAP_NEW, SWAP_OLD).replace(SWAP_STATE, '').replace(/ disabled=\{swapBusyId === sw\.id\}/g, '')
  return s
}
