import { Component } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { t as tr } from '../i18n/runtime.js'
import { LocaleContext } from '../context/LocaleContext.jsx'
import { isChunkLoadError, reportChunkFailure } from '../lib/versionCheck'

// Fehlergrenze je Seite (Resilience Batch 2c-2): Ein Darstellungsfehler einer Seite ersetzt nur den Inhaltsbereich –
// Navigation, Sitzung und andere Seiten bleiben nutzbar. Schlüssel = Pfad: Seitenwechsel setzt die Grenze zurück.
// Bewusst: keine Fehlermeldung/kein Stacktrace (React protokolliert in der Konsole), nie automatisch neu laden (keine
// Schleifen), Chunk-Ladefehler → Hinweis „neue Version“ (Batch 1). Fehler außerhalb der Seiten fängt die äußere Grenze.
class PageBoundary extends Component {
  static contextType = LocaleContext   // Sprachwechsel rendert die Anzeige neu
  state = { failed: false, chunk: false }
  static getDerivedStateFromError(error) { return { failed: true, chunk: isChunkLoadError(error) } }
  componentDidCatch(error) { if (isChunkLoadError(error)) reportChunkFailure() }
  render() {
    if (!this.state.failed) return this.props.children
    const { chunk } = this.state
    // Schon auf der Startseite: „Zur Startseite“ versucht die Seite einmal neu darzustellen (nur auf Klick)
    const home = () => (this.props.atHome ? this.setState({ failed: false, chunk: false }) : this.props.onHome())
    return (
      <div className="content">
        <div className="card" role="alert" data-testid="route-error-boundary" style={{ maxWidth:520, margin:'24px auto', padding:'24px 20px', textAlign:'center' }}>
          <div style={{ fontSize:32, marginBottom:8 }} aria-hidden="true">{chunk ? '🔄' : '⚠️'}</div>
          <h2 style={{ fontSize:17, fontWeight:600, margin:'0 0 8px' }}>{tr(chunk ? 'errorBoundary.chunkTitle' : 'routeError.title')}</h2>
          <p style={{ color:'var(--text-secondary)', fontSize:14, lineHeight:1.6, margin:'0 0 16px' }}>{tr(chunk ? 'errorBoundary.chunkText' : 'routeError.text')}</p>
          <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
            <button type="button" className="btn btn-primary" style={{ minHeight:44 }} onClick={() => window.location.reload()}>{tr('routeError.reload')}</button>
            <button type="button" className="btn" style={{ minHeight:44 }} onClick={home}>{tr('routeError.home')}</button>
          </div>
        </div>
      </div>
    )
  }
}

export default function RouteErrorBoundary({ children }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return <PageBoundary key={pathname} atHome={pathname === '/'} onHome={() => navigate('/')}>{children}</PageBoundary>
}
