import { t as tr, getIntlLocale } from '../../i18n/runtime.js'
import { useLocale } from '../../context/LocaleContext.jsx'
import { useState, useEffect } from 'react'
import { BrandMark } from '../UI/Brand'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useDarkMode } from '../../context/DarkModeContext'
import { logActivity } from '../../lib/activityLog'

const SECTIONS = [
  { get label() { return tr("ui.824543888534") }, items: [
    { label: 'Dashboard',             icon: '📊', path: '/',            end: true },
    { get label() { return tr("ui.23f6c8674993") },            icon: '⏱️', path: '/einclocken'  },
    { get label() { return tr("ui.77ecaf5660bb") },           icon: '📅', path: '/schichten'   },
    { get label() { return tr("ui.37beb63c4e2b") },        icon: '🌴', path: '/urlaub',     vacBadge: true },
    { get label() { return tr("ui.d969afbb67a9") },         icon: '⏰', path: '/stunden'     },
    { get label() { return tr("ui.5893138b1479") },icon: '📄', path: '/dokumente'   },
    { get label() { return tr("ui.5cf21c63b3d6") },           icon: '👤', path: '/konto'       },
  ]},
]
const MANAGER_ITEMS = [
  { get label() { return tr("ui.15e5ec97be8c") }, icon: '📆', path: '/abwesenheit' },
  { get label() { return tr("ui.f4cb6891b9e5") },          icon: '👤', path: '/mitarbeiter' },
  { get label() { return tr("ui.f7afcf9af81e") },     icon: '🖨️', path: '/stundennachweis' },
]
const ADMIN_ITEMS = [
  { get label() { return tr("ui.d3075b3fc4af") },       icon: '💶', path: '/lohn'        },
  { get label() { return tr("ui.1ba6ae4c4865") },  icon: '✏️', path: '/zeitkorrekturen' },
  { get label() { return tr("ui.3249b70702f2") }, icon: '🔑', path: '/benutzer' },
  { get label() { return tr("ui.9c8cc5cff19d") },        icon: '📋', path: '/protokoll' },
  { get label() { return tr("ui.f5750a5d7231") },    icon: '⚙️', path: '/einstellungen'  },
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
function NavItem({ item, collapsed, isManager, vacTotal }) {
  useLocale()
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

export default function Sidebar({ session, isAdmin, isManager, pendingCount, vacPendingCount, sickPendingCount }) {
  useLocale()
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



  const adminWithBadge = ADMIN_ITEMS.map(item =>
    item.path === '/benutzer' ? { ...item, badge: pendingCount > 0 ? pendingCount : null } : item
  )

  return (
    <>
      {/* ── Mobile-Kopfzeile ── */}
      <header className="mobile-bar">
        <button className="mobile-menu-btn" onClick={() => setOpen(true)} aria-label={tr("ui.ac3b2ef4fee1")} aria-expanded={open}>
          <span aria-hidden="true">☰</span>
          {totalBadge > 0 && <span className="mobile-menu-dot" aria-hidden="true" />}
        </button>
        <div className="mobile-bar-title" style={{ display:'flex', alignItems:'center', gap:8 }}>
          <BrandMark size={26} /> Café Buur
        </div>
      </header>

      {/* ── Abdunkelung hinter der Schublade (nur Mobile) ── */}
      <div className={`sidebar-backdrop${open ? ' show' : ''}`} onClick={() => setOpen(false)} aria-hidden="true" />

      <aside className={`sidebar${collapsed ? ' collapsed' : ''}${open ? ' open' : ''}`} aria-label={tr("ui.3db65f8c2a7d")}>
        <div className="sidebar-logo">
          <BrandMark size={30} style={{ flexShrink:0 }} />
          <div className="sidebar-logo-text">
            <div className="sidebar-logo-name">Café Buur</div>
            <div className="sidebar-logo-sub">{session?.user?.email}</div>
          </div>
          <button className="sidebar-close" onClick={() => setOpen(false)} aria-label={tr("ui.48700e16fc0c")}>✕</button>
        </div>

        <nav className="sidebar-nav">
          {SECTIONS.map(sec => (
            <div key={sec.items[0].path}>
              <div className="sidebar-section-label">{sec.label}</div>
              {sec.items.map(item => <NavItem key={item.path} item={item} collapsed={collapsed} isManager={isManager} vacTotal={vacTotal} />)}
            </div>
          ))}

          {isManager && (<>
            <div className="sidebar-section-label">{tr("ui.2456bb8ed72f")}</div>
            {MANAGER_ITEMS.map(item => <NavItem key={item.path} item={item} collapsed={collapsed} isManager={isManager} vacTotal={vacTotal} />)}
          </>)}

          {isAdmin && (<>
            <div className="sidebar-section-label">Administration</div>
            {adminWithBadge.map(item => <NavItem key={item.path} item={item} collapsed={collapsed} isManager={isManager} vacTotal={vacTotal} />)}
          </>)}
        </nav>

        <div className="sidebar-footer">
          <button className="dark-toggle" onClick={toggle} title={tr("ui.967636c74cfd")}>
            <span>{dark ? '☀️' : '🌙'}</span><span className="nav-label">{dark ? tr("ui.8d586f8b60df") : tr("ui.368b231be48a")}</span>
          </button>

          <div className="sidebar-role nav-label">
            {isAdmin ? tr("ui.224667160047") : isManager ? tr("ui.0e60bc79039b") : tr("ui.d422e9b832d6")}
          </div>
          <button className="nav-item" style={{ width:'calc(100% - 12px)', border:'none', background:'none', cursor:'pointer' }}
            onClick={logout} title={collapsed ? tr("ui.545f8be33bf0") : undefined}>
            <span className="nav-icon">🚪</span><span className="nav-label">{tr("ui.545f8be33bf0")}</span>
          </button>

          <button className="sidebar-collapse-btn" onClick={toggleCollapsed}
            aria-label={collapsed ? tr("ui.fe503b8e2f0d") : tr("ui.c141cc21abae")}
            title={collapsed ? tr("ui.b68cf2cea9a4") : tr("ui.5503d6ae1ee4")}>
            {collapsed ? '»' : tr("ui.eeb3838c69e1")}
          </button>
        </div>
      </aside>
    </>
  )
}
