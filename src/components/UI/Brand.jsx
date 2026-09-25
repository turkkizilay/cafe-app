import { t as tr, getIntlLocale } from '../../i18n/runtime.js'
import { useLocale } from '../../context/LocaleContext.jsx'
// Café-Buur-Logo (nachgebaut nach dem offiziellen Logo). Dateien liegen in /public.
// Sobald das Original als Datei vorliegt, einfach die Dateien in /public ersetzen.

/** Rundes Logo (schwarzer Kreis mit Hut, Ähre & Schnurrbart) — passt auf hell & dunkel */
export function BrandBadge({ size = 72, style }) {
  useLocale()
  return <img src="/logo-badge.svg" width={size} height={size} alt={tr("ui.3e8ae3d66b5d")} style={{ display:'block', ...style }} />
}

/** Nur das Zeichen in Weiß (für dunkle Flächen wie die Seitenleiste) */
export function BrandMark({ size = 28, style }) {
  useLocale()
  return <img src="/logo-mark-white.svg" width={size} height={size} alt="" aria-hidden="true" style={{ display:'block', ...style }} />
}

/** Schriftzug „CAFÉ ✕ BUUR“ — wählt automatisch hell/dunkel passend zum Design */
export function BrandWordmark({ height = 34, variant = 'auto', style }) {
  useLocale()
  const common = { height, width: 'auto', display:'block', ...style }
  if (variant === 'light') return <img src="/logo-wordmark-white.png" alt={tr("ui.3e8ae3d66b5d")} style={common} />
  if (variant === 'dark')  return <img src="/logo-wordmark-dark.png"  alt={tr("ui.3e8ae3d66b5d")} style={common} />
  return (
    <>
      <img src="/logo-wordmark-dark.png"  alt={tr("ui.3e8ae3d66b5d")} className="brand-wm-on-light" style={common} />
      <img src="/logo-wordmark-white.png" alt="" aria-hidden="true" className="brand-wm-on-dark" style={common} />
    </>
  )
}
