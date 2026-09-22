// ── Saving Guard — verhindert Doppel-Submit in allen async Funktionen ──
// Verwendung: const guard = useSavingGuard()
//             async function handleSave() { if (!guard.begin()) return; ... guard.end() }
import { useRef } from 'react'

export function useSavingGuard() {
  const ref = useRef(false)
  return {
    begin() {
      if (ref.current) return false
      ref.current = true
      return true
    },
    end() {
      ref.current = false
    },
    get active() {
      return ref.current
    }
  }
}
