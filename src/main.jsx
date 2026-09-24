import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { registerServiceWorker } from './lib/push'

// StrictMode entfernt — verursacht doppelte Toast-Aufrufe durch
// React 18's double-invocation von State-Updater-Funktionen in Dev-Mode
ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

// „App installieren“ (Android/Chrome): Ereignis kommt nur einmal – früh merken
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); window.__cafeInstallPrompt = e; window.dispatchEvent(new Event('cafe-install-available'))
})

// Service Worker (nur für Push-Benachrichtigungen, kein Offline-Cache)
if (typeof window !== 'undefined') window.addEventListener('load', () => { registerServiceWorker() })
