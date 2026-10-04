// Edge Function „complete-password-change“ (Migration 38): neues Passwort nach einem Admin-Reset festlegen.
// Erst Auth (PUT /auth/v1/user mit dem JWT der Person – offizieller Endpunkt, prüft Sitzung und Passwortregeln),
// danach löscht der Server die Pflicht zur Passwortänderung. Das Passwort wird nie geloggt oder gespeichert.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { bearer, handleCompletePasswordChange, CORS, JSON_HEADERS } from '../_shared/access-reset.js'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const admin = createClient(URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })

async function changeOwnPassword(jwt: string, password: string) {
  const res = await fetch(`${URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (res.ok) return { error: null }
  const j = await res.json().catch(() => ({}))
  return { error: { code: j?.error_code || j?.code || `http_${res.status}` } }   // Meldungstext wird nicht übernommen
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, reason: 'method' }), { status: 405, headers: JSON_HEADERS })
  try {
    const jwt = bearer(req.headers.get('Authorization'))
    const body = await req.json().catch(() => null)
    const asCaller = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    const r = await handleCompletePasswordChange({
      jwt, body, changeOwnPassword,
      auth: { getUser: (j: string) => admin.auth.getUser(j) },
      userRpc: (n: string, a: Record<string, unknown>) => asCaller.rpc(n, a),
      serviceRpc: (n: string, a: Record<string, unknown>) => admin.rpc(n, a),
      log: (c: string) => console.error('complete-password-change', c),   // nur Codes
    })
    return new Response(JSON.stringify(r.body), { status: r.status, headers: JSON_HEADERS })
  } catch {
    console.error('complete-password-change', 'unhandled')
    return new Response(JSON.stringify({ ok: false, reason: 'server_error' }), { status: 500, headers: JSON_HEADERS })
  }
})
