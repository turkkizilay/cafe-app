// Einstempeln: Live-Nachprüfung der Standortvoraussetzungen (WLAN/GPS) solange die Seite offen ist.
// Ereignisse (focus, visibilitychange, pageshow, online/offline, connection), gebündelt; begrenzte Nachprüfungen nach
// einem Ereignis; sparsamer Netzwerk-Check nur sichtbar; nie parallel; ältere Antworten überschreiben nie neuere;
// nach dem Verlassen der Seite nichts mehr. Fail-safe: offline/Fehler/unbekannt ist nie „erfüllt“.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClockRevalidator, bindClockRevalidationEvents, locationSatisfied, withTimeout, SETTLE_DELAYS_MS, POLL_MS, BURST_MS } from '../src/lib/clockRevalidation.js'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
// steuerbare Uhr für setTimer/clearTimer
function fakeClock() {
  let now = 0, id = 0; const timers = new Map()
  return {
    setTimer: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id },
    clearTimer: i => timers.delete(i),
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
      }
      now = end; await flush()
    },
    pending: () => timers.size,
  }
}
// steuerbare Prüfungen: jede Antwort kommt erst, wenn der Test sie freigibt (oder sofort mit Standardwert)
function harness({ net = { status: 'no' }, gps = { status: 'too-far' }, manual = false, visible = true } = {}) {
  const clock = fakeClock()
  const h = { clock, net: null, gps: null, checking: [], netCalls: 0, gpsCalls: 0, inFlight: 0, maxInFlight: 0, pendingNet: [], netValue: net, gpsValue: gps, visible }
  const rv = createClockRevalidator({
    checkNetwork: () => { h.netCalls++; h.inFlight++; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight)
      const done = v => { h.inFlight--; return v }
      if (manual) return new Promise(r => h.pendingNet.push(v => r(done(v))))
      return Promise.resolve(done(h.netValue)) },
    onNetwork: r => { h.net = r },
    checkGps: () => { h.gpsCalls++; return Promise.resolve(h.gpsValue) },
    onGps: r => { h.gps = r },
    onChecking: k => h.checking.push(k),
    isSatisfied: () => locationSatisfied(h.gps, h.net),
    isVisible: () => h.visible,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  h.rv = rv
  return h
}

test('Initiale Prüfung beim Öffnen: WLAN + GPS, sichtbar als „wird geprüft“', async () => {
  const h = harness({ net: { status: 'ok' }, gps: { status: 'ok' } })
  h.rv.trigger('initial'); await flush()
  assert.deepEqual([h.netCalls, h.gpsCalls], [1, 1])
  assert.deepEqual(h.checking, ['network', 'gps'])
  assert.equal(h.net.status, 'ok'); assert.equal(h.gps.status, 'ok')
  h.rv.dispose()
})

test('Nicht erfüllt → WLAN verbindet sich etwas später → begrenzte Nachprüfung wird grün, ohne Neuladen', async () => {
  const h = harness({ net: { status: 'no' }, gps: { status: 'too-far' } })
  h.rv.trigger('visible'); await h.clock.advance(BURST_MS)
  assert.equal(h.net.status, 'no')
  h.netValue = { status: 'ok' }                                   // iPhone: WLAN erst nach der Rückkehr verbunden
  await h.clock.advance(SETTLE_DELAYS_MS[0])
  assert.equal(h.net.status, 'ok')
  const calls = h.netCalls
  await h.clock.advance(SETTLE_DELAYS_MS.at(-1))                  // erfüllt → keine weiteren Nachprüfungen
  assert.equal(h.netCalls, calls)
  assert.equal(h.gpsCalls, 1, 'Nachprüfungen ohne GPS (kein GPS-Spam)')
  h.rv.dispose()
})

test('Nachprüfungen sind begrenzt (kein Dauer-Spam), solange es nicht erfüllt ist', async () => {
  const h = harness({ net: { status: 'no' }, gps: { status: 'too-far' } })
  h.rv.trigger('focus'); await h.clock.advance(BURST_MS + SETTLE_DELAYS_MS.at(-1) + 100)
  assert.equal(h.netCalls, 1 + SETTLE_DELAYS_MS.length)
  h.rv.dispose()
})

test('offline → sofort „Keine Verbindung“ (nie grün); online → neu prüfen → grün', async () => {
  const h = harness({ net: { status: 'ok' }, gps: { status: 'no-config' } })
  h.rv.trigger('initial'); await flush()
  assert.equal(locationSatisfied(h.gps, h.net), true)
  h.rv.markOffline()
  assert.equal(h.net.status, 'offline'); assert.equal(locationSatisfied(h.gps, h.net), false)
  h.rv.trigger('online'); await h.clock.advance(BURST_MS)
  assert.equal(h.net.status, 'ok')
  h.rv.dispose()
})

test('Erfüllt → nicht erfüllt ohne Ereignis (z. B. WLAN gewechselt): sparsamer Netzwerk-Check erkennt es, ohne Flackern', async () => {
  const h = harness({ net: { status: 'ok' }, gps: { status: 'no-config' } })
  h.rv.trigger('initial'); await flush()
  const checking = h.checking.length
  h.netValue = { status: 'no' }
  await h.clock.advance(POLL_MS)
  assert.equal(h.net.status, 'no', 'bleibt nicht dauerhaft grün')
  assert.equal(h.checking.length, checking, 'stille Prüfung (kein „wird geprüft“-Flackern)')
  assert.equal(h.gpsCalls, 1, 'Poll fragt kein GPS ab')
  h.rv.dispose()
})

test('Poll pausiert, solange die App im Hintergrund ist', async () => {
  const h = harness({ net: { status: 'ok' }, gps: { status: 'no-config' }, visible: false })
  await h.clock.advance(POLL_MS * 3)
  assert.equal(h.netCalls, 0)
  h.rv.dispose()
})

test('Ereignis-Burst (focus + visibilitychange + pageshow) → genau eine Prüfung', async () => {
  const h = harness({ net: { status: 'ok' }, gps: { status: 'ok' } })
  h.rv.trigger('focus'); h.rv.trigger('visible'); h.rv.trigger('pageshow')
  await h.clock.advance(BURST_MS)
  assert.deepEqual([h.netCalls, h.gpsCalls], [1, 1])
  h.rv.dispose()
})

test('Nie parallel: viele Ereignisse während einer laufenden Prüfung → höchstens eine nachgereichte', async () => {
  const h = harness({ manual: true, gps: { status: 'ok' } })
  h.rv.trigger('initial'); await flush()
  for (let i = 0; i < 5; i++) { h.rv.trigger('manual'); await flush() }
  assert.equal(h.maxInFlight, 1)
  assert.equal(h.netCalls, 1)
  h.pendingNet.shift()({ status: 'no' }); await flush()
  assert.equal(h.netCalls, 2, 'genau eine Nachprüfung')
  h.pendingNet.shift()({ status: 'ok' }); await flush()
  assert.equal(h.maxInFlight, 1); assert.equal(h.net.status, 'ok')
  h.rv.dispose()
})

test('Ältere Antwort überschreibt keinen neueren Zustand (offline während laufender Prüfung)', async () => {
  const h = harness({ manual: true, gps: { status: 'ok' } })
  h.rv.trigger('initial'); await flush()
  h.rv.markOffline()                                             // Verbindung weg, während die Prüfung noch läuft
  h.pendingNet.shift()({ status: 'ok' }); await flush()          // alte Antwort kommt verspätet als „ok“
  assert.equal(h.net.status, 'offline', 'verspätete Antwort verworfen')
  h.rv.dispose()
})

test('Seite verlassen während einer Prüfung: keine Zustandsänderung mehr, keine Timer', async () => {
  const h = harness({ manual: true })
  h.rv.trigger('initial'); await flush()
  h.rv.dispose()
  h.pendingNet.shift()({ status: 'ok' }); await flush()
  assert.equal(h.net, null)
  h.rv.trigger('online'); h.rv.markOffline(); await h.clock.advance(POLL_MS * 2)
  assert.equal(h.net, null); assert.equal(h.netCalls, 1); assert.equal(h.clock.pending(), 0)
})

test('Fehler einer Prüfung → „Fehler“/„nicht verfügbar“, nie grün', async () => {
  const clock = fakeClock(); let net = null, gps = null
  const rv = createClockRevalidator({ checkNetwork: () => Promise.reject(new Error('x')), onNetwork: r => { net = r },
    checkGps: () => Promise.reject(new Error('y')), onGps: r => { gps = r }, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  rv.trigger('initial'); await flush()
  assert.deepEqual([net.status, gps.status], ['error', 'unavailable'])
  assert.equal(locationSatisfied(gps, net), false)
  rv.dispose()
})

test('Fail-safe: nur „ok“ ist erfüllt – unbekannt, Fehler, offline, verweigert, Zeitüberschreitung sind es nicht', () => {
  for (const s of ['no', 'error', 'checking', 'offline', undefined]) assert.equal(locationSatisfied({ status: 'too-far' }, { status: s }), false, `net ${s}`)
  for (const s of ['denied', 'unavailable', 'timeout', 'checking', 'too-far']) assert.equal(locationSatisfied({ status: s }, { status: 'no' }), false, `gps ${s}`)
  assert.equal(locationSatisfied({ status: 'ok' }, { status: 'offline' }), false, 'offline schlägt GPS')
  assert.equal(locationSatisfied({ status: 'ok' }, { status: 'no', netOnly: true }), false, 'Nur-WLAN-Modus: GPS zählt nicht')
  assert.equal(locationSatisfied({ status: 'too-far' }, { status: 'ok' }), true)
  assert.equal(locationSatisfied({ status: 'ok' }, { status: 'no' }), true)
})

test('Browser-Ereignisse: focus, visibilitychange (nur sichtbar), pageshow, online, offline, connection; Abmelden entfernt alles', () => {
  const calls = []
  const rv = { trigger: r => calls.push(r), markOffline: () => calls.push('offline!') }
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }), conn = new EventTarget()
  const unbind = bindClockRevalidationEvents(rv, { win, doc, nav: { connection: conn } })
  win.dispatchEvent(new Event('focus')); win.dispatchEvent(new Event('pageshow')); win.dispatchEvent(new Event('online'))
  win.dispatchEvent(new Event('offline')); conn.dispatchEvent(new Event('change'))
  doc.dispatchEvent(new Event('visibilitychange'))
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
  assert.deepEqual(calls, ['focus', 'pageshow', 'online', 'offline!', 'connection', 'visible'])
  unbind()
  for (const e of ['focus', 'pageshow', 'online', 'offline']) win.dispatchEvent(new Event(e))
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); conn.dispatchEvent(new Event('change'))
  assert.equal(calls.length, 6, 'nach Abmelden keine Reaktion')
  assert.doesNotThrow(() => bindClockRevalidationEvents(rv, { win, doc, nav: {} })(), 'ohne navigator.connection (iOS)')
})

test('withTimeout: hängende Prüfung endet (Fehler oder Ersatzwert)', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), /timeout/)
  assert.deepEqual(await withTimeout(new Promise(() => {}), 20, { status: 'timeout' }), { status: 'timeout' })
  assert.equal(await withTimeout(Promise.resolve(5), 1000), 5)
})

test('Einstempel-Seite: Revalidator verdrahtet, Rollen/Remote-Logik unverändert, offline sperrt', () => {
  const src = readFileSync('src/pages/ClockIn.jsx', 'utf8')
  assert.match(src, /const unbind = bindClockRevalidationEvents\(rv\)\n\s+return \(\) => \{ unbind\(\); rv\.dispose\(\); revalidator\.current = null \}/)
  assert.match(src, /revalidator\.current\?\.trigger\('initial'\)/)
  assert.match(src, /onClick=\{\(\) => revalidator\.current\?\.trigger\('manual'\)\}/)
  assert.doesNotMatch(src, /function recheck\(\)|doGpsCheck\(/, 'alter Einzel-Check entfernt')
  assert.match(src, /withTimeout\(supabase\.rpc\('clock_network_status'\), 10000\)/)
  assert.match(src, /if \(typeof navigator !== 'undefined' && navigator\.onLine === false\) return \{ status: 'offline' \}/)
  assert.match(src, /err\?\.code === 1 \? 'denied' : err\?\.code === 3 \? 'timeout' : 'unavailable'/)
  assert.match(src, /const canClock = !offline && \(located \|\| \(!netOnly && !gpsConfigured && \(net\.status === 'unconfigured' \|\| net\.status === 'error'\)\)\)/)
  // Remote-Flow und Rollenlogik unverändert (nur zusätzlich offline gesperrt)
  assert.match(src, /const remote = canClock \? 'none' : remoteClockState\(\{ canManage: !!isManager, located, anyConfigured, stillChecking, netOnly, gpsConfigured, gpsStatus: gps\.status, netStatus: net\.status \}\)/)
  assert.equal((src.match(/disabled=\{working \|\| offline\}/g) || []).length, 2)
  assert.match(src, /from\('time_entries'\)\.insert/, 'normales Einstempeln unverändert (Server prüft)')
})
