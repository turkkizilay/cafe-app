/**
 * Edge Function: lightspeed-sync
 *
 * Führt die eigentliche Datensynchronisation durch.
 * Läuft server-side — kein Client-Timeout-Problem.
 *
 * Ablauf pro Ressource:
 * 1. Token laden + ggf. refreshen
 * 2. Lightspeed API paginiert abfragen (TO_VERIFY: Endpunkte)
 * 3. Daten mappen via Adapter
 * 4. In pos_* Tabellen upserten
 * 5. Mitarbeiterzuordnungen aktualisieren (nach E-Mail)
 * 6. Sync-Job Status + Items aktualisieren
 * 7. Fehler in pos_sync_errors schreiben
 *
 * TO_VERIFY vor Live-Betrieb:
 * - Lightspeed K-Series API Endpunkte (alle mit TO_VERIFY markiert)
 * - Pagination-Parameter (page vs. cursor-based)
 * - Datums-Filter für Delta-Sync (updated_since o.ä.)
 * - Verfügbare Ressourcen/Felder
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
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  )

  try {
    const { syncJobId, connectionId, locationId, resources, syncMode, triggeredBy } = await req.json()

    // ── Job auf 'running' setzen ──────────────────────────────────────
    await supabase.from('pos_sync_jobs').update({
      status:     'running',
      started_at: new Date().toISOString(),
    }).eq('id', syncJobId)

    // ── Token laden ───────────────────────────────────────────────────
    const { data: tokenRow } = await supabase
      .from('pos_oauth_tokens')
      .select('access_token, refresh_token, expires_at')
      .eq('connection_id', connectionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!tokenRow) {
      await failJob(supabase, syncJobId, 'TOKEN_REFRESH_FAILED', 'Kein Token für Verbindung gefunden')
      return errResponse('Kein Token gefunden', corsHeaders)
    }

    // Token ggf. refreshen
    let accessToken = tokenRow.access_token
    if (new Date(tokenRow.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
      const refreshed = await refreshToken(supabase, connectionId, tokenRow.refresh_token)
      if (!refreshed) {
        await failJob(supabase, syncJobId, 'TOKEN_REFRESH_FAILED', 'Token-Refresh fehlgeschlagen')
        return errResponse('Token-Refresh fehlgeschlagen', corsHeaders)
      }
      accessToken = refreshed
    }

    // ── Externe Location ID laden ─────────────────────────────────────
    const { data: locMapping } = await supabase
      .from('pos_location_mappings')
      .select('external_location_id')
      .eq('id', locationId)
      .single()

    if (!locMapping) {
      await failJob(supabase, syncJobId, 'LOCATION_NOT_MAPPED', 'Standort-Zuordnung nicht gefunden')
      return errResponse('Standort nicht gefunden', corsHeaders)
    }

    const externalLocationId = locMapping.external_location_id

    // ── Ressourcen synchronisieren ────────────────────────────────────
    let totalCreated = 0, totalUpdated = 0, totalFailed = 0

    for (const resource of resources) {
      const itemResult = await syncResource(supabase, {
        syncJobId, connectionId, locationId,
        externalLocationId, accessToken, resource, syncMode,
      })
      totalCreated += itemResult.created
      totalUpdated += itemResult.updated
      totalFailed  += itemResult.failed
    }

    // ── Job abschließen ───────────────────────────────────────────────
    await supabase.from('pos_sync_jobs').update({
      status:          totalFailed > 0 && totalCreated + totalUpdated === 0 ? 'failed' : totalFailed > 0 ? 'partial' : 'success',
      records_created: totalCreated,
      records_updated: totalUpdated,
      records_failed:  totalFailed,
      records_total:   totalCreated + totalUpdated + totalFailed,
      completed_at:    new Date().toISOString(),
    }).eq('id', syncJobId)

    return new Response(
      JSON.stringify({ success: true, syncJobId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('[lightspeed-sync]', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders })
  }
})

// ── Einzelne Ressource synchronisieren ───────────────────────────────────────
async function syncResource(supabase, { syncJobId, connectionId, locationId, externalLocationId, accessToken, resource, syncMode }) {

  // Job-Item anlegen
  const { data: jobItem } = await supabase.from('pos_sync_job_items').insert({
    sync_job_id: syncJobId, resource, status: 'running', started_at: new Date().toISOString()
  }).select('id').single()

  let created = 0, updated = 0, failed = 0, total = 0

  try {
    // API Base URL — VERIFIZIERT
    // Quelle: https://api-docs.lsk.lightspeed.app/
    const isProduction = Deno.env.get('LIGHTSPEED_ENV') !== 'trial'
    const apiBase = isProduction
      ? 'https://api.lsk.lightspeed.app'
      : 'https://api.trial.lsk.lightspeed.app'

    // BLOCKER: Genaue Endpunkt-Pfade für K-Series Financial/Orders/Staff APIs
    // müssen nach API-Client-Registrierung aus https://api-docs.lsk.lightspeed.app/ bestätigt werden.
    // Verifiziert: K-Series hat financial-api, orders-api, staff-api Scopes.
    // Pagination: HATEOAS _links mit 'nextPage' URL (pageSize max 1000)
    // Quelle: https://api-docs.lsk.lightspeed.app/group/endpoint-financial
    //
    // Die Endpunkte unten sind NOCH NICHT VERIFIZIERT — Blocker bis API-Client vorliegt.
    const endpoints = {
      // BLOCKER: Alle Pfade ohne API-Client nicht bestätigbar
      // Vorläufige Struktur basierend auf API-Docs-Kategorien:
      // financial: apiBase + '/...' (financial-api scope)
      // orders:    apiBase + '/...' (orders-api scope)
      // staff:     apiBase + '/...' (staff-api scope)
    }

    const endpoint = endpoints[resource]
    if (!endpoint) {
      // Ressource noch nicht implementiert — sauber überspringen
      console.warn(`[lightspeed-sync] Ressource '${resource}' noch nicht implementiert — API-Client-Zugang nötig`)
      return { created: 0, updated: 0, failed: 0 }
    }

    // Pagination — VERIFIZIERT: K-Series Financial API nutzt HATEOAS _links
    // Quelle: Financial API Docs — "Uses HATEOAS _links with self and nextPage URLs"
    // KEIN page/offset Parameter — nextPage URL aus Response verwenden
    let nextUrl = `${endpoint}?pageSize=100`, hasMore = true
    while (hasMore && nextUrl) {
      const res = await fetch(nextUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`API ${res.status}: ${errText}`)
      }

      const data = await res.json()
      // HATEOAS Pagination — VERIFIZIERT: nextPage URL in _links
      const items   = data.data || data.items || (Array.isArray(data) ? data : [])
      const nextPage = data._links?.nextPage

      for (const item of items) {
        try {
          const result = await upsertResource(supabase, resource, connectionId, locationId, item)
          if (result === 'created') created++
          else updated++
        } catch (itemErr) {
          failed++
          await supabase.from('pos_sync_errors').insert({
            connection_id: connectionId,
            sync_job_id:   syncJobId,
            resource,
            external_id:   item.id,
            error_code:    'VALIDATION_FAILED',
            error_message: itemErr.message,
            payload:       item,
          })
        }
        total++
      }

      nextUrl = nextPage || null
      hasMore = !!nextPage
    }

    // Job-Item abschließen
    await supabase.from('pos_sync_job_items').update({
      status: failed > 0 && created + updated === 0 ? 'failed' : failed > 0 ? 'partial' : 'success',
      records_total: total, records_created: created, records_updated: updated, records_failed: failed,
      completed_at: new Date().toISOString(),
    }).eq('id', jobItem?.id)

  } catch (err) {
    console.error(`[lightspeed-sync] ${resource}:`, err)
    failed++
    if (jobItem) {
      await supabase.from('pos_sync_job_items').update({
        status: 'failed', error_message: err.message, completed_at: new Date().toISOString()
      }).eq('id', jobItem.id)
    }
  }

  return { created, updated, failed }
}

// ── Ressource in DB schreiben ─────────────────────────────────────────────────
async function upsertResource(supabase, resource, connectionId, locationId, raw) {
  const tables = {
    locations:  'pos_external_locations',
    employees:  'pos_external_employees',
    products:   'pos_external_products',
    categories: 'pos_external_categories',
    registers:  'pos_external_registers',
    sales:      'pos_sales',
  }
  const table = tables[resource]
  if (!table) return 'updated'

  // Basis-Mapping — TO_VERIFY Feldnamen für K-Series
  let row = {
    connection_id:   connectionId,
    external_id:     raw.id,
    raw_data:        raw,
    last_synced_at:  new Date().toISOString(),
  }

  // Ressource-spezifische Felder
  if (resource === 'locations')  row = { ...row, name: raw.name || '', address: raw.address || null, active: raw.active !== false }
  if (resource === 'employees')  row = { ...row, first_name: raw.firstName || raw.first_name || '', last_name: raw.lastName || raw.last_name || '', email: raw.email || null, active: raw.active !== false }
  if (resource === 'products')   row = { ...row, name: raw.name || '', price_net: Math.round((parseFloat(raw.price || 0)) * 100), tax_rate: raw.taxRate || 7, available: raw.available !== false }
  if (resource === 'categories') row = { ...row, name: raw.name || '' }
  if (resource === 'registers')  row = { ...row, name: raw.name || '', external_location_id: raw.locationId || null, active: raw.active !== false }

  const { data: existing } = await supabase.from(table).select('id').eq('connection_id', connectionId).eq('external_id', raw.id).maybeSingle()
  await supabase.from(table).upsert(row, { onConflict: 'connection_id,external_id' })
  return existing ? 'updated' : 'created'
}

async function refreshToken(supabase, connectionId, refreshToken) {
  const clientId     = Deno.env.get('LIGHTSPEED_CLIENT_ID')
  const clientSecret = Deno.env.get('LIGHTSPEED_CLIENT_SECRET')
  const tokenUrl     = Deno.env.get('LIGHTSPEED_OAUTH_TOKEN_URL') || 'https://cloud.lightspeedapp.com/oauth/token'  // TO_VERIFY

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  })
  if (!res.ok) return null
  const data = await res.json()
  if (!data.access_token) return null
  await supabase.from('pos_oauth_tokens').upsert({ connection_id: connectionId, access_token: data.access_token, refresh_token: data.refresh_token || refreshToken, expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString() }, { onConflict: 'connection_id' })
  return data.access_token
}

async function failJob(supabase, syncJobId, errorCode, errorMessage) {
  await supabase.from('pos_sync_jobs').update({ status: 'failed', error_code: errorCode, error_message: errorMessage, completed_at: new Date().toISOString() }).eq('id', syncJobId)
}

function errResponse(message, headers) {
  return new Response(JSON.stringify({ error: message }), { status: 400, headers })
}
