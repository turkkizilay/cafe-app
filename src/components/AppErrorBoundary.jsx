import { Component } from 'react'
import { t as tr } from '../i18n/runtime.js'
import { LocaleContext } from '../context/LocaleContext.jsx'
import { isChunkLoadError, reportChunkFailure } from '../lib/versionCheck'

// Äußere Fehlergrenze (Resilience F7-a): fängt Darstellungsfehler, die keine innere Grenze abfängt – Anmeldung,
// Onboarding, Einladung, Passwort-Reset, Datenschutz-Gate, Sperrbildschirme. Statt einer weißen Seite: verständlicher
// Text + „Neu laden“ / „Zur Startseite“. Bewusst:
//  • keine technischen Details (keine Fehlermeldung, kein Stacktrace) – React protokolliert den Fehler ohnehin in der Konsole
//  • nie automatisch neu laden (keine Schleifen); nur auf Klick
//  • Chunk-Ladefehler (neue Version ausgeliefert, alter Chunk fehlt) werden als „neue Version“ erklärt
export default class AppErrorBoundary extends Component {
  static contextType = LocaleContext   // Sprachwechsel rendert die Fehleranzeige neu
  state = { failed: false, chunk: false }

  static getDerivedStateFromError(error) {
    return { failed: true, chunk: isChunkLoadError(error) }
  }

  componentDidCatch(error) {
    if (isChunkLoadError(error)) reportChunkFailure()
  }

  render() {
    if (!this.state.failed) return this.props.children
    const chunk = this.state.chunk
    return (
      <div role="alert" data-testid="app-error-boundary"
        style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:16, background:'#1C1917', boxSizing:'border-box' }}>
        <div style={{ background:'#fff', color:'#1C1917', borderRadius:14, padding:'32px 24px', maxWidth:420, width:'100%', textAlign:'center', fontFamily:'system-ui, sans-serif' }}>
          <div style={{ fontSize:36, marginBottom:12 }} aria-hidden="true">{chunk ? '🔄' : '⚠️'}</div>
          <h2 style={{ fontSize:18, fontWeight:600, margin:'0 0 8px' }}>{tr(chunk ? 'errorBoundary.chunkTitle' : 'errorBoundary.title')}</h2>
          <p style={{ color:'#57534E', fontSize:14, lineHeight:1.6, margin:'0 0 20px' }}>{tr(chunk ? 'errorBoundary.chunkText' : 'errorBoundary.text')}</p>
          <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
            <button type="button" className="btn btn-primary" style={{ minHeight:44 }} onClick={() => window.location.reload()}>{tr('errorBoundary.reload')}</button>
            <button type="button" className="btn" style={{ minHeight:44 }} onClick={() => { window.location.href = '/' }}>{tr('errorBoundary.home')}</button>
          </div>
        </div>
      </div>
    )
  }
}
