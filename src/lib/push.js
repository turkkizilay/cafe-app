import { message as appMessage, messageError } from '../i18n/runtime.js'
// Push-Benachrichtigungen im Browser (Web Push).
// iPhone/iPad: nur wenn die App über „Zum Home-Bildschirm“ installiert ist (ab iOS 16.4).
import { supabase } from './supabase'

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent || '') ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function b64ToBytes(b64) {
  const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(s)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }) } catch { return null }
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration('/')) || (await registerServiceWorker())
}

export async function currentSubscription() {
  try {
    const reg = await getRegistration()
    return reg ? await reg.pushManager.getSubscription() : null
  } catch { return null }
}

/**
 * Status für die Oberfläche:
 * unsupported | needs-install (iPhone im Browser) | denied | on | off
 */
export async function pushState() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const sub = await currentSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

/** Einschalten: Erlaubnis holen, Abo anlegen, beim Server anmelden. */
export async function enablePush() {
  if (!pushSupported()) throw messageError(isIOS() ? appMessage("push.error.0") : appMessage("push.error.1"))
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw messageError(appMessage("push.error.2"))
  const { data: key, error } = await supabase.rpc('push_public_key')
  if (error || !key) throw messageError(appMessage("push.error.3"))
  const reg = await getRegistration()
  if (!reg) throw messageError(appMessage("push.error.4"))
  await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  // Abo mit anderem Schlüssel (z. B. nach Schlüsselwechsel) ersetzen
  if (sub && sub.options?.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey)
    const want = b64ToBytes(key)
    if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) })
  const j = sub.toJSON()
  const { data, error: e2 } = await supabase.rpc('push_subscribe', {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_ua: navigator.userAgent.slice(0, 200),
  })
  if (e2 || !data?.success) throw messageError(data?.error || appMessage("push.error.5"))
  return true
}

/** Beim Abmelden: Gerät nur beim Server vom Konto lösen. Das Browser-Abo bleibt,
 *  damit nach der nächsten Anmeldung (z. B. nach automatischem Logout) alles
 *  ohne erneutes Einschalten weiterläuft – dann für die neu angemeldete Person. */
export async function detachPushFromAccount() {
  const sub = await currentSubscription()
  if (!sub) return
  try { await supabase.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }) } catch { /* offline: Server räumt beim nächsten Versand auf */ }
}

/** Ausschalten auf diesem Gerät. */
export async function disablePush() {
  const sub = await currentSubscription()
  if (!sub) return
  try { await supabase.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }) } catch { /* trotzdem lokal abmelden */ }
  try { await sub.unsubscribe() } catch { /* egal */ }
}

/** Nach dem App-Start: bestehendes Abo still beim Server auffrischen (z. B. nach Gerätewechsel des Kontos). */
export async function refreshPushSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return
    const sub = await currentSubscription()
    if (!sub) return
    const j = sub.toJSON()
    await supabase.rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_ua: navigator.userAgent.slice(0, 200) })
  } catch { /* still */ }
}
