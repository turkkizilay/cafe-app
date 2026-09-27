import { supabase } from './supabase'
import { PAY_FIXED } from './compensation'

// Vergütungsmodell eines Mitarbeiters setzen (nur Admin per RLS). Wird nach approve_onboarding
// genutzt, da die Freischaltung serverseitig immer mit Stundenlohn anlegt.
export async function setEmployeePay(employeeId, payType, monthlySalary) {
  return supabase.from('employees')
    .update({ pay_type: payType, monthly_salary: payType === PAY_FIXED ? monthlySalary : null })
    .eq('id', employeeId)
}
