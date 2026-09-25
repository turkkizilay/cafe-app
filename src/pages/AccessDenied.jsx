import { t as tr, getIntlLocale } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { Link } from 'react-router-dom'

export default function AccessDenied() {
  useLocale()
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', gap: 16,
      background: 'var(--bg)', color: 'var(--text-primary)',
      padding: 32, textAlign: 'center',
    }}>
      <div style={{ fontSize: 48 }}>🔒</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{tr("ui.cd2f7b0a21cd")}</h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0, maxWidth: 360 }}>{tr("ui.a87c03de43ae")}</p>
      <Link to="/" style={{
        marginTop: 8, padding: '10px 24px', borderRadius: 8,
        background: 'var(--accent)', color: '#fff',
        textDecoration: 'none', fontWeight: 600, fontSize: 14,
      }}>{tr("ui.1536a21358b0")}</Link>
    </div>
  )
}
