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
  const [bip, setBip] = useState(() => window.__cafeInstallPrompt || null)
  useEffect(() => {
    const h = () => setBip(window.__cafeInstallPrompt || null)
    window.addEventListener('cafe-install-available', h)
    return () => window.removeEventListener('cafe-install-available', h)
  }, [])

  if (isStandalone()) return <div style={{ fontSize:13.5 }}>✅ Die App ist auf diesem Gerät installiert.</div>

  if (isIOS()) return (
    <ol style={{ margin:'0 0 0 18px', padding:0, fontSize:13.5, lineHeight:1.8 }}>
      <li>Diese Seite in <strong>Safari</strong> öffnen.</li>
      <li>Unten auf <strong>Teilen</strong> tippen (Quadrat mit Pfeil nach oben <span aria-hidden="true">⬆︎</span>).</li>
      <li><strong>„Zum Home-Bildschirm“</strong> wählen → <strong>„Hinzufügen“</strong>.</li>
      <li>Die App über das neue Symbol öffnen und anmelden.</li>
    </ol>
  )

  return (
    <div style={{ fontSize:13.5, lineHeight:1.7 }}>
      {bip ? (
        <button className="btn btn-primary" onClick={async () => {
          try { bip.prompt(); await bip.userChoice } catch { /* abgebrochen */ }
          window.__cafeInstallPrompt = null; setBip(null)
        }}>📲 App installieren</button>
      ) : isAndroid() ? (
        <ol style={{ margin:'0 0 0 18px', padding:0 }}>
          <li>In <strong>Chrome</strong> oben rechts auf <strong>⋮</strong> tippen.</li>
          <li><strong>„App installieren“</strong> bzw. <strong>„Zum Startbildschirm hinzufügen“</strong> wählen.</li>
        </ol>
      ) : (
        <div>Am Computer: In Chrome/Edge in der Adresszeile auf das Installieren-Symbol klicken – oder einfach die Seite als Lesezeichen speichern.</div>
      )}
    </div>
  )
}

export default function AppSetupCard({ compact = false, onDismiss }) {
  const toast = useToast()
  const { isAdmin, isManager } = useProfile() || {}
  const [state, setState] = useState('loading')
  const [busy, setBusy] = useState(false)

  async function refresh() { setState(await pushState()) }
  useEffect(() => { refresh() }, [])

  async function turnOn() {
    if (busy) return
    setBusy(true)
    try { await enablePush(); toast.success('🔔 Benachrichtigungen sind an.') }
    catch (e) { toast.error(e.message || 'Das hat nicht geklappt.') }
    finally { setBusy(false); refresh() }
  }
  async function turnOff() {
    if (busy) return
    setBusy(true)
    try { await disablePush(); toast.success('Benachrichtigungen auf diesem Gerät ausgeschaltet.') }
    finally { setBusy(false); refresh() }
  }
  async function test() {
    if (busy) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('push_test')
      if (error || !data?.success) toast.error(data?.error || 'Test fehlgeschlagen.')
      else toast.success('Test verschickt – kommt in wenigen Sekunden.')
    } finally { setBusy(false) }
  }

  const pushBlock = (
    <div style={{ fontSize:13.5, lineHeight:1.6 }}>
      {state === 'loading' && <span style={{ color:'var(--text-secondary)' }}>Wird geprüft…</span>}
      {state === 'on' && (
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <span>✅ Auf diesem Gerät eingeschaltet.</span>
          <button className="btn btn-sm" onClick={test} disabled={busy}>Test senden</button>
          <button className="btn btn-sm" onClick={turnOff} disabled={busy}>Ausschalten</button>
        </div>
      )}
      {state === 'off' && (
        <button className="btn btn-primary" onClick={turnOn} disabled={busy}>{busy ? '…' : '🔔 Benachrichtigungen einschalten'}</button>
      )}
      {state === 'needs-install' && (
        <span>Auf dem iPhone gehen Benachrichtigungen nur in der installierten App. Bitte zuerst die App zum Home-Bildschirm hinzufügen (siehe oben) und dort einschalten.</span>
      )}
      {state === 'denied' && (
        <span>Benachrichtigungen sind für diese App blockiert. {isIOS() ? 'iPhone: Einstellungen → Mitteilungen → Café Buur → „Mitteilungen erlauben“.' : 'Im Browser auf das Schloss-Symbol neben der Adresse tippen → Benachrichtigungen erlauben.'} Danach diese Seite neu laden.</span>
      )}
      {state === 'unsupported' && <span>Dieser Browser unterstützt leider keine Benachrichtigungen.</span>}
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
            <div style={{ fontWeight:600, marginBottom:6 }}>{needsInstall ? 'Café Buur als App aufs Handy' : 'Benachrichtigungen einschalten'}</div>
            <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:10 }}>
              {needsInstall ? 'Dann startest du die App mit einem Tipp und bekommst Mitteilungen zu Schichten und Urlaub.' : 'Du erfährst sofort von neuen Schichten, Urlaubsentscheidungen und Anfragen.'}
            </div>
            {needsInstall ? <InstallSteps /> : pushBlock}
          </div>
          {onDismiss && <button className="btn btn-sm" onClick={onDismiss} aria-label="Ausblenden">✕</button>}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="card-header"><div className="card-title">📱 App aufs Handy</div></div>
        <div className="card-body"><InstallSteps /></div>
      </div>
      <div className="card" style={{ marginTop:16 }}>
        <div className="card-header"><div className="card-title">🔔 Benachrichtigungen</div></div>
        <div className="card-body">
          <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:12, lineHeight:1.6 }}>
            Du bekommst eine Mitteilung bei neuen oder geänderten Schichten, Tauschanfragen, Entscheidungen zu deinem Urlaub und neuen Lohnabrechnungen.
            {(isAdmin || isManager) && <> Als {isAdmin ? 'Admin' : 'Manager'} außerdem bei neuen Urlaubsanträgen, Krankmeldungen{isAdmin ? ', Registrierungen' : ''} und Schichttauschen, die auf Freigabe warten.</>}
            {' '}Die Einstellung gilt pro Gerät. Nach dem Abmelden bekommt das Gerät keine Mitteilungen mehr für dich – bis sich wieder jemand darauf anmeldet.
          </div>
          {pushBlock}
        </div>
      </div>
    </>
  )
}
