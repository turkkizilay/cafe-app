import { Link } from 'react-router-dom'

export default function AccessDenied() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', gap: 16,
      background: 'var(--bg)', color: 'var(--text-primary)',
      padding: 32, textAlign: 'center',
    }}>
      <div style={{ fontSize: 48 }}>🔒</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Kein Zugriff</h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0, maxWidth: 360 }}>
        Du hast keine Berechtigung, diese Seite aufzurufen.
        Bitte wende dich an deinen Administrator.
      </p>
      <Link to="/" style={{
        marginTop: 8, padding: '10px 24px', borderRadius: 8,
        background: 'var(--accent)', color: '#fff',
        textDecoration: 'none', fontWeight: 600, fontSize: 14,
      }}>
        Zurück zum Dashboard
      </Link>
    </div>
  )
}
