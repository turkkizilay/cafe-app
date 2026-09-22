import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// StrictMode entfernt — verursacht doppelte Toast-Aufrufe durch
// React 18's double-invocation von State-Updater-Funktionen in Dev-Mode
ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
