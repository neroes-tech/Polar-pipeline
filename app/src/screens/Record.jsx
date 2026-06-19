import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Capacitor } from '@capacitor/core'
import { PolarBle } from '../lib/polarBle.js'
import { SessionRecorder } from '../lib/sessionRecorder.js'
import { uploadSessionRecord, uploadEcgSamples } from '../lib/supabase.js'
import { saveSessionLocally, markSynced } from '../lib/offlineQueue.js'
import { EcgRecorder } from '../lib/ecgRecorder.js'
import EcgCanvas from '../components/EcgCanvas.jsx'
import BigButton from '../components/BigButton.jsx'
import LanguageToggle from '../components/LanguageToggle.jsx'
import HrChart from '../components/HrChart.jsx'
import Footer from '../components/Footer.jsx'

const CHART_MAX_POINTS = 300
const IS_WEB = !Capacitor.isNativePlatform()
const REST_DURATION_S = 300  // 5 minutes

function fmtTime(s) {
  const m  = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${m}:${ss}`
}

// ── Animated checkmark ────────────────────────────────────────────────────────
function CheckmarkAnim() {
  return (
    <svg
      className="check-svg animate-scale-in"
      width="88" height="88"
      viewBox="0 0 52 52"
      aria-hidden
    >
      <circle className="check-circle-anim" cx="26" cy="26" r="23" />
      <path   className="check-path-anim"   d="M15 27 L22 34 L37 18" />
    </svg>
  )
}

// ── BLE status pill ───────────────────────────────────────────────────────────
function BlePill({ status, error, t }) {
  const isAnimated = status === 'scanning' || status === 'connecting' || status === 'reconnecting'
  const isError    = status === 'error' || status === 'permission_denied'

  return (
    <div className={`ble-pill ${status}`} role="status" aria-live="polite">
      <span
        aria-hidden
        className={isAnimated ? 'pulse-dot' : ''}
        style={{
          width: 9, height: 9, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
          background:
            status === 'connected' ? 'var(--success)' :
            isError                ? 'var(--error)'   :
            isAnimated             ? 'var(--warning)'  : 'var(--text-4)',
        }}
      />
      {error || t(`ble.${status}`, { defaultValue: status })}
    </div>
  )
}

// ── Live HR display ───────────────────────────────────────────────────────────
function HrDisplay({ bpm }) {
  if (bpm == null) return null
  return (
    <div style={{ textAlign: 'center', padding: '16px 0 8px' }} className="animate-fade-up">
      <div style={{
        fontSize: '4.2rem',
        fontWeight: 800,
        color: 'var(--teal-2)',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
        letterSpacing: '-.02em',
      }}>
        {bpm}
      </div>
      <div style={{ color: 'var(--text-4)', fontSize: '.85rem', fontWeight: 600, marginTop: 4 }}>
        bpm
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, unit }) {
  return (
    <div className="stat-card">
      <div style={{ color: 'var(--text-4)', fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ color: 'var(--text-1)', fontSize: '1.1rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
        {value}
        {unit && <span style={{ color: 'var(--text-4)', fontSize: '.7rem', fontWeight: 500, marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  )
}

// ── Session summary (done screen) ─────────────────────────────────────────────
function SessionSummary({ summary, t }) {
  if (!summary) return null
  const f2  = v => v  != null ? v.toFixed(2)            : '—'
  const f1  = v => v  != null ? v.toFixed(1)            : '—'
  const fmt = v => v  != null ? String(Math.round(v))   : '—'
  const pct = v => v  != null ? `${Math.round(v)}%`     : '—'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '24px 0' }}>
      <StatCard label={t('stats.lnrmssd')} value={f2(summary.lnrmssd)} />
      <StatCard label={t('stats.rmssd')}   value={fmt(summary.rmssd)}  unit="ms" />
      <StatCard label={t('stats.sdnn')}    value={fmt(summary.sdnn)}   unit="ms" />
      <StatCard label={t('stats.pnn50')}   value={f1(summary.pnn50)}   unit="%" />
      <StatCard label={t('stats.mean_rr')} value={fmt(summary.mean_rr)} unit="ms" />
      <StatCard label={t('stats.hr_mean')} value={fmt(summary.hr)}     unit="bpm" />
      <StatCard label={t('stats.hr_min')}  value={fmt(summary.hr_min)} unit="bpm" />
      <StatCard label={t('stats.hr_max')}  value={fmt(summary.hr_max)} unit="bpm" />
      <StatCard label={t('stats.n_rr')}    value={summary.n_rr ?? '—'} />
      <StatCard label={t('stats.quality')} value={pct(summary.quality)} />
    </div>
  )
}

// ── Saved-locally icon (pending sync) ────────────────────────────────────────
function SavedLocalAnim() {
  return (
    <svg className="check-svg animate-scale-in" width="88" height="88" viewBox="0 0 52 52" fill="none" aria-hidden>
      <circle cx="26" cy="26" r="23" fill="var(--warning-light)" stroke="var(--warning)" strokeWidth="2"/>
      {/* Download-to-device arrow */}
      <path d="M18 34h16M26 16v13M21 25l5 5 5-5" stroke="var(--warning)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Mode selection card ───────────────────────────────────────────────────────
function ModeCard({ icon, title, desc, onClick }) {
  return (
    <button
      onClick={onClick}
      className="participant-card"
      style={{ textAlign: 'left', gap: 18 }}
    >
      <div style={{
        flexShrink: 0, width: 52, height: 52, borderRadius: '50%',
        background: 'var(--bg-teal-soft)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ color: 'var(--text-1)', fontWeight: 800, fontSize: '1.05rem', marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ color: 'var(--text-4)', fontSize: '.85rem', lineHeight: 1.45 }}>
          {desc}
        </div>
      </div>
      <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
        <path d="M7 5l5 5-5 5" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Record({ participant, onBack }) {
  const { t } = useTranslation()

  // ── State (logic unchanged) ──────────────────────────────
  const [bleStatus,    setBleStatus]    = useState('idle')
  const [bleError,     setBleError]     = useState(null)
  const [phase,        setPhase]        = useState('idle')  // idle|recording|uploading|done
  const [elapsed,      setElapsed]      = useState(0)
  const [nRr,          setNRr]          = useState(0)
  const [liveLnRmssd,  setLiveLnRmssd]  = useState(null)  // kept for legacy BLE pill label
  const [hrBpm,        setHrBpm]        = useState(null)
  const [chartData,    setChartData]    = useState([])
  const [hrStats,      setHrStats]      = useState({ min: null, avg: null, max: null })
  const [uploadError,    setUploadError]    = useState(null)
  const [uploadStatus,   setUploadStatus]   = useState(null)  // 'synced' | 'pending'
  const [sessionSummary, setSessionSummary] = useState(null)
  const [sessionMode,    setSessionMode]    = useState(null)   // null | 'rest_5min' | 'free'
  const [liveHrv,        setLiveHrv]        = useState({})    // live metrics snapshot
  // ECG
  const [ecgEnabled,  setEcgEnabled]  = useState(false)  // toggle before session starts
  const [ecgActive,   setEcgActive]   = useState(false)  // ECG stream actually running
  const [ecgSettling, setEcgSettling] = useState(true)   // first 2 s of signal
  const [ecgCount,    setEcgCount]    = useState(0)      // sample count for display

  const bleRef          = useRef(null)
  const recorderRef     = useRef(null)
  const sessionModeRef  = useRef(null)   // mirror of sessionMode for use in callbacks
  const autoStoppedRef  = useRef(false)  // guard: prevent double-trigger of auto-stop
  // ECG refs (read by canvas RAF loop and stopAndUpload — never trigger re-renders)
  const ecgRecRef      = useRef(null)    // EcgRecorder instance
  const ecgSettlingRef = useRef(true)    // mirrors ecgSettling for use in callbacks

  // ── BLE initialization (logic unchanged) ─────────────────
  useEffect(() => {
    const ble = new PolarBle({
      onStatus: (s) => {
        setBleStatus(s)
        if (s === 'error') setBleError(t('error.device_not_found'))
        else setBleError(null)
      },
      onHrm: ({ hr_bpm, rr_ms }) => {
        setHrBpm(hr_bpm)
        recorderRef.current?.addBeat(rr_ms, hr_bpm)
        setChartData(prev => [...prev, { t: prev.length, hr: hr_bpm }].slice(-CHART_MAX_POINTS))
        setHrStats(prev => {
          const vals = [...(prev._raw || []), hr_bpm].slice(-CHART_MAX_POINTS)
          return { _raw: vals, min: Math.min(...vals), avg: Math.round(vals.reduce((a,b)=>a+b,0)/vals.length), max: Math.max(...vals) }
        })
      },
      onDisconnect: () => setHrBpm(null),
    })
    bleRef.current = ble

    async function init() {
      try {
        await ble.initialize()
        // Both native and web: wait for user to tap "Ligar à banda".
      } catch (e) {
        if (e.message === 'permission_denied') {
          setBleStatus('permission_denied')
        } else {
          setBleError(e.message)
          setBleStatus('error')
        }
      }
    }
    init()
    return () => { ble.disconnect().catch(()=>{}); recorderRef.current?.reset() }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-stop for 5-min mode ─────────────────────────────
  useEffect(() => {
    if (phase !== 'recording') return
    if (sessionModeRef.current !== 'rest_5min') return
    if (elapsed < REST_DURATION_S) return
    if (autoStoppedRef.current) return
    autoStoppedRef.current = true
    stopAndUpload()
  }, [elapsed])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ─────────────────────────────────────────────
  function selectMode(mode) {
    setSessionMode(mode)
    sessionModeRef.current = mode
  }

  async function connectBle() {
    setBleError(null)
    try {
      await bleRef.current.connect()
    } catch (e) {
      if (e.message === 'permission_denied') {
        setBleStatus('permission_denied')
      } else {
        const msg = e.message === 'ble_unavailable'  ? t('error.ble_unavailable')
                  : e.message === 'device_not_found' ? t('error.device_not_found')
                  : e.message
        setBleError(msg)
        setBleStatus('error')
      }
    }
  }

  async function openSettings() {
    await bleRef.current?.openSettings()
  }

  function onRecorderUpdate({ elapsed_s, n_rr, live_metrics }) {
    setElapsed(elapsed_s)
    setNRr(n_rr)
    if (live_metrics) {
      setLiveHrv(live_metrics)
      setLiveLnRmssd(live_metrics.lnrmssd)
    }
  }

  // Called by PolarBle on every PMD Data notification (130 Hz burst)
  // Reads/writes refs only — never sets state on the hot path
  function onEcgSamples(samples) {
    const rec = ecgRecRef.current
    if (!rec) return
    rec.addSamples(samples)
    // Flip settling flag exactly once (avoids repeated setState at 130 Hz)
    if (ecgSettlingRef.current && !rec.isSettling()) {
      ecgSettlingRef.current = false
      setEcgSettling(false)
    }
    // Update sample count at most once per batch (not per sample)
    setEcgCount(rec.getSampleCount())
  }

  async function startRecording() {
    autoStoppedRef.current = false
    const recorder = new SessionRecorder(onRecorderUpdate)
    recorderRef.current = recorder
    recorder.start()
    setPhase('recording')
    setChartData([])
    setHrStats({ min: null, avg: null, max: null })

    // ECG — isolated: failure must not affect HR/RR recording
    if (ecgEnabled) {
      const ecgRec = new EcgRecorder()
      ecgRecRef.current   = ecgRec
      ecgSettlingRef.current = true
      setEcgSettling(true)
      setEcgCount(0)
      try {
        await bleRef.current.startEcg(onEcgSamples)
        setEcgActive(true)
      } catch (e) {
        console.warn('[ECG] startEcg failed:', e.message)
        ecgRecRef.current = null
        setEcgActive(false)
        // HR/RR recording continues normally
      }
    }
  }

  function cancelRecording() {
    autoStoppedRef.current = false
    if (ecgActive) {
      bleRef.current?.stopEcg().catch(() => {})
      ecgRecRef.current = null
      setEcgActive(false)
      setEcgSettling(true)
      setEcgCount(0)
    }
    recorderRef.current?.reset()
    recorderRef.current = null
    setPhase('idle')
    setElapsed(0); setNRr(0); setLiveLnRmssd(null); setLiveHrv({})
    setChartData([]); setHrStats({ min: null, avg: null, max: null })
    setUploadError(null)
  }

  async function stopAndUpload() {
    const recorder = recorderRef.current
    if (!recorder) return
    recorder.stop()
    setPhase('uploading')
    setUploadError(null)

    // ── Collect ECG before any await (samples stop arriving after stopEcg) ──
    let ecgSamples = []
    if (ecgActive) {
      try { await bleRef.current.stopEcg() } catch (_) {}
      ecgSamples = ecgRecRef.current?.getAll() ?? []
      setEcgActive(false)
    }

    const sessionId = crypto.randomUUID()
    const rr        = recorder.getRrIntervals()
    const metrics   = recorder.getMetrics()
    const durationS = recorder.getDurationS()
    const now       = new Date()

    const sessionData = {
      id:             sessionId,
      participant_id: participant.id,
      session_date:   now.toISOString().slice(0, 10),
      session_time:   now.toTimeString().slice(0, 8),
      duration_s:     durationS,
      rr_intervals:   rr,
      metrics,
      session_type:   sessionModeRef.current,
      has_ecg:        ecgSamples.length > 0,
      ecg_samples:    ecgSamples,   // stored locally; uploaded separately to ecg_samples table
    }

    // ── Step 1: Always save locally first (includes ECG data) ─────────────────
    let localSaved = false
    try {
      await saveSessionLocally(sessionData)
      localSaved = true
    } catch (e) {
      console.error('[stopAndUpload] local save failed:', e)
    }

    // ── Step 2: Try Supabase upload ───────────────────────────────────────────
    let remoteSynced = false
    try {
      await uploadSessionRecord(sessionData)
      remoteSynced = true
      // ECG upload is best-effort: failure leaves session synced, ECG in local store
      if (ecgSamples.length > 0) {
        await uploadEcgSamples(sessionId, ecgSamples).catch(e =>
          console.warn('[ECG] batch upload failed (data in local store):', e.message)
        )
      }
      if (localSaved) await markSynced(sessionId)
    } catch (_) {
      // No internet — session (and ECG) stays pending, synced via ParticipantSelect
    }

    // ── Step 3: Critical failure (neither local nor remote worked) ────────────
    if (!localSaved && !remoteSynced) {
      setUploadError(t('error.save_failed'))
      setPhase('recording')
      return
    }

    setSessionSummary({
      n_rr:     metrics.n_rr,
      hr:       metrics.hr_resting_mean,
      hr_min:   metrics.hr_min,
      hr_max:   metrics.hr_max,
      lnrmssd:  metrics.lnrmssd_app_estimate,
      rmssd:    metrics.rmssd_ms,
      sdnn:     metrics.sdnn_ms,
      pnn50:    metrics.pnn50_pct,
      mean_rr:  metrics.mean_rr_ms,
      quality:  metrics.data_quality_pct,
      duration: durationS,
    })
    setUploadStatus(remoteSynced ? 'synced' : 'pending')
    setPhase('done')
  }

  const bleConnected = bleStatus === 'connected'
  const canStart     = bleConnected && phase === 'idle' && sessionMode !== null
  const bleScanning  = bleStatus === 'scanning' || bleStatus === 'connecting'

  // Timer display — countdown for rest_5min, elapsed for free
  const displaySecs   = sessionMode === 'rest_5min' ? Math.max(0, REST_DURATION_S - elapsed) : elapsed
  const timerWarning  = sessionMode === 'rest_5min' && displaySecs <= 60 && displaySecs > 10
  const timerDanger   = sessionMode === 'rest_5min' && displaySecs <= 10

  // ── Render ───────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)', maxWidth: 520, margin: '0 auto' }}>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 'calc(16px + var(--safe-top)) 20px 16px',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}>
        <button
          onClick={onBack}
          aria-label={t('nav.sign_out')}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'transparent', border: 'none',
            color: 'var(--teal-2)', fontSize: '.95rem', fontWeight: 700,
            padding: '6px 0',
          }}
        >
          <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M13 5 L8 10 L13 15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('nav.sign_out')}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text-1)', fontWeight: 800, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {participant.name || participant.code}
          </div>
          <div style={{ color: 'var(--text-4)', fontSize: '.72rem', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            {participant.device_id}
          </div>
        </div>

        <LanguageToggle />
      </div>

      {/* ── Main content ────────────────────────────────────── */}
      <div style={{ padding: '20px 20px 40px' }}>

        {/* BLE Pill */}
        <div style={{ marginBottom: 20 }}>
          <BlePill status={bleStatus} error={bleError} t={t} />
        </div>

        {/* ══ IDLE ══════════════════════════════════════════ */}
        {phase === 'idle' && (
          <>
            {/* Live HR (shown as soon as connected, before recording) */}
            <HrDisplay bpm={hrBpm} />

            {/* ── Mode selection ───────────────────────────────── */}
            {sessionMode === null ? (
              <div className="animate-fade-up">
                <p style={{ color: 'var(--text-3)', fontWeight: 700, fontSize: '.85rem', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 14 }}>
                  {t('session.mode_title')}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <ModeCard
                    onClick={() => selectMode('rest_5min')}
                    title={t('session.mode_rest')}
                    desc={t('session.mode_rest_desc')}
                    icon={
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <circle cx="12" cy="12" r="9" stroke="var(--teal-2)" strokeWidth="2"/>
                        <path d="M12 7v5l3.5 3.5" stroke="var(--teal-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M12 3v1M12 20v1M3 12h1M20 12h1" stroke="var(--teal-2)" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    }
                  />
                  <ModeCard
                    onClick={() => selectMode('free')}
                    title={t('session.mode_free')}
                    desc={t('session.mode_free_desc')}
                    icon={
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M12 12c-2-2.5-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.5 6-4z" stroke="var(--teal-2)" strokeWidth="2" strokeLinejoin="round"/>
                        <path d="M12 12c2 2.5 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.5-6 4z" stroke="var(--teal-2)" strokeWidth="2" strokeLinejoin="round"/>
                      </svg>
                    }
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Mode badge — tap to change */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'var(--bg-teal-soft)', borderRadius: 'var(--r-md)',
                  padding: '10px 16px', marginBottom: 4,
                }} className="animate-fade-up">
                  <span style={{ color: 'var(--teal-2)', fontWeight: 700, fontSize: '.9rem' }}>
                    {sessionMode === 'rest_5min' ? t('session.mode_rest') : t('session.mode_free')}
                  </span>
                  <button
                    onClick={() => setSessionMode(null)}
                    style={{ background: 'none', border: 'none', color: 'var(--teal-2)', fontSize: '.85rem', fontWeight: 600, cursor: 'pointer', padding: '2px 0' }}
                  >
                    {t('session.mode_change')}
                  </button>
                </div>

                {/* Live chart */}
                {chartData.length > 0 && (
                  <div style={{ marginBottom: 16 }} className="animate-fade-up">
                    <HrChart data={chartData} stats={hrStats} />
                  </div>
                )}

                {/* Action area */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: hrBpm ? 16 : 24 }}>

                  {/* Permission denied */}
                  {bleStatus === 'permission_denied' && (
                    <div style={{ background: '#FFF0F0', border: '1px solid var(--error)', borderRadius: 14, padding: '16px 18px' }}>
                      <p style={{ color: 'var(--error)', fontWeight: 700, margin: '0 0 6px' }}>
                        {t('error.permission_denied')}
                      </p>
                      <p style={{ color: 'var(--text-3)', fontSize: '.88rem', margin: '0 0 14px', lineHeight: 1.5 }}>
                        {t('error.permission_hint')}
                      </p>
                      <BigButton variant="ghost" onClick={openSettings}>
                        {t('ble.open_settings')}
                      </BigButton>
                    </div>
                  )}

                  {/* Connect button */}
                  {!bleConnected && bleStatus !== 'permission_denied' && (
                    <BigButton onClick={connectBle} disabled={bleScanning} variant="secondary">
                      {bleScanning ? t('ble.scanning') : t('ble.connect_btn')}
                    </BigButton>
                  )}

                  {/* ECG toggle — shown only when connected (PMD needs BLE) */}
                  {bleConnected && (
                    <label style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: ecgEnabled ? 'rgba(0,214,143,0.08)' : 'var(--bg-card)',
                      border: `1.5px solid ${ecgEnabled ? 'rgba(0,214,143,0.35)' : 'var(--border)'}`,
                      borderRadius: 'var(--r-md)', padding: '11px 16px', cursor: 'pointer',
                    }}>
                      <div>
                        <div style={{ color: 'var(--text-1)', fontWeight: 700, fontSize: '.9rem' }}>
                          {t('ecg.toggle')}
                        </div>
                        <div style={{ color: 'var(--text-4)', fontSize: '.75rem', marginTop: 2 }}>
                          {t('ecg.toggle_desc')}
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={ecgEnabled}
                        onChange={e => setEcgEnabled(e.target.checked)}
                        style={{ width: 20, height: 20, accentColor: 'var(--teal-2)', flexShrink: 0 }}
                      />
                    </label>
                  )}

                  <BigButton onClick={startRecording} disabled={!canStart}>
                    {t('session.start')}
                  </BigButton>

                  {!bleConnected && (
                    <p style={{ textAlign: 'center', color: 'var(--text-4)', fontSize: '.9rem' }}>
                      {t('session.ble_required')}
                    </p>
                  )}
                  {sessionMode === 'rest_5min' && (
                    <p style={{ textAlign: 'center', color: 'var(--text-4)', fontSize: '.88rem', marginTop: 2 }}>
                      {t('session.hint')}
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* ══ RECORDING ═════════════════════════════════════ */}
        {phase === 'recording' && (
          <>
            {/* Timer — centrepiece */}
            <div style={{ textAlign: 'center', padding: '12px 0 20px' }}>
              <div
                className={`timer-active${timerDanger ? ' animate-pulse' : ''}`}
                style={{
                  fontSize: '5rem',
                  fontWeight: 800,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-.02em',
                  lineHeight: 1,
                  ...(timerDanger ? { color: 'var(--error)' }
                    : timerWarning ? { color: 'var(--warning)' }
                    : {
                        background: 'var(--brand-gradient)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                      }),
                }}
                aria-live="polite"
                aria-label={sessionMode === 'rest_5min'
                  ? `Tempo restante: ${fmtTime(displaySecs)}`
                  : `Tempo decorrido: ${fmtTime(displaySecs)}`}
              >
                {fmtTime(displaySecs)}
              </div>
              <div style={{ color: 'var(--text-4)', fontSize: '.85rem', fontWeight: 600, marginTop: 8 }}>
                {sessionMode === 'rest_5min' ? t('recording.time_remaining') : t('recording.title')}
              </div>
            </div>

            {/* ECG canvas — only when ECG stream is active */}
            {ecgActive && (
              <EcgCanvas ecgRef={ecgRecRef} isSettling={ecgSettling} />
            )}

            {/* ECG sample counter badge */}
            {ecgActive && ecgCount > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 10, marginTop: -8,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#2BBDBD', flexShrink: 0,
                  animation: 'pulse-dot 1.2s infinite',
                }} />
                <span style={{ color: 'rgba(43,189,189,0.85)', fontSize: '.72rem', fontWeight: 700 }}>
                  {t('ecg.samples', { count: ecgCount.toLocaleString() })}
                </span>
              </div>
            )}

            {/* Stats grid — 8 live HRV metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7, marginBottom: 24 }}>
              <StatCard label={t('stats.lnrmssd')} value={liveHrv.lnrmssd != null ? liveHrv.lnrmssd.toFixed(2) : '—'} />
              <StatCard label={t('stats.rmssd')}   value={liveHrv.rmssd   != null ? Math.round(liveHrv.rmssd) : '—'} unit="ms" />
              <StatCard label={t('stats.sdnn')}    value={liveHrv.sdnn    != null ? Math.round(liveHrv.sdnn)  : '—'} unit="ms" />
              <StatCard label={t('stats.pnn50')}   value={liveHrv.pnn50   != null ? liveHrv.pnn50.toFixed(1)  : '—'} unit="%" />
              <StatCard label={t('stats.mean_rr')} value={liveHrv.mean_rr != null ? liveHrv.mean_rr : '—'} unit="ms" />
              <StatCard label={t('stats.hr_mean')} value={hrBpm != null ? hrBpm : '—'} unit="bpm" />
              <StatCard label={t('stats.n_rr')}    value={nRr} />
              <StatCard label={t('stats.quality')} value={liveHrv.quality != null ? `${Math.round(liveHrv.quality)}%` : '—'} />
            </div>

            {/* Upload error */}
            {uploadError && (
              <div style={{
                background: 'var(--error-light)', border: '1.5px solid #FECACA',
                borderRadius: 'var(--r-md)', padding: '14px 18px', marginBottom: 16,
                color: 'var(--error)', fontSize: '.9rem', fontWeight: 600,
              }}>
                {t('error.upload_failed')}: {uploadError}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Free mode: prominent finish button. 5-min mode: early stop (ghost) */}
              {sessionMode === 'free' ? (
                <BigButton onClick={stopAndUpload} variant="success">
                  {t('session.finish')}
                </BigButton>
              ) : (
                <BigButton onClick={stopAndUpload} variant="ghost">
                  {t('session.finish_early')}
                </BigButton>
              )}
              <BigButton onClick={cancelRecording} variant="ghost">
                {t('session.cancel')}
              </BigButton>
            </div>
          </>
        )}

        {/* ══ UPLOADING ══════════════════════════════════════ */}
        {phase === 'uploading' && (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <div className="spinner" style={{ width: 36, height: 36, borderWidth: 4 }} />
            </div>
            <p style={{ color: 'var(--text-3)', fontSize: '1.05rem', fontWeight: 600 }}>
              {t('session.uploading')}
            </p>
          </div>
        )}

        {/* ══ DONE ═══════════════════════════════════════════ */}
        {phase === 'done' && (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>

            {/* Icon + status — differs by upload outcome */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              {uploadStatus === 'pending' ? <SavedLocalAnim /> : <CheckmarkAnim />}
            </div>

            <h2 style={{
              color: uploadStatus === 'pending' ? 'var(--warning)' : 'var(--success)',
              fontSize: '1.5rem', fontWeight: 800, marginBottom: 6,
            }}>
              {uploadStatus === 'pending'
                ? t('session_status.saved_local')
                : t('session_status.saved_synced')}
            </h2>

            {uploadStatus === 'pending' && (
              <p style={{ color: 'var(--text-4)', fontSize: '.85rem', marginBottom: 4 }}>
                {t('session_status.pending_sync', { count: 1 })}
              </p>
            )}

            <p style={{ color: 'var(--text-4)', fontSize: '.88rem', marginBottom: 4 }}>
              {participant.name || participant.code}
              {sessionMode && (
                <span style={{ marginLeft: 8, opacity: .7 }}>
                  · {sessionMode === 'rest_5min' ? t('session.mode_rest') : t('session.mode_free')}
                </span>
              )}
            </p>
            {sessionSummary?.duration != null && (
              <p style={{ color: 'var(--text-4)', fontSize: '.88rem', marginBottom: 0 }}>
                {fmtTime(sessionSummary.duration)} · {sessionSummary.n_rr} batimentos
              </p>
            )}

            {/* Summary metrics */}
            <SessionSummary summary={sessionSummary} t={t} />

            <BigButton onClick={onBack}>
              {t('session.new')}
            </BigButton>
          </div>
        )}
      </div>

      <Footer />
    </div>
  )
}
