import { useState, useEffect } from 'react'
import { BrandMark } from '../UI/Brand'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useDarkMode } from '../../context/DarkModeContext'
import { logActivity } from '../../lib/activityLog'

const SECTIONS = [
  { label: 'Mein Bereich', items: [
    { label: 'Dashboard',             icon: '📊', path: '/',            end: true },
    { label: 'Einclocken',            icon: '⏱️', path: '/einclocken'  },
    { label: 'Schichtplan',           icon: '📅', path: '/schichten'   },
    { label: 'Urlaub & Krank',        icon: '🌴', path: '/urlaub',     vacBadge: true },
    { label: 'Meine Stunden',         icon: '⏰', path: '/stunden'     },
    { label: 'Meine Lohnabrechnungen',icon: '📄', path: '/dokumente'   },
    { label: 'Mein Konto',           icon: '👤', path: '/konto'       },
  ]},
]
const MANAGER_ITEMS = [
  { label: 'Abwesenheitskalender', icon: '📆', path: '/abwesenheit' },
  { label: 'Mitarbeiter',          icon: '👤', path: '/mitarbeiter' },
  { label: 'Lohn & Stunden',       icon: '💶', path: '/lohn'        },
]
const ADMIN_ITEMS = [
  { label: 'Zeitkorrekturen',  icon: '✏️', path: '/zeitkorrekturen' },
  { label: 'Benutzerverwaltung', icon: '🔑', path: '/benutzer' },
  { label: 'Protokoll',        icon: '📋', path: '/protokoll' },
  { label: 'Einstellungen',    icon: '⚙️', path: '/einstellungen'  },
]

// Eingeklappt-Zustand (nur Desktop) pro Gerät merken — reine Komfort-Einstellung
const COLLAPSE_KEY = 'cafe_sidebar_collapsed'
function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}
function writeCollapsed(v) {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0') } catch { /* egal */ }
}

/**
 * Navigation.
 * Desktop (> 768px): feste Seitenleiste, per « / » einklappbar (nur Symbole).
 * Mobile  (≤ 768px): Leiste ist ausgeblendet; oben erscheint eine schmale Kopfzeile
 *                    mit ☰ — ein Tipp öffnet die Navigation als Schublade von links.
 */
export default function Sidebar({ session, isAdmin, isManager, pendingCount, vacPendingCount, sickPendingCount }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { dark, toggle } = useDarkMode()
  const [open,      setOpen]      = useState(false)          // Mobile-Schublade
  const [collapsed, setCollapsed] = useState(readCollapsed)  // Desktop eingeklappt

  // Nach jedem Seitenwechsel Schublade schließen
  useEffect(() => { setOpen(false) }, [location.pathname])

  // Escape schließt die Schublade
  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function toggleCollapsed() {
    setCollapsed(c => { writeCollapsed(!c); return !c })
  }

  async function logout() {
    await logActivity({ action: 'auth.logout', category: 'auth', summary: 'hat sich abgemeldet.' })
    await supabase.auth.signOut(); navigate('/')
  }

  const vacTotal = (vacPendingCount || 0) + (sickPendingCount || 0)
  const totalBadge = (isAdmin ? (pendingCount || 0) : 0) + (isManager ? vacTotal : 0)

  const NavItem = ({ item }) => {
    const badge = item.badge || (item.vacBadge && isManager && vacTotal > 0 ? vacTotal : null)
    return (
      <NavLink to={item.path} end={item.end} title={collapsed ? item.label : undefined}
        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
        <span className="nav-icon">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
        {badge && <span className="nav-badge">{badge}</span>}
      </NavLink>
    )
  }

  const adminWithBadge = ADMIN_ITEMS.map(item =>
    item.path === '/benutzer' ? { ...item, badge: pendingCount > 0 ? pendingCount : null } : item
  )

  return (
    <>
      {/* ── Mobile-Kopfzeile ── */}
      <header className="mobile-bar">
        <button className="mobile-menu-btn" onClick={() => setOpen(true)} aria-label="Menü öffnen" aria-expanded={open}>
          <span aria-hidden="true">☰</span>
          {totalBadge > 0 && <span className="mobile-menu-dot" aria-hidden="true" />}
        </button>
        <div className="mobile-bar-title" style={{ display:'flex', alignItems:'center', gap:8 }}>
          <BrandMark size={26} /> Café Buur
        </div>
      </header>

      {/* ── Abdunkelung hinter der Schublade (nur Mobile) ── */}
      <div className={`sidebar-backdrop${open ? ' show' : ''}`} onClick={() => setOpen(false)} aria-hidden="true" />

      <aside className={`sidebar${collapsed ? ' collapsed' : ''}${open ? ' open' : ''}`} aria-label="Navigation">
        <div className="sidebar-logo">
          <BrandMark size={30} style={{ flexShrink:0 }} />
          <div className="sidebar-logo-text">
            <div className="sidebar-logo-name">Café Buur</div>
            <div className="sidebar-logo-sub">{session?.user?.email}</div>
          </div>
          <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="Menü schließen">✕</button>
        </div>

        <nav className="sidebar-nav">
          {SECTIONS.map(sec => (
            <div key={sec.label}>
              <div className="sidebar-section-label">{sec.label}</div>
              {sec.items.map(item => <NavItem key={item.path} item={item} />)}
            </div>
          ))}

          {isManager && (<>
            <div className="sidebar-section-label">Verwaltung</div>
            {MANAGER_ITEMS.map(item => <NavItem key={item.path} item={item} />)}
          </>)}

          {isAdmin && (<>
            <div className="sidebar-section-label">Administration</div>
            {adminWithBadge.map(item => <NavItem key={item.path} item={item} />)}
          </>)}
        </nav>

        <div className="sidebar-footer">
          <button className="dark-toggle" onClick={toggle} title="Design wechseln">
            <span>{dark ? '☀️' : '🌙'}</span><span className="nav-label">{dark ? 'Hell' : 'Dunkel'}</span>
          </button>

          <div className="sidebar-role nav-label">
            {isAdmin ? '👑 Administrator' : isManager ? '🔧 Manager' : '👤 Mitarbeiter'}
          </div>
          <button className="nav-item" style={{ width:'calc(100% - 12px)', border:'none', background:'none', cursor:'pointer' }}
            onClick={logout} title={collapsed ? 'Abmelden' : undefined}>
            <span className="nav-icon">🚪</span><span className="nav-label">Abmelden</span>
          </button>

          <button className="sidebar-collapse-btn" onClick={toggleCollapsed}
            aria-label={collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}
            title={collapsed ? 'Ausklappen' : 'Einklappen'}>
            {collapsed ? '»' : '« Einklappen'}
          </button>
        </div>
      </aside>
    </>
  )
}
