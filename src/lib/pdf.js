// Minimaler PDF-Schreiber ohne externe Bibliothek (PDF 1.4, A4, Helvetica/Helvetica-Bold, WinAnsiEncoding).
// Reicht für tabellarische Dokumente wie den Stundennachweis. Rein funktional → im Test prüfbar.

export const A4 = { w: 595.28, h: 841.89 }

// Helvetica-Breiten (AFM, 1/1000 em) für ASCII 32–126; sonst Durchschnittswert
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]

// Unicode → WinAnsi (cp1252). Nicht darstellbare Zeichen (z. B. Emoji) entfallen.
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x201e: 0x84, 0x2026: 0x85, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95 }
export function toWinAnsi(text) {
  const out = []
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0)
    if (c >= 0x20 && c <= 0x7e) out.push(c)
    else if (c >= 0xa0 && c <= 0xff) out.push(c)
    else if (CP1252[c]) out.push(CP1252[c])
    else if (c === 0x09) out.push(0x20)
  }
  return out
}

export function textWidth(text, size, bold = false) {
  let w = 0
  for (const b of toWinAnsi(text)) w += (b >= 32 && b <= 126 ? HELV[b - 32] : 556)
  return (w / 1000) * size * (bold ? 1.06 : 1)
}

// Kürzt Text mit „…“, bis er in maxWidth passt
export function fitText(text, size, maxWidth, bold = false) {
  let t = String(text ?? '')
  if (textWidth(t, size, bold) <= maxWidth) return t
  while (t.length > 1 && textWidth(t + '…', size, bold) > maxWidth) t = t.slice(0, -1)
  return t + '…'
}

const esc = bytes => bytes.map(b => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b))).join('')
const num = n => (Math.round(n * 100) / 100).toString()

// pages: [[ {t:'text', x, y, text, size, bold, align:'left'|'right'} | {t:'line', x1, y1, x2, y2, width, gray} | {t:'rect', x, y, w, h, gray} ]]
// Koordinaten: Ursprung oben links (y nach unten), wird intern auf PDF-Koordinaten umgerechnet.
export function buildPdf(pages, { title = '' } = {}) {
  const chunks = []; let length = 0
  const push = s => { const b = typeof s === 'string' ? latin1(s) : s; chunks.push(b); length += b.length }
  const latin1 = s => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a }
  const offsets = []
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); push(body); push('\nendobj\n') }

  const nPages = Math.max(1, pages.length)
  const firstPageObj = 5
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: nPages }, (_, i) => `${firstPageObj + i * 2} 0 R`).join(' ')
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`)
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  for (let i = 0; i < nPages; i++) {
    const ops = []
    for (const op of pages[i] || []) {
      if (op.t === 'text') {
        const size = op.size || 10
        const x = op.align === 'right' ? op.x - textWidth(op.text, size, op.bold) : op.x
        ops.push(`BT /${op.bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(x)} ${num(A4.h - op.y)} Td (${esc(toWinAnsi(op.text))}) Tj ET`)
      } else if (op.t === 'line') {
        ops.push(`${num(op.gray ?? 0)} G ${num(op.width ?? 0.5)} w ${num(op.x1)} ${num(A4.h - op.y1)} m ${num(op.x2)} ${num(A4.h - op.y2)} l S`)
      } else if (op.t === 'rect') {
        ops.push(`${num(op.gray ?? 0.93)} g ${num(op.x)} ${num(A4.h - op.y - op.h)} ${num(op.w)} ${num(op.h)} re f 0 g`)
      }
    }
    const content = ops.join('\n')
    const pageObj = firstPageObj + i * 2
    obj(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObj + 1} 0 R >>`)
    obj(pageObj + 1, `<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`)
  }
  const infoObj = firstPageObj + nPages * 2
  obj(infoObj, `<< /Title (${esc(toWinAnsi(title))}) /Producer (Cafe Buur) >>`)
  const xrefAt = length
  const count = infoObj + 1
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  push(xref)
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
  const out = new Uint8Array(length); let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

// Dateiname: ASCII, ohne Sonderzeichen (Umlaute umschreiben)
export function safeFileName(name) {
  return String(name ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Dokument'
}
