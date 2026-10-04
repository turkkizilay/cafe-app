import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { registerServiceWorker } from './lib/push'
import { LocaleProvider } from './context/LocaleContext.jsx'
import LanguageSwitcher from './components/UI/LanguageSwitcher.jsx'
import { installModalA11y } from './lib/modalA11y'

// StrictMode entfernt — verursacht doppelte Toast-Aufrufe durch
// React 18's double-invocation von State-Updater-Funktionen in Dev-Mode
ReactDOM.createRoot(document.getElementById('root')).render(
  <LocaleProvider>
    <div className="language-dock"><LanguageSwitcher /></div>
    <App />
  </LocaleProvider>
)

// Dialoge: Rolle, Fokus, Tab im Dialog, Escape = Klick auf den Hintergrund (lib/modalA11y.js)
if (typeof document !== 'undefined') installModalA11y(document)

// „App installieren“ (Android/Chrome): Ereignis kommt nur einmal – früh merken
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); window.__cafeInstallPrompt = e; window.dispatchEvent(new Event('cafe-install-available'))
})

// Service Worker (nur für Push-Benachrichtigungen, kein Offline-Cache)
if (typeof window !== 'undefined') window.addEventListener('load', () => { registerServiceWorker() })
