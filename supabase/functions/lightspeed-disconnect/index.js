/**
 * Edge Function: lightspeed-disconnect
 * Trennt die Lightspeed-Verbindung sicher und revisionssicher.
 * Bestehende synchronisierte Daten werden NICHT gelöscht.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
  try {
    const { connectionId, disconnectedByUserId } = await req.json()
    if (!connectionId) return new Response(JSON.stringify({ error: 'connectionId Pflichtfeld' }), { status: 400, headers: corsHeaders })

    // Verbindung als inaktiv markieren (nicht löschen — revisionssicher)
    await supabase.from('pos_connections').update({
      is_active:         false,
      status:            'disconnected',
      disconnected_at:   new Date().toISOString(),
      disconnected_by:   disconnectedByUserId || null,
      disconnected_reason: 'manual',
    }).eq('id', connectionId)

    // Token löschen (Sicherheit — Token darf nicht weiter verwendet werden)
    await supabase.from('pos_oauth_tokens').delete().eq('connection_id', connectionId)

    // BLOCKER: Lightspeed K-Series Token-Revocation-Endpunkt nicht in offizieller Doku dokumentiert.
    // Nach API-Client-Registrierung prüfen ob /oauth/revoke oder ähnliches verfügbar.
    // Bis dahin: Tokens in DB löschen + Reconnect erzwingen (ausreichend für Pilot)

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders })
  }
})
