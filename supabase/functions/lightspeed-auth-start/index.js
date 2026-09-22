/**
 * Edge Function: lightspeed-auth-start
 *
 * Startet den OAuth-Flow für Lightspeed K-Series.
 * Gibt die Authorization URL zurück — Redirect erfolgt im Browser.
 *
 * WICHTIG: Client ID und Scopes kommen aus Supabase Secrets.
 * NIEMALS Client Secret oder Tokens im Browser exponieren.
 *
 * Secrets (in Supabase Dashboard → Project Settings → Edge Functions → Secrets):
 *   LIGHTSPEED_CLIENT_ID     - OAuth Client ID
 *   LIGHTSPEED_OAUTH_AUTH_URL - TO_VERIFY: Authorization URL für K-Series
 *
 * Aufruf: supabase.functions.invoke('lightspeed-auth-start', { body: {...} })
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { organizationId, state, redirectUri, scopes, provider } = await req.json()

    // Eingaben validieren
    if (!organizationId || !state || !redirectUri)
      return new Response(JSON.stringify({ error: 'organizationId, state und redirectUri sind Pflichtfelder' }), { status: 400, headers: corsHeaders })

    if (provider !== 'lightspeed_k_series')
      return new Response(JSON.stringify({ error: `Provider '${provider}' nicht unterstützt` }), { status: 400, headers: corsHeaders })

    // Client ID aus Supabase Secrets
    const clientId = Deno.env.get('LIGHTSPEED_CLIENT_ID')
    if (!clientId)
      return new Response(JSON.stringify({ error: 'LIGHTSPEED_CLIENT_ID nicht konfiguriert' }), { status: 500, headers: corsHeaders })

    // Authorization URL — VERIFIZIERT gegen offizielle K-Series Dokumentation
    // Quelle: https://api-portal.lsk.lightspeed.app/quick-start/authentication/authorization-overview
    const isProduction = Deno.env.get('LIGHTSPEED_ENV') !== 'trial'
    const authBase = isProduction
      ? 'https://api.lsk.lightspeed.app/oauth/authorize'
      : 'https://api.trial.lsk.lightspeed.app/oauth/authorize'

    // Scopes — VERIFIZIERT
    // Quelle: https://api-portal.lsk.lightspeed.app/quick-start/authentication/access-scopes
    const defaultScopes = ['financial-api', 'orders-api', 'staff-api', 'offline_access']
    const requestedScopes = scopes?.length ? scopes : defaultScopes

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      redirect_uri:  redirectUri,
      scope:         requestedScopes.join(' '),
      state,
    })

    const authorizationUrl = `${authBase}?${params}`

    return new Response(
      JSON.stringify({ authorizationUrl, provider, state }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[lightspeed-auth-start]', err)
    return new Response(
      JSON.stringify({ error: 'Interner Fehler', detail: err.message }),
      { status: 500, headers: corsHeaders }
    )
  }
})
