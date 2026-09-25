import { t as tr, getIntlLocale } from '../../i18n/runtime.js'
import { useLocale } from '../../context/LocaleContext.jsx'
import { useState } from 'react'

/**
 * Universelle Avatar-Komponente
 * Zeigt Profilbild wenn vorhanden, sonst farbige Initialen
 */
export default function Avatar({ src, firstName, lastName, color, size = 36, style = {} }) {
  useLocale()
  const [imgError, setImgError] = useState(false)
  const initials = `${(firstName||'').charAt(0)}${(lastName||'').charAt(0)}`.toUpperCase() || '?'
  const fontSize  = Math.round(size * 0.36)

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={`${firstName || ''} ${lastName || ''}`}
        onError={() => setImgError(true)}
        style={{
          width: size, height: size, borderRadius: '50%',
          objectFit: 'cover', flexShrink: 0,
          border: '2px solid var(--border)',
          ...style,
        }}
      />
    )
  }

  return (
    <div
      className={`avatar avatar-${color || 'blue'}`}
      style={{ width: size, height: size, fontSize, flexShrink: 0, ...style }}
    >
      {initials}
    </div>
  )
}
