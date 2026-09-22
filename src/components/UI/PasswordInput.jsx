import { useState } from 'react'

/**
 * Passwort-Eingabefeld mit Anzeigen/Verbergen Button
 * Ersetzt alle <input type="password"> in der App
 */
export default function PasswordInput({
  value, onChange, placeholder = '••••••••',
  autoComplete, required, disabled, style = {}, id,
}) {
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
        tabIndex={-1}
        onClick={() => setVisible(v => !v)}
        style={{
          position: 'absolute', right: '10px', top: '50%',
          transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: '17px',
          padding: '4px', lineHeight: 1,
          userSelect: 'none',
        }}
        title={visible ? 'Passwort verbergen' : 'Passwort anzeigen'}
        aria-label={visible ? 'Passwort verbergen' : 'Passwort anzeigen'}
      >
        {visible ? '🙈' : '👁️'}
      </button>
    </div>
  )
}
