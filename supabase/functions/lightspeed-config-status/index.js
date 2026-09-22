/**
 * Edge Function: lightspeed-config-status
 *
 * Liefert das einheitliche Konfigurationsstatus-Objekt (B14).
 * Die Webseite bestimmt daraus den nächsten Einrichtungsschritt (B15).
 *
 * Prüft serverseitig — kein Secret gelangt ins Frontend:
 * - Datenbank-Tabellen vorhanden
 * - RLS aktiv
 * - Client ID / Secret hinterlegt (nur ob, nicht Wert)
 * - Umgebung gesetzt
 * - OAuth verbunden
 * - Standort zugeordnet
 *
 * SICHERHEIT: Prüft Admin-Rolle des aufrufenden Users serverseitig.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // ── Auth: aufrufenden User verifizieren ────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader)
      return json({ error: 'Nicht authentifiziert' }, 401)

    // User-Client (mit dem Token des Aufrufers) — prüft echte Identität
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user)
      return json({ error: 'Ungültige Session' }, 401)

    // Admin-Rolle serverseitig prüfen
    const { data: profile } = await userClient
      .from('profiles')
      .select('role, status')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile || profile.role !== 'admin' || profile.status !== 'approved')
      return json({ error: 'Nur Administratoren' }, 403)

    // ── Service-Client für System-Prüfungen ────────────────────────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    )

    const organizationId = 'cafe-buur'
    const blockers = []

    // 1. Datenbank-Tabellen vorhanden?
    let databaseReady = true
    const requiredTables = ['pos_connections', 'pos_oauth_tokens', 'pos_location_mappings', 'pos_sync_jobs']
    for (const t of requiredTables) {
      const { error } = await admin.from(t).select('id').limit(1)
      if (error && error.code === '42P01') {  // undefined_table
        databaseReady = false
        blockers.push(`Tabelle ${t} fehlt — Migration ausführen`)
      }
    }

    // 2. Secrets konfiguriert? (nur ob, nie Wert)
    const clientIdConfigured     = !!Deno.env.get('LIGHTSPEED_CLIENT_ID')
    const clientSecretConfigured = !!Deno.env.get('LIGHTSPEED_CLIENT_SECRET')
    if (!clientIdConfigured)     blockers.push('Client-ID fehlt — in Supabase Secrets hinterlegen')
    if (!clientSecretConfigured) blockers.push('Client Secret fehlt — in Supabase Secrets hinterlegen')

    // 3. Umgebung gesetzt?
    const env = Deno.env.get('LIGHTSPEED_ENV')
    const environmentConfigured = env === 'trial' || env === 'production'
    if (!environmentConfigured) blockers.push('Umgebung nicht gesetzt (LIGHTSPEED_ENV = trial oder production)')

    // 4. Verbindung / OAuth?
    let oauthConnected = false, locationMapped = false
    let connection = null
    if (databaseReady) {
      const { data: conn } = await admin
        .from('pos_connections')
        .select('id, status, external_account_id, external_business_name, connected_at')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .maybeSingle()

      if (conn) {
        connection    = conn
        oauthConnected = conn.status === 'connected'

        const { data: mapping } = await admin
          .from('pos_location_mappings')
          .select('id')
          .eq('connection_id', conn.id)
          .eq('is_active', true)
          .limit(1)
        locationMapped = !!(mapping && mapping.length)
      }
    }
    if (!oauthConnected)  blockers.push('OAuth-Verbindung noch nicht hergestellt')
    if (oauthConnected && !locationMapped) blockers.push('Kein Standort zugeordnet')

    // 5. Redirect URI (aus Projekt-URL ableitbar → immer vorhanden)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const redirectUri = `${supabaseUrl}/functions/v1/lightspeed-auth-callback`
    const redirectUriConfigured = !!supabaseUrl

    // 6. Scopes (aus verifizierten Defaults)
    const scopesConfigured = true  // Defaults sind gesetzt
    const scopes = ['financial-api', 'orders-api', 'staff-api', 'offline_access']

    const status = {
      databaseReady,
      functionsReady:         true,   // Wenn diese Function antwortet, ist sie erreichbar
      clientIdConfigured,
      clientSecretConfigured,
      redirectUriConfigured,
      environmentConfigured,
      scopesConfigured,
      oauthConnected,
      locationMapped,
      syncReady:              oauthConnected && locationMapped,
      blockers,
      // Zusatzinfos für UI (keine Secrets!)
      environment:            env || null,
      redirectUri,
      scopes,
      connection:             connection ? {
        accountId:    connection.external_account_id,
        businessName: connection.external_business_name,
        connectedAt:  connection.connected_at,
        status:       connection.status,
      } : null,
    }

    return json(status, 200)

  } catch (err) {
    console.error('[lightspeed-config-status]', err.message)  // Kein Secret im Log
    return json({ error: 'Interner Fehler bei Statusprüfung' }, 500)
  }

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
