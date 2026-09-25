import { t as tr, getIntlLocale, message as appMessage, errorMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from './UI/Toast'
import { pushState, enablePush, disablePush, isIOS, isStandalone } from '../lib/push'
import { useProfile } from '../context/ProfileContext'

/**
 * „App & Mitteilungen“: App auf den Home-Bildschirm holen + Push-Benachrichtigungen.
 * compact = kleine Variante fürs Dashboard (ausblendbar).
 */
const isAndroid = () => /Android/i.test(navigator.userAgent || '')
const isMobile = () => isIOS() || isAndroid()

export function InstallSteps() {
  useLocale()
  const [bip, setBip] = useState(() => window.__cafeInstallPrompt || null)
  useEffect(() => {
    const h = () => setBip(window.__cafeInstallPrompt || null)
    window.addEventListener('cafe-install-available', h)
    return () => window.removeEventListener('cafe-install-available', h)
  }, [])

  if (isStandalone()) return <div style={{ fontSize:13.5 }}>{tr("ui.1e8d79f4b404")}</div>

  if (isIOS()) return (
    <ol style={{ margin:'0 0 0 18px', padding:0, fontSize:13.5, lineHeight:1.8 }}>
      <li>{tr("ui.38869d8d6a3e")}<strong>Safari</strong>{tr("ui.64ca88281d56")}</li>
      <li>{tr("ui.a8956e03af60")}<strong>{tr("ui.3050e581f294")}</strong>{tr("ui.7676096fba41")}<span aria-hidden="true">⬆︎</span>).</li>
      <li><strong>{tr("ui.ffa543c28fe3")}</strong>{tr("ui.444142b48199")}<strong>{tr("ui.bff96c5bb84d")}</strong>.</li>
      <li>{tr("ui.3939e3fd1cc6")}</li>
    </ol>
  )

  return (
    <div style={{ fontSize:13.5, lineHeight:1.7 }}>
      {bip ? (
        <button className="btn btn-primary" onClick={async () => {
          try { bip.prompt(); await bip.userChoice } catch { /* abgebrochen */ }
          window.__cafeInstallPrompt = null; setBip(null)
        }}>{tr("ui.3ea5665d5d30")}</button>
      ) : isAndroid() ? (
        <ol style={{ margin:'0 0 0 18px', padding:0 }}>
          <li>{tr("ui.592b238e52a5")}<strong>Chrome</strong>{tr("ui.7a185d6be062")}<strong>⋮</strong>{tr("ui.1888e54ed2af")}</li>
          <li><strong>{tr("ui.a2d5731477f0")}</strong>{tr("ui.74566b339f69")}<strong>{tr("ui.065b95578e10")}</strong>{tr("ui.2abdaf5ea0be")}</li>
        </ol>
      ) : (
        <div>{tr("ui.d7163b73a4c5")}</div>
      )}
    </div>
  )
}

export default function AppSetupCard({ compact = false, onDismiss }) {
  useLocale()
  const toast = useToast()
  const { isAdmin, isManager } = useProfile() || {}
  const [state, setState] = useState('loading')
  const [busy, setBusy] = useState(false)

  async function refresh() { setState(await pushState()) }
  useEffect(() => { refresh() }, [])

  async function turnOn() {
    if (busy) return
    setBusy(true)
    try { await enablePush(); toast.success(appMessage("ui.c84b240661d7")) }
    catch (e) { toast.error((errorMessage(e) || appMessage("ui.d76e42d66303"))) }
    finally { setBusy(false); refresh() }
  }
  async function turnOff() {
    if (busy) return
    setBusy(true)
    try { await disablePush(); toast.success(appMessage("ui.ce9cd47b2838")) }
    finally { setBusy(false); refresh() }
  }
  async function test() {
    if (busy) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('push_test')
      if (error || !data?.success) toast.error((data?.error || appMessage("ui.e25540b38c7d")))
      else toast.success(appMessage("ui.fec341f62b54"))
    } finally { setBusy(false) }
  }

  const pushBlock = (
    <div style={{ fontSize:13.5, lineHeight:1.6 }}>
      {state === 'loading' && <span style={{ color:'var(--text-secondary)' }}>{tr("ui.5db5a15d468a")}</span>}
      {state === 'on' && (
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <span>{tr("ui.78016a1ed128")}</span>
          <button className="btn btn-sm" onClick={test} disabled={busy}>{tr("ui.c8ad14009596")}</button>
          <button className="btn btn-sm" onClick={turnOff} disabled={busy}>{tr("ui.f706464b923a")}</button>
        </div>
      )}
      {state === 'off' && (
        <button className="btn btn-primary" onClick={turnOn} disabled={busy}>{busy ? '…' : tr("ui.2cb5d1b9c105")}</button>
      )}
      {state === 'needs-install' && (
        <span>{tr("ui.7da62777fa27")}</span>
      )}
      {state === 'denied' && (
        <span>{tr("ui.70f7fa858c49")}{isIOS() ? tr("ui.0f0649e9529a") : tr("ui.3db8419010f1")}{tr("ui.34fc87c75652")}</span>
      )}
      {state === 'unsupported' && <span>{tr("ui.fef616e1b097")}</span>}
    </div>
  )

  if (compact) {
    if (state === 'on' || state === 'loading' || state === 'unsupported') return null
    const needsInstall = isMobile() && !isStandalone()
    return (
      <div className="card" style={{ marginBottom:16 }}>
        <div className="card-body" style={{ display:'flex', gap:12, alignItems:'flex-start', flexWrap:'wrap' }}>
          <div style={{ fontSize:26 }} aria-hidden="true">{needsInstall ? '📱' : '🔔'}</div>
          <div style={{ flex:1, minWidth:220 }}>
            <div style={{ fontWeight:600, marginBottom:6 }}>{needsInstall ? tr("ui.262a61cefc1b") : tr("ui.bb506ecaf5f9")}</div>
            <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>
              {needsInstall ? tr("ui.f11774cfeb2c") : tr("ui.4ea22698c144")}
            </div>
            {needsInstall ? <InstallSteps /> : pushBlock}
          </div>
          {onDismiss && <button className="btn btn-sm" onClick={onDismiss} aria-label={tr("ui.042fae8a9e4a")}>✕</button>}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="card-header"><div className="card-title">{tr("ui.3ba48ec9ace5")}</div></div>
        <div className="card-body"><InstallSteps /></div>
      </div>
      <div className="card" style={{ marginTop:16 }}>
        <div className="card-header"><div className="card-title">{tr("ui.975a15f62531")}</div></div>
        <div className="card-body">
          <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:12, lineHeight:1.6 }}>{tr("ui.e93ee0345ef0")}{(isAdmin || isManager) && <>{tr("ui.5588aee22c1d")}{isAdmin ? tr("ui.c1c224b03cd9") : tr("ui.8b2085f74dfa")}{tr("ui.0cbfef9c151b")}{isAdmin ? tr("ui.142d2c7797c6") : ''}{tr("ui.d48aa7d94352")}</>}
            {' '}{tr("ui.033ed04d0950")}</div>
          {pushBlock}
        </div>
      </div>
    </>
  )
}
