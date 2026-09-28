import { useRef, useState } from 'react'
import { useLocale } from '../context/LocaleContext.jsx'
import { BrandBadge } from './UI/Brand'
import LegalLinks from './UI/LegalLinks.jsx'
import { LEGAL_PATHS } from '../legal/legalContent.js'
import { acknowledgePrivacyNotice } from '../lib/privacyAck.js'

// Einmalige Kenntnisnahme der aktuellen Datenschutzhinweise nach der Anmeldung (keine Einwilligung).
// Freigabe nur nach Serverbestätigung; bis dahin ist die App nicht erreichbar.
export default function PrivacyAckGate({ supabase, onAcknowledged, onSignOut }) {
  const { t } = useLocale()
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)

  async function confirm() {
    if (!checked || busy.current) return
    busy.current = true; setSaving(true); setError('')
    const res = await acknowledgePrivacyNotice(supabase)
    busy.current = false; setSaving(false)
    if (!res.ok) { setError(t('privacyAck.error')); return }
    onAcknowledged(res.acknowledgedAt)
  }

  return (
    <div className="login-page">
      <div className="login-card privacy-ack" role="dialog" aria-modal="true" aria-labelledby="privacy-ack-title">
        <BrandBadge size={52} style={{ margin:'0 auto 12px' }} />
        <h2 id="privacy-ack-title">{t('privacyAck.title')}</h2>
        <p className="privacy-ack-text">{t('privacyAck.text')}</p>
        <label className="privacy-ack-check">
          <input type="checkbox" checked={checked} disabled={saving} onChange={e => { setChecked(e.target.checked); setError('') }} />
          <span>{t('legal.ackBefore')}<a href={LEGAL_PATHS.privacy} target="_blank" rel="noopener noreferrer">{t('legal.ackLink')}</a>{t('privacyAck.checkAfter')}</span>
        </label>
        {error && <div role="alert" className="privacy-ack-error">{error}</div>}
        <button type="button" className="btn btn-primary privacy-ack-continue" onClick={confirm} disabled={!checked || saving}>
          {saving ? t('privacyAck.saving') : t('privacyAck.continue')}
        </button>
        <button type="button" className="privacy-ack-signout" onClick={onSignOut} disabled={saving}>{t('privacyAck.signOut')}</button>
        <LegalLinks />
      </div>
    </div>
  )
}

// Während der Serverstatus geladen wird: nichts vom geschützten Bereich zeigen
export function PrivacyAckChecking() {
  const { t } = useLocale()
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'#1C1917', color:'#fff', fontSize:16, gap:10 }}>
      <BrandBadge size={36} />{t('privacyAck.checking')}
    </div>
  )
}
