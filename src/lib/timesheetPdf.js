// Stundennachweis als echte PDF-Datei (A4). Bekommt fertig formatierte/übersetzte Texte,
// damit Bildschirm-/Druckansicht und PDF dieselben Werte zeigen.
import { buildPdf, fitText, A4 } from './pdf.js'

const M = 40                                              // Seitenrand
const COLS = [44, 32, 42, 42, 46, 72]                     // Datum, Tag, Beginn, Ende, Pause, Arbeitszeit; Rest = Bemerkung
const ROW_H = 13, FONT = 8.5

// sheet: { cafeName, cafeAddress, title, subtitle, monthLabel, empLines:[[label, value]],
//          header:[7], rows:[{ cells:[7], weekend }], sums:[[label, value]], warn, footnote, sign:[2], created }
export function timesheetPdf(sheets, { title = '' } = {}) {
  const pages = []
  const tableW = A4.w - 2 * M
  const noteW = tableW - COLS.reduce((a, b) => a + b, 0)
  const colX = [M]; for (const w of COLS) colX.push(colX[colX.length - 1] + w)

  for (const sh of sheets) {
    let page = [], y = M
    const newPage = () => { page = []; pages.push(page); y = M }
    const text = (x, yy, s, size = FONT, bold = false, align = 'left', maxW) =>
      page.push({ t: 'text', x, y: yy, text: maxW ? fitText(s, size, maxW, bold) : s, size, bold, align })
    const tableHeader = () => {
      page.push({ t: 'rect', x: M, y: y - 9, w: tableW, h: ROW_H, gray: 0.9 })
      sh.header.forEach((h, i) => text(i === 5 ? colX[i] + COLS[i] - 4 : colX[i] + 3, y, h, FONT, true, i === 5 ? 'right' : 'left', i === 6 ? noteW - 6 : COLS[i] - 4))
      y += ROW_H
    }
    newPage()
    // Kopf
    text(M, y + 6, sh.cafeName || '', 13, true)
    text(A4.w - M, y + 6, sh.title || '', 14, true, 'right')
    y += 20
    ;(sh.cafeAddress || '').split('\n').filter(Boolean).slice(0, 3).forEach(line => { text(M, y, line, 8.5); y += 11 })
    text(A4.w - M, M + 26, sh.monthLabel || '', 10, false, 'right')
    text(A4.w - M, M + 38, sh.subtitle || '', 7.5, false, 'right')
    y = Math.max(y, M + 50) + 6
    page.push({ t: 'line', x1: M, y1: y, x2: A4.w - M, y2: y, width: 0.8 })
    y += 14
    for (const [label, value] of sh.empLines) { text(M, y, label, 8.5); text(M + 110, y, value, 9, true, 'left', tableW - 110); y += 12 }
    y += 8
    tableHeader()
    for (const r of sh.rows) {
      if (y > A4.h - M - 110) { newPage(); tableHeader() }
      if (r.weekend) page.push({ t: 'rect', x: M, y: y - 9, w: tableW, h: ROW_H, gray: 0.96 })
      r.cells.forEach((c, i) => { if (c) text(i === 5 ? colX[i] + COLS[i] - 4 : colX[i] + 3, y, c, FONT, false, i === 5 ? 'right' : 'left', i === 6 ? noteW - 6 : COLS[i] - 4) })
      page.push({ t: 'line', x1: M, y1: y + 4, x2: A4.w - M, y2: y + 4, width: 0.25, gray: 0.8 })
      y += ROW_H
    }
    // Summen, Hinweise, Unterschriften
    if (y > A4.h - M - 130) newPage()
    y += 10
    sh.sums.forEach(([label, value], i) => { const x = M + i * (tableW / sh.sums.length); text(x, y, label, 8); text(x, y + 12, value, 10, true) })
    y += 30
    if (sh.warn) { text(M, y, sh.warn, 8.5, true, 'left', tableW); y += 13 }
    if (sh.footnote) { text(M, y, sh.footnote, 7.5, false, 'left', tableW); y += 12 }
    y += 34
    const half = (tableW - 30) / 2
    sh.sign.forEach((label, i) => {
      const x = M + i * (half + 30)
      page.push({ t: 'line', x1: x, y1: y, x2: x + half, y2: y, width: 0.6 })
      text(x, y + 11, label, 8)
    })
    text(M, A4.h - M + 10, sh.created || '', 7)
  }
  return buildPdf(pages, { title })
}
