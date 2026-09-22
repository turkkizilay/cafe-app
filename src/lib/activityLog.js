/**
 * activityLog.js — Zentraler Logging-Service für das Aktivitätsprotokoll
 *
 * Schreibt Audit-Log-Einträge über die serverseitige Funktion log_activity().
 * Die actor-Identität (wer) wird IMMER serverseitig aus auth.uid() bestimmt —
 * der Client liefert nur den Inhalt (was), niemals wer.
 *
 * WICHTIG: Logging darf die eigentliche Aktion NIEMALS blockieren.
 * Alle Aufrufe sind in try/catch gekapselt; Fehler landen nur in der Konsole.
 *
 * Sensible Daten (Passwörter, Tokens, Gehaltsbeträge, Attest-Inhalte)
 * dürfen NIEMALS in summary oder metadata landen.
 */

import { supabase } from './supabase'

/**
 * Schreibt einen Protokolleintrag.
 *
 * @param {Object} entry
 * @param {string} entry.action       - Maschinen-Code, z.B. 'vacation.approved'
 * @param {string} entry.category     - 'auth'|'vacation'|'sick_leave'|'payroll'|'employee'|'time'|'settings'|'integration'|'document'
 * @param {string} entry.summary      - Fertiger deutscher Satz
 * @param {string} [entry.targetType] - Betroffene Entität
 * @param {string} [entry.targetId]
 * @param {string} [entry.targetName] - Klartext-Name des Betroffenen
 * @param {Object} [entry.metadata]   - Zusatzdaten (KEINE Secrets/Beträge)
 * @returns {Promise<void>}
 */
export async function logActivity({ action, category, summary, targetType, targetId, targetName, metadata }) {
  try {
    if (!action || !category || !summary) return  // Pflichtfelder

    await supabase.rpc('log_activity', {
      p_action:      action,
      p_category:    category,
      p_summary:     summary,
      p_target_type: targetType || null,
      p_target_id:   targetId   != null ? String(targetId) : null,
      p_target_name: targetName || null,
      p_metadata:    metadata   || null,
    })
  } catch (err) {
    // Logging-Fehler dürfen die eigentliche Aktion nie blockieren
    console.error('[activityLog] Eintrag fehlgeschlagen:', err?.message)
  }
}

/**
 * Kategorien für Filter und Anzeige.
 */
export const LOG_CATEGORIES = {
  auth:        { label: 'Anmeldung',    icon: '🔐', color: '#6B7280', bg: '#F9FAFB' },
  vacation:    { label: 'Urlaub',       icon: '🌴', color: '#059669', bg: '#ECFDF5' },
  sick_leave:  { label: 'Krankmeldung', icon: '🤒', color: '#D97706', bg: '#FFFBEB' },
  payroll:     { label: 'Lohn',         icon: '💶', color: '#2563EB', bg: '#EFF6FF' },
  employee:    { label: 'Mitarbeiter',  icon: '👤', color: '#7C3AED', bg: '#F5F3FF' },
  time:        { label: 'Zeiten',       icon: '⏱️', color: '#0891B2', bg: '#ECFEFF' },
  settings:    { label: 'Einstellungen',icon: '⚙️', color: '#6B7280', bg: '#F9FAFB' },
  integration: { label: 'Integration',  icon: '🔌', color: '#0D9488', bg: '#F0FDFA' },
  document:    { label: 'Dokument',     icon: '📄', color: '#2563EB', bg: '#EFF6FF' },
}

/**
 * Cleanup-Trigger für die 12-Monats-Frist (nicht-blockierend).
 * Wird beim Öffnen der Protokoll-Seite aufgerufen, falls kein pg_cron läuft.
 */
export async function triggerLogCleanup() {
  try {
    await supabase.rpc('cleanup_old_activity_logs')
  } catch (err) {
    // Nicht kritisch — Cleanup läuft beim nächsten Mal erneut
    console.error('[activityLog] Cleanup übersprungen:', err?.message)
  }
}
