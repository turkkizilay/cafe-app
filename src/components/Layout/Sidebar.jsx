import { NavLink, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Avatar from '../UI/Avatar'
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

export default function Sidebar({ session, isAdmin, isManager, pendingCount, vacPendingCount, sickPendingCount }) {
  const navigate = useNavigate()
  const { dark, toggle } = useDarkMode()

  async function logout() {
    await logActivity({ action: 'auth.logout', category: 'auth', summary: 'hat sich abgemeldet.' })
    await supabase.auth.signOut(); navigate('/')
  }

  const NavItem = ({ item }) => {
    const vacTotal = (vacPendingCount || 0) + (sickPendingCount || 0)
    const badge = item.badge || (item.vacBadge && vacTotal > 0 ? vacTotal : null)
    return (
      <NavLink to={item.path} end={item.end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
        <span className="nav-icon">{item.icon}</span>
        <span style={{ flex:1 }}>{item.label}</span>
        {badge && (
          <span style={{ background:'#C2793A', color:'#fff', borderRadius:10, fontSize:10, fontWeight:700, padding:'1px 6px', minWidth:18, textAlign:'center' }}>
            {badge}
          </span>
        )}
      </NavLink>
    )
  }

  const adminWithBadge = ADMIN_ITEMS.map(item =>
    item.path === '/benutzer' ? { ...item, badge: pendingCount > 0 ? pendingCount : null } : item
  )

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <span className="sidebar-logo-icon">☕</span>
        <div className="sidebar-logo-name">Café Buur</div>
        <div className="sidebar-logo-sub" style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {session?.user?.email}
        </div>
      </div>

      <nav style={{ padding:'8px', flex:1, overflowY:'auto' }}>
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

      <div style={{ padding:'10px', borderTop:'1px solid rgba(255,255,255,0.06)' }}>
        {/* Dark Mode Toggle */}
        <button className="dark-toggle" onClick={toggle} title="Design wechseln">
          {dark ? '☀️' : '🌙'} {dark ? 'Hell' : 'Dunkel'}
        </button>

        <div style={{ fontSize:10, color:'rgba(255,255,255,0.2)', padding:'2px 10px', marginBottom:2 }}>
          {isAdmin ? '👑 Administrator' : isManager ? '🔧 Manager' : '👤 Mitarbeiter'}
        </div>
        <button className="nav-item" style={{ width:'100%', border:'none', background:'none', cursor:'pointer' }} onClick={logout}>
          <span className="nav-icon">🚪</span> Abmelden
        </button>
      </div>
    </div>
  )
}
