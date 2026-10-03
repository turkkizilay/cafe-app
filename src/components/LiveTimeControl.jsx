import { useMemo, useRef, useState } from 'react'
import { t as tr } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { ACTIONS_BY_STATE } from '../lib/liveTimeControl'

// Operative Live-Steuerung (Manager/Admin): für EINE Person nur die im aktuellen Zustand gültigen Aktionen,
// jede mit Bestätigung. Keine Uhrzeit-Eingabe – gebucht wird mit der Serverzeit.
const STATE_KEY = { OFF_CLOCK: 'live.stateOff', WORKING: 'live.stateWorking', ON_BREAK: 'live.stateOnBreak' }
const ACTION_KEY = { clock_in: 'live.clockIn', break_start: 'live.breakStart', break_end: 'live.breakEnd', clock_out: 'live.clockOut' }
const CONFIRM_KEY = { clock_in: 'live.confirmClockIn', break_start: 'live.confirmBreakStart', break_end: 'live.confirmBreakEnd', clock_out: 'live.confirmClockOut' }
const big = { minHeight: 48, width: '100%', fontSize: 15, justifyContent: 'center' }

export default function LiveTimeControl({ target, state, isSelf, onClose, onRun, staff = null }) {
  useLocale()
  const [picked, setPicked] = useState(null)          // Auswahl im „+ Einstempeln“-Modus
  const [action, setAction] = useState(null)          // gewählte Aktion → Bestätigung
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                       // Doppeltipp-Sperre (synchron, vor jedem Render)
  const person = target || picked
  const personState = target ? state : picked ? 'OFF_CLOCK' : null
  const candidates = useMemo(() => (staff || [])
    .filter(e => `${e.first_name} ${e.last_name}`.toLowerCase().includes(query.trim().toLowerCase())), [staff, query])

  async function confirm() {
    if (busyRef.current || !person || !action) return
    busyRef.current = true; setBusy(true)
    try { await onRun({ employeeId: person.employeeId, name: person.name, action, expected: personState }) }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }} data-testid="live-time-control">
        <div className="modal-header">
          <div className="modal-title">{person ? person.name : tr('live.pickTitle')}</div>
          <button className="btn btn-sm" onClick={onClose} disabled={busy} aria-label={tr('live.cancel')}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!person && (
            <>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('live.pickSearch')} aria-label={tr('live.pickSearch')} />
              {candidates.length === 0
                ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{tr('live.pickEmpty')}</div>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '50vh', overflowY: 'auto' }}>
                    {candidates.map(e => (
                      <button key={e.id} type="button" className="btn" style={{ ...big, justifyContent: 'flex-start' }} data-kind="pick"
                        onClick={() => { setPicked({ employeeId: e.id, name: `${e.first_name} ${e.last_name}` }); setAction('clock_in') }}>
                        {e.first_name} {e.last_name}
                      </button>
                    ))}
                  </div>}
            </>
          )}
          {person && !action && (
            <>
              <div data-testid="live-state" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{tr(STATE_KEY[personState])}</div>
              {isSelf ? (
                <div style={{ fontSize: 13 }}>{tr('live.self')}</div>
              ) : (
                ACTIONS_BY_STATE[personState].map(a => (
                  <button key={a} type="button" data-action={a} className={`btn${a === 'clock_out' ? '' : ' btn-primary'}`} style={big} onClick={() => setAction(a)}>
                    {tr(ACTION_KEY[a])}
                  </button>
                ))
              )}
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tr('live.serverTimeNote')} {tr('live.correctionHint')}</div>
            </>
          )}
          {person && action && (
            <>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{tr(CONFIRM_KEY[action], { name: person.name })}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }} data-testid="live-confirm-body">
                {tr('live.confirmBody')}{action === 'clock_out' && personState === 'ON_BREAK' ? ` ${tr('live.confirmBodyOnBreak')}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn" style={big} disabled={busy} onClick={() => (target ? setAction(null) : (setPicked(null), setAction(null)))}>{tr('live.cancel')}</button>
                <button type="button" className="btn btn-primary" style={big} disabled={busy} data-testid="live-confirm" onClick={confirm}>
                  {busy ? '…' : tr(ACTION_KEY[action])}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
