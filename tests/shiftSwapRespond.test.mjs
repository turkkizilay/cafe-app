// Schichttausch annehmen/ablehnen/zurückziehen (Production-Polish): echte Funktion updateOwnSwap aus Shifts.jsx mit
// simuliertem Supabase. Einzelklick, Doppeltipp (gleichzeitig), veraltete Ansicht (0 Zeilen), Server lehnt ab –
// nie widersprüchliche Erfolgs-/Fehlermeldungen, nie doppelte Änderung, Abfrage nur auf offene Anfragen.
// Die serverseitige Absicherung (swap_guard, approve_swap atomar) prüft tests/db/shift_swap.test.mjs unverändert.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync('src/pages/Shifts.jsx', 'utf8')
function extractFn(name) {
  const start = SRC.indexOf(`async function ${name}(`); assert.ok(start >= 0, name)
  let i = SRC.indexOf('{', SRC.indexOf(')', start)) + 1, depth = 1
  while (depth) { const c = SRC[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return SRC.slice(start, i)
}

// Simuliertes Supabase: zeichnet die Kette auf; await liefert das vorgegebene Ergebnis (optional verzögert)
function env({ result = { data: [{ id: 's1' }], error: null }, delay = 0 } = {}) {
  const calls = [], toasts = [], busy = []
  let fetches = 0, active = false
  const guard = { begin() { if (active) return false; active = true; return true }, end() { active = false } }   // wie useSavingGuard
  const chain = rec => new Proxy(function () {}, {
    get: (_, k) => k === 'then' ? (res => setTimeout(() => res(result), delay)) : (...a) => { rec.push([k, ...a]); return chain(rec) },
  })
  const supabase = { from: t => { const rec = [['from', t]]; calls.push(rec); return chain(rec) } }
  const deps = {
    respondGuard: guard, setSwapBusyId: v => busy.push(v), supabase,
    toast: { success: k => toasts.push(['success', k]), error: k => toasts.push(['error', k]) },
    translateSupabaseError: (e, fb) => fb, appMessage: k => k, fetchSwaps: () => { fetches++ },
  }
  const fn = new Function(...Object.keys(deps), `return (${extractFn('updateOwnSwap')})`)(...Object.values(deps))
  return { fn, calls, toasts, busy, fetches: () => fetches }
}
const accept = e => e.fn('s1', 'accepted', 'ui.14f8a52d95b2', 'ui.996526422813')

test('Einzelklick: genau eine Änderung, nur offene Anfrage, getroffene Zeile wird zurückgegeben; Erfolg; Liste neu', async () => {
  const e = env()
  await accept(e)
  assert.equal(e.calls.length, 1)
  assert.deepEqual(e.calls[0], [['from', 'shift_swap_requests'], ['update', { status: 'accepted' }], ['eq', 'id', 's1'], ['eq', 'status', 'open'], ['select', 'id']])
  assert.deepEqual(e.toasts, [['success', 'ui.996526422813']])
  assert.deepEqual(e.busy, ['s1', null], 'Button während der Anfrage gesperrt, danach frei')
  assert.equal(e.fetches(), 1)
})

test('Doppeltipp / gleichzeitige Klicks: nur EINE Änderung, nur EINE Meldung', async () => {
  const e = env({ delay: 30 })
  await Promise.all([accept(e), accept(e), e.fn('s1', 'declined', 'ui.14f8a52d95b2', 'ui.a9148e8654e8')])
  assert.equal(e.calls.length, 1, 'zweiter/dritter Tipp ohne Anfrage')
  assert.deepEqual(e.toasts, [['success', 'ui.996526422813']], 'keine widersprüchliche zweite Meldung')
  await accept(e)   // nach Abschluss wieder bedienbar
  assert.equal(e.calls.length, 2)
})

test('Veraltete Ansicht (inzwischen zurückgezogen/freigegeben): 0 Zeilen → nur „bereits abgeschlossen“, kein Erfolg', async () => {
  const e = env({ result: { data: [], error: null } })
  await accept(e)
  assert.deepEqual(e.toasts, [['error', 'error.bd03e1e5cae8']])
  assert.equal(e.fetches(), 1, 'aktuelle Lage wird nachgeladen')
  assert.deepEqual(e.busy, ['s1', null])
})

test('Server lehnt ab (swap_guard „bereits abgeschlossen“ / keine Berechtigung): nur Fehlermeldung, Sperre frei', async () => {
  const e = env({ result: { data: null, error: { message: 'Diese Anfrage ist bereits abgeschlossen.' } } })
  await accept(e)
  assert.deepEqual(e.toasts, [['error', 'ui.14f8a52d95b2']])
  await accept(e)
  assert.equal(e.calls.length, 2, 'nach Fehler erneut möglich')
})

test('Verdrahtung: Annehmen/Ablehnen/Zurückziehen nutzen die gesicherte Funktion; Buttons während der Anfrage deaktiviert; Freigabe/Ablehnung durch Manager unverändert (approve_swap atomar)', () => {
  assert.match(SRC, /const respondSwap = \(id, accept\) => updateOwnSwap\(id, accept \? 'accepted' : 'declined'/)
  assert.match(SRC, /const cancelSwap = id => updateOwnSwap\(id, 'cancelled'/)
  assert.equal((SRC.match(/disabled=\{swapBusyId === sw\.id\}/g) || []).length, 3)
  assert.match(SRC, /await supabase\.rpc\('approve_swap', \{ p_swap_id: swap\.id \}\)/)
  assert.match(SRC, /\.eq\('id', id\)\.in\('status', \['open', 'accepted'\]\)\.select\('id'\)/)
})
