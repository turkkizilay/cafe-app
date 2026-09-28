import { useLocale } from '../../context/LocaleContext.jsx'
import { LEGAL_PATHS } from '../../legal/legalContent.js'

// Dezente Links „Impressum · Datenschutz“ (öffentliche Seiten, volle Seitenladung)
export default function LegalLinks({ className = 'legal-links' }) {
  const { t } = useLocale()
  return (
    <nav className={className} aria-label={t('legal.navLabel')}>
      <a href={LEGAL_PATHS.imprint}>{t('legal.imprint')}</a>
      <span aria-hidden="true">·</span>
      <a href={LEGAL_PATHS.privacy}>{t('legal.privacy')}</a>
    </nav>
  )
}
