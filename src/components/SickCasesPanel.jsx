import { t as tr, message as appMessage, messageParts, errorMessage, localizeMessage } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDate } from '../i18n/format.js'
import { useToast } from './UI/Toast'
import { suggestGroups, buildContext, reasonProblem, RELATIONS, RELATION_BASES, EAU_KINDS, REASON_MAX } from '../lib/sickCases.js'
import { loadSickCaseData, confirmSickCase, removeFromSickCase, setSickCaseRelation, setSickEauKind } from '../lib/sickCasesApi.js'

// Krankheitsfälle Phase A: bestätigte Fälle + unverbindliche Vorschläge. Admin bestätigt/löst/legt Beziehungen fest,
// Manager sehen nur die Gruppierung. Keine Lohnwirkung (Lohnabrechnung liest diese Daten nicht).
const range = rs => {
  const s = rs.map(r => r.start_date).sort()[0]
  const open = rs.some(r => !r.end_date)
  const e = open ? null : rs.map(r => r.end_date).sort().pop()
  return `${formatDate(s)} – ${e ? formatDate(e) : tr('sickCase.open')}`
}
const errText = r => r.code ? appMessage(`sickCase.err.${r.code}`) : messageParts([appMessage('sickCase.failed'), errorMessage(r.error) || r.message || ''])

export default function SickCasesPanel({ sick, vacations, isAdmin, onChanged }) {
  useLocale()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState(null)   // { caseId, revision, employeeId, relation, prior, basis, reason, error }
  const seq = useRef(0)
  const key = sick.map(s => `${s.id}:${s.case_id || ''}:${s.eau_kind || ''}:${s.end_date || ''}`).join('|')

  useEffect(() => {
    const my = ++seq.current
    loadSickCaseData(sick).then(r => { if (my !== seq.current) return; if (r.ok) { setData(r); setFailed(false) } else setFailed(true) })
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps

  const byEmployee = useMemo(() => {
    if (!data) return []
    const groups = new Map()
    for (const s of sick) {
      if (!groups.has(s.employee_id)) groups.set(s.employee_id, { employeeId: s.employee_id, name: `${s.employees?.first_name || ''} ${s.employees?.last_name || ''}`.trim(), records: [] })
      groups.get(s.employee_id).records.push(s)
    }
    return [...groups.values()].map(g => {
      const ctx = buildContext(g.employeeId, { shifts: data.shifts, timeEntries: data.timeEntries, vacations, holidays: data.holidays })
      const cases = data.cases.filter(c => c.employee_id === g.employeeId).map(c => ({ ...c, records: g.records.filter(r => r.case_id === c.id).sort((a, b) => a.start_date.localeCompare(b.start_date)), relation: data.relations.find(x => x.case_id === c.id) }))
        .filter(c => c.records.length).sort((a, b) => a.records[0].start_date.localeCompare(b.records[0].start_date))
      return { ...g, cases, suggestions: suggestGroups(g.records, ctx) }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }, [data, sick, vacations])

  async function run(fn, ok = 'sickCase.saved') {
    if (busy) return false
    setBusy(true)
    try {
      const r = await fn()
      if (!r.ok) { toast.error(errText(r), 9000); if (r.conflict) onChanged?.(); return false }
      toast.success(appMessage(ok)); onChanged?.(); return true
    } finally { setBusy(false) }
  }

  async function saveRelation() {
    const d = dialog
    if (d.relation !== 'unknown') {
      if (!d.basis) { setDialog({ ...d, error: 'sickCase.err.basis' }); return }
      const p = reasonProblem(d.reason); if (p) { setDialog({ ...d, error: p }); return }
      if (d.relation === 'same_illness' && !d.prior) { setDialog({ ...d, error: 'sickCase.err.prior' }); return }
    }
    const ok = await run(() => setSickCaseRelation({ caseId: d.caseId, relation: d.relation, priorCaseId: d.prior || null,
      basis: d.relation === 'unknown' ? null : d.basis, reason: d.relation === 'unknown' ? null : d.reason, revision: d.revision }))
    if (ok) setDialog(null)
  }

  const recordLine = (r, inCase) => (
    <div key={r.id} style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', fontSize:12.5, padding:'3px 0' }}>
      <span>{formatDate(r.start_date)} – {r.end_date ? formatDate(r.end_date) : tr('sickCase.open')}</span>
      {r.eau_kind && <span className="badge badge-gray">{tr(`sickCase.eau.${r.eau_kind}`)}</span>}
      {isAdmin && (
        <select value={r.eau_kind || ''} disabled={busy} aria-label={tr('sickCase.eau')} title={tr('sickCase.eau')} style={{ width:'auto', fontSize:12, padding:'2px 6px' }}
          onChange={e => run(() => setSickEauKind(r.id, e.target.value || null))}>
          {['', ...EAU_KINDS].map(k => <option key={k || 'none'} value={k}>{tr(k ? `sickCase.eau.${k}` : 'sickCase.eau.none')}</option>)}
        </select>
      )}
      {isAdmin && inCase && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => removeFromSickCase([r.id], inCase.revision))}>{tr('sickCase.remove')}</button>}
    </div>
  )

  return (
    <div className="card mb-5" data-testid="sick-cases-panel">
      <div className="card-header"><div className="card-title">🧩 {tr('sickCase.title')}</div></div>
      <div className="card-body">
        <div style={{ fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6, marginBottom:6 }}>{tr('sickCase.intro')}</div>
        <div className="alert alert-info" style={{ fontSize:12, marginBottom:12 }}>{tr('sickCase.payrollNote')}</div>
        {!isAdmin && <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:10 }}>{tr('sickCase.managerReadonly')}</div>}
        {failed && <div className="alert alert-danger">{tr('sickCase.loadFailed')}</div>}
        {!failed && !data && <div style={{ color:'var(--text-muted)', fontSize:13 }}>{tr('ui.ebbb1d1f265f')}</div>}
        {data && !byEmployee.length && <div style={{ color:'var(--text-muted)', fontSize:13 }}>{tr('sickCase.empty')}</div>}
        {byEmployee.map(g => (
          <div key={g.employeeId} style={{ borderTop:'1px solid var(--border)', padding:'10px 0' }}>
            <div style={{ fontWeight:600, marginBottom:6 }}>{g.name}</div>
            {g.cases.map(c => (
              <div key={c.id} data-kind="case" style={{ border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  <span className="badge badge-green">{tr('sickCase.confirmed')}</span>
                  <strong style={{ fontSize:13 }}>{range(c.records)}</strong>
                  {isAdmin && <span style={{ fontSize:12, color:'var(--text-secondary)' }}>
                    {tr('sickCase.relation')}: {c.relation
                      ? (c.relation.relation === 'same_illness'
                        ? tr('sickCase.relOf', { date: formatDate(g.cases.find(x => x.id === c.relation.prior_case_id)?.records[0]?.start_date) })
                        : tr('sickCase.rel.new_illness'))
                      : tr('sickCase.rel.unknown')}
                  </span>}
                  {isAdmin && <button type="button" className="btn btn-sm" disabled={busy}
                    onClick={() => setDialog({ caseId: c.id, revision: c.revision, employeeId: g.employeeId, relation: c.relation?.relation || 'unknown', prior: c.relation?.prior_case_id || '', basis: c.relation?.basis || '', reason: c.relation?.reason || '', error: null })}>
                    {tr('sickCase.setRelation')}</button>}
                </div>
                {c.records.map(r => recordLine(r, c))}
              </div>
            ))}
            {g.suggestions.map(s => (
              <div key={s.records[0].id} data-kind={s.records.length > 1 ? 'suggestion' : 'single'} style={{ border:'1px dashed var(--border-strong)', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
                <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                  <span className="badge badge-amber">{tr(s.records.length > 1 ? 'sickCase.suggestion' : 'sickCase.single')}</span>
                  <strong style={{ fontSize:13 }}>{range(s.records)}</strong>
                  {isAdmin && <button type="button" className="btn btn-sm" disabled={busy}
                    onClick={() => run(() => confirmSickCase(s.records.map(r => r.id)))}>
                    {tr(s.records.length > 1 ? 'sickCase.confirmBtn' : 'sickCase.confirmSingle')}</button>}
                </div>
                {s.links.map(l => <div key={`${l.from}-${l.to}`} style={{ fontSize:11.5, color:'var(--text-muted)' }}>↳ {tr(`sickCase.gap.${l.gap}${l.basis ? `.${l.basis}` : ''}`)}</div>)}
                {s.review.map(l => <div key={`r-${l.from}-${l.to}`} style={{ fontSize:11.5, color:'var(--warn)' }}>⚠ {tr('sickCase.gap.unclear_gap')}</div>)}
                {s.records.map(r => recordLine(r, null))}
              </div>
            ))}
          </div>
        ))}
      </div>

      {dialog && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={tr('sickCase.setRelation')}>
            <div className="modal-header"><div className="modal-title">{tr('sickCase.setRelation')}</div><button aria-label={tr("a11y.close")} className="btn btn-sm" onClick={() => setDialog(null)} disabled={busy}>✕</button></div>
            <div className="modal-body">
              <div className="form-group">
                <label>{tr('sickCase.relation')}</label>
                <select value={dialog.relation} onChange={e => setDialog({ ...dialog, relation: e.target.value, error: null })}>
                  {RELATIONS.map(r => <option key={r} value={r}>{tr(`sickCase.rel.${r}`)}</option>)}
                </select>
              </div>
              {dialog.relation !== 'unknown' && <>
                <div className="form-group">
                  <label>{tr('sickCase.prior')}{dialog.relation === 'same_illness' && <span style={{ color:'var(--danger)' }}> *</span>}</label>
                  <select value={dialog.prior} onChange={e => setDialog({ ...dialog, prior: e.target.value, error: null })}>
                    {[{ id: '', none: true }, ...(byEmployee.find(g => g.employeeId === dialog.employeeId)?.cases || []).filter(c => c.id !== dialog.caseId)]
                      .map(c => <option key={c.id || 'none'} value={c.id}>{c.none ? tr('sickCase.priorNone') : range(c.records)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>{tr('sickCase.basis')}<span style={{ color:'var(--danger)' }}> *</span></label>
                  <select value={dialog.basis} onChange={e => setDialog({ ...dialog, basis: e.target.value, error: null })}>
                    {['', ...RELATION_BASES].map(b => <option key={b || 'none'} value={b}>{b ? tr(`sickCase.basis.${b}`) : tr('sickCase.priorNone')}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>{tr('sickCase.reason')}<span style={{ color:'var(--danger)' }}> *</span></label>
                  <input value={dialog.reason} maxLength={REASON_MAX} onChange={e => setDialog({ ...dialog, reason: e.target.value, error: null })} />
                  <div style={{ fontSize:11.5, color:'var(--warn)', marginTop:4 }}>{tr('sickCase.noDiagnosis')}</div>
                </div>
              </>}
              {dialog.error && <div role="alert" className="alert alert-danger" style={{ fontSize:12.5 }}>{localizeMessage(appMessage(dialog.error))}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setDialog(null)} disabled={busy}>{tr('ui.f7ff1178af20')}</button>
              <button className="btn btn-primary" onClick={saveRelation} disabled={busy}>{tr('ui.f6b2ff39f540')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
