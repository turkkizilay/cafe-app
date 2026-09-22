import { useSearchParams } from 'react-router-dom'
import React, { useState, useEffect, useRef } from 'react'
import { supabase, formatDate, toLocalDateStr } from '../lib/supabase'
import { translateSupabaseError } from '../lib/errorHelper'
import { useProfile } from '../context/ProfileContext'
import { useToast } from '../components/UI/Toast'
import { LOHNFORTZAHLUNG_TAGE } from '../lib/constants'
import { logActivity } from '../lib/activityLog'
import { groupSickLeavesIntoCases, calculateContinuedPayStatus, getSickCaseWarnings, getContinuedPayEnd, SICK_STATUS_LABELS, validateSickLeaveInput } from '../lib/sickLeaveLogic'
import {
  getVacationBalance,
  calculateRequestedDays,
  checkVacationDuringSick,
  checkSickDuringVacation,
  canRequestVacation,
} from '../lib/vacationLogic'

export default function Vacation() {
  const { isAdmin, isManager, profile, refetch } = useProfile()
  const toast     = useToast()
  const canManage = isAdmin || isManager
  const fileRef   = useRef()

  const [tab,        setTab]       = useState('urlaub')
  const [vacations,  setVacations] = useState([])
  const [sick,       setSick]      = useState([])
  const [employees,  setEmployees] = useState([])
  const [holidays,   setHolidays]  = useState([])
  const [myEmployee, setMyEmployee]= useState(null)
  const [myBalance,  setMyBalance] = useState(null)
  const [loading,    setLoading]   = useState(true)
  const [modal,      setModal]     = useState(null)
  const [form,       setForm]      = useState({})
  const [saving,     setSaving]    = useState(false)
  const [formError,  setFormError] = useState('')
  const [vacConflict,    setVacConflict]    = useState(null)
  const [actionWorking,   setActionWorking]   = useState(false)
  const [searchParams] = useSearchParams()
  const savingRef    = useRef(false)  // Ref-Guard saveVacation
  const sickSavingRef   = useRef(false)   // Ref-Guard saveSick
  const attestUploadRef = useRef(null)       // file input für nachträgliches Attest
  const [uploadingSickId, setUploadingSickId] = useState(null)
  const [deletingSickId,  setDeletingSickId]  = useState(null)
  const [selectedFile,    setSelectedFile]    = useState(null) // Datei-Vorschau im Krank-Formular
  const [rejectionReason, setRejectionReason] = useState('')
  const [adminComment,  setAdminComment]   = useState('')
  const [commentFor,    setCommentFor]     = useState(null) // id of vacation being actioned

  // URL-Tab-Parameter lesen (z.B. von Dashboard "Ansehen →")
  useEffect(() => {
    const urlTab = searchParams.get('tab')
    if (urlTab === 'krank' || urlTab === 'urlaub') setTab(urlTab)
  }, [searchParams])

  useEffect(() => { fetchAll() }, [profile?.employee_id])

  async function fetchAll() {
    setLoading(true)
    try {
      const year = new Date().getFullYear()
      const [vacRes, sickRes, holRes] = await Promise.all([
        supabase.from('vacation_requests').select('*, approved_by_name, employees!employee_id(first_name, last_name, vacation_days_per_year)').order('created_at', { ascending: false }),
        supabase.from('sick_leave').select('*, employees!employee_id(first_name, last_name)').order('start_date', { ascending: false }),
        supabase.from('public_holidays').select('date, name').eq('bundesland', 'Hessen').in('year', [year, year - 1, year + 1]),
      ])

      // Fehler-Check: zeige konkrete Fehlermeldung statt silent empty state
      if (vacRes.error)  { toast.error('Urlaub-Fehler: '  + vacRes.error.message);  }
      if (sickRes.error) { toast.error('Krank-Fehler: '   + sickRes.error.message); }
      if (holRes.error)  { toast.error('Feiertag-Fehler: '+ holRes.error.message);  }

      const allVacs    = vacRes.data  || []
      const allSick    = sickRes.data || []
      const allHols    = holRes.data  || []

      setVacations(allVacs)
      setSick(allSick)
      setHolidays(allHols)

      // Optionale Queries
      if (canManage) {
        const { data: emps } = await supabase
          .from('employees').select('id, first_name, last_name, vacation_days_per_year')
          .eq('is_active', true).order('last_name')
        setEmployees(emps || [])
      }
      if (profile?.employee_id) {
        const { data: myEmp } = await supabase
          .from('employees').select('id, first_name, last_name, vacation_days_per_year')
          .eq('id', profile.employee_id).maybeSingle()
        setMyEmployee(myEmp || null)

        if (myEmp) {
          // Präzise Bilanz für diesen Mitarbeiter
          const myVacs  = allVacs.filter(v => v.employee_id === profile.employee_id)
          const mySick  = allSick.filter(s => s.employee_id === profile.employee_id)
          const balance = getVacationBalance(myEmp, myVacs, mySick, allHols)
          setMyBalance(balance)

        }
      }
    } catch (err) {
      toast.error('Fehler beim Laden: ' + err.message)
    }
    setLoading(false)
  }

  // ── Urlaubsantrag Konflikt-Prüfung (live beim Tippen) ───────
  useEffect(() => {
    if (!form.start_date || !form.end_date || !form.employee_id) {
      setVacConflict(null); return
    }
    if (form.start_date > form.end_date) {
      setVacConflict(null); return
    }

    const empId   = canManage ? form.employee_id : profile?.employee_id
    const mySick  = sick.filter(s => s.employee_id === empId)
    const conflict = checkVacationDuringSick(form.start_date, form.end_date, mySick, holidays)
    setVacConflict(conflict.overlaps ? conflict : null)
  }, [form.start_date, form.end_date, form.employee_id])

  // ── Aktionen ────────────────────────────────────────────────
  async function vacAction(id, status) {
    if (!canManage) return  // Defense-in-depth: nur Admin/Manager darf Urlaubsstatus ändern
    if (actionWorking) return
    setActionWorking(true)

    // Bei Genehmigung: Überschneidung mit anderen approved/pending Urlauben prüfen
    if (status === 'approved') {
      const thisVac = vacations.find(v => v.id === id)
      if (thisVac) {
        const { data: otherVacs } = await supabase
          .from('vacation_requests')
          .select('id, start_date, end_date, status')
          .eq('employee_id', thisVac.employee_id)
          .in('status', ['pending', 'approved'])
          .neq('id', id)   // diesen Antrag selbst ausschließen

        const conflict = (otherVacs || []).find(ex =>
          thisVac.start_date <= ex.end_date && thisVac.end_date >= ex.start_date
        )
        if (conflict) {
          const von = new Date(conflict.start_date + 'T12:00:00').toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})
          const bis = new Date(conflict.end_date   + 'T12:00:00').toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})
          toast.error(`Konflikt: Überschneidung mit bestehendem Urlaub (${von} – ${bis}). Bitte zuerst den anderen Antrag prüfen.`)
          setActionWorking(false); return
        }
      }
    }

    const { error } = await supabase.from('vacation_requests')
      .update({
        status,
        approved_at:      new Date().toISOString(),
        approved_by_name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || profile?.email || 'Admin',
      })
      .eq('id', id)
    if (error) { toast.error(translateSupabaseError(error)); setActionWorking(false); return }
    toast.success(status === 'approved' ? '✅ Urlaub genehmigt' : 'Antrag abgelehnt')

    // Protokoll
    const vac = vacations.find(v => v.id === id)
    const empName = vac?.employee_name || 'Mitarbeiter'
    const actor = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Admin'
    logActivity({
      action:     status === 'approved' ? 'vacation.approved' : 'vacation.rejected',
      category:   'vacation',
      summary:    status === 'approved'
        ? `${actor} hat den Urlaub von ${empName} genehmigt.`
        : `${actor} hat den Urlaub von ${empName} abgelehnt.`,
      targetType: 'vacation_request',
      targetId:   id,
      targetName: empName,
    })

    await fetchAll()
    setActionWorking(false)
    refetch()
  }

  async function saveVacation() {
    if (savingRef.current) return  // Verhindert Doppel-Submit
    savingRef.current = true
    setFormError('')
    const empId = canManage ? form.employee_id : profile?.employee_id
    if (!empId || !form.start_date || !form.end_date) {
      setFormError('Bitte Start- und Enddatum auswählen.'); return
    }
    if (form.start_date > form.end_date) {
      setFormError('Startdatum muss vor dem Enddatum liegen.'); return
    }

    // ── Vergangenheits-Check ─────────────────────────────────────
    // toLocalDateStr statt toISOString() — vermeidet UTC-Versatz in DE (UTC+2)
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    if (form.start_date < todayStr) {
      setFormError('⛔ Urlaubsanträge für vergangene Tage sind nicht möglich. Bitte wähle ein Datum ab heute (' + now.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}) + ').')
      savingRef.current = false; return
    }

    // Exakte Tagesberechnung inkl. Feiertage (Feiertage werden nicht als Urlaubstage gezählt)
    const requestedDays = calculateRequestedDays(form.start_date, form.end_date, holidays)
    if (requestedDays === 0) {
      setFormError('Keine Arbeitstage im gewählten Zeitraum (nur Wochenenden/Feiertage).'); return
    }

    // §9 BUrlG: Krank-Überschneidung aufzeigen (info, kein Block)
    const mySick    = sick.filter(s => s.employee_id === empId)
    const conflict  = checkVacationDuringSick(form.start_date, form.end_date, mySick, holidays)
    const effectiveDays = requestedDays - (conflict.sickDays || 0)

    // Urlaubsbalance des BETROFFENEN Mitarbeiters prüfen
    const targetEmp = canManage
      ? employees.find(e => e.id === empId)
      : myEmployee

    if (targetEmp) {
      const targetVacs = vacations.filter(v => v.employee_id === empId)
      const targetSick = sick.filter(s => s.employee_id === empId)
      const balance    = getVacationBalance(targetEmp, targetVacs, targetSick, holidays)
      const check      = canRequestVacation(effectiveDays, balance)
      if (!check.ok) { setFormError(check.reason); return }
    }

    // ── Live-Überschneidungsprüfung Urlaub→Urlaub ────────────────────────
    // Direkt vor Insert frisch aus Supabase laden — lokaler State kann veraltet sein
    const { data: freshVacs, error: fetchVacErr } = await supabase
      .from('vacation_requests')
      .select('id, start_date, end_date, status')
      .eq('employee_id', empId)
      .in('status', ['pending', 'approved'])

    if (fetchVacErr) {
      setFormError('Fehler beim Prüfen bestehender Urlaubsanträge. Bitte erneut versuchen.')
      setSaving(false); savingRef.current = false; return
    }
    for (const ex of (freshVacs || [])) {
      if (form.start_date <= ex.end_date && form.end_date >= ex.start_date) {
        const von = new Date(ex.start_date + 'T12:00:00').toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})
        const bis = new Date(ex.end_date   + 'T12:00:00').toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})
        setFormError(`Für diesen Zeitraum existiert bereits ein Urlaubsantrag (${von} – ${bis}). Bitte bestehenden Antrag prüfen oder Zeitraum anpassen.`)
        setSaving(false); savingRef.current = false; return
      }
    }
    // ── Ende Overlap-Check ────────────────────────────────────────────────

    setSaving(true)
    const { error } = await supabase.from('vacation_requests').insert([{
      employee_id: empId,
      start_date:  form.start_date,
      end_date:    form.end_date,
      days_count:  requestedDays,
      reason:      form.reason || null,
    }])
    if (error) { toast.error(translateSupabaseError(error)); setSaving(false); sickSavingRef.current = false; return }

    if (conflict.overlaps) {
      toast.info(`✅ Antrag gestellt. ${conflict.message}`)
    } else {
      toast.success(`✅ Urlaubsantrag für ${requestedDays} Tag${requestedDays > 1 ? 'e' : ''} gestellt`)
    }

    // Protokoll
    const actor = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Mitarbeiter'
    const von = new Date(form.start_date + 'T12:00:00').toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})
    const bis = new Date(form.end_date   + 'T12:00:00').toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'})
    logActivity({
      action:   'vacation.requested',
      category: 'vacation',
      summary:  `${actor} hat Urlaub vom ${von} bis ${bis} beantragt.`,
      targetType: 'vacation_request',
    })

    setModal(null); setSaving(false); savingRef.current = false; fetchAll()
  }

  async function saveSick() {
    if (sickSavingRef.current) return
    sickSavingRef.current = true
    setFormError('')
    const empId = canManage ? form.employee_id : profile?.employee_id
    if (!empId || !form.start_date) { setFormError('Bitte Startdatum angeben.'); sickSavingRef.current = false; return }
    // ── Zentrale Input-Validierung (Zukunft/Vergangenheit/Rolle) ──────────
    const validation = validateSickLeaveInput({
      startDate: form.start_date,
      endDate:   form.end_date || null,
      role:      profile?.role || 'employee',
      today:     toLocalDateStr(new Date()),
    })
    if (!validation.valid) {
      setFormError(validation.message)
      sickSavingRef.current = false; return
    }
    // Warnungen anzeigen aber nicht blockieren
    if (validation.severity === 'warn') {
      setFormError(validation.message) // gelbe Warnung, kein Abbruch
    }
    if (form.end_date && new Date(form.end_date) < new Date(form.start_date)) {
      setFormError('Enddatum darf nicht vor dem Startdatum liegen.')
      sickSavingRef.current = false; return
    }

    // ── Überschneidungsprüfung — LIVE aus Supabase ────────────────────────
    // Frische DB-Abfrage direkt vor dem Insert (nicht lokaler State).
    // Filter strikt auf employee_id — zwei verschiedene Mitarbeiter bleiben unabhängig.
    const { data: freshSickLeaves, error: fetchErr } = await supabase
      .from('sick_leave')
      .select('id, start_date, end_date')
      .eq('employee_id', empId)

    if (fetchErr) {
      setFormError('Fehler beim Prüfen bestehender Krankmeldungen. Bitte erneut versuchen.')
      sickSavingRef.current = false; return
    }

    const newStart       = new Date(form.start_date + 'T00:00:00')
    const newEnd         = form.end_date ? new Date(form.end_date + 'T00:00:00') : null
    // Bei offenem Ende: effektiv unendlich
    const newEndEff      = newEnd || new Date('9999-12-31')

    for (const ex of (freshSickLeaves || [])) {
      const exStart   = new Date(ex.start_date + 'T00:00:00')
      const exEnd     = ex.end_date ? new Date(ex.end_date + 'T00:00:00') : null
      const exEndEff  = exEnd || new Date('9999-12-31')

      // Korrekte Zeitraum-Überschneidungsformel:
      // newStart <= exEndEff AND newEndEff >= exStart
      const overlaps = newStart <= exEndEff && newEndEff >= exStart

      if (!overlaps) continue

      // Direkt anschließend (Folgebescheinigung): erlaubt, kein Block
      // Definiert als: newStart === exEnd + 1 Tag
      if (exEnd) {
        const dayAfter = new Date(exEnd.getTime() + 86400000)
        if (newStart.getTime() === dayAfter.getTime()) continue // Fortsetzung → OK
      }

      // Ab hier: echte Überschneidung → blockieren
      if (!exEnd) {
        setFormError(
          `Es gibt bereits eine offene Krankmeldung (seit ${formatDate(ex.start_date)}).` +
          ` Bitte ergänze dort das Attest oder setze ein Enddatum, bevor du eine neue Meldung erstellst.`
        )
      } else {
        setFormError(
          `Dieser Zeitraum überschneidet sich mit einer bestehenden Krankmeldung` +
          ` (${formatDate(ex.start_date)} bis ${formatDate(ex.end_date)}).` +
          ` Bitte bearbeite die bestehende Meldung oder lade dort ein weiteres Attest hoch.`
        )
      }
      sickSavingRef.current = false; return
    }
    // ── Ende Überschneidungsprüfung ────────────────────────────────────────

    setSaving(true)

    // §9 BUrlG: Prüfen ob Krankmeldung genehmigten Urlaub überschneidet
    const empApprovedVacs = vacations.filter(v => v.employee_id === empId && v.status === 'approved')
    const overlap = checkSickDuringVacation(form.start_date, form.end_date || null, empApprovedVacs, holidays)

    const { data: sickRecord, error } = await supabase.from('sick_leave').insert([{
      employee_id: empId,
      start_date:  form.start_date,
      end_date:    form.end_date || null,
      notes:       form.notes || null,
    }]).select().maybeSingle()

    if (error) { toast.error(translateSupabaseError(error)); setSaving(false); sickSavingRef.current = false; return }

    // Attest Upload
    const file = fileRef.current?.files?.[0]
    if (file && sickRecord) {
      const ext  = file.name.split('.').pop().toLowerCase()
      const path = `${empId}/${sickRecord.id}.${ext}`
      const { error: upErr } = await supabase.storage.from('sick-certs').upload(path, file, { upsert: true })
      if (!upErr) {
        await supabase.from('sick_leave').update({
          certificate_received:    true,
          certificate_file_path:   path,
          certificate_file_name:   file.name,
        }).eq('id', sickRecord.id)
      } else {
        toast.warn('Krankmeldung gespeichert, Datei-Upload fehlgeschlagen: ' + upErr.message)
      }
    }

    // §9 BUrlG Hinweis anzeigen wenn relevant
    sickSavingRef.current = false
    toast.success('✅ Krankmeldung erfasst')
    if (overlap.overlaps) {
      setTimeout(() => toast.info(overlap.message, 8000), 500)
    }

    // Protokoll (kein medizinischer Inhalt, nur DASS eine Meldung erfasst wurde)
    const sickActor = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Mitarbeiter'
    const hadAttest = !!(fileRef.current?.files?.[0])
    logActivity({
      action: 'sick_leave.created', category: 'sick_leave',
      summary: canManage
        ? `${sickActor} hat eine Krankmeldung erfasst${hadAttest ? ' (mit Attest)' : ''}.`
        : `${sickActor} hat eine Krankmeldung eingereicht${hadAttest ? ' (mit Attest)' : ''}.`,
      targetType: 'sick_leave', targetId: sickRecord?.id,
    })

    setModal(null); setSaving(false); setSelectedFile(null)
    if (fileRef.current) fileRef.current.value = ''
    fetchAll()
  }

  // Krankmeldung löschen — Mitarbeiter: nur eigene; Admin/Manager: alle
  //
  // TODO (Vollbetrieb): Beim Löschen Storage-Datei bereinigen oder Soft-Delete einführen.
  //   Aktuell verbleibt die Datei im sick-certs Bucket (kein public access, aber verwaist).
  //   Empfehlung: sick_leave.certificate_file_path beim Löschen per Admin-RPC aus Storage entfernen.
  //   Nie automatisch ohne Policy — Gesundheitsdaten erfordern bewusstes Handeln.
  async function deleteSickLeave(sickId, ownEmployeeId, dateLabel, hasAttest = false) {
    if (deletingSickId) return
    const isOwnLeave = ownEmployeeId === (profile?.employee_id)
    if (!canManage && !isOwnLeave) {
      toast.error('Keine Berechtigung — bitte Manager/Admin kontaktieren')
      return
    }
    const attestNote = hasAttest
      ? '\n\n⚠️ Diese Krankmeldung hat ein hochgeladenes Attest. Der Datenbankeintrag wird gelöscht; die Datei im sicheren Speicher bleibt aus Datenschutzgründen ggf. erhalten und muss ggf. separat verwaltet werden.'
      : ''
    if (!window.confirm(
      `Krankmeldung ab ${dateLabel} löschen?${attestNote}\n\nDiese Aktion kann nicht rückgängig gemacht werden.`
    )) return
    setDeletingSickId(sickId)
    setSick(prev => prev.filter(s => s.id !== sickId))
    const { error } = await supabase.from('sick_leave').delete().eq('id', sickId)
    if (error) {
      toast.error('Fehler beim Löschen: ' + error.message)
      fetchAll()
    } else {
      toast.success('✅ Krankmeldung gelöscht')
    }
    setDeletingSickId(null)
  }

  async function viewCert(filePath) {
    const { data, error } = await supabase.storage
      .from('sick-certs').createSignedUrl(filePath, 60)
    if (error) { toast.error('Fehler beim Öffnen: ' + error.message); return }
    window.open(data.signedUrl, '_blank')
  }

  async function downloadCert(filePath, fileName) {
    // Signierte Download-URL (erzwingt Download statt Öffnen im Browser)
    const { data, error } = await supabase.storage
      .from('sick-certs').createSignedUrl(filePath, 60, { download: fileName || true })
    if (error) { toast.error('Fehler beim Download: ' + error.message); return }
    // Programmatischer Download via <a>-Tag
    const a = document.createElement('a')
    a.href = data.signedUrl
    a.download = fileName || 'attest.pdf'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  async function uploadAttestForExisting(sickId, empId, file) {
    if (!file) return
    if (uploadingSickId) return
    if (file.size > 10 * 1024 * 1024) { toast.warn('Datei zu groß — max. 10 MB'); return }
    setUploadingSickId(sickId)
    try {
      const ext  = file.name.split('.').pop().toLowerCase()
      const path = `${empId}/${sickId}.${ext}`

      // 1. Storage Upload
      const { error: upErr } = await supabase.storage
        .from('sick-certs').upload(path, file, { upsert: true })
      if (upErr) { toast.error('Upload fehlgeschlagen: ' + upErr.message); return }

      // 2. DB Update — mit .select() um 0 Zeilen (RLS-Block) zu erkennen
      const { data: updated, error: dbErr } = await supabase
        .from('sick_leave')
        .update({ certificate_received: true, certificate_file_path: path, certificate_file_name: file.name })
        .eq('id', sickId)
        .select('id')
      if (dbErr) { toast.error('Fehler beim Speichern: ' + dbErr.message); return }
      if (!updated || updated.length === 0) {
        toast.error('Keine Berechtigung — bitte Admin kontaktieren')
        return
      }

      // 3. Optimistisches UI-Update: sofort lokalen State aktualisieren
      setSick(prev => prev.map(s =>
        s.id === sickId
          ? { ...s, certificate_received: true, certificate_file_path: path, certificate_file_name: file.name }
          : s
      ))
      toast.success('✅ Attest hochgeladen!')
      const attestActor = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Mitarbeiter'
      logActivity({
        action: 'sick_leave.attest_uploaded', category: 'sick_leave',
        summary: `${attestActor} hat ein Attest hochgeladen.`,
        targetType: 'sick_leave', targetId: sickId,
      })
      fetchAll()  // Hintergrund-Refresh für Konsistenz
    } finally { setUploadingSickId(null) }
  }

  function f(k, v) { setForm(x => ({ ...x, [k]: v })) }

  // Berechne Preview für Antragsformular
  const formEmpId   = canManage ? form.employee_id : profile?.employee_id
  const previewDays = (modal === 'vacation' && form.start_date && form.end_date && form.start_date <= form.end_date)
    ? calculateRequestedDays(form.start_date, form.end_date, holidays)
    : 0
  const effectivePreview = previewDays - (vacConflict?.sickDays || 0)

  const STATUS = {
    pending:  <span className="badge badge-amber">Ausstehend</span>,
    approved: <span className="badge badge-green">Genehmigt</span>,
    rejected: <span className="badge badge-red">Abgelehnt</span>,
  }

  if (loading) return <div style={{ padding:24 }}>Lädt…</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Urlaub & Krankmeldungen</div>
        <div className="topbar-right">
          {tab === 'urlaub' && (
            <button className="btn btn-primary" onClick={() => {
              setFormError(''); setVacConflict(null)
              setForm({ employee_id: canManage ? (employees[0]?.id||'') : profile?.employee_id, start_date:'', end_date:'', reason:'' })
              setModal('vacation')
            }}>+ Urlaubsantrag</button>
          )}
          {tab === 'krank' && (
            <button className="btn btn-primary" onClick={() => {
              setFormError('')
              setForm({ employee_id: canManage ? (employees[0]?.id||'') : profile?.employee_id, start_date: toLocalDateStr(new Date()), notes:'' })
              setModal('sick')
            }}>+ Krankmeldung</button>
          )}
        </div>
      </div>

      <div className="content">
        {/* Urlaubskonto — nur auf Urlaubsanträge-Tab */}
        {tab === 'urlaub' && myBalance && (
          <div className="card mb-5" style={{ marginBottom:16 }}>
            <div className="card-body" style={{ padding:'16px 18px' }}>
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
                <div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:4 }}>
                    Mein Urlaubskonto {new Date().getFullYear()}
                  </div>
                  <div style={{ fontSize:26, fontWeight:700, color: myBalance.remaining < 0 ? 'var(--danger)' : myBalance.remaining < 5 ? 'var(--warn)' : 'var(--success)' }}>
                    {myBalance.remaining} {myBalance.remaining === 1 ? 'Tag' : 'Tage'} verfügbar
                    {myBalance.sick_review > 0 && (
                      <span style={{ fontSize:12, fontWeight:400, color:'var(--warn)', marginLeft:8 }}>(vorläufig)</span>
                    )}
                  </div>
                  {myBalance.pending > 0 && (
                    <div style={{ fontSize:12, color:'var(--warn)', marginTop:2 }}>
                      + {myBalance.pending} Tage ausstehend
                    </div>
                  )}
                </div>
                <div style={{ fontSize:13, color:'var(--text-secondary)', textAlign:'right', lineHeight:1.9 }}>
                  <div>Jahresanspruch: <strong>{myBalance.entitlement}</strong> Tage</div>
                  {myBalance.approved_total > 0 && (
                    <div>Genehmigter Urlaub: <strong>{myBalance.approved_total}</strong> Tage</div>
                  )}
                  {myBalance.returned_sick > 0 && (
                    <div style={{ color:'var(--success)', fontSize:12 }}>
                      ✅ §9 BUrlG: <strong>{myBalance.returned_sick}</strong> {myBalance.returned_sick === 1 ? 'Tag' : 'Tage'} zurückgegeben (Attest vorhanden)
                    </div>
                  )}
                  {myBalance.sick_review > 0 && (
                    <div style={{ color:'var(--warn)', fontSize:12, fontWeight:500 }}>
                      ⚠️ §9 BUrlG: <strong>{myBalance.sick_review}</strong> {myBalance.sick_review === 1 ? 'Tag' : 'Tage'} erkannt — Attest fehlt, Prüfung erforderlich
                    </div>
                  )}
                  {myBalance.returned_holiday > 0 && (
                    <div style={{ color:'var(--success)', fontSize:12 }}>
                      ✅ Feiertage: <strong>{myBalance.returned_holiday}</strong> {myBalance.returned_holiday === 1 ? 'Tag' : 'Tage'} nicht abgezogen
                    </div>
                  )}
                  <div style={{ borderTop:'1px solid var(--border)', paddingTop:2, marginTop:2 }}>
                    Tatsächlich genutzt: <strong>{myBalance.used}</strong> Tage
                    {myBalance.sick_review > 0 && (
                      <span style={{ fontSize:11, color:'var(--warn)', marginLeft:4 }}>(inkl. {myBalance.sick_review}T vorläufig)</span>
                    )}
                  </div>
                </div>

                {/* Warnung bei überlappenden Urlaubsanträgen in Altdaten */}
                {(() => {
                  const myApproved = vacations.filter(v =>
                    v.employee_id === profile?.employee_id &&
                    ['pending','approved'].includes(v.status)
                  )
                  const hasOverlap = myApproved.some((a, i) =>
                    myApproved.slice(i+1).some(b =>
                      a.start_date <= b.end_date && a.end_date >= b.start_date
                    )
                  )
                  return hasOverlap ? (
                    <div style={{ marginTop:10, padding:'8px 12px', background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, fontSize:12, color:'#92400E' }}>
                      ⚠️ <strong>Überlappende Urlaubsanträge erkannt.</strong> Das Konto wurde korrekt berechnet (Tage nur einmal gezählt). Bitte doppelte Anträge mit dem Management klären.
                    </div>
                  ) : null
                })()}
                <div style={{ width:'100%' }}>
                  <div className="progress" style={{ height:8 }}>
                    <div className="progress-fill" style={{
                      width: `${Math.min(100, (myBalance.used / (myBalance.entitlement||1)) * 100)}%`,
                      background: myBalance.remaining < 5 ? 'var(--warn)' : undefined,
                    }} />
                  </div>
                </div>
              </div>

              {/* ── Warnung bei bestehenden Überschneidungen ────────────── */}
              {(() => {
                const relevant = vacations.filter(v => v.employee_id === (canManage ? form.employee_id : profile?.employee_id) && (v.status === 'approved' || v.status === 'pending'))
                const found = []
                for (let i = 0; i < relevant.length; i++) {
                  for (let j = i+1; j < relevant.length; j++) {
                    const a = relevant[i], b = relevant[j]
                    if (a.start_date <= b.end_date && a.end_date >= b.start_date) {
                      const fmt = d => new Date(d+'T12:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})
                      found.push(`${fmt(a.start_date)}–${fmt(a.end_date)} und ${fmt(b.start_date)}–${fmt(b.end_date)}`)
                    }
                  }
                }
                if (!found.length) return null
                return (
                  <div style={{ marginTop:10, padding:'8px 12px', background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, fontSize:12, color:'#92400E' }}>
                    ⚠️ Überlappende Urlaubsanträge erkannt ({found.join(' · ')}). Bitte prüfen und bereinigen.
                  </div>
                )
              })()}

              {myBalance.breakdown.length > 0 && (
                <div style={{ marginTop:12, padding:'10px 12px', background:'var(--success-bg)', borderRadius:8, fontSize:12 }}>
                  <strong style={{ color:'var(--success)' }}>§9 BUrlG / Feiertage — Rückgaben:</strong>
                  {myBalance.breakdown.map((b, i) => (
                    <div key={i} style={{ marginTop:4, color:'var(--success)' }}>
                      • {formatDate(b.start)} – {formatDate(b.end)}: {b.effectiveDays} statt {b.originalDays} Tage gezählt
                      {b.sickDays > 0 && ` (${b.sickDays} Krankheitstage zurück)`}
                      {b.holidayDays > 0 && ` (${b.holidayDays} Feiertage nicht abgezogen)`}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-5" style={{ marginBottom:16 }}>
          <button className={`btn${tab==='urlaub'?' btn-primary':''}`} onClick={() => setTab('urlaub')}>
            🌴 Urlaubsanträge
            {canManage && vacations.filter(v=>v.status==='pending').length > 0 && (
              <span style={{ background:'var(--warn)', color:'#fff', borderRadius:10, fontSize:10, fontWeight:700, padding:'1px 6px', marginLeft:6 }}>
                {vacations.filter(v=>v.status==='pending').length}
              </span>
            )}
          </button>
          <button className={`btn${tab==='krank'?' btn-primary':''}`} onClick={() => setTab('krank')}>
            🤒 Krankmeldungen
            {sick.filter(s=>!s.end_date).length > 0 && (
              <span style={{ background:'var(--danger)', color:'#fff', borderRadius:10, fontSize:10, fontWeight:700, padding:'1px 6px', marginLeft:6 }}>
                {sick.filter(s=>!s.end_date).length}
              </span>
            )}
          </button>
        </div>

        {tab === 'urlaub' && (
          <div className="card">
            <div className="table-wrap">
              {vacations.length === 0
                ? <div className="empty-state">
                    <div className="empty-state-icon">🌴</div>
                    <div className="empty-state-text">Keine Urlaubsanträge</div>
                    {canManage && <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>
                      Falls du Anträge im Dashboard siehst aber hier nicht: Supabase → SQL Editor ausführen um den Datenbankstatus zu prüfen.
                    </div>}
                  </div>
                : <table>
                    <thead>
                      <tr>{canManage && <th>Mitarbeiter</th>}<th>Von</th><th>Bis</th><th>Tage*</th><th>Status</th>{canManage&&<th>Aktion</th>}</tr>
                    </thead>
                    <tbody>
                      {vacations.map(v => {
                        // Überlappungs-Check für diese Zeile — alle anderen pending/approved des gleichen Mitarbeiters
                        const conflictingVac = canManage
                          ? vacations.find(other =>
                              other.id !== v.id &&
                              other.employee_id === v.employee_id &&
                              ['pending','approved'].includes(other.status) &&
                              ['pending','approved'].includes(v.status) &&
                              v.start_date <= other.end_date &&
                              v.end_date   >= other.start_date
                            )
                          : null
                        const rowHasConflict = !!conflictingVac

                        return (
                        <tr key={v.id} style={ rowHasConflict ? { background:'#FFFBEB', outline:'1px solid #FDE68A' } : undefined }>
                          {canManage && <td><strong>{v.employees?.first_name} {v.employees?.last_name}</strong></td>}
                          <td>{formatDate(v.start_date)}</td>
                          <td>{formatDate(v.end_date)}</td>
                          <td>
                            {v.days_count}
                            {(() => {
                              const empVacs = vacations.filter(x => x.employee_id === v.employee_id && x.status === 'approved')
                              const empSick = sick.filter(s => s.employee_id === v.employee_id)
                              const b = getVacationBalance({ vacation_days_per_year: 999 }, empVacs, empSick, holidays)
                              const affected = b.breakdown.find(x => x.id === v.id)
                              if (!affected) return null
                              return (
                                <span style={{ marginLeft:6, fontSize:11, color:'var(--success)' }}>
                                  {affected.sickDays > 0 ? `→ ${affected.effectiveDays} abgezogen` : null}
                                </span>
                              )
                            })()}
                          </td>
                          <td>
                            {STATUS[v.status]}
                            {rowHasConflict && (
                              <div style={{ fontSize:11, color:'#92400E', marginTop:3, fontWeight:500 }}>
                                ⚠️ Überschneidet mit {conflictingVac.employees?.first_name ?? ''} {conflictingVac.employees?.last_name ?? ''} {formatDate(conflictingVac.start_date)}–{formatDate(conflictingVac.end_date)}
                              </div>
                            )}
                            {v.approved_by_name && (v.status === 'approved' || v.status === 'rejected') && (
                              <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:3 }}>
                                {v.status === 'approved' ? '✓' : '✗'} {v.approved_by_name}
                              </div>
                            )}
                          </td>
                          {canManage && (
                            <td>
                              {v.status==='pending' && (
                                <div className="flex gap-2">
                                  <button className="btn btn-sm btn-success" onClick={() => vacAction(v.id,'approved')}>✓</button>
                                  <button className="btn btn-sm btn-danger"  onClick={() => vacAction(v.id,'rejected')}>✗</button>
                                </div>
                              )}
                              {/* Überlappender genehmigter Urlaub: direkt ablehnen */}
                              {v.status === 'approved' && rowHasConflict && (
                                <button
                                  className="btn btn-sm btn-danger"
                                  style={{ fontSize:11 }}
                                  title={`Urlaub ${formatDate(v.start_date)}–${formatDate(v.end_date)} ablehnen`}
                                  onClick={() => {
                                    const isDuplicate =
                                      v.start_date >= conflictingVac.start_date &&
                                      v.end_date   <= conflictingVac.end_date
                                    const hint = isDuplicate
                                      ? `\n\nHinweis: Dieser Antrag (${formatDate(v.start_date)}–${formatDate(v.end_date)}) liegt komplett innerhalb des anderen Antrags → wahrscheinlich das Duplikat.`
                                      : ''
                                    if (window.confirm(
                                      `Urlaub ${formatDate(v.start_date)}–${formatDate(v.end_date)} ablehnen um Überschneidung zu bereinigen?${hint}\n\nDiese Aktion kann nicht rückgängig gemacht werden.`
                                    )) {
                                      vacAction(v.id, 'rejected')
                                    }
                                  }}
                                >✗ Bereinigen{
                                  v.start_date >= conflictingVac.start_date &&
                                  v.end_date   <= conflictingVac.end_date
                                    ? ' (Duplikat)' : ''
                                }</button>
                              )}
                            </td>
                          )}
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
              }
            </div>
            <div style={{ padding:'8px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
              * Arbeitstage ohne Wochenenden & gesetzliche Hessische Feiertage. "eff." = effektiv nach Abzug von Krankheitstagen (§9 BUrlG).
            </div>
          </div>
        )}

        {tab === 'krank' && (
          <div>
            {/* Krankmeldungs-Übersicht */}
            {sick.filter(s => new Date(s.start_date).getFullYear() === new Date().getFullYear()).length > 0 && (
              <div className="card" style={{ marginBottom:16 }}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:0 }}>
                  {[
                    { label:'Krankmeldungen ' + new Date().getFullYear(), value: sick.filter(s => new Date(s.start_date).getFullYear() === new Date().getFullYear()).length, icon:'🤒' },
                    { label:'Aktuell krank',   value: sick.filter(s => !s.end_date).length, icon:'🏥', color: sick.filter(s=>!s.end_date).length > 0 ? 'var(--danger)' : undefined },
                    { label:'Mit Attest',       value: sick.filter(s => s.certificate_received).length, icon:'📄' },
                  ].map(s => (
                    <div key={s.label} style={{ padding:'14px 16px', borderRight:'1px solid var(--border)', textAlign:'center' }}>
                      <div style={{ fontSize:18, marginBottom:4 }}>{s.icon}</div>
                      <div style={{ fontSize:20, fontWeight:700, color: s.color || 'var(--text-primary)' }}>{s.value}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          <div className="card">
            <div className="table-wrap">
              {sick.length === 0
                ? <div className="empty-state"><div className="empty-state-icon">🤒</div><div className="empty-state-text">Keine Krankmeldungen</div></div>
                : <table>
                    <thead>
                        <tr>
                          {canManage && <th>Mitarbeiter</th>}
                          <th>AU-Fall seit</th>
                          <th>Bis</th>
                          <th>Lohnfortz. bis</th>
                          <th>Status</th>
                          <th>§9 BUrlG</th>
                          <th>Attest</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          // Krankmeldungen nach Mitarbeiter gruppieren → AU-Fälle
                          const bySickCases = canManage
                            ? groupSickLeavesIntoCases(sick)
                            : groupSickLeavesIntoCases(sick.filter(s => s.employee_id === myEmployee?.id))
                          return bySickCases.map(sc => {
                            const status    = calculateContinuedPayStatus(sc)
                            const payEnd    = getContinuedPayEnd(sc)
                            const warnings  = getSickCaseWarnings(sc)
                            const statusCfg = SICK_STATUS_LABELS[status] || SICK_STATUS_LABELS.closed
                            // §9 BUrlG: prüfe letztes Enddatum gegen genehmigte Urlaube
                            const empVacs   = vacations.filter(v => v.employee_id === sc.employee_id && v.status === 'approved')
                            const lastLeave = sc.leaves[sc.leaves.length - 1]
                            const bUrlG     = checkSickDuringVacation(sc.start_date, sc.end_date, empVacs, holidays)
                            // Attest: neueste Meldung im Fall
                            const latestLeave = sc.leaves.reduce((a,b) => new Date(b.start_date) > new Date(a.start_date) ? b : a)
                            return (
                              <React.Fragment key={sc.id}>
                                <tr style={{ borderLeft: `3px solid ${statusCfg.color}` }}>
                                  {canManage && (
                                    <td>
                                      <strong>{sc.employee?.first_name} {sc.employee?.last_name}</strong>
                                      {sc.leaves.length > 1 && (
                                        <span style={{ display:'block', fontSize:11, color:'var(--text-muted)' }}>
                                          {sc.leaves.length} Meldungen
                                        </span>
                                      )}
                                    </td>
                                  )}
                                  <td>{formatDate(sc.start_date)}</td>
                                  <td>
                                    {sc.end_date
                                      ? formatDate(sc.end_date)
                                      : <span className="badge badge-amber">noch krank</span>}
                                  </td>
                                  <td style={{ fontSize:12 }}>
                                    {status === 'health_insurance_review'
                                      ? <span style={{ color:'#DC2626', fontWeight:600 }}>endete {payEnd.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</span>
                                      : <span>{payEnd.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</span>
                                    }
                                  </td>
                                  <td>
                                    <span style={{ fontSize:11, fontWeight:600, color:statusCfg.color,
                                      background:statusCfg.bg, padding:'2px 8px', borderRadius:4 }}>
                                      {statusCfg.text}
                                    </span>
                                  </td>
                                  <td>
                                    {bUrlG.overlaps
                                      ? <span className="badge badge-green" title={bUrlG.message}>↩ {bUrlG.returnedDays}T zurück</span>
                                      : <span style={{ fontSize:12, color:'var(--text-muted)' }}>–</span>}
                                  </td>
                                  <td>
                                    {latestLeave.certificate_file_path
                                      ? <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                                          <button className="btn btn-sm" onClick={() => viewCert(latestLeave.certificate_file_path)}>📄 Öffnen</button>
                                          <button className="btn btn-sm" style={{ background:'var(--info-bg)', color:'var(--info)', border:'1px solid var(--info)' }}
                                            onClick={() => downloadCert(latestLeave.certificate_file_path, latestLeave.certificate_file_name)}>⬇ Download</button>
                                        </div>
                                      : latestLeave.certificate_received
                                        ? <span className="badge badge-green">✓ erhalten</span>
                                        : <label style={{ cursor:'pointer' }}>
                                            <input type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display:'none' }}
                                              onChange={e => { const f = e.target.files?.[0]; if(f) uploadAttestForExisting(latestLeave.id, latestLeave.employee_id || myEmployee?.id, f); e.target.value='' }} />
                                            {uploadingSickId === latestLeave.id
                                              ? <span style={{ fontSize:12, color:'var(--text-muted)' }}>⏳ Lädt…</span>
                                              : <span className="btn btn-sm" style={{ background:'var(--warn-bg)', color:'var(--warn)', border:'1px solid var(--warn)' }}>📤 Attest hochladen</span>}
                                          </label>}
                                  </td>
                                  <td>
                                    {/* Löschen: NUR bei Einzelmeldung über diesen Button.
                                        Bei mehreren Meldungen im Fall: individuelle Buttons im Warn-Bereich unten. */}
                                    {sc.leaves.length === 1 &&
                                     (canManage || sc.employee_id === profile?.employee_id) && (
                                      <button
                                        className="btn btn-sm"
                                        disabled={!!deletingSickId}
                                        style={{ background:'#FEF2F2', color:'#DC2626', border:'1px solid #FECACA' }}
                                        onClick={() => {
                                          const lv = sc.leaves[0]
                                          deleteSickLeave(lv.id, lv.employee_id, formatDate(lv.start_date), !!lv.certificate_file_path)
                                        }}
                                      >🗑</button>
                                    )}
                                  </td>
                                </tr>
                                {warnings.length > 0 && (
                                  <tr>
                                    <td colSpan={canManage ? 8 : 7} style={{ padding:'6px 12px 10px', background:'#FFFBEB', borderLeft:'3px solid #F59E0B' }}>
                                      {warnings.map((w,i) => (
                                        <div key={i} style={{ fontSize:12, color: w.level === 'error' ? '#DC2626' : w.level === 'info' ? '#1D4ED8' : '#92400E', marginTop: i>0 ? 4 : 0, lineHeight:1.5 }}>
                                          {w.level === 'error' ? '🔴' : w.level === 'info' ? 'ℹ️' : '⚠️'} {w.text}
                                        </div>
                                      ))}
                                      {/* Detailansicht aller Einzelmeldungen wenn mehrere im Fall */}
                                      {sc.leaves.length > 1 && (
                                        <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid #E5E7EB' }}>
                                          <div style={{ fontSize:12, fontWeight:600, marginBottom:6, color:'var(--text-secondary)' }}>
                                            Einzelne Meldungen in diesem AU-Fall:
                                          </div>
                                          {sc.leaves.map((lv, idx) => {
                                            const isFirst = idx === 0
                                            const prevLv  = idx > 0 ? sc.leaves[idx - 1] : null
                                            const prevEnd = prevLv?.end_date
                                            const lsContinuation = prevEnd
                                              ? new Date(lv.start_date + 'T00:00:00').getTime() ===
                                                new Date(prevEnd + 'T00:00:00').getTime() + 86400000
                                              : false
                                            return (
                                              <div key={lv.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, padding:'4px 0', borderBottom:'1px solid #F3F4F6' }}>
                                                <span style={{ color:'var(--text-muted)', minWidth:20 }}>{idx + 1}.</span>
                                                <span style={{ flex:1 }}>
                                                  <strong>{formatDate(lv.start_date)}</strong>
                                                  {lv.end_date ? ` bis ${formatDate(lv.end_date)}` : ' (noch offen)'}
                                                  {isFirst && <span style={{ marginLeft:6, fontSize:11, background:'#EFF6FF', color:'#2563EB', padding:'1px 5px', borderRadius:3 }}>Erstmeldung</span>}
                                                  {!isFirst && lsContinuation && <span style={{ marginLeft:6, fontSize:11, background:'#F0FDF4', color:'#16A34A', padding:'1px 5px', borderRadius:3 }}>Folgebescheinigung</span>}
                                                  {!isFirst && !lsContinuation && <span style={{ marginLeft:6, fontSize:11, background:'#FEF3C7', color:'#D97706', padding:'1px 5px', borderRadius:3 }}>Überschneidend</span>}
                                                </span>
                                                {lv.certificate_file_path
                                                  ? <button className="btn btn-sm" style={{ fontSize:11 }} onClick={() => viewCert(lv.certificate_file_path)}>📄</button>
                                                  : lv.certificate_received
                                                    ? <span style={{ fontSize:11, color:'#059669' }}>✓</span>
                                                    : <span style={{ fontSize:11, color:'#DC2626' }}>Attest fehlt</span>
                                                }
                                                {(canManage || lv.employee_id === profile?.employee_id) && (
                                                  <button
                                                    className="btn btn-sm"
                                                    style={{ background:'#FEF2F2', color:'#DC2626', border:'1px solid #FECACA', padding:'1px 6px', fontSize:11 }}
                                                    disabled={!!deletingSickId}
                                                    onClick={() => deleteSickLeave(lv.id, lv.employee_id, formatDate(lv.start_date), !!lv.certificate_file_path)}
                                                  >🗑</button>
                                                )}
                                              </div>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            )
                          })
                        })()}
                      </tbody>
                  </table>
              }
            </div>
            <div style={{ padding:'8px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>
              📋 Lohnfortzahlung: max. {LOHNFORTZAHLUNG_TAGE} Kalendertage je AU-Fall (§3 EFZG) — §9 BUrlG: Bei Erkrankung im Urlaub werden nachgewiesene Krankheitstage nicht auf den Jahresurlaub angerechnet (Hinweis erscheint bei Überschneidung)
            </div>
          </div>
          </div>
        )}
      </div>

      {/* ── Urlaub Modal ── */}
      {modal === 'vacation' && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(null)}>
          <div className="modal" style={{ maxWidth:500 }}>
            <div className="modal-header"><div className="modal-title">🌴 Urlaubsantrag</div><button className="btn btn-sm" onClick={() => setModal(null)}>✕</button></div>
            <div className="modal-body">
              {formError && <div className="alert alert-danger">{formError}</div>}

              {canManage ? (
                <div className="form-group">
                  <label>Mitarbeiter</label>
                  <select value={form.employee_id||''} onChange={e => f('employee_id', e.target.value)}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.vacation_days_per_year} Tage/Jahr)</option>)}
                  </select>
                </div>
              ) : myBalance && (
                <div className="alert alert-info" style={{ marginBottom:12 }}>
                  Antrag für: <strong>{myEmployee?.first_name} {myEmployee?.last_name}</strong>
                  <span style={{ marginLeft:8 }}>· <strong>{myBalance.remaining}</strong> Tage verfügbar</span>
                </div>
              )}

              <div className="two-col">
                <div className="form-group">
                  <label>Erster Urlaubstag</label>
                  <input type="date" value={form.start_date||''}
                    min={(() => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` })()}
                    onChange={e => f('start_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Letzter Urlaubstag</label>
                  <input type="date" value={form.end_date||''} min={form.start_date||''}
                    onChange={e => f('end_date', e.target.value)} />
                </div>
              </div>

              {/* Preview: Zusammenfassung nach Datumswahl */}
              {form.start_date && form.end_date && previewDays > 0 && (
                <div className="alert" style={{
                  background: vacConflict ? 'var(--info-bg)' : 'var(--success-bg)',
                  color:      vacConflict ? 'var(--info)'    : 'var(--success)',
                  marginBottom:12, fontSize:13,
                }}>
                  📅 Urlaub vom <strong>{new Date(form.start_date+'T12:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</strong> bis <strong>{new Date(form.end_date+'T12:00:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'})}</strong> — <strong>{previewDays} Arbeitstag{previewDays>1?'e':''}</strong> beantragt.
                  {previewDays !== effectivePreview && (
                    <div style={{ marginTop:4, fontSize:12 }}>
                      ℹ️ §9 BUrlG: {vacConflict?.sickDays} davon fallen in eine Krankmeldung → effektiv <strong>{effectivePreview}</strong> Tage abgezogen
                    </div>
                  )}
                </div>
              )}
              {form.start_date && !form.end_date && (
                <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:8 }}>
                  Bitte noch den letzten Urlaubstag auswählen.
                </div>
              )}

              {/* §9 BUrlG Konflikt-Info */}
              {vacConflict && vacConflict.overlaps && (
                <div className="alert alert-info" style={{ marginBottom:12, fontSize:12 }}>
                  {vacConflict.message}
                </div>
              )}

              <div className="form-group"><label>Grund (optional)</label><textarea rows="2" value={form.reason||''} onChange={e => f('reason', e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(null)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveVacation} disabled={saving || previewDays === 0}>
                {saving ? '…' : '💾 Antrag stellen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Krank Modal ── */}
      {modal === 'sick' && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(null)}>
          <div className="modal">
            <div className="modal-header"><div className="modal-title">🤒 Krankmeldung</div><button className="btn btn-sm" onClick={() => setModal(null)}>✕</button></div>
            <div className="modal-body">
              {formError && <div className="alert alert-danger">{formError}</div>}
              {canManage ? (
                <div className="form-group">
                  <label>Mitarbeiter</label>
                  <select value={form.employee_id||''} onChange={e => f('employee_id', e.target.value)}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                  </select>
                </div>
              ) : myEmployee && (
                <div className="alert alert-info" style={{ marginBottom:12 }}>
                  Für: <strong>{myEmployee.first_name} {myEmployee.last_name}</strong>
                </div>
              )}

              <div className="form-group"><label>Krank seit</label><input type="date" value={form.start_date||''} onChange={e => f('start_date', e.target.value)} /></div>

              <div className="form-group">
                <label style={{ display:'flex', alignItems:'center', gap:6 }}>
                  Wieder gesund ab
                  <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400 }}>(leer lassen wenn noch krank)</span>
                </label>
                <input
                  type="date"
                  value={form.end_date||''}
                  min={form.start_date||''}
                  onChange={e => f('end_date', e.target.value || null)}
                />
                {form.start_date && form.end_date && new Date(form.end_date) < new Date(form.start_date) && (
                  <div className="alert alert-danger" style={{ marginTop:6, fontSize:12 }}>Enddatum liegt vor dem Startdatum.</div>
                )}
                {form.start_date && form.end_date && (
                  <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>
                    {Math.ceil((new Date(form.end_date) - new Date(form.start_date)) / 86400000) + 1} Krankheitstag(e)
                  </div>
                )}
              </div>

              {/* §9 BUrlG Live-Preview wenn Urlaub im Zeitraum */}
              {form.start_date && (() => {
                const empId   = canManage ? form.employee_id : profile?.employee_id
                const empVacs = vacations.filter(v => v.employee_id === empId && v.status === 'approved')
                const overlap = checkSickDuringVacation(form.start_date, form.end_date || null, empVacs, holidays)
                if (!overlap.overlaps) return null
                return (
                  <div className="alert alert-success" style={{ marginBottom:12, fontSize:12 }}>
                    {overlap.message}
                  </div>
                )
              })()}

              <div className="alert alert-info" style={{ marginBottom:12, fontSize:12 }}>
                {form.end_date
                  ? `📋 Krankheitsdauer: ${Math.ceil((new Date(form.end_date) - new Date(form.start_date || form.end_date)) / 86400000) + 1} Tag(e) — Lohnfortzahlung gilt bis max. ${LOHNFORTZAHLUNG_TAGE} Tage.`
                  : `📋 Kein Enddatum gesetzt → "noch krank". Lohnfortzahlung läuft bis max. ${LOHNFORTZAHLUNG_TAGE} Tage ab Startdatum (§3 EFZG).`
                }
              </div>
              {/* Attest Upload — mit Datei-Vorschau */}
              <div className="form-group">
                <label style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span>📄 Attest hochladen</span>
                  <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400 }}>
                    (ab 3. Krankheitstag Pflicht — PDF, JPG, PNG, max. 10 MB)
                  </span>
                </label>

                {selectedFile ? (
                  /* Datei ausgewählt — Vorschau */
                  <div style={{ border:'2px solid var(--success)', borderRadius:10, padding:'14px 16px', background:'var(--success-bg)' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span style={{ fontSize:24 }}>
                        {selectedFile.type === 'application/pdf' ? '📄' : '🖼️'}
                      </span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:600, fontSize:13, color:'var(--success)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          ✅ {selectedFile.name}
                        </div>
                        <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                          {(selectedFile.size / 1024).toFixed(0)} KB · {selectedFile.type || 'Unbekannter Typ'} · Bereit zum Absenden
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ flexShrink:0 }}
                        onClick={() => { setSelectedFile(null); if (fileRef.current) fileRef.current.value = '' }}
                      >✕ Entfernen</button>
                    </div>
                  </div>
                ) : (
                  /* Noch keine Datei */
                  <div style={{
                    border:'2px dashed var(--border)', borderRadius:10, padding:'16px',
                    textAlign:'center', cursor:'pointer', background:'var(--bg)',
                  }}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent)' }}
                    onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                    onDrop={e => {
                      e.preventDefault()
                      e.currentTarget.style.borderColor = 'var(--border)'
                      const dropped = e.dataTransfer.files[0]
                      if (dropped) {
                        if (dropped.size > 10485760) { toast.warn('Datei zu groß — max. 10 MB'); return }
                        if (fileRef.current) {
                          const dt = new DataTransfer(); dt.items.add(dropped)
                          fileRef.current.files = dt.files
                        }
                        setSelectedFile(dropped)
                      }
                    }}
                  >
                    <div style={{ fontSize:28, marginBottom:6 }}>📎</div>
                    <div style={{ fontSize:13, fontWeight:500 }}>Datei hier ablegen oder klicken</div>
                    <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>PDF, JPG, PNG, HEIC · max. 10 MB</div>
                  </div>
                )}

                <input
                  ref={fileRef} type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
                  style={{ display:'none' }}
                  onChange={e => {
                    const f2 = e.target.files?.[0]
                    if (!f2) { setSelectedFile(null); return }
                    if (f2.size > 10485760) {
                      toast.warn('Datei zu groß! Max. 10 MB erlaubt.')
                      e.target.value = ''
                      setSelectedFile(null)
                      return
                    }
                    setSelectedFile(f2)
                  }}
                />
              </div>
              <div className="form-group">
                <label>Notizen (optional)</label>
                <textarea rows="2" value={form.notes||''} onChange={e => f('notes', e.target.value)} placeholder="z.B. Attest wird per Post nachgereicht…" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(null)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={saveSick} disabled={saving}>{saving?'…':'💾 Einreichen'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
