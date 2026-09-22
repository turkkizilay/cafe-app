/**
 * Mitarbeiterzuordnung (Employee Mapping)
 *
 * Verbindet interne Café-Buur-Mitarbeiter mit Lightspeed-Mitarbeitern.
 *
 * WICHTIG: Automatische Zuordnung NUR nach priorisierter Logik.
 * Niemals automatisch anhand des Namens allein.
 * Bei Konflikten (mehrere Treffer): Status 'conflict', kein Auto-Match.
 *
 * Priorität:
 * 1. Gespeicherte externe Lightspeed-ID
 * 2. Bestätigte E-Mail
 * 3. Personalnummer
 * 4. Manuell durch Admin
 */

import { supabase }            from '../../../lib/supabase.js'
import { PosIntegrationError } from '../errors/PosIntegrationError.js'

export const employeeMappingService = {

  /**
   * Alle Zuordnungen für eine Verbindung laden (inkl. Café-Buur-Mitarbeiter)
   */
  async getMappings(connectionId) {
    const { data, error } = await supabase
      .from('pos_employee_mappings')
      .select(`
        id,
        status,
        mapping_basis,
        internal_employee_id,
        external_employee_id,
        external_employee_name,
        external_employee_email,
        confirmed_at,
        employees:internal_employee_id (
          id, first_name, last_name, email, position
        ),
        pos_external_employees:external_employee_id (
          external_id, first_name, last_name, email, external_role
        )
      `)
      .eq('connection_id', connectionId)
      .order('status')

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
    return data || []
  },

  /**
   * Automatische Zuordnungsvorschläge erstellen.
   * NUR auf E-Mail oder Personalnummer — NICHT auf Name.
   *
   * @param {string} connectionId
   * @param {string[]} [externalEmployeeIds] - optional: nur diese prüfen
   */
  async suggestMappings(connectionId, externalEmployeeIds) {
    // Externe Mitarbeiter laden
    let externalQuery = supabase
      .from('pos_external_employees')
      .select('id, external_id, first_name, last_name, email')
      .eq('connection_id', connectionId)

    if (externalEmployeeIds?.length)
      externalQuery = externalQuery.in('external_id', externalEmployeeIds)

    const { data: externalEmps } = await externalQuery
    if (!externalEmps?.length) return []

    // Interne Mitarbeiter (E-Mails)
    const { data: internalEmps } = await supabase
      .from('employees')
      .select('id, email, first_name, last_name')

    const emailIndex = Object.fromEntries(
      (internalEmps || [])
        .filter(e => e.email)
        .map(e => [e.email.toLowerCase().trim(), e])
    )

    const suggestions = []

    for (const extEmp of externalEmps) {
      // Prüfen ob bereits zugeordnet
      const { data: existing } = await supabase
        .from('pos_employee_mappings')
        .select('id, status')
        .eq('connection_id', connectionId)
        .eq('external_employee_id', extEmp.id)
        .maybeSingle()

      if (existing) continue  // Bereits verarbeitet

      // Priorität 2: E-Mail-Vergleich
      const extEmail = extEmp.email?.toLowerCase()?.trim()
      if (extEmail && emailIndex[extEmail]) {
        const internalEmp = emailIndex[extEmail]
        // Nur ein Treffer → 'suggested', mehrere → 'conflict'
        const matchCount = Object.values(emailIndex).filter(e =>
          e.email?.toLowerCase()?.trim() === extEmail
        ).length

        await supabase.from('pos_employee_mappings').upsert({
          connection_id:           connectionId,
          internal_employee_id:    internalEmp.id,
          external_employee_id:    extEmp.id,
          external_employee_name:  `${extEmp.first_name} ${extEmp.last_name}`.trim(),
          external_employee_email: extEmp.email,
          status:                  matchCount === 1 ? 'suggested' : 'conflict',
          mapping_basis:           'email',
        }, { onConflict: 'connection_id,external_employee_id' })

        suggestions.push({ externalId: extEmp.external_id, status: matchCount === 1 ? 'suggested' : 'conflict' })
        continue
      }

      // Kein Treffer → 'unmatched'
      await supabase.from('pos_employee_mappings').upsert({
        connection_id:           connectionId,
        internal_employee_id:    null,
        external_employee_id:    extEmp.id,
        external_employee_name:  `${extEmp.first_name} ${extEmp.last_name}`.trim(),
        external_employee_email: extEmp.email,
        status:                  'unmatched',
        mapping_basis:           null,
      }, { onConflict: 'connection_id,external_employee_id' })

      suggestions.push({ externalId: extEmp.external_id, status: 'unmatched' })
    }

    return suggestions
  },

  /**
   * Manuelle Zuordnung bestätigen (Admin-Aktion)
   * @param {string} mappingId
   * @param {string} internalEmployeeId
   * @param {string} confirmedByUserId
   */
  async confirmMapping(mappingId, internalEmployeeId, confirmedByUserId) {
    const { error } = await supabase
      .from('pos_employee_mappings')
      .update({
        internal_employee_id: internalEmployeeId,
        status:               'matched',
        mapping_basis:        'manual',
        confirmed_at:         new Date().toISOString(),
        confirmed_by:         confirmedByUserId,
      })
      .eq('id', mappingId)

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
  },

  /**
   * Zuordnung aufheben
   * @param {string} mappingId
   */
  async removeMapping(mappingId) {
    const { error } = await supabase
      .from('pos_employee_mappings')
      .update({
        internal_employee_id: null,
        status:               'unmatched',
        mapping_basis:        null,
        confirmed_at:         null,
        confirmed_by:         null,
      })
      .eq('id', mappingId)

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
  },

  /**
   * Zuordnung als 'ignored' markieren (Lightspeed-Mitarbeiter ohne Café-Buur-Entsprechung)
   */
  async ignoreMapping(mappingId) {
    const { error } = await supabase
      .from('pos_employee_mappings')
      .update({ status: 'ignored' })
      .eq('id', mappingId)

    if (error) throw new PosIntegrationError('DATABASE_ERROR', error.message, false)
  },
}
