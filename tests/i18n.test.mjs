import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { de, en } from '../src/i18n/catalogs.js'
import { LOCALE_KEY, normalizeLocale, readLocale, writeLocale, localeFromStorageEvent, translate, createFormatters } from '../src/i18n/core.js'
import { setRuntimeLocale, t, localizeMessage, sourceLabel, message, messageParts, formatParam, messageError, errorMessage } from '../src/i18n/runtime.js'
import { parse } from '@babel/parser'
import { translateSupabaseError } from '../src/lib/errorHelper.js'
import { RateLimitError, SyncConflictError, toLightspeedUserMessage } from '../src/integrations/lightspeed/utils/errors.js'
import { privacySections } from '../src/i18n/privacy.js'
import * as format from '../src/i18n/format.js'
import * as vacation from '../src/lib/vacationLogic.js'
import * as sick from '../src/lib/sickLeaveLogic.js'
import * as personal from '../src/lib/personalData.js'

const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
const placeholders = s => [...s.matchAll(/\{([A-Za-z]\w*)\}/g)].map(m => m[1]).sort()
test('catalog parity, plural forms, nonempty translations and placeholders', () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort())
  for (const key of Object.keys(de)) {
    assert.equal(typeof de[key], typeof en[key], key)
    const variants = typeof de[key] === 'object' ? Object.keys(de[key]) : [null]
    if (variants[0] !== null) assert.deepEqual(Object.keys(de[key]), Object.keys(en[key]), key)
    for (const variant of variants) {
      const a = variant ? de[key][variant] : de[key], b = variant ? en[key][variant] : en[key]
      assert.equal(typeof b, 'string', key)
      // Some JSX fragments intentionally consist only of whitespace.
      assert.ok(b.length, key)
      assert.deepEqual(placeholders(a), placeholders(b), `${key}.${variant}`)
    }
  }
})
test('every literal translation key used in application code exists', () => {
  for (const f of files('src').filter(f => /\.(js|jsx)$/.test(f) && !f.includes('/i18n/'))) {
    const s = readFileSync(f, 'utf8')
    for (const m of s.matchAll(/\b(?:tr|t|appMessage|message)\(\s*['"]([^'"]+)['"]/g)) assert.ok(Object.hasOwn(de,m[1]), `${f}: ${m[1]}`)
  }
})
test('German default, persistence, storage denial and cross-tab/reset events', () => {
  assert.equal(normalizeLocale('fr'), 'de')
  assert.equal(readLocale({getItem: () => null}), 'de')
  const denied = {getItem(){throw Error('denied')},setItem(){throw Error('denied')}}
  assert.equal(readLocale(denied),'de'); assert.equal(writeLocale('en',denied),'en')
  const memory = new Map(), storage = {getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)}
  assert.equal(writeLocale('en',storage),'en'); assert.equal(readLocale(storage),'en')
  assert.equal(localeFromStorageEvent({key:LOCALE_KEY,newValue:'en'}),'en')
  assert.equal(localeFromStorageEvent({key:LOCALE_KEY,newValue:null}),'de')
  assert.equal(localeFromStorageEvent({key:null,newValue:null}),'de')
  assert.equal(localeFromStorageEvent({key:'unrelated',newValue:'en'}),undefined)
})
test('fallback, literal interpolation and singular/plural rendering', () => {
  assert.equal(translate('en','missing',{}, {de:{missing:'Fallback'},en:{}}),'Fallback')
  assert.equal(translate('en','unknown'),'unknown')
  assert.equal(translate('en','count.days',{count:1}),'1 day')
  assert.equal(translate('en','count.days',{count:2}),'2 days')
  assert.equal(translate('de','count.days',{count:1}),'1 Tag')
  assert.equal(translate('en','x',{name:'<script>$&</script>'},{de:{x:'Hello {name}'},en:{}}),'Hello <script>$&</script>')
})
test('existing toast and validation messages follow locale selection', () => {
  setRuntimeLocale('de'); const retained=message('vacation.requested',{count:2})
  setRuntimeLocale('en'); assert.equal(localizeMessage(retained),'✅ Leave requested for 2 days')
  assert.equal(localizeMessage('Die IBAN ist ungültig.'),'Die IBAN ist ungültig.')
  assert.equal(localizeMessage('❌ Die IBAN ist ungültig.'),'❌ Die IBAN ist ungültig.')
  assert.equal(localizeMessage('unknown backend detail'),'unknown backend detail')
  assert.equal(sourceLabel('Vorname'),'First name')
  setRuntimeLocale('de')
})
test('formatting uses the locale while keeping precision, EUR and date construction', () => {
  const d=new Date(2026,8,25,13,5)
  for(const locale of ['de','en']) {
    setRuntimeLocale(locale);const intl=locale==='de'?'de-DE':'en-GB', f=createFormatters(locale)
    assert.equal(f.number(1234.5),new Intl.NumberFormat(intl).format(1234.5))
    assert.equal(f.currency(1234.5),new Intl.NumberFormat(intl,{style:'currency',currency:'EUR'}).format(1234.5))
    assert.equal(f.time(d),new Intl.DateTimeFormat(intl,{hour:'2-digit',minute:'2-digit'}).format(d))
    assert.equal(format.formatDate('2026-09-25'),d.toLocaleDateString(intl,{day:'2-digit',month:'2-digit',year:'numeric'}))
    assert.equal(format.formatCurrency(null),'–')
  }
  setRuntimeLocale('de')
})
test('privacy notice has both complete language versions and no placeholders', () => {
  const a=privacySections('de'),b=privacySections('en')
  assert.equal(a.length,8);assert.equal(a.length,b.length)
  for(let i=0;i<a.length;i++) {assert.notEqual(a[i].title,b[i].title);assert.notEqual(a[i].text,b[i].text);assert.doesNotMatch(b[i].text,/\{p\d+\}/)}
})
test('public/auth routes share one provider and switcher without locale remount keys', () => {
  const main=readFileSync('src/main.jsx','utf8'), context=readFileSync('src/context/LocaleContext.jsx','utf8'), switcher=readFileSync('src/components/UI/LanguageSwitcher.jsx','utf8')
  assert.match(main,/<LocaleProvider>[\s\S]*<LanguageSwitcher \/>[\s\S]*<App \/>[\s\S]*<\/LocaleProvider>/)
  assert.match(context,/document\.documentElement\.lang = locale/)
  assert.match(context,/removeEventListener\('storage', synchronize\)/)
  // Labelled radio group: one checked option per locale, selection only via setLocale.
  assert.match(switcher,/role="radiogroup" aria-labelledby=\{id\}/);assert.match(switcher,/role="radio"/);assert.match(switcher,/aria-checked=\{active\}/);assert.match(switcher,/setLocale\(/)
  assert.doesNotMatch(main,/key=\{locale\}/)
})
// Load only these pure, dependency-free baseline modules from the workspace archive.
async function baseline(file) {
  const code=execFileSync('python3',['-c','import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(".i18n-work/baseline.zip").read(sys.argv[1]))',file])
  return import('data:text/javascript;base64,'+code.toString('base64'))
}
test('leave calculations and validation outcomes match the interrupted task baseline in both languages', async () => {
  const original=await baseline('src/lib/vacationLogic.js')
  for(const locale of ['de','en']) {
    setRuntimeLocale(locale)
    for(const [start,end,holidays] of [['2026-09-21','2026-09-27',[]],['2026-09-21','2026-09-25',[{date:'2026-09-23'}]],['2026-09-26','2026-09-27',[]]]) {
      assert.equal(vacation.calculateRequestedDays(start,end,holidays),original.calculateRequestedDays(start,end,holidays))
    }
    for(const requested of [0,1,5,6])assert.equal(vacation.canRequestVacation(requested,{remaining:5}).ok,original.canRequestVacation(requested,{remaining:5}).ok)
    const approved=[{start_date:'2026-09-21',end_date:'2026-09-25',status:'approved'}]
    const a=vacation.checkSickDuringVacation('2026-09-23','2026-09-25',approved),b=original.checkSickDuringVacation('2026-09-23','2026-09-25',approved)
    assert.deepEqual({...a,message:null},{...b,message:null})
  }
  setRuntimeLocale('de')
})
test('sickness grouping and personal-data checks retain baseline business behavior', async () => {
  const os=await baseline('src/lib/sickLeaveLogic.js'),op=await baseline('src/lib/personalData.js')
  const leaves=[{id:'test-a',employee_id:'test-person',start_date:'2026-09-01',end_date:'2026-09-03'},{id:'test-b',employee_id:'test-person',start_date:'2026-09-04',end_date:'2026-09-05'}]
  for(const locale of ['de','en']) {
    setRuntimeLocale(locale)
    assert.deepEqual(sick.groupSickLeavesIntoCases(leaves),os.groupSickLeavesIntoCases(leaves))
    for(const iban of ['', 'DE89370400440532013000','DE89370400440532013001']) assert.equal(personal.isValidIBAN(iban),op.isValidIBAN(iban))
    assert.deepEqual(personal.REQUIRED_FIELDS,op.REQUIRED_FIELDS)
    assert.equal(personal.FIELD_LABELS.first_name,locale==='de'?'Vorname':'First name')
  }
  setRuntimeLocale('de')
})

// Exercise the production message expressions, including their actual parameters,
// without mounting the app or importing modules that initialize backend clients.
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (node.type) visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'extra') continue
    if (Array.isArray(value)) value.forEach(child => walk(child, visit))
    else if (value && typeof value === 'object') walk(value, visit)
  }
}
function productionMessage(file, key, parameters = {}) {
  const source = readFileSync(file, 'utf8')
  let expression
  walk(parse(source, { sourceType: 'module', plugins: ['jsx'] }), node => {
    if (node.type === 'CallExpression' && node.callee.name === 'appMessage' && node.arguments[0]?.value === key) expression = source.slice(node.start, node.end)
  })
  assert.ok(expression, `${file}: ${key}`)
  const scope = { appMessage: message, messageParts, formatParam, errorMessage, ...parameters }
  return Function(...Object.keys(scope), `return (${expression})`)(...Object.values(scope))
}

test('retained nested leave and clock-out messages switch DE → EN → DE', () => {
  setRuntimeLocale('de')
  const conflict = vacation.checkSickDuringVacation('2026-09-24', '2026-09-25', [{ start_date:'2026-09-21', end_date:'2026-09-25', status:'approved' }])
  const retained = productionMessage('src/pages/Vacation.jsx', 'ui.92603e36a8c0', { conflict })
  const clockOut = productionMessage('src/pages/ClockIn.jsx', 'ui.974c5412d6ec', { netH:1234.5, breakMin:30 })
  for (const locale of ['de', 'en', 'de']) {
    setRuntimeLocale(locale)
    assert.equal(localizeMessage(retained), translate(locale, 'ui.92603e36a8c0', { p1:translate(locale, 'vacation.returned', { count:2 }) }))
    assert.equal(localizeMessage(clockOut), translate(locale, 'ui.974c5412d6ec', {
      p1:createFormatters(locale).number(1234.5, { minimumFractionDigits:2, maximumFractionDigits:2 }),
      p2:translate(locale, 'ui.b90bda0a43ef', { p1:30 }),
    }))
  }
})

test('retained payroll months, document names and numeric formats use the new locale', () => {
  setRuntimeLocale('de')
  const payroll = productionMessage('src/pages/Payroll.jsx', 'ui.644f27781f6a', { year:2026, month:3 })
  const doc = productionMessage('src/pages/PayrollDocuments.jsx', 'ui.2137fc6a781d', {
    emp:{first_name:'Vorname',last_name:'März'}, selMonth:3, selYear:2026,
  })
  const rate = productionMessage('src/pages/Employees.jsx', 'ui.e464f6564209', { rate:1234.5, MINDESTLOHN:13.9 })
  for (const locale of ['de', 'en', 'de']) {
    setRuntimeLocale(locale)
    const f = createFormatters(locale)
    assert.equal(localizeMessage(payroll), translate(locale, 'ui.644f27781f6a', {p1:f.date(new Date(2026,2),{month:'long',year:'numeric'})}))
    assert.equal(localizeMessage(doc), translate(locale, 'ui.2137fc6a781d', {p1:'Vorname',p2:'März',p3:f.date(new Date(2000,2),{month:'long'}),p4:2026}))
    assert.equal(localizeMessage(rate), translate(locale, 'ui.e464f6564209', {p1:f.number(1234.5,{minimumFractionDigits:2,maximumFractionDigits:2}),p2:13.9}))
  }
})

test('retained joined fragments, field labels and error contexts switch together', () => {
  setRuntimeLocale('de')
  const parts = [message('count.entries',{count:3}), message('count.files',{count:1})]
  const purge = productionMessage('src/components/RetentionCard.jsx', 'ui.8663a5d4e1e0', {parts,files:[1,2],removed:[1]})
  const errors = personal.validatePersonal({first_name:''}, ['first_name'])
  const field = messageParts([personal.FIELD_MESSAGES.first_name, ': ', errors.first_name])
  const denied = translateSupabaseError({code:'42501',message:'permission denied for table "employees"'})
  const backend = 'Die IBAN ist ungültig.'
  const contextual = translateSupabaseError({message:backend}, message('ui.0038a9cf8661'))
  for (const locale of ['de','en','de']) {
    setRuntimeLocale(locale)
    assert.equal(localizeMessage(purge), translate(locale,'ui.8663a5d4e1e0', {p1:` (${translate(locale,'count.entries',{count:3})}, ${translate(locale,'count.files',{count:1})})`,p2:1}))
    assert.equal(localizeMessage(field), `${translate(locale,'ui.d2d77b6ffa70')}: ${translate(locale,'ui.f5fd476de96f')}`)
    assert.equal(localizeMessage(denied), translate(locale,'ui.cc827c4f5474',{p1:translate(locale,'ui.f4cb6891b9e5')}))
    assert.equal(localizeMessage(contextual), translate(locale,'ui.af0e9bbf0113',{p1:translate(locale,'ui.0038a9cf8661'),p2:backend}))
  }
})

test('more than 2,000 generated messages cannot evict or overwrite provenance', () => {
  setRuntimeLocale('de')
  const retained = Array.from({length:2505}, (_, count) => message('vacation.requested',{count}))
  const nested = message('ui.92603e36a8c0',{p1:message('vacation.returned',{count:2})})
  for (let count=0;count<3000;count++) t('vacation.requested',{count})
  for (const locale of ['en','de']) {
    setRuntimeLocale(locale)
    retained.forEach((value,count) => assert.equal(localizeMessage(value),translate(locale,'vacation.requested',{count})))
    assert.equal(localizeMessage(nested),translate(locale,'ui.92603e36a8c0',{p1:translate(locale,'vacation.returned',{count:2})}))
  }
  assert.doesNotMatch(readFileSync('src/i18n/runtime.js','utf8'), /generatedMessages|new (?:Map|WeakMap)\(/)
})

test('free text is literal even when identical to an app translation or generated message', () => {
  setRuntimeLocale('de')
  const translated = message('vacation.returned',{count:2})
  const literal = localizeMessage(translated)
  const nestedLiteral = message('ui.92603e36a8c0',{p1:literal})
  const nestedTranslated = message('ui.92603e36a8c0',{p1:translated})
  const freeTexts = ['Vorname','Die IBAN ist ungültig.','❌ Die IBAN ist ungültig.','März','1.234,50',literal,'<script>$&{count}</script>','hat einen DATEV-Export für März 2026 erstellt.']
  for (const locale of ['de','en','de']) {
    setRuntimeLocale(locale)
    for (const value of freeTexts) {
      assert.equal(localizeMessage(value),value)
      assert.equal(localizeMessage(message('ui.92603e36a8c0',{p1:value})),translate(locale,'ui.92603e36a8c0',{p1:value}))
      assert.equal(localizeMessage(translateSupabaseError({code:'P0001',message:value})),`❌ ${value}`)
    }
    assert.equal(localizeMessage(nestedLiteral),translate(locale,'ui.92603e36a8c0',{p1:literal}))
    if (locale==='en') assert.notEqual(localizeMessage(nestedLiteral),localizeMessage(nestedTranslated))
  }
})

test('format descriptors snapshot raw dates, values and options; error carriers retain descriptors', () => {
  setRuntimeLocale('de')
  const date = new Date(2026,2,5), options = {month:'long'}, values = {count:2}
  const month = formatParam('date',date,options)
  const retained = message('vacation.returned',values)
  const failure = messageError(messageParts([month, ': ', retained]))
  const rate = new RateLimitError(42), conflict = new SyncConflictError('Vorname')
  date.setMonth(9); options.month='numeric'; values.count=999
  for (const locale of ['de','en','de']) {
    setRuntimeLocale(locale)
    assert.equal(localizeMessage(errorMessage(failure)),`${createFormatters(locale).date(new Date(2026,2,5),{month:'long'})}: ${translate(locale,'vacation.returned',{count:2})}`)
    assert.equal(localizeMessage(toLightspeedUserMessage(rate)),translate(locale,'ui.e211fd758eb5',{p1:42}))
    assert.equal(localizeMessage(toLightspeedUserMessage(conflict)),translate(locale,'ui.dbf8631425e1',{p1:'Vorname'}))
  }
})

test('stored UI message sites cannot regress to immediate translated strings', () => {
  for (const file of files('src').filter(f => /\.(js|jsx)$/.test(f) && !f.includes('/i18n/'))) {
    const source = readFileSync(file,'utf8')
    walk(parse(source,{sourceType:'module',plugins:['jsx']}), node => {
      if (node.type !== 'CallExpression') return
      const c=node.callee
      // Toasts, state setters and collected warning lists are retained after render.
      const sink = c.type==='MemberExpression' && (c.object.name==='toast' || c.property.name==='push') || /^set(?!Timeout$|Interval$)[A-Z]/.test(c.name || '')
      if (!sink || !node.arguments[0]) return
      walk(node.arguments[0], child => {
        if (child.type==='CallExpression') assert.notEqual(child.callee.name,'tr',`${file}:${child.loc.start.line}: retain a descriptor`)
      })
    })
  }
})
