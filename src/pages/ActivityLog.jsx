/**
 * ActivityLog — Aktivitätsprotokoll (Admin-only)
 *
 * Route: /protokoll
 * Zeigt alle protokollierten Aktionen in lesbaren deutschen Sätzen.
 * Filter nach Kategorie, Zeitraum und Freitext. "Mehr laden" für Performance.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { LOG_CATEGORIES, triggerLogCleanup } from '../lib/activityLog'

const PAGE_SIZE = 50

function fmtDateTime(isoStr) {
  if (!isoStr) return '–'
  const d = new Date(isoStr)
  const date = d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' })
  const time = d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })
  return `${date}, ${time} Uhr`
}

// Sicherheitsrelevante Aktionen bekommen eine dezente Markierung
const SECURITY_ACTIONS = new Set([
  'auth.login', 'auth.logout', 'auth.auto_logout', 'auth.password_changed',
  'employee.role_changed', 'employee.deleted', 'employee.approved',
  'integration.connected', 'integration.disconnected',
  'settings.changed',
])
function severityOf(action) {
  return SECURITY_ACTIONS.has(action) ? 'security' : 'info'
}

export default function ActivityLog() {
  const [entries,   setEntries]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore,   setHasMore]   = useState(false)
  const [error,     setError]     = useState(null)

  // Filter
  const [category, setCategory] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate,   setToDate]   = useState('')
  const [search,   setSearch]   = useState('')

  const cleanupDone = useRef(false)

  // Ungültiger Zeitraum: Von nach Bis
  const invalidRange = fromDate && toDate && fromDate > toDate

  const loadEntries = useCallback(async (reset = true) => {
    if (fromDate && toDate && fromDate > toDate) {
      setError('Das „Von"-Datum darf nicht nach dem „Bis"-Datum liegen.')
      setLoading(false)
      return
    }
    reset ? setLoading(true) : setLoadingMore(true)
    setError(null)
    try {
      const offset = reset ? 0 : entries.length
      let query = supabase
        .from('activity_log')
        .select('id, created_at, actor_name, actor_role, action, category, summary, target_name')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)

      if (category !== 'all') query = query.eq('category', category)
      if (fromDate) query = query.gte('created_at', `${fromDate}T00:00:00`)
      if (toDate)   query = query.lte('created_at', `${toDate}T23:59:59`)
      if (search.trim()) {
        const s = search.trim().replace(/[%,]/g, '')
        query = query.or(`summary.ilike.%${s}%,actor_name.ilike.%${s}%`)
      }

      const { data, error } = await query
      if (error) throw error

      const rows = data || []
      setHasMore(rows.length === PAGE_SIZE)
      setEntries(reset ? rows : prev => [...prev, ...rows])
    } catch (err) {
      setError(err.message || 'Protokoll konnte nicht geladen werden.')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [category, fromDate, toDate, search, entries.length])

  // Erstes Laden + Cleanup-Trigger (12-Monats-Frist, nicht-blockierend)
  useEffect(() => {
    if (!cleanupDone.current) {
      cleanupDone.current = true
      triggerLogCleanup()  // läuft im Hintergrund, blockiert nicht
    }
    loadEntries(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, fromDate, toDate])

  // Freitext mit kleiner Verzögerung
  useEffect(() => {
    const t = setTimeout(() => loadEntries(true), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  function resetFilters() {
    setCategory('all'); setFromDate(''); setToDate(''); setSearch('')
  }

  const hasActiveFilter = category !== 'all' || fromDate || toDate || search.trim()

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Aktivitätsprotokoll</div>
        <div style={{ padding:'0 24px', fontSize:12, color:'var(--text-muted)' }}>
          Aktivitätsprotokoll · Nur Admin
        </div>
      </div>

      <div className="content">
        {/* Filter */}
        <div className="card" style={{ marginBottom:16 }}>
          <div style={{ padding:16, display:'flex', flexWrap:'wrap', gap:12, alignItems:'flex-end' }}>
            <div style={{ flex:'1 1 160px' }}>
              <label style={{ fontSize:12, fontWeight:600, color:'var(--text-muted)', display:'block', marginBottom:4 }}>Kategorie</label>
              <select className="input select-styled" value={category} onChange={e => setCategory(e.target.value)} style={{ width:'100%' }}>
                <option value="all">Alle Kategorien</option>
                {Object.entries(LOG_CATEGORIES).map(([key, c]) => (
                  <option key={key} value={key}>{c.icon} {c.label}</option>
                ))}
              </select>
            </div>
            <div style={{ flex:'1 1 130px' }}>
              <label style={{ fontSize:12, fontWeight:600, color:'var(--text-muted)', display:'block', marginBottom:4 }}>Von</label>
              <input type="date" lang="de-DE" className="input" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)} style={{ width:'100%' }} />
            </div>
            <div style={{ flex:'1 1 130px' }}>
              <label style={{ fontSize:12, fontWeight:600, color:'var(--text-muted)', display:'block', marginBottom:4 }}>Bis</label>
              <input type="date" lang="de-DE" className="input" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)} style={{ width:'100%' }} />
            </div>
            <div style={{ flex:'2 1 200px' }}>
              <label style={{ fontSize:12, fontWeight:600, color:'var(--text-muted)', display:'block', marginBottom:4 }}>Suche</label>
              <input type="text" className="input" placeholder="Name oder Aktion…" value={search} onChange={e => setSearch(e.target.value)} style={{ width:'100%' }} />
            </div>
            {hasActiveFilter && (
              <button className="btn btn-sm" onClick={resetFilters}>Filter zurücksetzen</button>
            )}
          </div>
        </div>

        {/* Fehler */}
        {error && (
          <div className="alert alert-danger" style={{ marginBottom:16, fontSize:13 }}>
            ⚠️ {error}
          </div>
        )}

        {/* Liste */}
        <div className="card">
          {loading ? (
            <div style={{ padding:'40px 0', textAlign:'center', color:'var(--text-muted)', fontSize:14 }}>
              ⏳ Protokoll wird geladen…
            </div>
          ) : entries.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📋</div>
              <div className="empty-state-text">
                {hasActiveFilter ? 'Keine Protokolleinträge für diesen Filter.' : 'Noch keine Protokolleinträge.'}
              </div>
            </div>
          ) : (
            <div>
              {entries.map(entry => {
                const cat = LOG_CATEGORIES[entry.category] || { icon:'•', color:'var(--text-muted)', bg:'var(--bg-secondary)', label:entry.category }
                const isSecurity = severityOf(entry.action) === 'security'
                return (
                  <div key={entry.id} style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--border)', borderLeft: isSecurity ? '3px solid #D97706' : '3px solid transparent' }}>
                    <div style={{ width:32, height:32, borderRadius:8, background:cat.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>
                      {cat.icon}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, lineHeight:1.4 }}>{entry.summary}</div>
                      <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2, display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                        <span style={{ color:cat.color, fontWeight:600 }}>{cat.label}</span>
                        <span>·</span>
                        <span>{fmtDateTime(entry.created_at)}</span>
                        {isSecurity && (
                          <>
                            <span>·</span>
                            <span style={{ color:'#D97706', fontWeight:600 }}>Sicherheit</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}

              {hasMore && (
                <div style={{ padding:16, textAlign:'center' }}>
                  <button className="btn" onClick={() => loadEntries(false)} disabled={loadingMore}>
                    {loadingMore ? '⏳ Lädt…' : 'Mehr laden'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hinweis Aufbewahrungsfrist */}
        <div style={{ textAlign:'center', fontSize:12, color:'var(--text-muted)', marginTop:16 }}>
          Aus Datenschutzgründen werden Protokolleinträge nur 12 Monate aufbewahrt. Ältere Einträge werden automatisch entfernt.
        </div>
      </div>
    </>
  )
}
