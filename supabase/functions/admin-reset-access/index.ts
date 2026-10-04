// Edge Function „admin-reset-access“ (Migration 38): Admin setzt den App-Zugang eines Mitarbeiters zurück.
// Der Service-Schlüssel existiert nur hier (von Supabase gesetzt). Das temporäre Passwort steht ausschließlich in
// der Antwort dieser einen Anfrage – nie im Log, nie in der Datenbank.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { bearer, handleAdminReset, CORS, JSON_HEADERS } from '../_shared/access-reset.js'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const admin = createClient(URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, reason: 'method' }), { status: 405, headers: JSON_HEADERS })
  try {
    const jwt = bearer(req.headers.get('Authorization'))
    const body = await req.json().catch(() => null)
    const asCaller = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    const r = await handleAdminReset({
      jwt, body,
      auth: {
        getUser: (j: string) => admin.auth.getUser(j),
        updatePassword: (id: string, pw: string) => admin.auth.admin.updateUserById(id, { password: pw }),
      },
      userRpc: (n: string, a: Record<string, unknown>) => asCaller.rpc(n, a),
      serviceRpc: (n: string, a: Record<string, unknown>) => admin.rpc(n, a),
      log: (c: string) => console.error('admin-reset-access', c),   // nur Codes
    })
    return new Response(JSON.stringify(r.body), { status: r.status, headers: JSON_HEADERS })
  } catch {
    console.error('admin-reset-access', 'unhandled')
    return new Response(JSON.stringify({ ok: false, reason: 'server_error' }), { status: 500, headers: JSON_HEADERS })
  }
})
