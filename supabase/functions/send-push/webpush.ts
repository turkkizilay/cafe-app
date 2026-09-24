// Web Push ohne Fremdbibliothek: Verschlüsselung nach RFC 8291 (aes128gcm)
// und VAPID-Anmeldung nach RFC 8292 – nur WebCrypto (läuft in Deno und Node ≥ 20).

const te = new TextEncoder()

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

/** Verschlüsselt eine Nachricht für ein Abo (p256dh/auth aus PushSubscription). */
export async function encryptPayload(payload: Uint8Array, p256dhB64: string, authB64: string): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dhB64)
  const authSecret = b64urlDecode(authB64)
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('invalid subscription keys')

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256))

  const ikm = await hkdf(authSecret, ecdh, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, concat(payload, new Uint8Array([2]))))

  const rs = new Uint8Array([0, 0, 0x10, 0])           // Datensatzgröße 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct)
}

export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }

/** Neues VAPID-Schlüsselpaar (öffentlich: base64url, 65 Byte; privat: JWK). */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey) as JsonWebKey
  return { publicKey: b64urlEncode(pub), privateJwk }
}

/** Authorization-Header für einen Push-Endpunkt. */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })))
  const key = await crypto.subtle.importKey('jwk', { ...keys.privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${keys.publicKey}`
}

export interface PushResult { status: number; ok: boolean; gone: boolean; error?: string }

/** Sendet eine Nachricht an ein Abo. gone=true → Abo existiert nicht mehr (löschen). */
export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, message: unknown,
                               keys: VapidKeys, subject: string, opts: { ttl?: number; topic?: string } = {}): Promise<PushResult> {
  try {
    const body = await encryptPayload(te.encode(JSON.stringify(message)), sub.p256dh, sub.auth)
    const headers: Record<string, string> = {
      'Authorization': await vapidHeader(sub.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(opts.ttl ?? 86400),
      'Urgency': 'normal',
    }
    if (opts.topic) headers['Topic'] = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'cafe'
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body })
    const gone = res.status === 404 || res.status === 410
    const ok = res.status >= 200 && res.status < 300
    let error: string | undefined
    if (!ok) error = `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`
    return { status: res.status, ok, gone, error }
  } catch (e) {
    return { status: 0, ok: false, gone: false, error: String((e as Error)?.message || e).slice(0, 200) }
  }
}
