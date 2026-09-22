/**
 * @param {Object} raw - Lightspeed API response employee
 * @returns {import('../types/index.js').LightspeedEmployee}
 */
export function mapEmployee(raw) {
  return {
    id:        raw.id,
    firstName: raw.firstname  || raw.first_name || '',
    lastName:  raw.lastname   || raw.last_name  || '',
    email:     raw.email      || '',
    role:      mapRole(raw.role),
    active:    raw.deleted !== true,
    cafeEmpId: null,  // wird später durch E-Mail-Lookup gefüllt
  }
}

function mapRole(role) {
  if (!role) return 'cashier'
  const r = String(role).toLowerCase()
  if (r.includes('owner') || r.includes('admin')) return 'owner'
  if (r.includes('manager'))                       return 'manager'
  return 'cashier'
}
