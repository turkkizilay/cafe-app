import { useLocale } from '../../context/LocaleContext.jsx'
import { privacySections } from '../../i18n/privacy.js'

function Sections({ locale }) {
  return <div lang={locale}>{privacySections(locale).map((section, index) => (
    <div key={index} style={{ marginBottom:10 }}>
      <div style={{ fontWeight:600, color:'var(--text-primary)' }}>{section.title}</div>
      <div>{section.text}</div>
    </div>
  ))}</div>
}

export default function PrivacyNotice() {
  const { locale, t } = useLocale()
  return <>
    <Sections locale={locale} />
    <details>
      <summary lang={locale === 'de' ? 'en' : 'de'}>{t('privacy.otherLanguage')}</summary>
      <Sections locale={locale === 'de' ? 'en' : 'de'} />
    </details>
  </>
}
