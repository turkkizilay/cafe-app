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

// StrictMode entfernt — verursacht doppelte Toast-Aufrufe durch
// React 18's double-invocation von State-Updater-Funktionen in Dev-Mode
// Äußere Fehlergrenze: nie eine weiße Seite (auch vor der Anmeldung); Hinweis bei neuer App-Version (Resilience F7-a/F8)
ReactDOM.createRoot(document.getElementById('root')).render(
  <LocaleProvider>
    <div className="language-dock"><LanguageSwitcher /></div>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
    <UpdateBanner />
  </LocaleProvider>
)

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
