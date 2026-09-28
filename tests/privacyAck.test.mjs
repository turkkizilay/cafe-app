// Versionierte Kenntnisnahme der Datenschutzhinweise: App-Sperre, Bestätigungsseite, Onboarding, Fehlerpfade, DE/EN.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPrivacyAck, acknowledgePrivacyNotice, nextAckState } from '../src/lib/privacyAck.js'
import { PRIVACY_NOTICE_VERSION, LEGAL_VERSION, LEGAL_PATHS, legalKindForPath } from '../src/legal/legalContent.js'
import { de, en } from '../src/i18n/catalogs.js'

const read = f => readFileSync(f, 'utf8')
// supabase-js-Attrappe: Tabelle mit gespeicherten Kenntnisnahmen, RPC mit steuerbarem Ergebnis
function fakeDb({ rows = [], rpc } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const f = {}
      const api = {
        select() { return api }, eq(k, v) { f[k] = v; return api },
        async maybeSingle() { calls.push(['select', table, { ...f }]); return { data: rows.find(r => r.profile_id === f.profile_id && r.notice_version === f.notice_version) || null, error: null } },
      }
      return api
    },
    async rpc(name, args) { calls.push(['rpc', name, args]); return rpc ? rpc(args) : { data: { version: args.p_version, acknowledged_at: '2026-09-28T10:00:00Z' }, error: null } },
  }
}

test('Version: aktuelle Datenschutzhinweise 2026-09-28, eine Quelle für „Stand“ und Kenntnisnahme', () => {
  assert.equal(PRIVACY_NOTICE_VERSION, '2026-09-28')
  assert.equal(PRIVACY_NOTICE_VERSION, LEGAL_VERSION)
  assert.match(read('src/lib/privacyAck.js'), /\.eq\('notice_version', version\)/)
})

test('1/2/11/12: Status nur aus versionierter Kenntnisnahme – altes privacy_accepted zählt nicht', async () => {
  assert.equal(await loadPrivacyAck(fakeDb(), 'u1'), 'required')                                                          // 1
  assert.equal(await loadPrivacyAck(fakeDb({ rows: [{ profile_id: 'u1', notice_version: '2025-01-01' }] }), 'u1'), 'required')   // 11
  assert.equal(await loadPrivacyAck(fakeDb({ rows: [{ profile_id: 'u1', notice_version: '2026-09-28' }] }), 'u1'), 'ok')         // 12
  assert.equal(await loadPrivacyAck(fakeDb({ rows: [{ profile_id: 'u2', notice_version: '2026-09-28' }] }), 'u1'), 'required')   // fremde Kenntnisnahme zählt nicht
  assert.equal(await loadPrivacyAck(fakeDb({ rows: [{ profile_id: 'u1', notice_version: '2026-09-28' }] }), 'u1', '2027-03-01'), 'required')   // neue Version
  const src = read('src/lib/privacyAck.js') + read('src/App.jsx') + read('src/components/PrivacyAckGate.jsx')
  assert.doesNotMatch(src, /privacy_accepted/, '2: Legacy-Feld wird für die Freigabe nicht ausgewertet')
})

test('App: freigeschaltete Konten sehen die App erst nach serverseitig bestätigter Kenntnisnahme', () => {
  const app = read('src/App.jsx')
  const gate = app.indexOf("if (profile.status === 'approved' && ackForProfile !== 'ok') return (")
  assert.ok(gate > 0 && gate < app.indexOf('<div className="app-shell">'), 'Sperre vor dem geschützten Bereich')
  assert.ok(app.indexOf('legalKindForPath(window.location.pathname)') < gate, '22: Rechtsseiten bleiben öffentlich')
  assert.match(app, /const ackForProfile = privacyAck\.uid === profile\.id \? privacyAck\.state : 'checking'/)   // Status gehört zur Person
  assert.match(app, /const ack = await loadPrivacyAck\(supabase, uid\)\s*\n\s*setPrivacyAck\(prev => nextAckState\(prev, uid, ack\)\)/)
  assert.ok(app.indexOf('await loadPrivacyAck(supabase, uid)') < app.indexOf('setProfile(data || null)'), 'Status vor dem Profil gesetzt → kein kurzes Aufblitzen der App')
  assert.match(app, /setPrivacyAck\(\{ uid: null, state: 'checking' \}\)\s*\n\s*setProfile\(null\)/)                // Abmelden setzt zurück
  assert.match(app, /\? <PrivacyAckGate supabase=\{supabase\}/); assert.match(app, /: <PrivacyAckChecking \/>/)
  assert.equal(legalKindForPath('/datenschutz'), 'privacy'); assert.equal(legalKindForPath('/impressum'), 'imprint')
})

test('8/9/10/16: Reload, neue Sitzung, Fehler – Freigabe nie aus lokalem Zustand', () => {
  assert.deepEqual(nextAckState({ uid: 'u1', state: 'checking' }, 'u1', 'ok'), { uid: 'u1', state: 'ok' })
  assert.deepEqual(nextAckState(null, 'u1', 'required'), { uid: 'u1', state: 'required' })
  assert.deepEqual(nextAckState(null, 'u1', 'error'), { uid: 'u1', state: 'required' }, 'unbekannt → Hinweis statt Freigabe')
  assert.deepEqual(nextAckState({ uid: 'u2', state: 'ok' }, 'u1', 'error'), { uid: 'u1', state: 'required' }, 'kein Übertrag auf andere Person')
  assert.deepEqual(nextAckState({ uid: 'u1', state: 'ok' }, 'u1', 'error'), { uid: 'u1', state: 'ok' }, 'vorübergehender Fehler entzieht bestätigte Freigabe nicht')
  assert.deepEqual(nextAckState({ uid: 'u1', state: 'ok' }, 'u1', 'required'), { uid: 'u1', state: 'required' }, 'Server sagt „fehlt“ → erneut anzeigen')
  assert.doesNotMatch(read('src/lib/privacyAck.js') + read('src/components/PrivacyAckGate.jsx'), /localStorage|sessionStorage/)
})

test('6/16/17: Bestätigen – Erfolg nur mit Serverbestätigung, Fehler ohne False-Success', async () => {
  const db = fakeDb()
  const ok = await acknowledgePrivacyNotice(db)
  assert.equal(ok.ok, true); assert.equal(ok.acknowledgedAt, '2026-09-28T10:00:00Z')
  assert.deepEqual(db.calls[0], ['rpc', 'acknowledge_privacy_notice', { p_version: '2026-09-28' }])
  for (const rpc of [() => ({ data: null, error: { message: 'boom' } }), () => ({ data: null, error: null }), () => ({ data: { version: '2025-01-01', acknowledged_at: 'x' }, error: null }), () => ({ data: { version: '2026-09-28' }, error: null }), () => { throw new Error('offline') }])
    assert.equal((await acknowledgePrivacyNotice(fakeDb({ rpc }))).ok, false)
  const gate = read('src/components/PrivacyAckGate.jsx')
  assert.match(gate, /if \(!checked \|\| busy\.current\) return/)                                  // 17: Doppelklick
  assert.match(gate, /if \(!res\.ok\) \{ setError\(t\('privacyAck\.error'\)\); return \}\s*\n\s*onAcknowledged\(res\.acknowledgedAt\)/)   // 16
  assert.match(read('src/App.jsx'), /onAcknowledged=\{\(\) => setPrivacyAck\(\{ uid: profile\.id, state: 'ok' \}\)\}/)
})

test('3/4/5: Bestätigungsseite – Checkbox nicht vorausgewählt, Weiter erst mit Häkchen, Link auf /datenschutz', () => {
  const gate = read('src/components/PrivacyAckGate.jsx')
  assert.match(gate, /const \[checked, setChecked\] = useState\(false\)/)                           // 3
  assert.match(gate, /<input type="checkbox" checked=\{checked\}/)
  assert.match(gate, /disabled=\{!checked \|\| saving\}/)                                           // 4
  assert.match(gate, /<a href=\{LEGAL_PATHS\.privacy\} target="_blank" rel="noopener noreferrer">\{t\('legal\.ackLink'\)\}<\/a>/)   // 5
  assert.equal(LEGAL_PATHS.privacy, '/datenschutz')
  assert.match(gate, /role="dialog" aria-modal="true"/)
  assert.doesNotMatch(gate, /onClose|Escape|Schließen/)                                             // nicht umgehbar
})

test('18: neues Onboarding speichert die aktuelle Version über dasselbe System, vor dem Absenden', () => {
  const onb = read('src/pages/Onboarding.jsx')
  const submit = onb.slice(onb.indexOf('async function submit('))                                   // Absenden (nicht Entwurf speichern)
  const ack = submit.indexOf('const ack = await acknowledgePrivacyNotice(supabase)')
  assert.ok(ack > 0 && ack < submit.indexOf("supabase.rpc('save_onboarding'"), 'Kenntnisnahme vor dem Absenden')
  assert.ok(submit.indexOf('if (!privacy)') < ack, 'nur mit gesetzter Checkbox')
  assert.match(onb, /if \(!ack\.ok\) \{ setSaving\(false\); toast\.error\(appMessage\('privacyAck\.error'\)\); return \}/)
  assert.match(onb, /p_data: \{ \.\.\.toPayload\(form\), privacy_accepted: true \}, p_submit: true/)   // Legacy-Flag unverändert mitgesendet
})

test('19/20/21: DE und EN vollständig, DE → EN → DE, Kenntnisnahme statt Einwilligung', () => {
  const keys = ['privacyAck.title', 'privacyAck.text', 'privacyAck.checkAfter', 'privacyAck.continue', 'privacyAck.saving', 'privacyAck.error', 'privacyAck.checking', 'privacyAck.signOut']
  for (const k of keys) { assert.ok(de[k] && en[k], k); if (k !== 'privacyAck.checkAfter') assert.notEqual(de[k], en[k], k) }
  assert.equal(de['privacyAck.title'], 'Aktualisierte Datenschutzhinweise'); assert.equal(en['privacyAck.title'], 'Updated Privacy Information')
  assert.equal(de['privacyAck.continue'], 'Weiter'); assert.equal(en['privacyAck.continue'], 'Continue')
  assert.equal(de['legal.ackBefore'] + de['legal.ackLink'] + de['privacyAck.checkAfter'], 'Ich habe die Datenschutzhinweise für Beschäftigte zur Kenntnis genommen.')
  assert.equal(en['legal.ackBefore'] + en['legal.ackLink'] + en['privacyAck.checkAfter'], 'I have read the privacy information for employees.')
  assert.match(de['privacyAck.text'], /Café-Buur-Mitarbeiterportal/); assert.match(en['privacyAck.text'], /Café Buur employee portal/)
  const round = [de, en, de].map(c => keys.map(k => c[k]).join('|'))
  assert.equal(round[0], round[2]); assert.notEqual(round[0], round[1])
  for (const c of [de, en]) for (const k of keys) assert.doesNotMatch(c[k], /akzeptier|stimme .*zu|willige|einverstanden|\baccept|\bconsent|\bagree/i, k)
})

test('Migration 23: additiv, kein Backfill, nur eigene Kenntnisnahme per RPC, keine IP/GPS/Geräte', () => {
  const sql = read('supabase/migrations_onboarding/23_privacy_notice_acknowledgements.sql')
  const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  assert.match(code, /CREATE TABLE IF NOT EXISTS public\.privacy_notice_acknowledgements/)
  assert.match(code, /PRIMARY KEY \(profile_id, notice_version\)/)
  assert.match(code, /REVOKE ALL ON public\.privacy_notice_acknowledgements FROM PUBLIC, anon, authenticated;\s*\nGRANT SELECT ON public\.privacy_notice_acknowledgements TO authenticated;/)
  assert.match(code, /USING \(profile_id = auth\.uid\(\) OR is_admin\(\)\)/)
  assert.match(code, /VALUES \(v_uid, p_version\)\s*\n\s*ON CONFLICT \(profile_id, notice_version\) DO NOTHING/)
  assert.doesNotMatch(code, /\bUPDATE\b|privacy_accepted|ALTER TABLE public\.(profiles|employees|employee_onboarding)|DROP (TABLE|COLUMN)/i, 'kein Backfill, keine Änderung bestehender Tabellen')
  assert.doesNotMatch(code, /ip_address|inet|_client_ip|gps|user_agent/i)
  for (const n of [17, 18, 19, 20, 21, 22]) assert.equal(read('supabase/migrations_onboarding/' + (n === 17 ? '17_break_tracking' : n === 18 ? '18_compensation_model' : n === 19 ? '19_manager_data_minimization' : n === 20 ? '20_swap_approve_atomic' : n === 21 ? '21_one_open_time_entry' : '22_sick_certs_no_manager_delete') + '.sql').length > 0, true)
})
