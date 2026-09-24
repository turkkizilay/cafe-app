/* Café Buur – Service Worker
 * Nur für Push-Benachrichtigungen. Bewusst KEIN Offline-Cache, damit nie eine
 * veraltete App-Version hängen bleibt.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data ? event.data.text() : '' } }
  const title = data.title || 'Café Buur'
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    lang: 'de',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
  }
  if (data.tag) { options.tag = data.tag; options.renotify = true }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        try { await c.navigate(target) } catch { /* ältere Browser */ }
        return c.focus()
      }
    }
    return self.clients.openWindow(target)
  })())
})

// Browser hat das Abo erneuert → App meldet es beim nächsten Öffnen neu an
self.addEventListener('pushsubscriptionchange', () => {})
