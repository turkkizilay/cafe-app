import { t as tr, getIntlLocale, localizeMessage, message as appMessage, errorMessage, messageParts, formatParam } from '../i18n/runtime.js'
import { useLocale } from '../context/LocaleContext.jsx'
import { useSearchParams } from 'react-router-dom'
import React, { useState, useEffect, useRef } from 'react'
import { supabase, toLocalDateStr } from '../lib/supabase'
import { formatDate } from '../i18n/format.js'
import { openSignedFile } from '../lib/openFile'
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
  useLocale()
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
      if (vacRes.error)  { toast.error(messageParts([appMessage("ui.7006ce026791"), errorMessage(vacRes.error)]));  }
      if (sickRes.error) { toast.error(messageParts([appMessage("ui.ab26cc01cc01"), errorMessage(sickRes.error)])); }
      if (holRes.error)  { toast.error(messageParts([appMessage("ui.242ecdcec487"), errorMessage(holRes.error)]));  }

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
      toast.error(messageParts([appMessage("ui.f1abd7e4336c"), errorMessage(err)]))
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
          const von = formatParam('date', new Date(conflict.start_date + 'T12:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})
          const bis = formatParam('date', new Date(conflict.end_date   + 'T12:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})
          toast.error(appMessage("ui.7f2a2c2e2769", { p1: (von), p2: (bis) }))
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
    toast.success(status === 'approved' ? (appMessage("ui.6b8d7a1ddcc8")) : (appMessage("ui.af0f632149dd")))

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
      setFormError(appMessage("ui.e356cf56fb30")); return
    }
    if (form.start_date > form.end_date) {
      setFormError(appMessage("ui.5630c0b15b57")); return
    }

    // ── Vergangenheits-Check ─────────────────────────────────────
    // toLocalDateStr statt toISOString() — vermeidet UTC-Versatz in DE (UTC+2)
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    if (form.start_date < todayStr) {
      setFormError(messageParts([appMessage("ui.b83d623deb29"), formatParam("date", now, {day:'2-digit',month:'2-digit',year:'numeric'}), ').']))
      savingRef.current = false; return
    }

    // Exakte Tagesberechnung inkl. Feiertage (Feiertage werden nicht als Urlaubstage gezählt)
    const requestedDays = calculateRequestedDays(form.start_date, form.end_date, holidays)
    if (requestedDays === 0) {
      setFormError(appMessage("ui.d5b1e7a1a8a7")); return
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
      setFormError(appMessage("ui.f9c045b64df6"))
      setSaving(false); savingRef.current = false; return
    }
    for (const ex of (freshVacs || [])) {
      if (form.start_date <= ex.end_date && form.end_date >= ex.start_date) {
        const von = formatParam('date', new Date(ex.start_date + 'T12:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})
        const bis = formatParam('date', new Date(ex.end_date   + 'T12:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})
        setFormError(appMessage("ui.634d20c3b949", { p1: (von), p2: (bis) }))
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
      toast.info(appMessage("ui.92603e36a8c0", { p1: (errorMessage(conflict)) }))
    } else {
      toast.success(appMessage("vacation.requested", { count: (requestedDays) }))
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
    if (!empId || !form.start_date) { setFormError(appMessage("ui.649ee731c344")); sickSavingRef.current = false; return }
    // ── Zentrale Input-Validierung (Zukunft/Vergangenheit/Rolle) ──────────
    const validation = validateSickLeaveInput({
      startDate: form.start_date,
      endDate:   form.end_date || null,
      role:      profile?.role || 'employee',
      today:     toLocalDateStr(new Date()),
    })
    if (!validation.valid) {
      setFormError(errorMessage(validation))
      sickSavingRef.current = false; return
    }
    // Warnungen anzeigen aber nicht blockieren
    if (validation.severity === 'warn') {
      setFormError(errorMessage(validation)) // gelbe Warnung, kein Abbruch
    }
    if (form.end_date && new Date(form.end_date) < new Date(form.start_date)) {
      setFormError(appMessage("ui.aeefb04ae6e1"))
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
      setFormError(appMessage("ui.f02d3561bbb0"))
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
          messageParts([appMessage("ui.f68fcf159175", { p1: (formatParam('date', new Date(ex.start_date + 'T00:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})) }), appMessage("ui.702e9ad837ca")])
        )
      } else {
        setFormError(
          messageParts([appMessage("ui.dbeb68a1044b"), appMessage("ui.9785ff29fc68", { p1: (formatParam('date', new Date(ex.start_date + 'T00:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})), p2: (formatParam('date', new Date(ex.end_date + 'T00:00:00'), {day:'2-digit',month:'2-digit',year:'numeric'})) }), appMessage("ui.a250eb280107")])
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
        toast.warn(messageParts([appMessage("ui.c6b3e686f9fd"), errorMessage(upErr)]))
      }
    }

    // §9 BUrlG Hinweis anzeigen wenn relevant
    sickSavingRef.current = false
    toast.success(appMessage("ui.dd3c0506d6a2"))
    if (overlap.overlaps) {
      setTimeout(() => toast.info(errorMessage(overlap), 8000), 500)
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
  // Mitarbeiter dürfen eigene Krankmeldungen nur kurz nach dem Anlegen und ohne Attest löschen
  // (gleiche Regel wie in der Datenbank — sonst entstehen Lücken in der Lohnabrechnung)
  function canSelfDeleteSick(lv) {
    if (!lv || lv.certificate_file_path) return false
    return lv.created_at && (Date.now() - new Date(lv.created_at).getTime()) < 24 * 3600 * 1000
  }

  async function deleteSickLeave(sickId, ownEmployeeId, dateLabel, hasAttest = false) {
    if (deletingSickId) return
    const isOwnLeave = ownEmployeeId === (profile?.employee_id)
    if (!canManage && !isOwnLeave) {
      toast.error(appMessage("ui.fc5b42196a31"))
      return
    }
    const attestNote = hasAttest
      ? tr("ui.c3a0a85a3e76")
      : ''
    if (!window.confirm(
      tr("ui.17a11bb99dde", { p1: (dateLabel), p2: (attestNote) })
    )) return
    setDeletingSickId(sickId)
    setSick(prev => prev.filter(s => s.id !== sickId))
    const { data: deleted, error } = await supabase.from('sick_leave').delete().eq('id', sickId).select('id')
    if (error || !deleted?.length) {
      // Datenbank lässt Mitarbeitern nur frische (24 h) Meldungen ohne Attest löschen
      toast.error(error ? (messageParts([appMessage("ui.3b6ed3d1f8f5"), errorMessage(error)])) : (appMessage("ui.531b7318f9d9")), 8000)
      fetchAll()
    } else {
      toast.success(appMessage("ui.effdf556532d"))
    }
    setDeletingSickId(null)
  }

  // Kein await vor openSignedFile — sonst blockiert Safari den neuen Tab
  function viewCert(filePath) {
    openSignedFile(async () => {
      const { data, error } = await supabase.storage
        .from('sick-certs').createSignedUrl(filePath, 120)
      if (error) throw error
      return data.signedUrl
    }, appMessage("ui.0125cf6ff8d7")).catch(() => toast.error(appMessage("ui.fe7a4cc5a8ff")))
  }

  async function downloadCert(filePath, fileName) {
    // Signierte Download-URL (erzwingt Download statt Öffnen im Browser)
    const { data, error } = await supabase.storage
      .from('sick-certs').createSignedUrl(filePath, 60, { download: fileName || true })
    if (error) { toast.error(messageParts([appMessage("ui.b83dc85a91fe"), errorMessage(error)])); return }
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
    if (file.size > 10 * 1024 * 1024) { toast.warn(appMessage("ui.59acd2fe5194")); return }
    setUploadingSickId(sickId)
    try {
      const ext  = file.name.split('.').pop().toLowerCase()
      const path = `${empId}/${sickId}.${ext}`

      // 1. Storage Upload
      const { error: upErr } = await supabase.storage
        .from('sick-certs').upload(path, file, { upsert: true })
      if (upErr) { toast.error(messageParts([appMessage("ui.69d9669978d1"), errorMessage(upErr)])); return }

      // 2. DB Update — mit .select() um 0 Zeilen (RLS-Block) zu erkennen
      const { data: updated, error: dbErr } = await supabase
        .from('sick_leave')
        .update({ certificate_received: true, certificate_file_path: path, certificate_file_name: file.name })
        .eq('id', sickId)
        .select('id')
      if (dbErr) { toast.error(messageParts([appMessage("ui.a4497d16d103"), errorMessage(dbErr)])); return }
      if (!updated || updated.length === 0) {
        toast.error(appMessage("ui.f8e752f6990f"))
        return
      }

      // 3. Optimistisches UI-Update: sofort lokalen State aktualisieren
      setSick(prev => prev.map((s, labelIndex) =>
        s.id === sickId
          ? { ...s, certificate_received: true, certificate_file_path: path, certificate_file_name: file.name }
          : s
      ))
      toast.success(appMessage("ui.b046db6c302b"))
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
    pending:  <span className="badge badge-amber">{tr("ui.0b5e85dd2508")}</span>,
    approved: <span className="badge badge-green">{tr("ui.9b3015a9dbf0")}</span>,
    rejected: <span className="badge badge-red">{tr("ui.a9148e8654e8")}</span>,
  }

  if (loading) return <div style={{ padding:24 }}>{tr("ui.ebbb1d1f265f")}</div>

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{tr("ui.70171f345790")}</div>
        <div className="topbar-right">
          {tab === 'urlaub' && (
            <button className="btn btn-primary" onClick={() => {
              setFormError(''); setVacConflict(null)
              setForm({ employee_id: canManage ? (employees[0]?.id||'') : profile?.employee_id, start_date:'', end_date:'', reason:'' })
              setModal('vacation')
            }}>{tr("ui.6d2092656740")}</button>
          )}
          {tab === 'krank' && (
            <button className="btn btn-primary" onClick={() => {
              setFormError('')
              setForm({ employee_id: canManage ? (employees[0]?.id||'') : profile?.employee_id, start_date: toLocalDateStr(new Date()), notes:'' })
              setModal('sick')
            }}>{tr("ui.d3ee11d0960b")}</button>
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
                  <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:4 }}>{tr("ui.bade2068667e")}{new Date().getFullYear()}
                  </div>
                  <div style={{ fontSize:26, fontWeight:700, color: myBalance.remaining < 0 ? 'var(--danger)' : myBalance.remaining < 5 ? 'var(--warn)' : 'var(--success)' }}>
                    {myBalance.remaining} {myBalance.remaining === 1 ? tr("ui.1503916a2ab2") : tr("ui.6770c319ff7b")}{tr("ui.addff0163a31")}{myBalance.sick_review > 0 && (
                      <span style={{ fontSize:12, fontWeight:400, color:'var(--warn)', marginLeft:8 }}>{tr("ui.69b6e1d3ea0b")}</span>
                    )}
                  </div>
                  {myBalance.pending > 0 && (
                    <div style={{ fontSize:12, color:'var(--warn)', marginTop:2 }}>
                      + {myBalance.pending}{tr("ui.32042b3bbc6c")}</div>
                  )}
                </div>
                <div style={{ fontSize:13, color:'var(--text-secondary)', textAlign:'right', lineHeight:1.9 }}>
                  <div>{tr("ui.f27bd5c7c231")}<strong>{myBalance.entitlement}</strong>{tr("ui.d00de448b9e2")}</div>
                  {myBalance.approved_total > 0 && (
                    <div>{tr("ui.1658b46c9ffd")}<strong>{myBalance.approved_total}</strong>{tr("ui.d00de448b9e2")}</div>
                  )}
                  {myBalance.returned_sick > 0 && (
                    <div style={{ color:'var(--success)', fontSize:12 }}>{tr("ui.180a9b18d3bb")}<strong>{myBalance.returned_sick}</strong> {myBalance.returned_sick === 1 ? tr("ui.1503916a2ab2") : tr("ui.6770c319ff7b")}{tr("ui.bb976edbcdfb")}</div>
                  )}
                  {myBalance.sick_review > 0 && (
                    <div style={{ color:'var(--warn)', fontSize:12, fontWeight:500 }}>{tr("ui.80a230a0f82f")}<strong>{myBalance.sick_review}</strong> {myBalance.sick_review === 1 ? tr("ui.1503916a2ab2") : tr("ui.6770c319ff7b")}{tr("ui.eea228eea676")}</div>
                  )}
                  {myBalance.returned_holiday > 0 && (
                    <div style={{ color:'var(--success)', fontSize:12 }}>{tr("ui.9ac8a8422bda")}<strong>{myBalance.returned_holiday}</strong> {myBalance.returned_holiday === 1 ? tr("ui.1503916a2ab2") : tr("ui.6770c319ff7b")}{tr("ui.03f14a6dab10")}</div>
                  )}
                  <div style={{ borderTop:'1px solid var(--border)', paddingTop:2, marginTop:2 }}>{tr("ui.1b17fd3ad40d")}<strong>{myBalance.used}</strong>{tr("ui.d00de448b9e2")}{myBalance.sick_review > 0 && (
                      <span style={{ fontSize:11, color:'var(--warn)', marginLeft:4 }}>{tr("ui.9bb4a6e2c971")}{myBalance.sick_review}{tr("ui.657d20bf9403")}</span>
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
                      ⚠️ <strong>{tr("ui.36ba31be2040")}</strong>{tr("ui.7c66b59606e1")}</div>
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
                      found.push([a, b])
                    }
                  }
                }
                if (!found.length) return null
                const fmt = d => new Date(d+'T12:00:00').toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit'})
                const pairs = found.map(([a, b]) => tr('vacation.overlapPair', { first: `${fmt(a.start_date)}–${fmt(a.end_date)}`, second: `${fmt(b.start_date)}–${fmt(b.end_date)}` }))
                return (
                  <div style={{ marginTop:10, padding:'8px 12px', background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, fontSize:12, color:'#92400E' }}>{tr("ui.e394d6ec9802")}{pairs.join(' · ')}{tr("ui.1a99f19a35ac")}</div>
                )
              })()}

              {myBalance.breakdown.length > 0 && (
                <div style={{ marginTop:12, padding:'10px 12px', background:'var(--success-bg)', borderRadius:8, fontSize:12 }}>
                  <strong style={{ color:'var(--success)' }}>{tr("ui.e72ea847346d")}</strong>
                  {myBalance.breakdown.map((b, i) => (
                    <div key={i} style={{ marginTop:4, color:'var(--success)' }}>
                      • {formatDate(b.start)} – {formatDate(b.end)}: {b.effectiveDays}{tr("ui.46b151c76386")}{b.originalDays}{tr("ui.7d31ec1c66bc")}{b.sickDays > 0 && tr("ui.0d24c4f0e244", { p1: (b.sickDays) })}
                      {b.holidayDays > 0 && tr("ui.79ee0c2ba6dd", { p1: (b.holidayDays) })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-5" style={{ marginBottom:16 }}>
          <button className={`btn${tab==='urlaub'?' btn-primary':''}`} onClick={() => setTab('urlaub')}>{tr("ui.33eb3a95746b")}{canManage && vacations.filter(v=>v.status==='pending').length > 0 && (
              <span style={{ background:'var(--warn)', color:'#fff', borderRadius:10, fontSize:10, fontWeight:700, padding:'1px 6px', marginLeft:6 }}>
                {vacations.filter(v=>v.status==='pending').length}
              </span>
            )}
          </button>
          <button className={`btn${tab==='krank'?' btn-primary':''}`} onClick={() => setTab('krank')}>{tr("ui.aa681bca6636")}{sick.filter(s=>!s.end_date).length > 0 && (
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
                    <div className="empty-state-text">{tr("ui.b744ba813488")}</div>
                    {canManage && <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8 }}>{tr("ui.747d7196243b")}</div>}
                  </div>
                : <table>
                    <thead>
                      <tr>{canManage && <th>{tr("ui.f4cb6891b9e5")}</th>}<th>{tr("ui.640e86cbc244")}</th><th>{tr("ui.078a815372af")}</th><th>{tr("ui.d2a94bcff13a")}</th><th>{tr("ui.920e413c7d41")}</th>{canManage&&<th>{tr("ui.a4ad259e71cb")}</th>}</tr>
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
                                  {affected.sickDays > 0 ? tr("vacation.deducted", { days: affected.effectiveDays }) : null}
                                </span>
                              )
                            })()}
                          </td>
                          <td>
                            {STATUS[v.status]}
                            {rowHasConflict && (
                              <div style={{ fontSize:11, color:'#92400E', marginTop:3, fontWeight:500 }}>{tr("ui.48ef5787ea06")}{conflictingVac.employees?.first_name ?? ''} {conflictingVac.employees?.last_name ?? ''} {formatDate(conflictingVac.start_date)}–{formatDate(conflictingVac.end_date)}
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
                                  title={tr("ui.248dab382a85", { p1: (formatDate(v.start_date)), p2: (formatDate(v.end_date)) })}
                                  onClick={() => {
                                    const isDuplicate =
                                      v.start_date >= conflictingVac.start_date &&
                                      v.end_date   <= conflictingVac.end_date
                                    const hint = isDuplicate
                                      ? tr("ui.1d496a3db61e", { p1: (formatDate(v.start_date)), p2: (formatDate(v.end_date)) })
                                      : ''
                                    if (window.confirm(
                                      tr("ui.2b76f8f6b693", { p1: (formatDate(v.start_date)), p2: (formatDate(v.end_date)), p3: (hint) })
                                    )) {
                                      vacAction(v.id, 'rejected')
                                    }
                                  }}
                                >{tr("ui.c904fda89ac4")}{
                                  v.start_date >= conflictingVac.start_date &&
                                  v.end_date   <= conflictingVac.end_date
                                    ? tr("ui.15f040f0d48a") : ''
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
            <div style={{ padding:'8px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>{tr("ui.b0687b5c1818")}</div>
          </div>
        )}

        {tab === 'krank' && (
          <div>
            {/* Krankmeldungs-Übersicht */}
            {sick.filter(s => new Date(s.start_date).getFullYear() === new Date().getFullYear()).length > 0 && (
              <div className="card" style={{ marginBottom:16 }}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:0 }}>
                  {[
                    { label:tr("ui.44aa40ade27a") + new Date().getFullYear(), value: sick.filter(s => new Date(s.start_date).getFullYear() === new Date().getFullYear()).length, icon:'🤒' },
                    { label:tr("ui.891f25d4f8da"),   value: sick.filter(s => !s.end_date).length, icon:'🏥', color: sick.filter(s=>!s.end_date).length > 0 ? 'var(--danger)' : undefined },
                    { label:tr("ui.8f4091ae36f3"),       value: sick.filter(s => s.certificate_received).length, icon:'📄' },
                  ].map((s, labelIndex) => (
                    <div key={labelIndex} style={{ padding:'14px 16px', borderRight:'1px solid var(--border)', textAlign:'center' }}>
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
                ? <div className="empty-state"><div className="empty-state-icon">🤒</div><div className="empty-state-text">{tr("ui.7f0c943892ac")}</div></div>
                : <table>
                    <thead>
                        <tr>
                          {canManage && <th>{tr("ui.f4cb6891b9e5")}</th>}
                          <th>{tr("ui.3a04db51f7a1")}</th>
                          <th>{tr("ui.078a815372af")}</th>
                          <th>{tr("ui.4494993a0fd0")}</th>
                          <th>{tr("ui.920e413c7d41")}</th>
                          <th>{tr("ui.4a4ffb2dc785")}</th>
                          <th>{tr("ui.c81da7e67a9d")}</th>
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
                                          {sc.leaves.length}{tr("ui.fb07970d47ac")}</span>
                                      )}
                                    </td>
                                  )}
                                  <td>{formatDate(sc.start_date)}</td>
                                  <td>
                                    {sc.end_date
                                      ? formatDate(sc.end_date)
                                      : <span className="badge badge-amber">{tr("ui.5920b018bf9f")}</span>}
                                  </td>
                                  <td style={{ fontSize:12 }}>
                                    {status === 'health_insurance_review'
                                      ? <span style={{ color:'#DC2626', fontWeight:600 }}>{tr("ui.9addee09de7e")}{payEnd.toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'})}</span>
                                      : <span>{payEnd.toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'})}</span>
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
                                      ? <span className="badge badge-green" title={localizeMessage(bUrlG.message)}>↩ {bUrlG.returnedDays}{tr("ui.a6f0cdc2ee1f")}</span>
                                      : <span style={{ fontSize:12, color:'var(--text-muted)' }}>–</span>}
                                  </td>
                                  <td>
                                    {latestLeave.certificate_file_path
                                      ? <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                                          <button className="btn btn-sm" onClick={() => viewCert(latestLeave.certificate_file_path)}>{tr("ui.ced8ed5a3dca")}</button>
                                          <button className="btn btn-sm" style={{ background:'var(--info-bg)', color:'var(--info)', border:'1px solid var(--info)' }}
                                            onClick={() => downloadCert(latestLeave.certificate_file_path, latestLeave.certificate_file_name)}>{tr("ui.fee265346c65")}</button>
                                        </div>
                                      : latestLeave.certificate_received
                                        ? <span className="badge badge-green">{tr("ui.e65f6c7a20d5")}</span>
                                        : <label style={{ cursor:'pointer' }}>
                                            <input type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display:'none' }}
                                              onChange={e => { const f = e.target.files?.[0]; if(f) uploadAttestForExisting(latestLeave.id, latestLeave.employee_id || myEmployee?.id, f); e.target.value='' }} />
                                            {uploadingSickId === latestLeave.id
                                              ? <span style={{ fontSize:12, color:'var(--text-muted)' }}>{tr("ui.e770d51fc2cc")}</span>
                                              : <span className="btn btn-sm" style={{ background:'var(--warn-bg)', color:'var(--warn)', border:'1px solid var(--warn)' }}>{tr("ui.b64a6b039400")}</span>}
                                          </label>}
                                  </td>
                                  <td>
                                    {/* Löschen: NUR bei Einzelmeldung über diesen Button.
                                        Bei mehreren Meldungen im Fall: individuelle Buttons im Warn-Bereich unten. */}
                                    {sc.leaves.length === 1 &&
                                     (canManage || (sc.employee_id === profile?.employee_id && canSelfDeleteSick(sc.leaves[0]))) && (
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
                                          {w.level === 'error' ? '🔴' : w.level === 'info' ? 'ℹ️' : '⚠️'} {localizeMessage(w.text)}
                                        </div>
                                      ))}
                                      {/* Detailansicht aller Einzelmeldungen wenn mehrere im Fall */}
                                      {sc.leaves.length > 1 && (
                                        <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid #E5E7EB' }}>
                                          <div style={{ fontSize:12, fontWeight:600, marginBottom:6, color:'var(--text-secondary)' }}>{tr("ui.077b21eede27")}</div>
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
                                                  {lv.end_date ? tr("ui.75a2ca4efd47", { p1: (formatDate(lv.end_date)) }) : tr("ui.acdb1877c9c2")}
                                                  {isFirst && <span style={{ marginLeft:6, fontSize:11, background:'#EFF6FF', color:'#2563EB', padding:'1px 5px', borderRadius:3 }}>{tr("ui.3e6375f451f2")}</span>}
                                                  {!isFirst && lsContinuation && <span style={{ marginLeft:6, fontSize:11, background:'#F0FDF4', color:'#16A34A', padding:'1px 5px', borderRadius:3 }}>{tr("ui.a07b00b6ebe0")}</span>}
                                                  {!isFirst && !lsContinuation && <span style={{ marginLeft:6, fontSize:11, background:'#FEF3C7', color:'#D97706', padding:'1px 5px', borderRadius:3 }}>{tr("ui.5e081e7b8268")}</span>}
                                                </span>
                                                {lv.certificate_file_path
                                                  ? <button className="btn btn-sm" style={{ fontSize:11 }} onClick={() => viewCert(lv.certificate_file_path)}>📄</button>
                                                  : lv.certificate_received
                                                    ? <span style={{ fontSize:11, color:'#059669' }}>✓</span>
                                                    : <span style={{ fontSize:11, color:'#DC2626' }}>{tr("ui.24e80f20f406")}</span>
                                                }
                                                {(canManage || (lv.employee_id === profile?.employee_id && canSelfDeleteSick(lv))) && (
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
            <div style={{ padding:'8px 16px', fontSize:11, color:'var(--text-secondary)', borderTop:'1px solid var(--border)' }}>{tr("ui.3111897089e2")}{LOHNFORTZAHLUNG_TAGE}{tr("ui.cb6fec7d7880")}</div>
          </div>
          </div>
        )}
      </div>

      {/* ── Urlaub Modal ── */}
      {modal === 'vacation' && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(null)}>
          <div className="modal" style={{ maxWidth:500 }}>
            <div className="modal-header"><div className="modal-title">{tr("ui.8e2f41b0af17")}</div><button className="btn btn-sm" onClick={() => setModal(null)}>✕</button></div>
            <div className="modal-body">
              {formError && <div className="alert alert-danger">{localizeMessage(formError)}</div>}

              {canManage ? (
                <div className="form-group">
                  <label>{tr("ui.f4cb6891b9e5")}</label>
                  <select value={form.employee_id||''} onChange={e => f('employee_id', e.target.value)}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.vacation_days_per_year}{tr("ui.9d50ab8d134f")}</option>)}
                  </select>
                </div>
              ) : myBalance && (
                <div className="alert alert-info" style={{ marginBottom:12 }}>{tr("ui.da9ceaf8d683")}<strong>{myEmployee?.first_name} {myEmployee?.last_name}</strong>
                  <span style={{ marginLeft:8 }}>· <strong>{myBalance.remaining}</strong>{tr("ui.fd9bddf4c00a")}</span>
                </div>
              )}

              <div className="two-col">
                <div className="form-group">
                  <label>{tr("ui.5ab20db9e839")}</label>
                  <input type="date" value={form.start_date||''}
                    min={(() => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` })()}
                    onChange={e => f('start_date', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>{tr("ui.d82bc660bbce")}</label>
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
                }}>{tr("ui.925f7ed0d7ea")}<strong>{new Date(form.start_date+'T12:00:00').toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'})}</strong>{tr("ui.cffcbd9e175f")}<strong>{new Date(form.end_date+'T12:00:00').toLocaleDateString(getIntlLocale(),{day:'2-digit',month:'2-digit',year:'numeric'})}</strong> — <strong>{tr("count.workdays", { count: previewDays })}</strong>{tr("ui.84123473136c")}{previewDays !== effectivePreview && (
                    <div style={{ marginTop:4, fontSize:12 }}>{tr("ui.2f570506eaf6")}{vacConflict?.sickDays}{tr("ui.7afb3835fe15")}<strong>{effectivePreview}</strong>{tr("ui.e05017b50845")}</div>
                  )}
                </div>
              )}
              {form.start_date && !form.end_date && (
                <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:8 }}>{tr("ui.d9e4c2667678")}</div>
              )}

              {/* §9 BUrlG Konflikt-Info */}
              {vacConflict && vacConflict.overlaps && (
                <div className="alert alert-info" style={{ marginBottom:12, fontSize:12 }}>
                  {localizeMessage(vacConflict.message)}
                </div>
              )}

              <div className="form-group"><label>{tr("ui.a96aed7de9d5")}</label><textarea rows="2" value={form.reason||''} onChange={e => f('reason', e.target.value)} /></div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-primary" onClick={saveVacation} disabled={saving || previewDays === 0}>
                {saving ? '…' : tr("ui.cca7a6c2ed41")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Krank Modal ── */}
      {modal === 'sick' && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setModal(null)}>
          <div className="modal">
            <div className="modal-header"><div className="modal-title">{tr("ui.26339448d884")}</div><button className="btn btn-sm" onClick={() => setModal(null)}>✕</button></div>
            <div className="modal-body">
              {formError && <div className="alert alert-danger">{localizeMessage(formError)}</div>}
              {canManage ? (
                <div className="form-group">
                  <label>{tr("ui.f4cb6891b9e5")}</label>
                  <select value={form.employee_id||''} onChange={e => f('employee_id', e.target.value)}>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                  </select>
                </div>
              ) : myEmployee && (
                <div className="alert alert-info" style={{ marginBottom:12 }}>{tr("ui.2400f1d4e7a0")}<strong>{myEmployee.first_name} {myEmployee.last_name}</strong>
                </div>
              )}

              <div className="form-group"><label>{tr("ui.99f9a2da8069")}</label><input type="date" value={form.start_date||''} onChange={e => f('start_date', e.target.value)} /></div>

              <div className="form-group">
                <label style={{ display:'flex', alignItems:'center', gap:6 }}>{tr("ui.e2c735e44191")}<span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400 }}>{tr("ui.e93f94a77abc")}</span>
                </label>
                <input
                  type="date"
                  value={form.end_date||''}
                  min={form.start_date||''}
                  onChange={e => f('end_date', e.target.value || null)}
                />
                {form.start_date && form.end_date && new Date(form.end_date) < new Date(form.start_date) && (
                  <div className="alert alert-danger" style={{ marginTop:6, fontSize:12 }}>{tr("ui.b73b91f43f72")}</div>
                )}
                {form.start_date && form.end_date && (
                  <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:4 }}>
                    {Math.ceil((new Date(form.end_date) - new Date(form.start_date)) / 86400000) + 1}{tr("ui.c59166deaff8")}</div>
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
                    {localizeMessage(overlap.message)}
                  </div>
                )
              })()}

              <div className="alert alert-info" style={{ marginBottom:12, fontSize:12 }}>
                {form.end_date
                  ? tr("ui.6a9bc974e3a1", { p1: (Math.ceil((new Date(form.end_date) - new Date(form.start_date || form.end_date)) / 86400000) + 1), p2: (LOHNFORTZAHLUNG_TAGE) })
                  : tr("ui.42232f25609f", { p1: (LOHNFORTZAHLUNG_TAGE) })
                }
              </div>
              {/* Attest Upload — mit Datei-Vorschau */}
              <div className="form-group">
                <label style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span>{tr("ui.2f44991e7485")}</span>
                  <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400 }}>{tr("ui.c938973ba74b")}</span>
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
                          {(selectedFile.size / 1024).toFixed(0)}{tr("ui.ad0444fc45d4")}{selectedFile.type || tr("ui.2bcdf6920e37")}{tr("ui.a8d3ba49c171")}</div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ flexShrink:0 }}
                        onClick={() => { setSelectedFile(null); if (fileRef.current) fileRef.current.value = '' }}
                      >{tr("ui.20fdb002a8ac")}</button>
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
                        if (dropped.size > 10485760) { toast.warn(appMessage("ui.59acd2fe5194")); return }
                        if (fileRef.current) {
                          const dt = new DataTransfer(); dt.items.add(dropped)
                          fileRef.current.files = dt.files
                        }
                        setSelectedFile(dropped)
                      }
                    }}
                  >
                    <div style={{ fontSize:28, marginBottom:6 }}>📎</div>
                    <div style={{ fontSize:13, fontWeight:500 }}>{tr("ui.e829fc39d152")}</div>
                    <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{tr("ui.93081d65fa60")}</div>
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
                      toast.warn(appMessage("ui.4741713b54ef"))
                      e.target.value = ''
                      setSelectedFile(null)
                      return
                    }
                    setSelectedFile(f2)
                  }}
                />
              </div>
              <div className="form-group">
                <label>{tr("ui.115aef1019b4")}</label>
                <textarea rows="2" value={form.notes||''} onChange={e => f('notes', e.target.value)} placeholder={tr("ui.63bb086386d4")} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(null)}>{tr("ui.f7ff1178af20")}</button>
              <button className="btn btn-primary" onClick={saveSick} disabled={saving}>{saving?'…':tr("ui.ac21d3424fe6")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
