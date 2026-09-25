import { t as tr, getIntlLocale, localizeMessage } from '../../i18n/runtime.js'
import { useLocale } from '../../context/LocaleContext.jsx'
import { useState, useEffect, useRef } from 'react'
import { subscribeOpenFallback, clearOpenFallback } from '../../lib/openFile'

// ── Singleton außerhalb React — vollständig immun gegen Concurrent Mode ──
let _id     = 0
const _map  = new Map()
const _subs = new Set()

function _notify() {
  const list = [..._map.values()]
  _subs.forEach(fn => fn(list))
}

export function showToast(message, type = 'info', duration = 4000) {
  for (const t of _map.values()) {
    if (localizeMessage(t.message) === localizeMessage(message) && t.type === type) return
  }
  const id = ++_id
  _map.set(id, { id, message, type })
  _notify()
  if (duration > 0) {
    setTimeout(() => { _map.delete(id); _notify() }, duration)
  }
}

export function dismissToast(id) {
  _map.delete(id)
  _notify()
}

export function useToast() {
  return {
    success: (m, d) => showToast(m, 'success', d ?? 4000),
    error:   (m, d) => showToast(m, 'error',   d ?? 7000),
    warn:    (m, d) => showToast(m, 'warn',    d ?? 4000),
    info:    (m, d) => showToast(m, 'info',    d ?? 4000),
  }
}

const COLORS = {
  success: { bg:'var(--success-bg)', border:'#A7F3D0', color:'var(--success)' },
  error:   { bg:'var(--danger-bg)',  border:'#FECACA', color:'var(--danger)'  },
  warn:    { bg:'var(--warn-bg)',    border:'#FDE68A', color:'var(--warn)'    },
  info:    { bg:'var(--info-bg)',    border:'#BFDBFE', color:'var(--info)'    },
}

export function ToastProvider({ children }) {
  useLocale()
  const [toasts, setToasts] = useState([])
  const listRef = useRef([])

  useEffect(() => {
    const fn = list => { listRef.current = list; setToasts([...list]) }
    _subs.add(fn)
    return () => _subs.delete(fn)
  }, [])

  return (
    <>
      {children}
      <div className="toast-container" style={{
        position:'fixed', bottom:24, right:24, zIndex:9999,
        display:'flex', flexDirection:'column-reverse', gap:8,
        maxWidth:400, width:'calc(100% - 32px)',
        pointerEvents:'none',
      }}>
        {toasts.map(t => {
          const c = COLORS[t.type] || COLORS.info
          return (
            <div key={t.id} role="alert" style={{
              background:c.bg, border:`1px solid ${c.border}`, borderRadius:10,
              padding:'12px 16px', display:'flex', alignItems:'flex-start', gap:10,
              boxShadow:'0 4px 16px rgba(0,0,0,0.12)', pointerEvents:'all',
              animation:'toast-in 0.2s ease',
            }}>
              <span style={{ fontSize:14, color:c.color, flex:1, lineHeight:1.55 }}>
                {localizeMessage(t.message)}
              </span>
              <button
                aria-label={tr("toast.close")}
                onClick={() => dismissToast(t.id)}
                style={{ background:'none', border:'none', cursor:'pointer',
                  color:c.color, fontSize:18, lineHeight:1, padding:0, opacity:0.5 }}
              >×</button>
            </div>
          )
        })}
      </div>
      <OpenFileFallback />
    </>
  )
}

// ── Fallback, falls der Browser den neuen Tab trotzdem blockiert ──
// Ein echter Tipp auf diesen Link ist eine Nutzeraktion und wird nie blockiert.
function OpenFileFallback() {
  useLocale()
  const [pending, setPending] = useState(null)
  useEffect(() => subscribeOpenFallback(setPending), [])
  if (!pending) return null
  return (
    <div className="modal-overlay" onClick={clearOpenFallback} style={{ zIndex:10000 }}>
      <div className="modal" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{tr("ui.d92b5a7dc109")}</div>
        </div>
        <div className="modal-body" style={{ fontSize:14, color:'var(--text-secondary)', lineHeight:1.6 }}>{tr("ui.ee05ff291ee8")}<div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>{tr("ui.447951124698")}</div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={clearOpenFallback}>{tr("ui.b808f6e97075")}</button>
          <a className="btn btn-primary" href={pending.url} target="_blank" rel="noopener noreferrer"
             onClick={() => setTimeout(clearOpenFallback, 0)}>
            📄 {localizeMessage(pending.label)}
          </a>
        </div>
      </div>
    </div>
  )
}
