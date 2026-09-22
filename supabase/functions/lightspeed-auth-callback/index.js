/**
 * Edge Function: lightspeed-auth-callback
 *
 * Token-Exchange nach OAuth-Callback.
 * Client Secret bleibt IMMER server-side — niemals im Frontend.
 *
 * Ablauf:
 * 1. Authorization Code empfangen
 * 2. Token-Exchange mit Lightspeed API
 * 3. Verbindung in pos_connections anlegen
 * 4. Token in pos_oauth_tokens speichern (TODO: Vault-Encryption)
 * 5. connectionId zurückgeben
 *
 * Secrets:
 *   LIGHTSPEED_CLIENT_ID
 *   LIGHTSPEED_CLIENT_SECRET
 *   LIGHTSPEED_OAUTH_TOKEN_URL - TO_VERIFY: Token URL für K-Series
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),  // Service Role für DB-Schreibzugriff
  )

  try {
    const { code, organizationId, redirectUri } = await req.json()

    if (!code || !organizationId)
      return new Response(JSON.stringify({ error: 'code und organizationId Pflichtfelder' }), { status: 400, headers: corsHeaders })

    const clientId     = Deno.env.get('LIGHTSPEED_CLIENT_ID')
    const clientSecret = Deno.env.get('LIGHTSPEED_CLIENT_SECRET')
    // Token URL — VERIFIZIERT gegen offizielle K-Series Dokumentation
    // Quelle: https://api-portal.lsk.lightspeed.app/quick-start/authentication/authorization-overview
    const isProduction = Deno.env.get('LIGHTSPEED_ENV') !== 'trial'
    const tokenUrl = isProduction
      ? 'https://api.lsk.lightspeed.app/oauth/token'
      : 'https://api.trial.lsk.lightspeed.app/oauth/token'

    if (!clientId || !clientSecret)
      return new Response(JSON.stringify({ error: 'Lightspeed Credentials nicht konfiguriert' }), { status: 500, headers: corsHeaders })

    // ── Token-Exchange mit Lightspeed API ──────────────────────────────
    // VERIFIZIERT: K-Series verwendet Basic Auth Header (base64(client_id:client_secret))
    // Quelle: Authentication Tutorial — "client_id and client_secret must be base64 encoded
    //         and passed as the authorization header"
    // ACHTUNG: client_id/client_secret NICHT als Form-Body-Parameter!
    const basicCredentials = btoa(`${clientId}:${clientSecret}`)
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicCredentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
        // client_id + client_secret NICHT im Body — nur im Authorization Header
      }),
    })

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text()
      console.error('[lightspeed-auth-callback] Token exchange failed:', errBody)
      return new Response(JSON.stringify({ error: 'Token-Exchange fehlgeschlagen', detail: errBody }), { status: 400, headers: corsHeaders })
    }

    const tokenData = await tokenResponse.json()
    // TO_VERIFY: Genaue Felder in K-Series Token-Response
    // Token-Response-Felder — VERIFIZIERT
    // Quelle: Authentication Tutorial Response-Beispiel:
    // { "access_token": "...", "token_type": "bearer", "refresh_token": "...",
    //   "expires_in": 3599, "scope": "financial-api orders-api" }
    const { access_token, refresh_token, expires_in, scope, token_type } = tokenData

    if (!access_token)
      return new Response(JSON.stringify({ error: 'Kein Access Token in Antwort' }), { status: 400, headers: corsHeaders })

    // ── Business-Info abrufen (TO_VERIFY: K-Series Account-Endpunkt) ──
    // TO_VERIFY: Endpunkt für Business-Info
    let externalAccountId    = 'unknown'
    let externalBusinessName = ''
    // try {
    //   const accountRes = await fetch('https://api.lsretail.com/v2/account', {   // TO_VERIFY
    //     headers: { Authorization: `Bearer ${access_token}` }
    //   })
    //   const accountData = await accountRes.json()
    //   externalAccountId    = accountData.id || accountData.businessId
    //   externalBusinessName = accountData.name || accountData.businessName
    // } catch (e) { console.warn('[lightspeed-auth-callback] Kein Account-Abruf:', e.message) }

    // ── Verbindung in DB anlegen ──────────────────────────────────────
    const { data: connection, error: connErr } = await supabase
      .from('pos_connections')
      .insert({
        organization_id:       organizationId,
        provider:              'lightspeed_k_series',
        status:                'connected',
        is_active:             true,
        external_account_id:   externalAccountId,
        external_business_name: externalBusinessName,
        connected_at:          new Date().toISOString(),
      })
      .select('id')
      .single()

    if (connErr) {
      console.error('[lightspeed-auth-callback] DB insert connection:', connErr)
      return new Response(JSON.stringify({ error: 'Verbindung konnte nicht gespeichert werden' }), { status: 500, headers: corsHeaders })
    }

    // ── Token speichern ────────────────────────────────────────────────
    // TODO Vollbetrieb: Access + Refresh Token via Supabase Vault verschlüsseln
    const { error: tokenErr } = await supabase.from('pos_oauth_tokens').insert({
      connection_id: connection.id,
      access_token,
      refresh_token: refresh_token || '',
      expires_at:    new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
      scope:         scope || '',
    })

    if (tokenErr) {
      console.error('[lightspeed-auth-callback] DB insert token:', tokenErr)
      // Verbindung rückgängig machen
      await supabase.from('pos_connections').delete().eq('id', connection.id)
      return new Response(JSON.stringify({ error: 'Token konnte nicht gespeichert werden' }), { status: 500, headers: corsHeaders })
    }

    return new Response(
      JSON.stringify({ connectionId: connection.id, provider: 'lightspeed_k_series', status: 'connected' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[lightspeed-auth-callback]', err)
    return new Response(JSON.stringify({ error: 'Interner Fehler', detail: err.message }), { status: 500, headers: corsHeaders })
  }
})
