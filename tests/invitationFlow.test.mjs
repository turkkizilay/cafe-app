// Einladung erstellen: „⏳ Wird erstellt…“ endet immer, Schließen während der Anfrage legt nichts an,
// Teil-Erfolg wird nie als Fehler gemeldet, Doppelklick/erneuter Versuch erzeugen keine zweite gültige Einladung.
// Echter Handler aus dem Quelltext + echter boundedRequest gegen eine skriptbare Supabase (Verzögern, Hängen, Fehler).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boundedRequest } from '../src/lib/boundedRequest.js'
import { de, en } from '../src/i18n/catalogs.js'

const SRC = readFileSync('src/pages/UserManagement.jsx', 'utf8')
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  let i = SRC.indexOf('{', SRC.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = SRC[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return SRC.slice(SRC.lastIndexOf('\n', start) + 1, i).trim()
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const HANG = Symbol('hang')

// Supabase-Nachbildung: jede Anfrage wird protokolliert; Antwort je Schritt skriptbar (Wert, Verzögerung, HANG).
// abortSignal verhält sich wie postgrest-js: Abbruch → { status: 0, error: AbortError }.
function fakeDb(script) {
  const db = { log: [], invitations: [...(script.existing || [])] }
  const respond = async (key, compute, signal) => {
    db.log.push(key)
    const plan = script[key]?.shift?.() ?? script[key] ?? {}
    const aborted = new Promise(r => signal?.addEventListener('abort', () => r({ data: null, error: { message: 'AbortError: aborted', code: '' }, status: 0 }), { once: true }))
    const work = (async () => {
      if (plan.delay) await sleep(plan.delay)
      if (plan.hang) await new Promise(() => {})
      const out = compute(plan)
      if (plan.lostResponse) await new Promise(() => {})   // Server hat geschrieben, Antwort kommt nie an
      return out
    })()
    return Promise.race([work, aborted])
  }
  const q = (key, compute) => {
    let signal
    const b = { abortSignal: s => ((signal = s), b), select: () => b, is: () => b, gt: () => b, eq: (c, v) => ((b._eq = v), b), maybeSingle: () => b,
      then: (res, rej) => respond(key, plan => compute(plan, b), signal).then(res, rej) }
    return b
  }
  db.supabase = {
    rpc: (name, args) => q(`rpc:${name}`, plan => {
      if (plan.error) return { data: null, error: plan.error, status: 400 }
      if (name === 'revoke_invitation') { const i = db.invitations.find(x => x.id === args.p_id); if (i) i.revoked_at = 'now' }
      return { data: plan.data ?? (name === 'check_email_registered' ? { exists: false } : { success: true }), error: null, status: 200 }
    }),
    from: () => ({
      select: () => q('select', (plan, b) => {
        if (plan.error) return { data: null, error: plan.error, status: 400 }
        const open = db.invitations.filter(i => !i.revoked_at)
        return { data: b._eq ? (open.find(i => i.id === b._eq) || null) : open, error: null, status: 200 }
      }),
      insert: ([row]) => q('insert', plan => {
        if (plan.error) return { data: null, error: plan.error, status: 403 }
        const inv = { ...row, token: `tok-${row.id}`, expires_at: '2026-10-06T00:00:00Z' }
        db.invitations.push(inv)
        return { data: inv, error: null, status: 201 }
      }),
    }),
  }
  return db
}

// Komponente im Kleinen: echte Funktionen createInvitation/closeInvite/openInvite, State als Protokoll
function mount(script, { modal = { isNew: true }, email = 'neu@example.org', timeouts = { read: 80, write: 80, verify: 80 } } = {}) {
  const db = fakeDb(script)
  const st = { saving: [], result: null, invitations: [], toasts: [], fetches: 0, conflict: null, activity: [], modal }
  const ref = v => ({ current: v })
  const g = { on: false, begin() { if (this.on) return false; this.on = true; return true }, end() { this.on = false } }
  const env = {
    inviteGuard: g, inviteForm: { email, role: 'employee' }, inviteJob: null, inviteModal: modal, profile: { id: 'admin' },
    toast: Object.fromEntries(['success', 'error', 'warn', 'info'].map(k => [k, m => st.toasts.push([k, m?.key ?? m?.parts?.[0]?.key ?? m])])),
    appMessage: key => ({ key }), messageParts: parts => ({ parts }), translateSupabaseError: e => e?.message,
    setInviteSaving: v => st.saving.push(v), setInviteResult: v => { st.result = v }, setInviteConflictInfo: v => { st.conflict = v },
    setInviteModal: v => { st.modal = v }, setInviteForm: () => {}, setInviteJob: () => {},
    setInvitations: f => { st.invitations = f(st.invitations) }, fetchAll: () => { st.fetches++ },
    logActivity: a => st.activity.push(a), inviteConflict: () => ({}), allProfiles: [], accountStates: {}, onboardings: [], orphans: [],
    supabase: db.supabase, boundedRequest, INVITE_TIMEOUT: timeouts,
    inviteRunRef: ref(null), inviteModalSeq: ref(1), window: { location: { origin: 'https://app.test' } },
    validatePayModel: () => null, payTypeOf: () => 'hourly', parseMonthlySalary: x => x, PAY_FIXED: 'fixed',
  }
  const make = name => new Function(...Object.keys(env), `return (${extractFn(name)})`)(...Object.values(env))
  return { db, st, create: make('createInvitation'), close: make('closeInvite'), env }
}
const kinds = st => st.toasts.map(t => t[0])
const openCount = db => db.invitations.filter(i => !i.revoked_at).length

test('Normalfall: Erfolgsanzeige, Liste sofort aktualisiert, Protokoll, Laden beendet', async () => {
  const { db, st, create } = mount({})
  await create()
  assert.deepEqual(st.saving, [true, false])
  assert.match(st.result.link, /^https:\/\/app\.test\/\?invite=tok-/)
  assert.equal(st.invitations.length, 1, 'neue Einladung ohne Warten auf den Reload in der Liste')
  assert.equal(st.activity.length, 1); assert.equal(st.fetches, 1); assert.deepEqual(st.toasts, [])
  assert.deepEqual(db.log, ['rpc:check_email_registered', 'select', 'insert'])
})

test('Vorfall 29.09.: Prüfung hängt → Laden endet mit klarer Meldung, nichts angelegt, Button wieder frei', async () => {
  const { db, st, create, env } = mount({ 'rpc:check_email_registered': { hang: true } })
  await create()
  assert.deepEqual(st.saving, [true, false]); assert.equal(env.inviteGuard.on, false)
  assert.deepEqual(st.toasts, [['error', 'invite.noResponse']])
  assert.equal(db.invitations.length, 0); assert.equal(st.result, null)
})

test('Dialog während der Prüfung geschlossen → Versuch abgebrochen, später keine „Zombie“-Einladung', async () => {
  const { db, st, create, close } = mount({ 'rpc:check_email_registered': { delay: 40 } }, { timeouts: { read: 5000, write: 5000, verify: 5000 } })
  const p = create()
  await sleep(5); close()
  await p; await sleep(60)
  assert.deepEqual(db.log, ['rpc:check_email_registered'], 'kein Einfügen nach dem Schließen')
  assert.equal(db.invitations.length, 0); assert.deepEqual(st.toasts, []); assert.deepEqual(st.saving, [true, false])
})

test('Dialog nach Beginn des Schreibens geschlossen → Einladung wird fertig angelegt und gemeldet (Toast statt Dialog)', async () => {
  const { db, st, create, close } = mount({ insert: { delay: 40 } }, { timeouts: { read: 5000, write: 5000, verify: 5000 } })
  const p = create()
  while (!db.log.includes('insert')) await sleep(1)
  close(); await p
  assert.equal(db.invitations.length, 1); assert.equal(st.result, null, 'kein Ergebnis in einen geschlossenen/anderen Dialog')
  assert.deepEqual(st.toasts, [['success', 'invite.createdClosed']]); assert.equal(st.invitations.length, 1)
})

test('Schneller Doppelklick → genau eine Anfragekette, eine Einladung', async () => {
  const { db, create } = mount({ 'rpc:check_email_registered': { delay: 20 } }, { timeouts: { read: 5000, write: 5000, verify: 5000 } })
  await Promise.all([create(), create(), create()])
  assert.equal(db.log.filter(k => k === 'insert').length, 1); assert.equal(db.invitations.length, 1)
})

test('Teil-Erfolg: gespeichert, aber Antwort verloren → per eigener ID nachgeprüft und als Erfolg angezeigt', async () => {
  const { db, st, create } = mount({ insert: { lostResponse: true } })
  await create()
  assert.equal(db.invitations.length, 1)
  assert.deepEqual(db.log, ['rpc:check_email_registered', 'select', 'insert', 'select'])
  assert.ok(st.result?.link.endsWith(db.invitations[0].token), 'Erfolgsanzeige mit dem echten Link')
  assert.deepEqual(kinds(st), [], 'kein Fehler-Toast'); assert.deepEqual(st.saving, [true, false])
})

test('Ergebnis unbekannt (Einfügen + Nachprüfung ohne Antwort) → Hinweis statt Fehler; neuer Versuch lässt nur EINEN Link gültig', async () => {
  const s = mount({ insert: [{ lostResponse: true }, {}], select: [{}, { hang: true }, {}] })
  await s.create()
  assert.deepEqual(kinds(s.st), ['warn']); assert.equal(s.st.toasts[0][1], 'invite.unconfirmed'); assert.equal(s.st.fetches, 1)
  assert.equal(openCount(s.db), 1, 'Server hat tatsächlich gespeichert')
  s.st.toasts.length = 0
  await s.create()   // Admin versucht es erneut
  assert.deepEqual(s.db.log.slice(-3), ['select', 'rpc:revoke_invitation', 'insert'], 'unsichtbare erste Einladung wird zurückgezogen')
  assert.equal(openCount(s.db), 1, 'nur ein gültiger Link'); assert.ok(s.st.result)
})

test('Echter Serverfehler beim Einfügen → verständliche Meldung, keine Erfolgsanzeige, Button wieder frei', async () => {
  const { db, st, create, env } = mount({ insert: { error: { message: 'new row violates row-level security', code: '42501' } } })
  await create()
  assert.deepEqual(kinds(st), ['error']); assert.equal(st.result, null); assert.equal(db.invitations.length, 0)
  assert.equal(env.inviteGuard.on, false); assert.deepEqual(st.saving, [true, false])
  assert.deepEqual(db.log.filter(k => k === 'select').length, 1, 'keine Nachprüfung bei eindeutigem Serverfehler')
})

test('Fehler der Adressprüfung wird nicht mehr ignoriert (vorher: Einladung trotz fehlgeschlagener Prüfung)', async () => {
  const { db, st, create } = mount({ 'rpc:check_email_registered': { error: { message: 'Nicht autorisiert.', code: 'P0001' } } })
  await create()
  assert.deepEqual(st.toasts, [['error', 'invite.checkFailed']]); assert.equal(db.invitations.length, 0)
})

test('Alte offene Einladung wird vom Server gelesen (nicht aus veralteter Liste) und ersetzt', async () => {
  const { db, st, create } = mount({ existing: [{ id: 'alt', email: 'Neu@Example.org', employee_id: null }, { id: 'andere', email: 'x@example.org', employee_id: null }] })
  await create()
  assert.deepEqual(db.invitations.filter(i => !i.revoked_at).map(i => i.id).filter(id => id !== 'alt' && id !== 'andere').length, 1)
  assert.equal(db.invitations.find(i => i.id === 'alt').revoked_at, 'now')
  assert.equal(db.invitations.find(i => i.id === 'andere').revoked_at, undefined, 'andere Person unberührt')
  assert.ok(st.result)
})

test('boundedRequest: endet auch, wenn die Abfrage vor dem fetch hängt; Abbruch ≠ Zeitüberschreitung', async () => {
  const hung = await boundedRequest(() => new Promise(() => {}), { ms: 20 })
  assert.equal(hung.status, 0); assert.equal(hung.timedOut, true); assert.equal(hung.cancelled, false)
  const c = new AbortController(); setTimeout(() => c.abort(), 5)
  const cancelled = await boundedRequest(() => new Promise(() => {}), { ms: 5000, cancel: c.signal })
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.timedOut, false)
  const ok = await boundedRequest(() => Promise.resolve({ data: 1, error: null, status: 200 }), { ms: 20 })
  assert.deepEqual(ok, { data: 1, error: null, status: 200 })
  const thrown = await boundedRequest(() => Promise.reject(new Error('Failed to fetch')), { ms: 20 })
  assert.equal(thrown.status, 0); assert.match(thrown.error.message, /Failed to fetch/)
})

test('Verdrahtung: alle Schließen-Wege brechen ab; Reload nach Einladung ohne Ganzseiten-Laden; Lesefehler leert Liste nicht', () => {
  assert.equal((SRC.match(/onClick=\{closeInvite\}/g) || []).length, 3, 'Overlay, ✕, Abbrechen')
  assert.doesNotMatch(SRC, /setInviteModal\(null\); setInviteResult\(null\)/)
  assert.match(SRC, /if \(!silent\) setLoading\(true\)/)
  assert.match(SRC, /if \(!invErr\) setInvitations\(invs \|\| \[\]\)/)
  assert.equal((SRC.match(/if \(seq !== fetchSeq\.current\) return/g) || []).length, 3, 'ältere Aktualisierung überschreibt nicht')
  // Link kopieren in „Aktive Einladungen“ unverändert
  assert.match(SRC, /const link = `\$\{window\.location\.origin\}\/\?invite=\$\{inv\.token\}`\s*\n\s*copyLink\(link\)/)
})

test('i18n: neue Einladungs-Meldungen DE/EN vollständig', () => {
  for (const k of ['invite.checkFailed', 'invite.noResponse', 'invite.unconfirmed', 'invite.createdClosed']) {
    assert.ok(de[k] && en[k] && de[k] !== en[k], k)
    assert.deepEqual(en[k].match(/\{\w+\}/g), de[k].match(/\{\w+\}/g), k)
  }
})
