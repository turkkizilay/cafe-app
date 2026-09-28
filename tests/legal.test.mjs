// Impressum & Datenschutzhinweise für Beschäftigte: Inhalt, Erreichbarkeit ohne Login, Onboarding-Kenntnisnahme.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { legalContent, legalKindForPath, LEGAL_PATHS, COMPANY } from '../src/legal/legalContent.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const text = (kind, locale) => JSON.stringify(legalContent(kind, locale))
const sectionText = (kind, locale, re) => JSON.stringify(legalContent(kind, locale).sections.find(s => re.test(s.title)))

test('1+2: Impressum und Datenschutz ohne Login erreichbar (Pfad wird vor jeder Anmeldeprüfung ausgewertet)', () => {
  assert.equal(legalKindForPath('/impressum'), 'imprint')
  assert.equal(legalKindForPath('/datenschutz'), 'privacy')
  assert.equal(legalKindForPath('/datenschutz/'), 'privacy')
  assert.equal(legalKindForPath('/'), null); assert.equal(legalKindForPath('/lohn'), null)
  const app = read('src/App.jsx')
  const legal = app.indexOf('legalKindForPath(window.location.pathname)')
  assert.ok(legal > 0)
  for (const gate of ['if (!session) return', "profile?.status === 'pending'", "profile?.status === 'disabled'", 'if (loading && !profile)', 'if (inviteToken)'])
    assert.ok(legal < app.indexOf(gate), `vor: ${gate}`)
  assert.match(app, /if \(legalKind\) return \(\s*<DarkModeProvider>\s*<LegalPage kind=\{legalKind\} \/>/)
  assert.match(read('vercel.json'), /"source": "\/\(\.\*\)",\s*"destination": "\/index\.html"/)   // SPA-Rewrite liefert /impressum und /datenschutz aus
})

test('3: Impressum enthält die verifizierten Angaben (DE und EN)', () => {
  for (const l of ['de', 'en']) {
    const s = text('imprint', l)
    for (const v of ['BP Food Revolution GmbH', 'Fürstenbergstraße 94', '50226 Frechen', 'Mazlum Akyol', 'Amtsgericht Köln', 'HRB 96756', 'DE322384214', 'info-ffm@cafebuur.de']) assert.ok(s.includes(v), `${l}: ${v}`)
  }
})

test('Unternehmen vs. Betriebsstätte: Firmenanschrift nur für die GmbH, Seckbächer Gasse nur als Einsatzort', () => {
  for (const l of ['de', 'en']) {
    const provider = sectionText('imprint', l, /^(Anbieter|Provider)$/)
    assert.ok(provider.includes('Fürstenbergstraße 94') && !provider.includes('Seckbächer'), `${l}: Anbieter`)
    const site = sectionText('imprint', l, /Einsatzort|Place of business/)
    assert.ok(site.includes('Seckbächer Gasse 14') && site.includes('Café Buur Frankfurt') && !site.includes('Fürstenberg'), `${l}: Einsatzort`)
    const controller = JSON.stringify(legalContent('privacy', l).sections[0])
    assert.ok(controller.includes('BP Food Revolution GmbH') && controller.includes('Fürstenbergstraße 94'), `${l}: Verantwortlicher`)
    assert.ok(/Betriebs- und Einsatzort|Place of business and work/.test(controller))
  }
  // Seckbächer Gasse erscheint nie in derselben Adresszeilen-Gruppe wie der Firmenname
  for (const l of ['de', 'en']) for (const k of ['imprint', 'privacy']) for (const s of legalContent(k, l).sections) for (const b of s.blocks)
    if (b.lines) assert.ok(!(b.lines.includes(COMPANY.name) && b.lines.includes('Seckbächer Gasse 14')), `${k}/${l}`)
})

test('4–6: keine Steuernummer, keine Bankverbindung, keine Nummer 88872049 – nirgends im ausgelieferten Code', () => {
  const files = [...walk('src'), ...walk('public'), 'index.html'].filter(f => /\.(jsx?|html|json|css|svg|txt)$/.test(f))
  for (const f of files) {
    const s = read(f)
    assert.ok(!s.includes('224/5704/3174') && !s.includes('2245704317'), `${f}: Steuernummer`)
    assert.ok(!s.includes('88872049'), `${f}: 88872049`)
  }
  for (const l of ['de', 'en']) for (const k of ['imprint', 'privacy']) {
    const s = text(k, l)
    assert.doesNotMatch(s, /\bDE\d{2}\s?\d{4}\s?\d{4}/, `${k}/${l}: keine IBAN`)
    assert.doesNotMatch(s, /Bankverbindung der|Bank details of|BIC|Kontonummer/i, `${k}/${l}`)
    assert.doesNotMatch(s, /Steuernummer|tax number/i, `${k}/${l}`)
  }
})

test('7+8: Datenschutzhinweise DE und EN vollständig mit den Pflichtabschnitten', () => {
  const need = {
    de: ['Verantwortlicher', 'Kontakt zum Datenschutz', 'Zweck', 'Welche Daten', 'Zwecke', 'Rechtsgrundlagen', 'Empfänger', 'Supabase', 'Vercel', 'Drittländer', 'Standortdaten', 'Gesundheitsdaten', 'Vergütung', 'Dokumente', 'Sicherheit', 'Push', 'Browser', 'Speicherdauer', 'Rechte', 'Beschwerde', 'Bereitstellung', 'automatisierten', 'Änderungen'],
    en: ['Controller', 'Data protection contact', 'Purpose', 'What data', 'Purposes', 'Legal bases', 'recipients', 'Supabase', 'Vercel', 'third countries', 'Location data', 'Health data', 'Pay', 'Documents', 'Security', 'Push', 'Browser', 'Storage period', 'rights', 'complaint', 'provide data', 'automated', 'Changes'],
  }
  for (const l of ['de', 'en']) {
    const titles = legalContent('privacy', l).sections.map(s => s.title).join(' | ')
    for (const n of need[l]) assert.ok(titles.includes(n), `${l}: ${n}`)
  }
  const deText = text('privacy', 'de')
  assert.match(deText, /Art\. 9 Abs\. 2 lit\. b DSGVO/)            // Gesundheitsdaten
  assert.match(deText, /§ 26 BDSG/)
  assert.doesNotMatch(deText, /Kalenderjahre|\b(3|6|8|10) Jahre|\b6 Monate/)          // keine nicht verifizierten Aufbewahrungsfristen
  assert.match(deText, /Protokolleinträge 12 Monate/)                                 // nur im Code festgelegte Fristen
})

test('Standort: Text entspricht dem Code (Koordinaten werden gespeichert, kein Hintergrund-Tracking, Pausen ohne Standort)', () => {
  const de = sectionText('privacy', 'de', /Standortdaten/), en = sectionText('privacy', 'en', /Location data/)
  assert.match(de, /GPS-Koordinaten \(Breiten- und Längengrad\)/); assert.match(de, /keine Standortabfrage im Hintergrund/); assert.match(de, /Pause werden ohne Standortangaben/)
  assert.match(en, /GPS coordinates \(latitude and longitude\)/); assert.match(en, /no location query in the background/)
  assert.doesNotMatch(text('privacy', 'de'), /speichern keine Standortdaten|keine Standortdaten gespeichert/)
  // Code-Abgleich: Koordinaten werden tatsächlich gesendet, Pausen-RPCs ohne Standort, kein watchPosition
  const clock = read('src/pages/ClockIn.jsx')
  assert.match(clock, /gps_lat_in: gps\.lat \?\? null/); assert.match(clock, /gps_lat_out: gps\.lat \?\? null/)
  assert.match(clock, /getCurrentPosition\(/)
  for (const f of walk('src').filter(f => /\.jsx?$/.test(f))) assert.doesNotMatch(read(f), /watchPosition/, f)
})

test('9: DE → EN → DE wechselt Rechtstexte und Beschriftungen vollständig', () => {
  for (const k of ['imprint', 'privacy']) {
    const d1 = text(k, 'de'), e = text(k, 'en'), d2 = text(k, 'de')
    assert.equal(d1, d2); assert.notEqual(d1, e)
    assert.doesNotMatch(e, /Verantwortlicher|Rechtsgrundlagen|Datenschutzhinweise|Beschäftigte/)
    assert.doesNotMatch(d1, /\bController\b|Legal bases|\bemployees\b/)
  }
  for (const key of ['legal.imprint', 'legal.privacy', 'legal.navLabel', 'legal.email', 'legal.updated', 'legal.back', 'legal.ackBefore', 'legal.ackLink', 'legal.ackAfter'])
    assert.ok(de[key] && en[key] && de[key] !== en[key], key)
  assert.equal(de['privacy.controller'], undefined, 'alter Hinweis mit falschem Verantwortlichen entfernt')
})

test('10: Login unverändert funktionsfähig, dezente Links „Impressum · Datenschutz“', () => {
  const login = read('src/components/Auth/Login.jsx')
  assert.match(login, /supabase\.auth\.signInWithPassword\(/)
  assert.match(login, /supabase\.auth\.resetPasswordForEmail\(/)
  assert.match(login, /<LegalLinks \/>/)
  const links = read('src/components/UI/LegalLinks.jsx')
  assert.match(links, /href=\{LEGAL_PATHS\.imprint\}/); assert.match(links, /href=\{LEGAL_PATHS\.privacy\}/)
  assert.equal(LEGAL_PATHS.imprint, '/impressum'); assert.equal(LEGAL_PATHS.privacy, '/datenschutz')
  assert.match(read('src/components/Layout/Sidebar.jsx'), /<LegalLinks className="legal-links sidebar-legal nav-label" \/>/)   // eingeloggt: Seitenleiste
  assert.match(read('src/pages/Account.jsx'), /<LegalLinks className="legal-links account-legal" \/>/)                    // eingeloggt: Mein Konto
})

test('11–14: Onboarding: Kenntnisnahme (keine Einwilligung), nicht vorausgewählt, Link zur Datenschutzseite, Absenden unverändert', () => {
  const onb = read('src/pages/Onboarding.jsx')
  assert.match(onb, /const \[privacy, setPrivacy\] = useState\(false\)/)                       // 12: nicht vorausgewählt
  assert.match(onb, /<input type="checkbox" checked=\{privacy\}/)
  assert.match(onb, /if \(!privacy\) \{ setErrors\(\{ privacy_accepted:/)                       // 11: Pflicht vor Absenden
  assert.match(onb, /p_data: \{ \.\.\.toPayload\(form\), privacy_accepted: true \}, p_submit: true/)
  assert.match(onb, /disabled=\{saving \|\| !privacy\}/)
  assert.match(onb, /<a href=\{LEGAL_PATHS\.privacy\} target="_blank" rel="noopener noreferrer"/)   // 14: direkt erreichbar, Formular bleibt
  assert.doesNotMatch(onb, /<PrivacyNotice|import PrivacyNotice|showPrivacy/)   // alter Inline-Hinweis entfernt
  const ack = l => l.ackBefore + l.ackLink + l.ackAfter
  const d = ack({ ackBefore: de['legal.ackBefore'], ackLink: de['legal.ackLink'], ackAfter: de['legal.ackAfter'] })
  const e = ack({ ackBefore: en['legal.ackBefore'], ackLink: en['legal.ackLink'], ackAfter: en['legal.ackAfter'] })
  assert.equal(d, 'Ich habe die Datenschutzhinweise für Beschäftigte zur Kenntnis genommen und bestätige, dass meine Angaben richtig sind.')
  assert.equal(e, 'I have read the privacy information for employees and confirm that my details are correct.')
  assert.doesNotMatch(d, /willige|Einwilligung|einverstanden|zustimm/i)                          // 13
  assert.doesNotMatch(e, /consent|agree/i)
  assert.match(text('privacy', 'de'), /dokumentiert nur, dass du diese Hinweise zur Kenntnis genommen hast/)
})

test('15–17: kein Tracking/Analytics, kein Cookie-Banner, keine neue Dependency', () => {
  const pkg = JSON.parse(read('package.json'))
  const base = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { encoding: 'utf8' }))
  assert.deepEqual(pkg.dependencies, base.dependencies); assert.deepEqual(pkg.devDependencies, base.devDependencies)
  const code = [...walk('src'), 'index.html', 'public/sw.js'].filter(f => /\.(jsx?|html)$/.test(f)).map(f => read(f)).join('\n')
  for (const re of [/googletagmanager|gtag\(|google-analytics/i, /fbq\(|connect\.facebook/i, /@sentry|Sentry\.init/, /hotjar|clarity\.ms|plausible|posthog|mixpanel|@vercel\/analytics|segment\.com/i])
    assert.doesNotMatch(code, re)
  assert.doesNotMatch(code, /document\.cookie/)
  assert.doesNotMatch(code, /CookieBanner|cookie-banner|cookieConsent|Cookie-Einwilligung/i)
  assert.match(text('privacy', 'de'), /setzt keine Cookies/)
})
