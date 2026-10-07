import { t as tr, getIntlLocale } from '../../i18n/runtime.js'
import { useLocale } from '../../context/LocaleContext.jsx'
import { useState } from 'react'

/**
 * Passwort-Eingabefeld mit Anzeigen/Verbergen Button
 * Ersetzt alle <input type="password"> in der App
 */
export default function PasswordInput({
  value, onChange, placeholder = '••••••••',
  autoComplete, required, disabled, style = {}, id,
}) {
  useLocale()
  const [visible, setVisible] = useState(false)

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        style={{ paddingRight: '42px', width: '100%', ...style }}
      />
      <button
        type="button"
        className="password-toggle"
        tabIndex={-1}
        onClick={() => setVisible(v => !v)}
        style={{
          // Tippfläche über die volle Feldhöhe und 42 px breit (vorher ~29 × 25 px – auf dem Handy schwer zu treffen)
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '42px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: '17px',
          padding: 0, lineHeight: 1,
          userSelect: 'none',
        }}
        title={visible ? tr("ui.680d43e0eca7") : tr("ui.dccd381767f2")}
        aria-label={visible ? tr("ui.680d43e0eca7") : tr("ui.dccd381767f2")}
      >
        {visible ? '🙈' : '👁️'}
      </button>
    </div>
  )
}
