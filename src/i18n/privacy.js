import { PRIVACY_NOTICE_SECTIONS, CONTROLLER } from '../lib/privacyNotice.js'
import { translate } from './core.js'
import { translateSource } from './messages.js'

export function privacySections(locale) {
  if (locale !== 'en') return PRIVACY_NOTICE_SECTIONS
  return PRIVACY_NOTICE_SECTIONS.map((section, index) => ({
    title: translateSource(locale, section.title),
    text: index === 0
      ? translateSource(locale, 'Verantwortlich für die Verarbeitung deiner Daten ist dein Arbeitgeber: {p1}.', { p1: translate(locale, 'privacy.controller') })
      : translateSource(locale, section.text),
  }))
}
