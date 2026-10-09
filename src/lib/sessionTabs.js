// „Nicht angemeldet bleiben“ + neuer Tab (Resilience Batch 2a / F6-2).
// Die App merkt sich eine Sitzung ohne „angemeldet bleiben“ per sessionStorage-Flag (gilt nur für EINEN Tab). Ein neuer
// Tab ohne Flag wurde beim Start abgemeldet (App.jsx) – und damit, weil die Sitzung im gemeinsamen Speicher liegt, auch
// der laufende Tab mitten in der Arbeit. Gemeint ist aber: „Sitzung endet, wenn der Browser geschlossen wird“.
//
// Lösung ohne Änderung an App.jsx: Vor dem ersten Rendern fragt ein neuer Tab per BroadcastChannel, ob noch ein
// angemeldeter Tab dieses Browsers lebt. Antwortet einer, übernimmt der neue Tab das Flag (Browser ist offen → Sitzung
// darf bleiben); sonst bleibt alles wie bisher (Startprüfung meldet ab). Ohne BroadcastChannel: unverändertes Verhalten.
// Nur derselbe Browser/dasselbe Profil kann antworten (BroadcastChannel ist auf den Ursprung + Browserprofil begrenzt).
export const SESSION_CHANNEL = 'cafe-session-tabs'
export const HANDSHAKE_MS = 300
export const FLAG_ACTIVE = 'cafe_session_active'     // sessionStorage (je Tab) – gesetzt bei Anmeldung (Login.jsx)
export const FLAG_NO_REMEMBER = 'cafe_no_remember'   // localStorage – „angemeldet bleiben“ abgewählt

const safeGet = (store, key) => { try { return store?.getItem(key) ?? null } catch { return null } }
const safeSet = (store, key, value) => { try { store?.setItem(key, value); return true } catch { return false } }

// Lebender Tab: beantwortet Anfragen, solange DIESER Tab angemeldet ist (Flag wird beim Abmelden entfernt).
export function answerSessionPings({ Channel, session }) {
  if (!Channel) return () => {}
  let ch
  try { ch = new Channel(SESSION_CHANNEL) } catch { return () => {} }
  ch.onmessage = e => {
    const m = e?.data
    if (m?.type === 'ping' && typeof m.id === 'string' && safeGet(session, FLAG_ACTIVE) === '1') {
      try { ch.postMessage({ type: 'alive', id: m.id }) } catch { /* Tab wird gerade geschlossen */ }
    }
  }
  return () => { try { ch.close() } catch { /* bereits zu */ } }
}

// Neuer Tab: lebt ein angemeldeter Tab? → true/false nach spätestens timeoutMs
export function askForActiveTab({ Channel, timeoutMs = HANDSHAKE_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id), makeId = () => Math.random().toString(36).slice(2) }) {
  return new Promise(resolve => {
    let ch
    try { ch = new Channel(SESSION_CHANNEL) } catch { resolve(false); return }
    const id = makeId()
    let done = false
    const finish = alive => { if (done) return; done = true; clearTimer(timer); try { ch.close() } catch { /* */ } resolve(alive) }
    const timer = setTimer(() => finish(false), timeoutMs)
    ch.onmessage = e => { if (e?.data?.type === 'alive' && e.data.id === id) finish(true) }
    try { ch.postMessage({ type: 'ping', id }) } catch { finish(false) }
  })
}

// Vor dem ersten Rendern: 'remember' | 'active' | 'adopted' | 'none' | 'no-channel'
// Nur 'adopted' ändert etwas (Flag gesetzt → die bestehende Startprüfung in App.jsx meldet nicht ab).
export async function prepareSessionFlag({ session, local, Channel, timeoutMs = HANDSHAKE_MS, ...timers }) {
  if (safeGet(local, FLAG_NO_REMEMBER) !== '1') return 'remember'
  if (safeGet(session, FLAG_ACTIVE) === '1') return 'active'
  if (!Channel) return 'no-channel'
  const alive = await askForActiveTab({ Channel, timeoutMs, ...timers })
  if (alive && safeSet(session, FLAG_ACTIVE, '1')) return 'adopted'
  return 'none'
}
