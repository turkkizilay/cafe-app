// Edge Function „send-push“: arbeitet die Warteschlange push_outbox ab.
// Wird von der Datenbank (pg_net) angestoßen. Verschickt nur, was die Datenbank
// selbst eingereiht hat – ein fremder Aufruf bewirkt höchstens, dass wartende
// Nachrichten etwas früher rausgehen.
// Zugriff auf die DB mit dem Service-Schlüssel, den Supabase automatisch setzt.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { generateVapidKeys, sendPush, type VapidKeys } from './webpush.ts'

const SUBJECT = 'https://cafe-buur-v2.vercel.app'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

let cachedKeys: VapidKeys | null = null
async function getKeys(): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys
  const { data, error } = await db.rpc('push_worker_keys')
  if (error) throw new Error('keys: ' + error.message)
  if (data) { cachedKeys = { publicKey: data.public, privateJwk: data.private_jwk }; return cachedKeys }
  // Erster Lauf: Schlüssel erzeugen und im Vault ablegen (bei gleichzeitigen Läufen gewinnt der erste)
  const fresh = await generateVapidKeys()
  const { data: stored, error: e2 } = await db.rpc('push_worker_set_keys', { p_public: fresh.publicKey, p_private_jwk: fresh.privateJwk })
  if (e2 || !stored) throw new Error('set keys: ' + (e2?.message || 'leer'))
  cachedKeys = { publicKey: stored.public, privateJwk: stored.private_jwk }
  return cachedKeys
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  try {
    const keys = await getKeys()
    let total = 0
    for (let round = 0; round < 4; round++) {                 // max. 200 Nachrichten pro Aufruf
      const { data: items, error } = await db.rpc('push_worker_claim', { p_limit: 50 })
      if (error) throw new Error('claim: ' + error.message)
      if (!items?.length) break
      const results = await Promise.all(items.map(async (it: any) => {
        const message = { title: it.title, body: it.body, url: it.url || '/', tag: it.tag || undefined }
        const gone: string[] = [], delivered: string[] = []
        let ok = it.subs.length === 0          // keine Geräte mehr → erledigt
        let lastErr: string | undefined
        for (const s of it.subs) {
          const r = await sendPush(s, message, keys, SUBJECT, { topic: it.tag || undefined })
          if (r.ok) { ok = true; delivered.push(s.id) }
          else if (r.gone) gone.push(s.id)
          else lastErr = r.error
        }
        if (!ok && gone.length === it.subs.length) ok = true   // alle Geräte abgemeldet → nicht erneut versuchen
        return { id: it.id, ok, gone, delivered, error: ok ? undefined : lastErr }
      }))
      const { error: e3 } = await db.rpc('push_worker_done', { p_results: results })
      if (e3) throw new Error('done: ' + e3.message)
      total += items.length
      if (items.length < 50) break
    }
    return new Response(JSON.stringify({ ok: true, processed: total }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('send-push', (e as Error).message)
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
