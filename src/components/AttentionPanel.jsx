import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { t as tr, sourceLabel } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { formatDate, formatDateTime } from '../i18n/format.js'
import { deriveAttentionItems } from '../lib/attention'

// „Handlungsbedarf“ – kompakte operative Inbox oben im Dashboard (nur Admin/Manager; Mitarbeiter sehen sie nie).
// Reine Darstellung: Regeln in src/lib/attention.js; Daten kommen vom Dashboard (keine eigenen Anfragen).
// Ganze Zeile ist Link (Route) bzw. Knopf (Live-Steuerung) – eine Navigation je Zeile, ≥ 44 px, sichtbarer Fokus.
const MAX_VISIBLE = 5
const ICON = { critical: '⛔', action: '▲', info: 'ⓘ' }

function texts(item, role) {
  const p = item.params
  switch (item.kind) {
    case 'longOpen':  return [tr('attention.longOpen', { name: p.name }), tr('attention.since', { when: formatDateTime(p.since) }) + ' · ' + tr(role === 'admin' ? 'attention.longOpenAdmin' : 'attention.longOpenManager')]
    case 'forgotten': return [tr('attention.forgotten', { count: p.count }), tr('attention.forgottenHint')]
    case 'vacation':  return [tr('attention.vacation', { count: p.count }), p.soon ? tr('attention.vacationSoon', { date: formatDate(p.soon) }) : null]
    case 'swaps':     return [tr('attention.swaps', { count: p.count }), null]
    case 'onboarding':return [tr('attention.onboarding', { count: p.count }), null]
    case 'backup':    return [p.days === -1 ? tr('ui.48fd6a9638f4') : tr('ui.15e9ef667d1b', { p1: p.days }), tr('ui.add2b4917aba').trim()]
    case 'longBreak': return [tr('attention.longBreak', { name: p.name, minutes: p.minutes }), tr('attention.since', { when: formatDateTime(p.since) })]
    case 'retention': return [tr('attention.retention'), p.categories.map(c => `${c.due} ${c.key === 'verwaist' ? tr('ui.c664e3a24d8b') : sourceLabel(c.title)}`).join(', ') + tr('ui.6043f353c565')]   // wie bisheriger Banner
    default: return ['', null]
  }
}

// incomplete (Resilience Batch 2d): mindestens eine Datenquelle konnte nicht geladen werden → nie „nichts zu tun“ melden,
// sondern „nicht vollständig prüfbar“; vorhandene Punkte bleiben sichtbar. Ohne incomplete: Anzeige unverändert.
export default function AttentionPanel({ role, loading, data, onOpenLive, incomplete = false }) {
  useLocale()
  const [now, setNow] = useState(() => new Date())
  const [expanded, setExpanded] = useState(false)
  // „Wird geprüft …“ nur beim ersten Laden; beim Aktualisieren bleibt die bisherige Liste stehen (kein Springen)
  const [loadedOnce, setLoadedOnce] = useState(false)
  useEffect(() => { if (!loading) setLoadedOnce(true) }, [loading])
  const initial = loading && !loadedOnce
  // Schwellen (12 h / 90 min) sollen auch bei offen gelassener Seite greifen – nur Neuberechnung, keine Anfragen
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t) }, [])
  if (role !== 'admin' && role !== 'manager') return null

  const items = initial ? [] : deriveAttentionItems({ ...data, role, now })
  const visible = expanded ? items : items.slice(0, MAX_VISIBLE)
  const hidden = items.length - visible.length

  return (
    <section className="card attention-panel" aria-labelledby="attention-title" data-testid="attention-panel">
      <div className="attention-head">
        <h2 id="attention-title" className="attention-title">{tr('attention.title')}</h2>
        {!initial && items.length > 0 && <span className="attention-count" aria-label={tr('attention.countLabel', { count: items.length })}>{items.length}</span>}
      </div>
      {initial ? (
        <p className="attention-empty attention-muted" aria-live="polite">{tr('attention.checking')}</p>
      ) : items.length === 0 && incomplete ? (
        <p className="attention-empty attention-muted" aria-live="polite" data-testid="attention-incomplete"><span aria-hidden="true">⚠️ </span>{tr('attention.incomplete')}</p>
      ) : items.length === 0 ? (
        <p className="attention-empty" aria-live="polite"><span aria-hidden="true">✓ </span>{tr('attention.none')}</p>
      ) : (
        <ul className="attention-list">
          {visible.map(item => {
            const [title, detail] = texts(item, role)
            const inner = (
              <>
                <span className={`attention-icon attention-${item.level}`} aria-hidden="true">{ICON[item.level]}</span>
                <span className="attention-text">
                  <span className="sr-only">{tr(`attention.level.${item.level}`)}: </span>
                  <span className="attention-line">{title}</span>
                  {detail && <span className="attention-detail">{detail}</span>}
                </span>
                <span className="attention-go" aria-hidden="true">→</span>
              </>
            )
            return (
              <li key={item.id} className={`attention-item attention-item-${item.level}`} data-kind={item.kind}>
                {item.to
                  ? <Link to={item.to} className="attention-row">{inner}</Link>
                  : <button type="button" className="attention-row" onClick={() => onOpenLive?.(item.live)}>{inner}</button>}
              </li>
            )
          })}
        </ul>
      )}
      {!initial && incomplete && items.length > 0 && (
        <p className="attention-empty attention-muted" data-testid="attention-incomplete-hint">{tr('attention.incompleteHint')}</p>
      )}
      {hidden > 0 && (
        <button type="button" className="attention-more" onClick={() => setExpanded(true)}>{tr('attention.more', { count: hidden })}</button>
      )}
    </section>
  )
}
