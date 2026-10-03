import { t as tr, getIntlLocale } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'

// Live-Personalkosten (nur Admin). Werte kommen aus useLiveLaborCost (Serverbasis + lokales Fortschreiben).
// Fixgehälter sind bewusst nicht enthalten (keine Umrechnung in einen Stundenlohn) – das steht sichtbar dabei.
const eur = v => v.toLocaleString(getIntlLocale(), { style: 'currency', currency: 'EUR' })
const hrs = v => v.toLocaleString(getIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const berlinTime = iso => new Date(iso).toLocaleTimeString(getIntlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Berlin' })

export default function LiveLaborCostCard({ labor }) {
  useLocale()
  const { figures: f, base, problem } = labor
  if (!f) {
    return (
      <div className="card" style={{ marginBottom:16 }} data-testid="live-labor-cost">
        <div className="card-header"><div className="card-title">{tr("ui.9236588794e4")}</div></div>
        <div style={{ padding:'14px 20px', fontSize:13, color:'var(--text-secondary)' }}>{problem ? tr("labor.loadFailed") : tr("labor.loading")}</div>
      </div>
    )
  }
  const tiles = [
    { key: 'live', label: tr("labor.liveCost"), value: eur(f.cost), sub: tr("labor.liveCostSub", { running: f.runningHourly, onBreak: f.onBreak }), strong: true },
    { key: 'worked', label: tr("ui.af6b12601f96"), value: tr("labor.hoursValue", { hours: hrs(f.hours) }), sub: tr("labor.workedSub") },
    { key: 'planned', label: tr("ui.0f71bd36b6c8"), value: eur(f.planned), sub: tr("labor.plannedSub") },
    { key: 'week', label: tr("ui.f9ef5e928e9b"), value: eur(f.week), sub: tr("labor.weekSub") },
  ]
  return (
    <div className="card" style={{ marginBottom:16 }} data-testid="live-labor-cost">
      <div className="card-header">
        <div className="card-title">{tr("ui.9236588794e4")}</div>
        <div style={{ fontSize:11, color:'var(--text-secondary)' }} data-testid="labor-basis">{tr("labor.basis")}</div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:0 }}>
        {tiles.map(item => (
          <div key={item.key} data-kind={item.key} style={{ padding:'14px 20px', borderRight:'1px solid var(--border)' }}>
            <div style={{ fontSize:11, color:'var(--text-secondary)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em' }}>{item.label}</div>
            <div style={{ fontSize:22, fontWeight:700, color: item.strong ? 'var(--text-primary)' : 'var(--text-secondary)', fontVariantNumeric:'tabular-nums' }}>{item.value}</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{item.sub}</div>
          </div>
        ))}
        <div data-kind="usage" style={{ padding:'14px 20px', background:'var(--accent-light)' }} title={tr("labor.planUsageHint")}>
          <div style={{ fontSize:11, color:'var(--accent)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em', fontWeight:600 }}>{tr("labor.planUsage")}</div>
          <div style={{ fontSize:18, fontWeight:700, color: f.usage != null && f.usage > 100 ? 'var(--warn)' : 'var(--accent)', fontVariantNumeric:'tabular-nums' }}>
            {f.usage == null ? '–' : `${Math.round(f.usage).toLocaleString(getIntlLocale())} %`}
          </div>
          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{tr("labor.planUsageSub")}</div>
        </div>
      </div>
      <div style={{ padding:'8px 16px', fontSize:11, color:'var(--text-muted)', borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:4 }}>
        <div>{tr("labor.planUsageHint")}</div>
        {(f.fixedWorking > 0 || f.fixedShifts > 0) && <div>{tr("labor.fixedNote", { count: Math.max(f.fixedWorking, f.fixedShifts) })}</div>}
        <div data-testid="labor-asof" style={{ color: problem ? 'var(--warn)' : undefined }}>
          {problem ? tr(problem.kind === 'offline' ? "labor.staleOffline" : "labor.staleError", { time: berlinTime(base.server_now) }) : tr("labor.asOf", { time: berlinTime(base.server_now) })}
        </div>
        <div>{tr("ui.3455e09bcd65")}</div>
      </div>
    </div>
  )
}
