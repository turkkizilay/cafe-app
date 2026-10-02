// Bangla (বাংলা) als vollständige dritte App-Sprache + Onboarding: eigene Telefonnummer, Notfallkontakt freiwillig.
// Vollständigkeit: DE/EN/BN identische Keys/Pluralformen/Platzhalter, keine leeren BN-Werte, keine stillen
// deutschen/englischen Reste (Bangla-Schrift überall, wo DE und EN sich unterscheiden), keine rohen Keys.
// Server-Seite (Migration 32, RLS Telefonnummer): tests/db/onboarding_emergency_optional.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { parse } from '@babel/parser'
import { de, en } from '../src/i18n/catalogs.js'
import { bn } from '../src/i18n/catalogBn.js'
import { LOCALES, LOCALE_KEY, normalizeLocale, readLocale, writeLocale, localeFromStorageEvent, translate, createFormatters, intlLocale, catalogs } from '../src/i18n/core.js'
import { setRuntimeLocale, localizeMessage, message, messageParts, formatParam } from '../src/i18n/runtime.js'
import { legalContent } from '../src/legal/legalContent.js'
import { validatePersonal, REQUIRED_FIELDS, EMERGENCY_FIELDS, PHONE_MAX, toPayload, PERSONAL_FIELDS } from '../src/lib/personalData.js'
import { resumeStep, STEP_KEYS, STEP_FIELDS, rowToForm } from '../src/lib/onboardingFlow.js'

const read = f => readFileSync(f, 'utf8')
const files = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${d}/${e.name}`) : [`${d}/${e.name}`])
const placeholders = s => [...String(s).matchAll(/\{([A-Za-z]\w*)\}/g)].map(m => m[1]).sort()
const BENGALI = /[ঀ-৿]/
const variants = (cat, k) => typeof cat[k] === 'object' ? Object.entries(cat[k]) : [[null, cat[k]]]
// Bewusst nicht übersetzt (Original-Beschriftungen fremder Oberflächen bzw. reine Zeichen)
const KEEP_ORIGINAL = new Set(['ui.065b95578e10', 'ui.a2d5731477f0', 'ui.bff96c5bb84d', 'ui.ffa543c28fe3', 'ui.3050e581f294', 'ui.24db69445a9d'])

test('Kataloge: DE, EN und BN haben exakt dieselben Keys, Pluralformen und Platzhalter; kein BN-Wert leer', () => {
  const kd = Object.keys(de).sort()
  assert.deepEqual(Object.keys(en).sort(), kd)
  assert.deepEqual(Object.keys(bn).sort(), kd, 'BN fehlt/zu viel')
  assert.ok(kd.length > 2000)
  for (const k of kd) {
    assert.equal(typeof bn[k], typeof de[k], k)
    if (typeof de[k] === 'object') assert.deepEqual(Object.keys(bn[k]).sort(), Object.keys(de[k]).sort(), k)
    for (const [v, s] of variants(bn, k)) {
      const d = v ? de[k][v] : de[k]
      assert.equal(typeof s, 'string', `${k}.${v}`)
      assert.ok(s.length, `${k}.${v}: leer`)
      assert.deepEqual(placeholders(s), placeholders(d), `${k}.${v}: Platzhalter`)
    }
  }
})

test('Keine stillen DE/EN-Reste in BN: überall Bangla-Schrift, wo sich DE und EN unterscheiden', () => {
  const missing = []
  for (const k of Object.keys(de)) for (const [v, s] of variants(bn, k)) {
    const d = v ? de[k][v] : de[k], e = v ? en[k][v] : en[k]
    if (d === e || KEEP_ORIGINAL.has(k) || !/[A-Za-z]{3,}/.test(e)) continue
    if (!BENGALI.test(s)) missing.push(k)
    if (s === d || s === e) missing.push(`${k} (Kopie)`)
  }
  assert.deepEqual(missing, [])
})

test('Keine rohen Keys: jede Übersetzung in BN liefert Text statt Key, kein BN-Wert sieht wie ein Key aus', () => {
  for (const k of Object.keys(de)) {
    const out = translate('bn', k, { count: 2 })
    assert.notEqual(out, k, k)
    assert.doesNotMatch(out, /\b(ui|error|onb|clock|time|reset|lifecycle|payroll)\.[a-z0-9]{6,}/i, k)
  }
  // Fallback auf Deutsch greift in BN nie (jeder Key ist eigenständig vorhanden)
  for (const k of Object.keys(de)) assert.ok(Object.hasOwn(catalogs.bn, k), k)
})

test('Locale: bn gültig und persistent; Unbekanntes bleibt Deutsch; Storage-Ereignis aus anderem Tab', () => {
  assert.deepEqual(LOCALES, ['de', 'en', 'bn'])
  assert.equal(normalizeLocale('bn'), 'bn'); assert.equal(normalizeLocale('bd'), 'de'); assert.equal(normalizeLocale('fr'), 'de')
  const memory = new Map(), storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) }
  assert.equal(writeLocale('bn', storage), 'bn'); assert.equal(memory.get(LOCALE_KEY), 'bn'); assert.equal(readLocale(storage), 'bn')
  assert.equal(localeFromStorageEvent({ key: LOCALE_KEY, newValue: 'bn' }), 'bn')
})

test('Sprachwechsel DE → BN → EN: gespeicherte Meldungen und Pluralformen folgen der Auswahl', () => {
  const stored = messageParts([message('onb.emergencyIncomplete'), ' ', message('count.days', { count: 3 })])
  const seen = ['de', 'bn', 'en'].map(l => { setRuntimeLocale(l); return localizeMessage(stored) })
  assert.deepEqual(seen, [
    'Bitte Name und Telefonnummer angeben – oder beide Felder leer lassen. 3 Tage',
    'অনুগ্রহ করে নাম ও ফোন নম্বর দুটোই দিন – অথবা দুটোই খালি রাখুন। 3 দিন',
    'Please enter both name and phone number – or leave both empty. 3 days',
  ])
  setRuntimeLocale('bn'); assert.equal(localizeMessage(message('count.days', { count: 1 })), '1 দিন')
  setRuntimeLocale('de')
})

test('BN-Formatierung: Bangla-Monatsnamen, aber lateinische Ziffern und 24-h-Uhr (wie Zeitfelder/Lohnunterlagen)', () => {
  assert.equal(intlLocale('bn'), 'bn-BD-u-hc-h23-nu-latn')
  const f = createFormatters('bn'), d = new Date(2026, 9, 2, 14, 5)
  assert.equal(f.time(d), '14:05')
  assert.equal(f.date(d, { day: '2-digit', month: '2-digit', year: 'numeric' }), '02/10/2026')
  assert.match(f.date(d, { month: 'long' }), BENGALI)
  assert.doesNotMatch(f.currency(1234.5) + f.number(12.5, { minimumFractionDigits: 2 }), /[০-৯]/)
  assert.doesNotMatch(Object.values(bn).flatMap(v => typeof v === 'object' ? Object.values(v) : [v]).join(''), /[০-৯]/, 'keine Bangla-Ziffern im Katalog (einheitlich)')
  setRuntimeLocale('de')
})

test('Sprachumschalter: DE · EN · বাংলা, nur per Benutzerwahl; keine automatische Auswahl', () => {
  const sw = read('src/components/UI/LanguageSwitcher.jsx')
  assert.match(sw, /\{ value: 'de', short: 'DE'[\s\S]*\{ value: 'en', short: 'EN'[\s\S]*\{ value: 'bn', short: 'বাংলা'/)
  assert.match(sw, /lang=\{option\.value\}/)
  const css = read('src/index.css')
  assert.match(css, /grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/)
  assert.match(css, /\.language-segment\[data-active="2"\] \.language-segment-indicator \{ transform:translateX\(200%\); \}/)
  assert.doesNotMatch(css, /104px/, 'Breite des Umschalters nur über --language-dock-w')
  assert.match(css, /:root \{ --language-dock-w: 180px; \}/, 'gemessene Breite (176 px) + Reserve, sonst überlappt ↻')
  assert.match(css, /@media \(max-width:359px\) \{ \.mobile-bar-brand \{ display:none; \} \}/)
  // Sprache wird nie aus Name/Herkunft/Rolle/Browser abgeleitet: einzige Quelle ist die gespeicherte Auswahl
  for (const f of files('src').filter(f => /\.(js|jsx)$/.test(f) && !f.includes('/i18n/'))) {
    const s = read(f)
    assert.doesNotMatch(s, /navigator\.languages?\b/, `${f}: Browser-Sprache`)
    assert.doesNotMatch(s, /setLocale\(\s*['"]bn['"]/, `${f}: automatische Auswahl`)
  }
  assert.match(read('src/context/LocaleContext.jsx'), /useState\(\(\) => \{\n\s+const initial = readLocale\(\)/)
})

test('Keine fest eingebauten UI-Texte im JSX (würden in BN/EN deutsch bleiben)', () => {
  const ALLOWED_TEXT = new Set(['Café Buur', 'Safari', 'Chrome', 'Lightspeed K-Series', 'Lightspeed', 'IBAN', 'LÖSCHEN'])
  const found = []
  for (const f of files('src').filter(f => f.endsWith('.jsx'))) {
    const ast = parse(read(f), { sourceType: 'module', plugins: ['jsx'] })
    const walk = (n, inJsx = false) => {
      if (!n || typeof n.type !== 'string') return
      inJsx = inJsx || n.type === 'JSXExpressionContainer'   // Protokoll-Texte (logActivity summary) bleiben bewusst deutsch
      if (n.type === 'JSXText' && /[A-Za-zÄÖÜäöüß]{2,}/.test(n.value) && !ALLOWED_TEXT.has(n.value.trim())) found.push(`${f}:${n.loc.start.line} ${n.value.trim()}`)
      if (n.type === 'JSXAttribute' && n.value?.type === 'StringLiteral' && /^(hint|placeholder|title|aria-label|label|alt)$/.test(n.name.name) && /[a-zäöüß]{3,}/.test(n.value.value))
        found.push(`${f}:${n.loc.start.line} ${n.name.name}="${n.value.value}"`)
      if (inJsx && n.type === 'ConditionalExpression' && [n.consequent, n.alternate].some(x => x.type === 'StringLiteral' && /[a-zäöüß]{4,}/.test(x.value) && /[äöüß]|automatisch|manuell/.test(x.value)))
        found.push(`${f}:${n.loc.start.line} ternary`)
      for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(c => walk(c, inJsx)); else if (v && typeof v.type === 'string') walk(v, inJsx) }
    }
    walk(ast.program)
  }
  assert.deepEqual(found, [])
})

test('Übersetzungs-Parameter enthalten keine festen Wörter (z. B. früher „gleich“ im Dashboard)', () => {
  const OK = /^(long|short|narrow|2-digit|numeric|add|edit)$/   // Intl-Optionen / Vergleiche, kein angezeigter Text
  const found = []
  for (const f of files('src').filter(f => /\.(js|jsx)$/.test(f) && !f.includes('/i18n/'))) {
    const ast = parse(read(f), { sourceType: 'module', plugins: ['jsx'] })
    const lits = (n, acc) => {
      if (!n || typeof n.type !== 'string') return acc
      if (n.type === 'StringLiteral' && /[A-Za-zÄÖÜäöüß]{3,}/.test(n.value) && !OK.test(n.value)) acc.push(n)
      if (n.type === 'CallExpression' && ['tr', 't', 'appMessage', 'message', 'formatParam'].includes(n.callee.name)) return acc
      for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(c => lits(c, acc)); else if (v && typeof v.type === 'string') lits(v, acc) }
      return acc
    }
    const walk = n => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'CallExpression' && ['tr', 't', 'appMessage', 'message'].includes(n.callee.name) && n.arguments[1]?.type === 'ObjectExpression')
        for (const l of lits(n.arguments[1], [])) found.push(`${f}:${l.loc.start.line} ${l.value}`)
      for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v) }
    }
    walk(ast.program)
  }
  assert.deepEqual(found, [])
  assert.deepEqual([de['dashboard.soon'], en['dashboard.soon'], bn['dashboard.soon']], ['gleich', 'soon', 'শীঘ্রই'])
})

test('Rechtstexte: BN zeigt die englische Fassung mit Hinweis (keine ungeprüfte Übersetzung des Rechtstexts)', () => {
  for (const kind of ['privacy', 'imprint']) assert.deepEqual(legalContent(kind, 'bn'), legalContent(kind, 'en'))
  const page = read('src/pages/Legal.jsx')
  assert.match(page, /textLang !== locale && <p className="alert alert-info" lang=\{locale\}>\{t\('legal\.translationNotice'\)\}/)
  assert.match(page, /<div lang=\{textLang\}>/)
  assert.match(bn['legal.translationNotice'], /জার্মান/)
})

// ── Onboarding: eigene Telefonnummer + freiwilliger Notfallkontakt (echte Validierung) ──
const BASE = { first_name: 'Rafi', last_name: 'Test', birth_date: '1996-05-04', street: 'Testweg', house_number: '3', postal_code: '60311', city: 'Frankfurt',
  phone: '+880 1712-345678', iban: 'DE89 3704 0044 0532 0130 00', account_holder: 'Rafi Test', tax_id: '12345678901', social_security_number: '12345678A123',
  health_insurance: 'TK', other_employment: false, other_employment_note: '', emergency_contact_name: '', emergency_contact_phone: '' }

test('Notfallkontakt: komplett leer → gültig, Onboarding springt zur Übersicht; vollständig → gültig', () => {
  assert.ok(!REQUIRED_FIELDS.includes('emergency_contact_name') && !REQUIRED_FIELDS.includes('emergency_contact_phone'))
  assert.deepEqual(EMERGENCY_FIELDS, STEP_FIELDS.emerg)
  assert.deepEqual(validatePersonal(BASE, STEP_FIELDS.emerg), {})
  assert.equal(STEP_KEYS[resumeStep(BASE)], 'review', 'ohne Notfallkontakt vollständig')
  assert.deepEqual(validatePersonal({ ...BASE, emergency_contact_name: 'Nila (Mutter)', emergency_contact_phone: '+880 1811 000000' }, PERSONAL_FIELDS), {})
})

test('Notfallkontakt: halber Eintrag → Fehler am fehlenden Feld (DE/EN/BN), Fortsetzen bleibt beim Notfall-Schritt', () => {
  for (const [part, missing] of [[{ emergency_contact_name: 'Nur Name' }, 'emergency_contact_phone'], [{ emergency_contact_phone: '+49 170 1' }, 'emergency_contact_name']]) {
    const form = { ...BASE, ...part }
    const err = validatePersonal(form, STEP_FIELDS.emerg)
    assert.deepEqual(Object.keys(err), [missing])
    assert.equal(STEP_KEYS[resumeStep(form)], 'emerg')
    for (const [l, txt] of [['de', /beide Felder leer/], ['en', /leave both empty/], ['bn', /খালি রাখুন/]]) { setRuntimeLocale(l); assert.match(localizeMessage(err[missing]), txt) }
  }
  // Profil: nur das Namensfeld geändert → Paarprüfung greift trotzdem (Wert des anderen Felds zählt)
  assert.deepEqual(Object.keys(validatePersonal({ ...BASE, emergency_contact_name: 'X' }, ['emergency_contact_name'])), ['emergency_contact_phone'])
  setRuntimeLocale('de')
})

test('Eigene Telefonnummer: Pflicht, + und international erlaubt, max. 50 Zeichen, bleibt Text', () => {
  assert.ok(REQUIRED_FIELDS.includes('phone'))
  assert.deepEqual(Object.keys(validatePersonal({ ...BASE, phone: '  ' }, ['phone'])), ['phone'])
  for (const phone of ['+880 1712-345678', '0049 (69) 123 456', '+1 415 555 0100', '01701234567']) assert.deepEqual(validatePersonal({ ...BASE, phone }, ['phone']), {}, phone)
  assert.deepEqual(Object.keys(validatePersonal({ ...BASE, phone: '+' + '1'.repeat(PHONE_MAX) }, ['phone'])), ['phone'])
  assert.deepEqual(Object.keys(validatePersonal({ ...BASE, phone: 'abc' }, ['phone'])), ['phone'])
  const payload = toPayload({ ...BASE, phone: ' +880 1712-345678 ' })
  assert.equal(typeof payload.phone, 'string'); assert.match(payload.phone, /^\+880/)
  assert.equal(rowToForm({ phone: '+880 1712-345678' }).phone, '+880 1712-345678', 'Fortsetzen: Telefonnummer kommt unverändert zurück')
})

test('Onboarding-Formular: Telefonfeld tel/+ und getrennte Beschriftung; Notfallkontakt ohne Pflichtstern; Übersicht ohne „null, null“', () => {
  const s = read('src/pages/Onboarding.jsx')
  assert.match(s, /<Field label=\{tr\('onb\.ownPhone'\)\} required error=\{e\.phone\} hint=\{tr\('onb\.ownPhoneHint'\)\}>\n\s+<input type="tel" inputMode="tel" value=\{form\.phone\} onChange=\{ev => set\('phone', ev\.target\.value\)\} autoComplete="tel" maxLength=\{PHONE_MAX\}/)
  assert.match(s, /get title\(\) \{ return tr\('onb\.emergencyOptional'\) \}/)
  assert.match(s, /<Field label=\{tr\("ui\.f2fbb683da7e"\)\} error=\{e\.emergency_contact_name\}>/)
  assert.match(s, /<Field label=\{tr\('onb\.emergencyPhone'\)\} error=\{e\.emergency_contact_phone\}>/)
  assert.doesNotMatch(s, /required error=\{e\.emergency_contact/)
  assert.match(s, /form\.emergency_contact_name\?\.trim\(\) \? `\$\{form\.emergency_contact_name\}, \$\{form\.emergency_contact_phone\}` : tr\('onb\.emergencyNone'\)/)
  assert.equal(de['onb.ownPhone'], 'Telefonnummer'); assert.equal(en['onb.ownPhone'], 'Phone number'); assert.equal(bn['onb.ownPhone'], 'ফোন নম্বর')
  assert.equal(de['onb.emergencyOptional'], 'Notfallkontakt (optional)'); assert.equal(en['onb.emergencyOptional'], 'Emergency contact (optional)')
  assert.equal(bn['onb.emergencyOptional'], 'জরুরি যোগাযোগ (ঐচ্ছিক)')
})

test('Sprachwechsel verliert keine Eingaben: Provider ohne Remount, Formularzustand hängt nicht an der Sprache', () => {
  assert.doesNotMatch(read('src/main.jsx'), /key=\{locale\}/)
  const s = read('src/pages/Onboarding.jsx')
  assert.doesNotMatch(s, /key=\{[^}]*locale/)
  assert.doesNotMatch(s, /useEffect\([^)]*\[[^\]]*locale[^\]]*\]/, 'kein Neuladen der Daten beim Sprachwechsel')
})
