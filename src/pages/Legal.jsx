import { useEffect } from 'react'
import { useLocale } from '../context/LocaleContext.jsx'
import { BrandBadge } from '../components/UI/Brand.jsx'
import { legalContent, LEGAL_PATHS, LEGAL_VERSION } from '../legal/legalContent.js'

// Öffentliche Rechtsseiten (ohne Login): Impressum und Datenschutzhinweise für Beschäftigte.
// Normale Links (volle Seitenladung) – App.jsx entscheidet anhand des Pfads vor jeder Anmeldung.
function Block({ block, t }) {
  if (block.p) return <p>{block.p}</p>
  if (block.ul) return <ul>{block.ul.map((item, i) => <li key={i}>{item}</li>)}</ul>
  if (block.lines) return <p className="legal-lines">{block.lines.map((line, i) => <span key={i}>{line}</span>)}</p>
  if (block.email) return <p>{t('legal.email')}: <a href={`mailto:${block.email}`}>{block.email}</a></p>
  if (block.link) return <p><a href={LEGAL_PATHS[block.link]}>{block.text}</a></p>
  return null
}

export default function LegalPage({ kind }) {
  const { locale, t } = useLocale()
  const content = legalContent(kind, locale)
  useEffect(() => { document.title = `${content.title} – Café Buur` }, [content.title])
  const updated = new Date(`${LEGAL_VERSION}T12:00:00`).toLocaleDateString(locale === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
  return (
    <div className="legal-page" lang={locale}>
      <header className="legal-header">
        <a href="/" className="legal-brand"><BrandBadge size={34} /><span>Café Buur</span></a>
        <nav className="legal-nav" aria-label={t('legal.navLabel')}>
          <a href={LEGAL_PATHS.imprint} aria-current={kind === 'imprint' ? 'page' : undefined}>{t('legal.imprint')}</a>
          <a href={LEGAL_PATHS.privacy} aria-current={kind === 'privacy' ? 'page' : undefined}>{t('legal.privacy')}</a>
        </nav>
      </header>
      <main className="legal-card">
        <h1>{content.title}</h1>
        <p className="legal-intro">{content.intro}</p>
        {content.sections.map((section, i) => (
          <section key={i}>
            <h2>{section.title}</h2>
            {section.blocks.map((block, j) => <Block key={j} block={block} t={t} />)}
          </section>
        ))}
        <p className="legal-updated">{t('legal.updated', { date: updated })}</p>
      </main>
      <p className="legal-back"><a href="/">{t('legal.back')}</a></p>
    </div>
  )
}
