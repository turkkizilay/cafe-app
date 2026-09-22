import { useState, useRef, useEffect, useCallback } from 'react'

export default function ImageCropper({ src, onDone, onCancel }) {
  const canvasRef  = useRef()
  const imgRef     = useRef(new Image())
  const [scale,    setScale]    = useState(1)
  const [offset,   setOffset]   = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [imgLoaded,setImgLoaded]= useState(false)
  const dragStart  = useRef({ x:0, y:0, ox:0, oy:0 })
  const SIZE = 260

  useEffect(() => {
    const img = imgRef.current
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const minDim = Math.min(img.width, img.height)
      setScale(SIZE / minDim)
      setOffset({ x:0, y:0 })
      setImgLoaded(true)
    }
    img.src = src
  }, [src])

  useEffect(() => {
    if (!imgLoaded) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const img = imgRef.current
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.beginPath()
    ctx.arc(SIZE/2, SIZE/2, SIZE/2-2, 0, Math.PI*2)
    ctx.clip()
    ctx.clearRect(0, 0, SIZE, SIZE)
    const sw = img.width*scale, sh = img.height*scale
    ctx.drawImage(img, SIZE/2-sw/2+offset.x, SIZE/2-sh/2+offset.y, sw, sh)
    ctx.restore()
    ctx.beginPath()
    ctx.arc(SIZE/2, SIZE/2, SIZE/2-2, 0, Math.PI*2)
    ctx.strokeStyle = '#C2793A'
    ctx.lineWidth = 3
    ctx.stroke()
  }, [scale, offset, imgLoaded])

  const onMouseDown = useCallback((e) => {
    setDragging(true)
    dragStart.current = { x:e.clientX, y:e.clientY, ox:offset.x, oy:offset.y }
  }, [offset])
  const onMouseMove = useCallback((e) => {
    if (!dragging) return
    setOffset({ x: dragStart.current.ox+(e.clientX-dragStart.current.x), y: dragStart.current.oy+(e.clientY-dragStart.current.y) })
  }, [dragging])
  const onMouseUp = useCallback(() => setDragging(false), [])
  const onTouchStart = useCallback((e) => {
    e.preventDefault()
    const t = e.touches[0]
    setDragging(true)
    dragStart.current = { x:t.clientX, y:t.clientY, ox:offset.x, oy:offset.y }
  }, [offset])
  const onTouchMove = useCallback((e) => {
    e.preventDefault()
    if (!dragging) return
    const t = e.touches[0]
    setOffset({ x: dragStart.current.ox+(t.clientX-dragStart.current.x), y: dragStart.current.oy+(t.clientY-dragStart.current.y) })
  }, [dragging])
  const onTouchEnd = useCallback(() => setDragging(false), [])

  function handleDone() {
    const out = document.createElement('canvas')
    out.width = 400; out.height = 400
    const ctx = out.getContext('2d')
    const img = imgRef.current
    const r = 400 / SIZE
    ctx.drawImage(img,
      400/2 - img.width*scale*r/2 + offset.x*r,
      400/2 - img.height*scale*r/2 + offset.y*r,
      img.width*scale*r, img.height*scale*r
    )
    const dataUrl = out.toDataURL('image/jpeg', 0.85)
    onDone(dataUrl)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target===e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth:340 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">📷 Profilbild zuschneiden</div>
          <button className="btn btn-sm" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body" style={{ textAlign:'center' }}>
          <p style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:12 }}>Ziehen zum Verschieben · Slider zum Zoomen</p>
          <canvas ref={canvasRef} width={SIZE} height={SIZE}
            style={{ borderRadius:'50%', cursor:dragging?'grabbing':'grab', touchAction:'none', display:'block', margin:'0 auto' }}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          />
          <div style={{ marginTop:20, padding:'0 8px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:12 }}>🔍</span>
              <input type="range" min="0.3" max="4" step="0.02" value={scale}
                onChange={e => setScale(parseFloat(e.target.value))}
                style={{ flex:1, accentColor:'#C2793A' }} />
              <span style={{ fontSize:12 }}>🔍+</span>
            </div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>Zoom: {Math.round(scale*100)}%</div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>Abbrechen</button>
          <button className="btn btn-primary" onClick={handleDone} disabled={!imgLoaded}>
            ✓ Zuschneiden & Speichern
          </button>
        </div>
      </div>
    </div>
  )
}
