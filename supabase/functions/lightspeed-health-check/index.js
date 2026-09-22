/**
 * Edge Function: lightspeed-health-check
 * Testet ob die Lightspeed-Verbindung noch funktioniert.
 * TO_VERIFY: Welcher Endpunkt für K-Series als Health-Check geeignet ist.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
  const start = Date.now()
  try {
    const { connectionId } = await req.json()
    const { data: tokenRow } = await supabase.from('pos_oauth_tokens').select('access_token').eq('connection_id', connectionId).order('created_at', { ascending: false }).limit(1).single()
    if (!tokenRow) return new Response(JSON.stringify({ healthy: false, status: 'error', errorCode: 'TOKEN_REFRESH_FAILED', errorMessage: 'Kein Token', responseTimeMs: Date.now()-start, checkedAt: new Date().toISOString() }), { status: 200, headers: corsHeaders })

    // TO_VERIFY: Welcher K-Series Endpunkt als Health-Check geeignet
    const apiBase = Deno.env.get('LIGHTSPEED_API_BASE') || 'https://api.lsretail.com'
    const res = await fetch(`${apiBase}/v2/account`, { headers: { Authorization: `Bearer ${tokenRow.access_token}` } })  // TO_VERIFY

    const healthy = res.ok
    return new Response(JSON.stringify({ healthy, status: healthy ? 'connected' : 'error', errorCode: healthy ? null : `HTTP_${res.status}`, responseTimeMs: Date.now()-start, checkedAt: new Date().toISOString() }), { status: 200, headers: corsHeaders })
  } catch (err) {
    return new Response(JSON.stringify({ healthy: false, status: 'error', errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: err.message, responseTimeMs: Date.now()-start, checkedAt: new Date().toISOString() }), { status: 200, headers: corsHeaders })
  }
})
