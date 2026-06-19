import { useEffect, useRef } from 'react'
import { N_DISPLAY } from '../lib/ecgRecorder.js'

const CANVAS_H    = 200
const TRACE_COLOR = '#2BBDBD'
const BG_COLOR    = '#060D1A'
const GRID_MAJOR  = 'rgba(220,50,50,0.12)'
const GRID_MINOR  = 'rgba(220,50,50,0.05)'
const ZERO_COLOR  = 'rgba(43,189,189,0.18)'

/**
 * EcgCanvas — premium real-time scrolling ECG trace.
 *
 * Props:
 *   ecgRef     : React ref whose .current is an EcgRecorder instance
 *   isSettling : boolean — shows settling badge when true
 *
 * Canvas reads from EcgRecorder ring buffer via RAF (~60 fps).
 * No React state updates on the 130 Hz hot path.
 */
export default function EcgCanvas({ ecgRef, isSettling }) {
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)

  // ── RAF draw loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function draw() {
      const W = canvas.width
      const H = canvas.height
      if (!W || !H) { rafRef.current = requestAnimationFrame(draw); return }

      ctx.fillStyle = BG_COLOR
      ctx.fillRect(0, 0, W, H)

      // ECG paper grid — minor (5× finer) then major
      const MAJOR  = W / 5
      const minorX = MAJOR / 5
      const majorH = H / 4
      const minorH = majorH / 5

      ctx.strokeStyle = GRID_MINOR
      ctx.lineWidth   = 0.5
      for (let x = minorX; x < W; x += minorX) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      }
      for (let y = minorH; y < H; y += minorH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
      }

      ctx.strokeStyle = GRID_MAJOR
      ctx.lineWidth   = 0.8
      for (let x = MAJOR; x < W; x += MAJOR) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      }
      for (let y = majorH; y < H; y += majorH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
      }

      const recorder = ecgRef.current
      if (!recorder || recorder.getSampleCount() < 2) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }

      const samples = recorder.getDisplayBuffer()
      let min = Infinity, max = -Infinity
      for (let i = 0; i < samples.length; i++) {
        if (samples[i] < min) min = samples[i]
        if (samples[i] > max) max = samples[i]
      }
      const range  = max - min || 1
      const margin = H * 0.08
      const scale  = (H - 2 * margin) / range

      if (min <= 0 && max >= 0) {
        const y0 = margin + (max / range) * (H - 2 * margin)
        ctx.strokeStyle = ZERO_COLOR
        ctx.lineWidth   = 1
        ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke()
      }

      // Glow pass
      ctx.save()
      ctx.shadowColor = TRACE_COLOR
      ctx.shadowBlur  = 10
      ctx.strokeStyle = `${TRACE_COLOR}80`
      ctx.lineWidth   = 3.5
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      for (let i = 0; i < samples.length; i++) {
        const x = (i / (samples.length - 1)) * W
        const y = margin + (max - samples[i]) * scale
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.restore()

      // Crisp trace on top
      ctx.strokeStyle = TRACE_COLOR
      ctx.lineWidth   = 1.8
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      for (let i = 0; i < samples.length; i++) {
        const x = (i / (samples.length - 1)) * W
        const y = margin + (max - samples[i]) * scale
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [ecgRef])

  // ── Sync canvas pixel size to CSS layout size ───────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(([entry]) => {
      canvas.width  = Math.round(entry.contentRect.width  * (window.devicePixelRatio || 1))
      canvas.height = Math.round(CANVAS_H                 * (window.devicePixelRatio || 1))
      canvas.style.width  = '100%'
      canvas.style.height = `${CANVAS_H}px`
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  return (
    <div style={{
      position: 'relative',
      borderRadius: 14,
      overflow: 'hidden',
      marginBottom: 16,
      background: BG_COLOR,
      border: '1px solid rgba(43,189,189,0.18)',
      boxShadow: '0 0 28px rgba(43,189,189,0.07)',
    }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: CANVAS_H }} />

      {/* ECG label */}
      <div style={{
        position: 'absolute', top: 8, left: 12,
        color: 'rgba(43,189,189,0.6)', fontSize: '.63rem', fontWeight: 800,
        letterSpacing: '.12em',
      }}>
        ECG · 130 Hz
      </div>

      {/* Settling badge */}
      {isSettling && (
        <div style={{
          position: 'absolute', top: 8, right: 12,
          background: 'rgba(6,13,26,0.85)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(251,191,36,0.45)',
          borderRadius: 8,
          padding: '4px 12px',
          color: '#FBBF24', fontSize: '.67rem', fontWeight: 700,
          letterSpacing: '.08em',
        }}>
          ◉ A ESTABILIZAR…
        </div>
      )}
    </div>
  )
}
