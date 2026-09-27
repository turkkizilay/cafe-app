import { t as tr } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { canHaveFixedPay, PAY_HOURLY, PAY_FIXED } from '../lib/compensation'

// Vergütung (Stundenlohn / Fixgehalt) – gleiche Regeln wie Mitarbeiterformular und Migration 18.
// Fixgehalt nur bei Vollzeit/Teilzeit; der Stundenlohn bleibt technisch Pflicht (interner Satz).
export default function PayModelFields({ employmentType, payType, monthlySalary, onChange, name = 'pay_type' }) {
  useLocale()
  const fixedOk = canHaveFixedPay(employmentType)
  const isFixed = payType === PAY_FIXED
  return (
    <div className="two-col">
      <div className="form-group">
        <label>{tr("payModel.label")}</label>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
            <input type="radio" name={name} checked={!isFixed} onChange={() => onChange({ pay_type: PAY_HOURLY })} />{tr("payModel.hourly")}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, opacity: fixedOk ? 1 : 0.5 }}>
            <input type="radio" name={name} checked={isFixed} disabled={!fixedOk} onChange={() => onChange({ pay_type: PAY_FIXED })} />{tr("payModel.fixed")}
          </label>
        </div>
        {!fixedOk && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{tr("payModel.fixedNotAllowed")}</div>}
      </div>
      {isFixed && (
        <div className="form-group">
          <label>{tr("payModel.monthlySalary")}</label>
          <input type="number" step="0.01" min="0" inputMode="decimal" value={monthlySalary ?? ''} onChange={e => onChange({ monthly_salary: e.target.value })} />
        </div>
      )}
    </div>
  )
}
