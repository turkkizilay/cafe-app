// Barrierefreiheit für alle Dialoge (.modal-overlay > .modal) an EINER Stelle statt in jedem der ~30 Dialoge:
// • role="dialog", aria-modal, aria-labelledby (→ .modal-title)
// • Fokus beim Öffnen in den Dialog – auf den Container, nicht auf das erste Feld (sonst springt auf dem Handy
//   ungefragt die Tastatur auf); beim Schließen zurück zum auslösenden Element
// • Tab/Shift+Tab bleiben im obersten Dialog
// • Escape = Klick auf den Hintergrund des obersten Dialogs. Damit gelten dieselben Regeln wie bisher: Dialoge, die
//   sich bewusst nicht per Hintergrund schließen (z. B. „Temporärer Zugang erstellt“, laufendes Speichern), bleiben offen.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export const topDialog = (doc = document) => {
  const all = doc.querySelectorAll('.modal-overlay')
  return all.length ? all[all.length - 1] : null
}

let seq = 0
function prepare(overlay) {
  const dlg = overlay.querySelector('.modal') || overlay
  if (!dlg.getAttribute('role')) dlg.setAttribute('role', 'dialog')
  dlg.setAttribute('aria-modal', 'true')
  const title = dlg.querySelector('.modal-title')
  if (title && !dlg.getAttribute('aria-labelledby') && !dlg.getAttribute('aria-label')) {
    if (!title.id) title.id = `dialog-title-${++seq}`
    dlg.setAttribute('aria-labelledby', title.id)
  }
  if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1')
  return dlg
}

export function installModalA11y(doc = document) {
  const open = new Map()   // Overlay → Element, das vorher den Fokus hatte
  const sync = () => {
    for (const o of doc.querySelectorAll('.modal-overlay')) {
      if (open.has(o)) continue
      open.set(o, doc.activeElement)
      const dlg = prepare(o)
      if (!o.contains(doc.activeElement)) dlg.focus({ preventScroll: true })   // autoFocus im Dialog bleibt unberührt
    }
    for (const [o, prev] of open) {
      if (o.isConnected) continue
      open.delete(o)
      const top = topDialog(doc)
      const target = prev && prev.isConnected ? prev : top ? top.querySelector('.modal') : null
      if (target && (!top || top.contains(target)) && !(top && top.contains(doc.activeElement))) target.focus?.({ preventScroll: true })
    }
  }
  const onKey = e => {
    const o = topDialog(doc)
    if (!o || e.defaultPrevented) return
    if (e.key === 'Escape') {
      e.preventDefault()
      o.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }))
    } else if (e.key === 'Tab') {
      const items = [...o.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length)
      if (!items.length) { e.preventDefault(); return }
      const first = items[0], last = items[items.length - 1], i = items.indexOf(doc.activeElement)
      if (i < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus() }            // Fokus auf Container/außerhalb
      else if (e.shiftKey && i === 0) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); first.focus() }
    }
  }
  const mo = new MutationObserver(sync)
  mo.observe(doc.body, { childList: true, subtree: true })
  doc.addEventListener('keydown', onKey)
  sync()
  return () => { mo.disconnect(); doc.removeEventListener('keydown', onKey) }
}
