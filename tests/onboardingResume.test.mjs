// Onboarding fortsetzbar + idempotent (Frontend zu Migration 28): Schritt aus Serverdaten, Revision bei jedem Speichern,
// Konflikt → Serverstand laden, Zeitlimit + Entscheidung am Serverstand bei fehlender Antwort, Doppelklick, Einladung.
// DB-Seite: tests/db/onboarding_resume.test.mjs. Manuell im Browser geprüft (siehe Bericht).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  STEP_KEYS, STEP_FIELDS, REVIEW_STEP, rowToForm, resumeStep, canOpenStep, matchesPayload, classifyAfterNoAnswer,
  saveOnboarding, loadOnboarding, classifySignup, mergeUnsaved,
} from '../src/lib/onboardingFlow.js'
import { toPayload, validatePersonal, PERSONAL_FIELDS } from '../src/lib/personalData.js'
import { boundedRequest } from '../src/lib/boundedRequest.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
const ONB = read('src/pages/Onboarding.jsx')
const INV = read('src/pages/InvitationAccept.jsx')
const APP = read('src/App.jsx')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// So liefert der Server eine vollständige Zeile (IBAN/SV ohne Leerzeichen, Datum als Text, Beschreibung nur bei „ja“)
const FULL = { first_name: 'Ada', last_name: 'Test', birth_name: null, birth_date: '1995-04-01', birth_place: null, nationality: null,
  street: 'Testweg', house_number: '1', postal_code: '60311', city: 'Frankfurt', phone: '+49 69 1234',
  iban: 'DE89370400440532013000', account_holder: 'Ada Test', tax_id: '12345678901', social_security_number: '12345678A123',
  health_insurance: 'TK', other_employment: false, other_employment_note: null, emergency_contact_name: 'Bo', emergency_contact_phone: '+49 170 1',
  status: 'draft', revision: 7 }
const only = keys => Object.fromEntries(Object.entries(FULL).filter(([k]) => keys.includes(k) || !PERSONAL_FIELDS.includes(k)))

test('Fortsetzen: Schritt kommt aus den gespeicherten Angaben (erster unvollständiger), nie aus Client-Zustand', () => {
  assert.deepEqual(STEP_KEYS, ['person', 'contact', 'bank', 'payroll', 'emerg', 'review'])
  assert.equal(resumeStep(rowToForm(null)), 0, 'neu')
  assert.equal(resumeStep(rowToForm(only(STEP_FIELDS.person))), 1, 'Schritt 1 gespeichert → Schritt 2')
  assert.equal(resumeStep(rowToForm(only([...STEP_FIELDS.person, ...STEP_FIELDS.contact]))), 2)
  assert.equal(resumeStep(rowToForm({ ...FULL, iban: 'DE89370400440532013001' })), 2, 'ungültige IBAN → Bank-Schritt')
  assert.equal(resumeStep(rowToForm({ ...FULL, other_employment: true, other_employment_note: null })), 3, 'Nebenbeschäftigung ohne Beschreibung')
  assert.equal(resumeStep(rowToForm({ ...FULL, other_employment: null })), 3)
  assert.equal(resumeStep(rowToForm({ ...FULL, emergency_contact_phone: null })), 4)
  assert.equal(resumeStep(rowToForm(FULL)), REVIEW_STEP, 'alles vollständig → Übersicht')
  assert.equal(resumeStep(rowToForm({ ...FULL, first_name: null })), 0, 'Lücke vorne gewinnt, auch wenn später alles da ist')
  // Kein Überspringen: nur Schritte bis zum ersten unvollständigen sind erreichbar
  const half = rowToForm(only(STEP_FIELDS.person))
  assert.deepEqual([0, 1, 2, 5].map(i => canOpenStep(half, i)), [true, true, false, false])
  assert.equal(rowToForm(FULL).iban, 'DE89 3704 0044 0532 0130 00', 'Anzeigeformat')
})

test('„Steht genau das gespeichert?“: Vergleich wie die Server-Normalisierung', () => {
  const payload = toPayload(rowToForm(FULL))
  assert.equal(matchesPayload(FULL, payload), true)
  assert.equal(matchesPayload(FULL, { ...payload, iban: 'de89 3704 0044 0532 0130 00' }), true, 'Leerzeichen/Groß-Klein wie Server')
  assert.equal(matchesPayload(FULL, { ...payload, city: 'Köln' }), false)
  assert.equal(matchesPayload(FULL, { ...payload, other_employment_note: 'alt' }), true, 'Beschreibung zählt nur bei „ja“')
  assert.equal(matchesPayload({ ...FULL, other_employment: true, other_employment_note: 'Minijob' }, { ...payload, other_employment: true, other_employment_note: 'Minijob' }), true)
})

test('Konflikt: eigene Eingaben des Schritts bleiben, wo das andere Gerät nichts geändert hat (Drei-Wege-Vergleich)', () => {
  const base = toPayload(rowToForm(FULL))
  const server = rowToForm({ ...FULL, phone: '+49 69 999', city: 'Köln' })        // anderes Gerät: Telefon + Ort
  const mine = { ...rowToForm(FULL), street: 'Neuer Weg', city: 'Mainz' }          // ich: Straße + Ort (ungespeichert)
  const m = mergeUnsaved(server, mine, base, STEP_FIELDS.contact)
  assert.deepEqual([m.street, m.city, m.phone], ['Neuer Weg', 'Köln', '+49 69 999'], 'Straße bleibt, Ort beidseitig geändert → Server, Telefon vom anderen Gerät')
  assert.equal(mergeUnsaved(server, { ...mine, iban: 'DE00' }, base, STEP_FIELDS.contact).iban, server.iban, 'nur Felder des aktuellen Schritts')
})

test('Keine Antwort erhalten → Entscheidung am Serverstand (nie raten)', () => {
  const p = toPayload(rowToForm(FULL))
  assert.deepEqual(classifyAfterNoAnswer(FULL, p, 6, false), { kind: 'saved', status: 'draft', revision: 7, recovered: true }, 'gespeichert, Antwort verloren')
  assert.deepEqual(classifyAfterNoAnswer(FULL, { ...p, city: 'Köln' }, 7, false), { kind: 'notSaved', revision: 7 }, 'Server unverändert')
  assert.deepEqual(classifyAfterNoAnswer(FULL, { ...p, city: 'Köln' }, 6, false), { kind: 'conflict', revision: 7 }, 'anderes Gerät hat gespeichert')
  assert.deepEqual(classifyAfterNoAnswer({ ...FULL, status: 'submitted' }, p, 6, true).kind, 'saved', 'Einreichung angekommen')
  assert.deepEqual(classifyAfterNoAnswer(FULL, p, 6, true), { kind: 'notSaved', revision: 7 }, 'gespeichert, aber nicht eingereicht → erneut')
  assert.equal(classifyAfterNoAnswer({ ...FULL, status: 'approved' }, p, 6, false).kind, 'locked')
  assert.equal(classifyAfterNoAnswer(null, p, 6, false).kind, 'unknown')
  const old = { ...FULL }; delete old.revision   // Server ohne Migration 28
  assert.equal(classifyAfterNoAnswer(old, { ...p, city: 'Köln' }, undefined, false).kind, 'notSaved')
})

// Skriptbare Supabase: rpc/select liefern Werte, verzögern oder hängen; Aufrufe werden protokolliert
function fakeSupabase(script) {
  const log = []
  const answer = (key, plan) => {
    const b = { abortSignal: s => ((b.signal = s), b), select: () => b, eq: () => b, maybeSingle: () => b,
      then: (res, rej) => (async () => {
        const p = typeof plan === 'function' ? plan() : plan
        if (p?.hang) await new Promise((_, reject) => b.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
        if (p?.delay) await sleep(p.delay)
        return p?.result ?? { data: null, error: null, status: 200 }
      })().then(res, rej) }
    return b
  }
  return {
    log,
    rpc: (name, args) => { log.push(['rpc', name, args]); return answer(`rpc:${name}`, script.rpc?.shift?.() ?? script.rpc) },
    from: t => { log.push(['from', t]); return answer(t, script.select?.shift?.() ?? script.select) },
  }
}
const ok = data => ({ result: { data, error: null, status: 200 } })

test('saveOnboarding: Revision mitsenden (nur wenn bekannt), Antworten eindeutig einordnen', async () => {
  const p = toPayload(rowToForm(FULL))
  const cases = [
    [ok({ success: true, status: 'draft', revision: 8 }), { kind: 'saved', status: 'draft', revision: 8 }],
    [ok({ success: true, status: 'submitted', already: true, revision: 9 }), { kind: 'already', status: 'submitted', revision: 9 }],
    [ok({ success: false, conflict: true, revision: 9, status: 'draft', error: 'x' }), { kind: 'conflict', revision: 9 }],
    [ok({ success: false, field: 'iban', error: 'Die IBAN ist ungültig.', revision: 8, status: 'draft' }), { kind: 'invalid', field: 'iban', message: 'Die IBAN ist ungültig.', revision: 8 }],
    [ok({ success: false, status: 'submitted', error: 'bereits eingereicht' }), { kind: 'locked', status: 'submitted', message: 'bereits eingereicht' }],
    [{ result: { data: null, error: { message: 'permission denied', code: '42501' }, status: 403 } }, { kind: 'error', error: { message: 'permission denied', code: '42501' } }],
  ]
  for (const [plan, want] of cases) {
    const sb = fakeSupabase({ rpc: plan })
    assert.deepEqual(await saveOnboarding(sb, { uid: 'u', payload: p, revision: 7 }), want)
    assert.deepEqual(sb.log[0], ['rpc', 'save_onboarding', { p_data: p, p_submit: false, p_expected_revision: 7 }])
  }
  const legacy = fakeSupabase({ rpc: ok({ success: true, status: 'draft' }) })
  await saveOnboarding(legacy, { uid: 'u', payload: p, revision: undefined })
  assert.deepEqual(Object.keys(legacy.log[0][2]), ['p_data', 'p_submit'], 'Server ohne Migration 28: Aufruf wie bisher')
})

test('saveOnboarding ohne Antwort: endet nach dem Zeitlimit und prüft den Serverstand', async () => {
  const p = toPayload(rowToForm(FULL))
  const saved = fakeSupabase({ rpc: { hang: true }, select: ok(FULL) })
  const t0 = Date.now()
  assert.deepEqual((await saveOnboarding(saved, { uid: 'u', payload: p, revision: 6, ms: 40 })).kind, 'saved', 'gespeichert, Antwort verloren → Erfolg')
  assert.ok(Date.now() - t0 < 1000, 'endet (kein endloses „Speichert…“)')
  assert.deepEqual(saved.log.map(l => l[1]), ['save_onboarding', 'employee_onboarding'])
  const nothing = await saveOnboarding(fakeSupabase({ rpc: { hang: true }, select: ok({ ...FULL, city: 'Alt' }) }), { uid: 'u', payload: p, revision: 7, ms: 40 })
  assert.deepEqual([nothing.kind, nothing.revision], ['notSaved', 7])
  assert.equal((await saveOnboarding(fakeSupabase({ rpc: { hang: true }, select: ok({ ...FULL, city: 'Alt', revision: 8 }) }), { uid: 'u', payload: p, revision: 7, ms: 40 })).kind, 'conflict')
  // Auch die Nachprüfung hängt → „unklar“, nie Erfolg
  const r = await boundedRequest(() => saveOnboarding(fakeSupabase({ rpc: { hang: true }, select: { hang: true } }), { uid: 'u', payload: p, revision: 7, ms: 40, readMs: 40 }), { ms: 5000 })
  assert.equal(r.kind, 'unknown')
  // loadOnboarding: Zeitlimit greift
  const l = await loadOnboarding(fakeSupabase({ select: { hang: true } }), 'u', 30)
  assert.deepEqual(l, { ok: false, noAnswer: true })
})

test('Registrierung einordnen: Session, Bestätigung, vorhanden, abgelehnt (Migration 28), keine Antwort', () => {
  assert.equal(classifySignup({ data: { user: { identities: [{}] }, session: { access_token: 'x' } }, error: null }), 'session')
  assert.equal(classifySignup({ data: { user: { identities: [{}] }, session: null }, error: null }), 'confirm')
  assert.equal(classifySignup({ data: { user: { identities: [] }, session: null }, error: null }), 'exists')
  assert.equal(classifySignup({ data: null, error: { message: 'User already registered' } }), 'exists')
  assert.equal(classifySignup({ data: null, error: { message: 'Database error saving new user', status: 500 } }), 'rejected')
  assert.equal(classifySignup({ data: null, error: { message: 'Password should be at least 8 characters' } }), 'password')
  assert.equal(classifySignup({ data: null, error: { message: 'For security purposes, you can only request this after 30 seconds' } }), 'rate')
  assert.equal(classifySignup({ data: null, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } }), 'noAnswer')
  assert.equal(classifySignup({ data: null, error: { message: 'AbortError' }, status: 0, timedOut: true }), 'noAnswer')
})

// ── Echte Handler aus Onboarding.jsx (next/back/submit/applyOutcome) mit simuliertem Zustand ──
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return src.slice(src.lastIndexOf('\n', start) + 1, i).trim()
}
function mountOnboarding({ row = FULL, rpc, select, step, ack = { ok: true }, serverOnLoad }) {
  const st = { step: step ?? resumeStep(rowToForm(row)), errors: {}, saving: [], toasts: [], loads: [], acks: 0 }
  const sb = fakeSupabase({ rpc, select })
  const STEPS = STEP_KEYS.map(k => ({ key: k, fields: STEP_FIELDS[k] }))
  const env = {
    supabase: sb, uid: 'u', form: rowToForm(row), privacy: true, busy: { current: false }, revision: { current: row.revision },
    savedPayload: { current: JSON.stringify(toPayload(rowToForm(row))) }, STEPS, REVIEW_STEP, ONB_TIMEOUT: { write: 60 },
    validatePersonal, toPayload, saveOnboarding: (s, o) => saveOnboarding(s, { ...o, ms: 60, readMs: 60 }), boundedRequest, resumeStep,
    acknowledgePrivacyNotice: async () => { st.acks++; return ack },
    toast: Object.fromEntries(['success', 'error', 'warn', 'info'].map(k => [k, m => st.toasts.push([k, m?.key ?? m])])),
    appMessage: key => ({ key }), translateSupabaseError: e => e?.message, FIELD_MESSAGES: {},
    setSaving: v => st.saving.push(v), setErrors: v => { st.errors = typeof v === 'function' ? v(st.errors) : v },
    setStep: v => { st.step = typeof v === 'function' ? v(st.step) : v }, scrollTop: () => {},
    load: async n => { st.loads.push(n ?? null); if (serverOnLoad) st.form = rowToForm(serverOnLoad) }, canOpenStep, mergeUnsaved,
    setForm: v => { st.form = typeof v === 'function' ? v(st.form) : v }, setNotice: v => { st.notice = v },
  }
  env.at = Math.min(st.step, resumeStep(env.form))
  const make = name => new Function(...Object.keys(env), `return (${extractFn(ONB, name)})`)(...Object.values(env))
  env.applyOutcome = make('applyOutcome')
  const fns = { next: make('next'), back: make('back'), submit: make('submit'), goTo: make('goTo') }
  return { st, sb, env, ...fns }
}

test('Weiter: speichert mit Revision und geht erst nach Serverbestätigung weiter; Doppelklick = eine Anfrage', async () => {
  const m = mountOnboarding({ row: { ...FULL, emergency_contact_name: null }, rpc: { delay: 20, result: { data: { success: true, status: 'draft', revision: 8 }, error: null, status: 200 } } })
  assert.equal(m.st.step, 4)
  await Promise.all([m.next(), m.next(), m.next()])
  assert.equal(m.sb.log.filter(l => l[1] === 'save_onboarding').length, 0, 'Pflichtfeld fehlt → gar nicht gesendet')
  assert.ok(m.st.errors.emergency_contact_name)
  const m2 = mountOnboarding({ row: FULL, step: 4, rpc: { delay: 20, result: { data: { success: true, status: 'draft', revision: 8 }, error: null, status: 200 } } })
  await Promise.all([m2.next(), m2.next(), m2.next()])
  assert.equal(m2.sb.log.filter(l => l[1] === 'save_onboarding').length, 1, 'Doppelklick → genau ein Speichern')
  assert.equal(m2.sb.log[0][2].p_expected_revision, 7)
  assert.deepEqual([m2.st.step, m2.env.revision.current, m2.st.saving], [5, 8, [true, false]])
})

test('Konflikt (anderes Fenster/Gerät): kein Weitergehen, Serverstand wird mit Hinweis neu geladen', async () => {
  const m = mountOnboarding({ row: FULL, step: 2, rpc: ok({ success: false, conflict: true, revision: 9, status: 'draft', error: 'x' }),
    serverOnLoad: { ...FULL, account_holder: 'Ada T.', phone: '+49 69 999', revision: 9 } })
  m.env.form.iban = 'GB82 WEST 1234 5698 7654 32'   // eigene Eingabe in diesem Schritt
  await m.next()
  assert.deepEqual(m.st.loads, [{ kind: 'conflict' }])
  assert.deepEqual([m.st.form.iban, m.st.form.account_holder, m.st.form.phone], ['GB82 WEST 1234 5698 7654 32', 'Ada T.', '+49 69 999'], 'eigene IBAN bleibt, Serveränderungen sichtbar')
  assert.equal(m.st.step, 2, 'bleibt stehen (load setzt den Schritt aus dem Serverstand)')
  assert.deepEqual(m.st.saving, [true, false])
})

test('Keine Antwort beim Weiter: Laden endet, gespeichert erkannt → weiter; nicht gespeichert → Meldung, bleibt stehen', async () => {
  const lost = mountOnboarding({ row: FULL, step: 1, rpc: { hang: true }, select: ok({ ...FULL, revision: 8 }) })
  await lost.next()
  assert.deepEqual([lost.st.step, lost.env.revision.current, lost.st.toasts], [2, 8, []], 'Teil-Erfolg ist Erfolg')
  const n2 = mountOnboarding({ row: FULL, step: 1, rpc: { hang: true }, select: ok({ ...FULL, city: 'Server' }) })
  await n2.next()
  assert.deepEqual([n2.st.step, n2.st.toasts], [1, [['error', 'onb.noAnswer']]])
  assert.deepEqual(n2.st.saving, [true, false])
})

test('Einreichen: Kenntnisnahme vorher, „bereits eingereicht“ ist Erfolg, Serverfehler am richtigen Feld ([f]-Fehler behoben)', async () => {
  const done = mountOnboarding({ row: FULL, rpc: ok({ success: true, status: 'submitted', revision: 9 }) })
  await Promise.all([done.submit(), done.submit()])
  assert.equal(done.st.acks, 1); assert.equal(done.sb.log.length, 1, 'Doppelklick → eine Einreichung')
  assert.deepEqual(done.sb.log[0][2].p_data.privacy_accepted, true)
  assert.deepEqual([done.sb.log[0][2].p_submit, done.st.toasts, done.st.loads], [true, [['success', 'ui.6c8dd191bd56']], [null]])
  const again = mountOnboarding({ row: FULL, rpc: ok({ success: true, already: true, status: 'submitted', revision: 9 }) })
  await again.submit()
  assert.deepEqual(again.st.toasts, [['success', 'onb.alreadySubmitted']], 'verlorene erste Antwort → kein Fehler')
  const bad = mountOnboarding({ row: FULL, rpc: ok({ success: false, field: 'iban', error: 'Die IBAN ist ungültig.', revision: 8, status: 'draft' }) })
  await bad.submit()
  assert.deepEqual([bad.st.errors, bad.st.step, bad.env.revision.current], [{ iban: 'Die IBAN ist ungültig.' }, 2, 8])
  const noAck = mountOnboarding({ row: FULL, ack: { ok: false } })
  await noAck.submit()
  assert.deepEqual([noAck.sb.log.length, noAck.st.toasts], [0, [['error', 'privacyAck.error']]], 'ohne Kenntnisnahme kein Absenden')
  const lost = mountOnboarding({ row: FULL, rpc: { hang: true }, select: ok({ ...FULL, status: 'submitted', revision: 9 }) })
  await lost.submit()
  assert.deepEqual(lost.st.toasts, [['success', 'ui.6c8dd191bd56']], 'eingereicht, Antwort verloren → Erfolg')
})

test('Zurück speichert ungespeicherte Eingaben; Übersicht springt nur zu erreichbaren Schritten', async () => {
  const m = mountOnboarding({ row: FULL, step: 3, rpc: ok({ success: true, status: 'draft', revision: 8 }) })
  m.env.form.health_insurance = 'AOK'
  await m.back()
  assert.equal(m.sb.log.length, 1); assert.equal(m.sb.log[0][2].p_data.health_insurance, 'AOK')
  assert.deepEqual([m.st.step, m.env.revision.current], [2, 8])
  const clean = mountOnboarding({ row: FULL, step: 3 })
  await clean.back()
  assert.equal(clean.sb.log.length, 0, 'nichts geändert → keine Anfrage')
  const half = mountOnboarding({ row: only(STEP_FIELDS.person), step: 1 })
  half.goTo(4); assert.equal(half.st.step, 1, 'nicht nach vorn springen')
  half.goTo(0); assert.deepEqual([half.st.step, half.st.notice], [0, null], 'Hinweis „Willkommen zurück“ verschwindet beim Navigieren')
})

test('Verdrahtung: Server als Quelle, kein Überspringen, Warnung beim Schließen, Auto-Logout-Warnung im Onboarding', () => {
  assert.doesNotMatch(ONB, /setErrors\(\{ f:/, '[f]-Fehler behoben')
  assert.match(ONB, /setErrors\(\{ \[f\]: o\.message \}\)/)
  assert.match(ONB, /const at = Math\.min\(step, resumeStep\(form\)\)/)
  assert.match(ONB, /const cur = STEPS\[at\]/)
  assert.match(ONB, /window\.addEventListener\('beforeunload', warn\)/)
  assert.match(ONB, /if \(seq !== loadSeq\.current\) return/)
  assert.doesNotMatch(ONB, /localStorage\.setItem|sessionStorage\.setItem/, 'keine Personaldaten im Browser-Speicher')
  assert.doesNotMatch(ONB, /supabase\.(rpc|from)\(/, 'Serverzugriffe nur über onboardingFlow (mit Zeitlimit)')
  // Einladung: vor dem Anlegen erneut prüfen, Teil-Erfolg am Einladungsstatus entscheiden, kein Zurück auf den Link
  const h = extractFn(INV, 'handleAccept')
  assert.ok(h.indexOf('const pre = await fetchInfo()') < h.indexOf('supabase.auth.signUp('), 'erst prüfen, dann anlegen')
  assert.match(h, /if \(post\.data\.reason === 'used'\) \{ setStep\('confirm'\); return \}/)
  assert.match(h, /window\.location\.replace\('\/'\)/)
  assert.match(h, /if \(busy\.current\) return/)
  assert.match(INV, /reason === 'offline'\s*\n\s*\? <button type="button" onClick=\{validateToken\}/)
  // Auto-Logout-Warnung: App und Onboarding
  assert.equal((APP.match(/\{showWarning && <AutoLogoutWarning /g) || []).length, 2)
  const pendingBranch = APP.slice(APP.indexOf("if (profile?.status === 'pending') return ("), APP.indexOf('// Kein Profil = Konto wurde gelöscht'))
  assert.match(pendingBranch, /<Onboarding[\s\S]*\{showWarning && <AutoLogoutWarning/)
})

test('i18n: neue Texte DE/EN vollständig, Platzhalter identisch', () => {
  const keys = Object.keys(de).filter(k => /^onb\.|^invite\.(checkUnavailable|offlineTitle|notCreatedRetry|unclear|usedHint|toApp)$/.test(k))
  assert.equal(keys.length, 25)   // 13 + 12 aus dem Onboarding-Batch (eigene Telefonnummer, Notfallkontakt optional, Hinweise)
  for (const k of keys) {
    assert.ok(en[k] && de[k] !== en[k], k)
    assert.deepEqual((en[k].match(/\{\w+\}/g) || []).sort(), (de[k].match(/\{\w+\}/g) || []).sort(), k)
  }
})
