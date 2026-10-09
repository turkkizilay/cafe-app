import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { registerServiceWorker } from './lib/push'
import { LocaleProvider } from './context/LocaleContext.jsx'
import LanguageSwitcher from './components/UI/LanguageSwitcher.jsx'
import { installModalA11y } from './lib/modalA11y'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
import { reportChunkFailure } from './lib/versionCheck'
import { answerSessionPings, prepareSessionFlag } from './lib/sessionTabs'

// StrictMode entfernt — verursacht doppelte Toast-Aufrufe durch
// React 18's double-invocation von State-Updater-Funktionen in Dev-Mode
// „Nicht angemeldet bleiben“: angemeldete Tabs antworten neuen Tabs desselben Browsers; ein neuer Tab übernimmt die
// Sitzung, solange noch einer lebt – sonst meldet die bestehende Startprüfung wie bisher ab (Resilience Batch 2a, lib/sessionTabs.js)
const Channel = typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null
const storage = name => { try { return window[name] } catch { return null } }   // gesperrter Speicher darf den Start nie verhindern
answerSessionPings({ Channel, session: storage('sessionStorage') })

// Äußere Fehlergrenze: nie eine weiße Seite (auch vor der Anmeldung); Hinweis bei neuer App-Version (Resilience F7-a/F8)
const renderApp = () => ReactDOM.createRoot(document.getElementById('root')).render(
  <LocaleProvider>
    <div className="language-dock"><LanguageSwitcher /></div>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
    <UpdateBanner />
  </LocaleProvider>
)
// Nur im Fall „nicht angemeldet bleiben“ + Tab ohne Flag wird bis zu 300 ms gewartet; sonst sofort
prepareSessionFlag({ session: storage('sessionStorage'), local: storage('localStorage'), Channel }).catch(() => 'error').finally(renderApp)

// Nachgeladener Chunk nach einem Deploy nicht mehr vorhanden → Hinweis „neue Version“ (kein automatisches Neuladen)
if (typeof window !== 'undefined') window.addEventListener('vite:preloadError', () => { reportChunkFailure() })

// Dialoge: Rolle, Fokus, Tab im Dialog, Escape = Klick auf den Hintergrund (lib/modalA11y.js)
if (typeof document !== 'undefined') installModalA11y(document)

// „App installieren“ (Android/Chrome): Ereignis kommt nur einmal – früh merken
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); window.__cafeInstallPrompt = e; window.dispatchEvent(new Event('cafe-install-available'))
})

// Service Worker (nur für Push-Benachrichtigungen, kein Offline-Cache)
if (typeof window !== 'undefined') window.addEventListener('load', () => { registerServiceWorker() })
