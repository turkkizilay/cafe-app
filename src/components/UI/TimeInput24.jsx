import { useRef, useState } from 'react'
import { parseCompleteTime24, sanitizeTimeDraft } from '../../lib/time24'

// Uhrzeit-Eingabe im 24-Stunden-Format (HH:MM), identisch in Chrome, Safari (macOS/iOS) und Firefox.
// Nach außen gibt es nur „HH:MM“ (vollständig + gültig) oder „“ – nie einen halben Wert. Gültig ist nur eine
// vollständige Uhrzeit („18:00“, „1800“, „8:30“, „8.30“); Kurzformen wie „18“ bleiben unvollständig (rot + Hinweis).
// Das Verlassen des Feldes ändert NIE den Formularwert, sondern formatiert nur die Anzeige („8:30“ → „08:30“):
// Ein Wert, der erst beim Blur entsteht, lässt Vorschau/Warnungen erscheinen und verschiebt den Speichern-Button
// zwischen Drücken und Loslassen der Maus – der Klick ginge verloren (im Browser nachgewiesen).
// Zweites Argument von onChange: { incomplete } – true, wenn im Feld etwas steht, das keine vollständige Uhrzeit ist.
// Formulare, in denen „leer“ eine Bedeutung hat (z. B. offene Schicht), müssen damit Speichern verhindern.
export default function TimeInput24({ value, onChange, invalidText, ...rest }) {
  const [draft, setDraft] = useState(value || '')
  const [seenValue, setSeenValue] = useState(value || '')
  const [touched, setTouched] = useState(false)

  // Wert von außen (z. B. Schicht/Eintrag zum Bearbeiten geladen) sofort im selben Render übernehmen – aber nicht,
  // solange der Entwurf ihn schon darstellt oder noch getippt wird (sonst würde die Eingabe überschrieben)
  if ((value || '') !== seenValue) {
    setSeenValue(value || '')
    if ((parseCompleteTime24(draft) || '') !== (value || '')) setDraft(value || '')
  }

  const invalid = touched && draft !== '' && !parseCompleteTime24(draft)
  // Zuletzt gemeldetes „unvollständig“: Wird ein Teilwert („16:0“ … „1“) ganz gelöscht, bleibt der Wert '' gleich –
  // die Rückkehr zu „vollständig/leer“ muss trotzdem gemeldet werden, sonst bleibt das Formular blockiert
  const reportedIncomplete = useRef(false)
  const emit = (v, incomplete) => {
    if (v !== (value || '') || incomplete || reportedIncomplete.current) onChange(v, { incomplete })
    reportedIncomplete.current = incomplete
  }

  return (
    <>
      <input
        type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={5} placeholder="HH:MM"
        {...rest}
        value={draft}
        aria-invalid={invalid || undefined}
        style={invalid ? { borderColor: 'var(--danger)' } : undefined}
        onChange={e => {
          const next = sanitizeTimeDraft(e.target.value)
          setDraft(next)
          const p = parseCompleteTime24(next)
          emit(p || '', next !== '' && !p)
        }}
        onBlur={() => {
          setTouched(true)
          const p = parseCompleteTime24(draft)
          if (p && p !== draft) setDraft(p)   // nur Anzeige („8:30“ → „08:30“); der Wert ist schon beim Tippen übernommen
        }}
        onFocus={e => {
          rest.onFocus?.(e)
          // Touch (Handy/PWA): beim Antippen den ganzen Wert markieren – neue Ziffern ersetzen ihn. Sonst landen Ziffern
          // in einem vollen „15:15“ (maxLength) im Nichts, und nach Löschen des „:“ entsteht „15315“, das die
          // Ziffern-Tastatur (ohne „:“) nicht mehr reparieren kann. Erneutes Antippen setzt den Cursor wie gewohnt.
          const el = e.currentTarget
          if (el.value && window.matchMedia?.('(pointer: coarse)').matches) setTimeout(() => { if (document.activeElement === el) el.select() }, 0)
        }}
      />
      {/* Hinweis ohne Layout-Verschiebung (liegt im Abstand unter dem Feld) */}
      {invalid && invalidText && <div style={{ position: 'relative', height: 0 }}><div style={{ position: 'absolute', top: 2, left: 0, right: 0, fontSize: 11, lineHeight: 1.3, color: 'var(--danger)' }}>{invalidText}</div></div>}
    </>
  )
}
