import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Capacitor } from '@capacitor/core'
import { PolarBle } from '../lib/polarBle.js'
import { SessionRecorder } from '../lib/sessionRecorder.js'
import { uploadSession } from '../lib/supabase.js'
import BigButton from '../components/BigButton.jsx'
import LanguageToggle from '../components/LanguageToggle.jsx'
import HrChart from '../components/HrChart.jsx'

const CHART_MAX_POINTS = 300
const IS_WEB = !Capacitor.isNativePlatform()

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
        color: 'var(--aurora-1)',
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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '24px 0' }}>
      <StatCard label={t('stats.n_rr')}    value={summary.n_rr ?? '—'} unit="bat" />
      <StatCard label={t('stats.hr_mean')} value={summary.hr != null ? Math.round(summary.hr) : '—'} unit="bpm" />
      <StatCard label={t('stats.lnrmssd')} value={summary.lnrmssd != null ? summary.lnrmssd.toFixed(2) : '—'} />
      <StatCard label={t('stats.quality')} value={summary.quality != null ? `${Math.round(summary.quality)}%` : '—'} />
    </div>
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
  const [liveLnRmssd,  setLiveLnRmssd]  = useState(null)
  const [hrBpm,        setHrBpm]        = useState(null)
  const [chartData,    setChartData]    = useState([])
  const [hrStats,      setHrStats]      = useState({ min: null, avg: null, max: null })
  const [uploadError,  setUploadError]  = useState(null)
  const [sessionSummary, setSessionSummary] = useState(null)  // populated after successful upload

  const bleRef      = useRef(null)
  const recorderRef = useRef(null)

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

  // ── Handlers (logic unchanged) ───────────────────────────
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

  function onRecorderUpdate({ elapsed_s, n_rr, live_lnrmssd }) {
    setElapsed(elapsed_s)
    setNRr(n_rr)
    setLiveLnRmssd(live_lnrmssd)
  }

  function startRecording() {
    const recorder = new SessionRecorder(onRecorderUpdate)
    recorderRef.current = recorder
    recorder.start()
    setPhase('recording')
    setChartData([])
    setHrStats({ min: null, avg: null, max: null })
  }

  function cancelRecording() {
    recorderRef.current?.reset()
    recorderRef.current = null
    setPhase('idle')
    setElapsed(0); setNRr(0); setLiveLnRmssd(null)
    setChartData([]); setHrStats({ min: null, avg: null, max: null })
    setUploadError(null)
  }

  async function stopAndUpload() {
    const recorder = recorderRef.current
    if (!recorder) return
    recorder.stop()
    setPhase('uploading')

    const rr        = recorder.getRrIntervals()
    const metrics   = recorder.getMetrics()
    const durationS = recorder.getDurationS()
    const now       = new Date()

    try {
      await uploadSession(
        participant.id,
        now.toISOString().slice(0, 10),
        now.toTimeString().slice(0, 8),
        durationS, rr, metrics
      )
      setSessionSummary({
        n_rr:     metrics.n_rr,
        hr:       metrics.hr_resting_mean,
        lnrmssd:  metrics.lnrmssd_app_estimate,
        quality:  metrics.data_quality_pct,
        duration: durationS,
      })
      setPhase('done')
    } catch (e) {
      setUploadError(e.message)
      setPhase('recording')
    }
  }

  const bleConnected = bleStatus === 'connected'
  const canStart     = bleConnected && phase === 'idle'
  const bleScanning  = bleStatus === 'scanning' || bleStatus === 'connecting'

  // ── Render ───────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)', maxWidth: 520, margin: '0 auto' }}>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '16px 20px',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}>
        <button
          onClick={onBack}
          aria-label={t('nav.back')}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'transparent', border: 'none',
            color: 'var(--aurora-1)', fontSize: '.95rem', fontWeight: 700,
            padding: '6px 0',
          }}
        >
          <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M13 5 L8 10 L13 15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('nav.back')}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text-1)', fontWeight: 800, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {participant.name}
          </div>
          <div style={{ color: 'var(--text-4)', fontSize: '.72rem', fontWeight: 500 }}>
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

            {/* Live chart (fills in as data arrives) */}
            {chartData.length > 0 && (
              <div style={{ marginBottom: 20 }} className="animate-fade-up">
                <HrChart data={chartData} stats={hrStats} />
              </div>
            )}

            {/* Action area */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: hrBpm ? 20 : 32 }}>

              {/* Permission denied — guide user to fix without crashing */}
              {bleStatus === 'permission_denied' && (
                <div style={{
                  background: '#FFF0F0', border: '1px solid var(--error)',
                  borderRadius: 14, padding: '16px 18px',
                }}>
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

              {/* Connect button — both web and native need user gesture for picker */}
              {!bleConnected && bleStatus !== 'permission_denied' && (
                <BigButton
                  onClick={connectBle}
                  disabled={bleScanning}
                  variant="secondary"
                >
                  {bleScanning ? t('ble.scanning') : t('ble.connect_btn')}
                </BigButton>
              )}

              <BigButton onClick={startRecording} disabled={!canStart}>
                {t('session.start')}
              </BigButton>

              {!bleConnected && (
                <p style={{ textAlign: 'center', color: 'var(--text-4)', fontSize: '.9rem' }}>
                  {t('session.ble_required')}
                </p>
              )}
              <p style={{ textAlign: 'center', color: 'var(--text-4)', fontSize: '.88rem', marginTop: 4 }}>
                {t('session.hint')}
              </p>
            </div>
          </>
        )}

        {/* ══ RECORDING ═════════════════════════════════════ */}
        {phase === 'recording' && (
          <>
            {/* Timer — centrepiece */}
            <div style={{ textAlign: 'center', padding: '12px 0 20px' }}>
              <div
                className="timer-active"
                style={{
                  fontSize: '5rem',
                  fontWeight: 800,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-.02em',
                  lineHeight: 1,
                  background: 'var(--aurora-gradient)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
                aria-live="polite"
                aria-label={`Tempo decorrido: ${fmtTime(elapsed)}`}
              >
                {fmtTime(elapsed)}
              </div>
              <div style={{ color: 'var(--text-4)', fontSize: '.85rem', fontWeight: 600, marginTop: 8 }}>
                {t('recording.title')}
              </div>
            </div>

            {/* Live chart */}
            {chartData.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <HrChart data={chartData} stats={hrStats} />
              </div>
            )}

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 24 }}>
              <StatCard label={t('stats.n_rr')}    value={nRr} />
              <StatCard label={t('stats.hr_mean')} value={hrBpm != null ? hrBpm : '—'} unit="bpm" />
              <StatCard label={t('stats.lnrmssd')} value={liveLnRmssd != null ? liveLnRmssd.toFixed(2) : '—'} />
              <StatCard label={t('stats.quality')} value="—" />
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
              <BigButton onClick={stopAndUpload} variant="success">
                {t('session.finish')}
              </BigButton>
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

            {/* Animated checkmark */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <CheckmarkAnim />
            </div>

            <h2 style={{ color: 'var(--success)', fontSize: '1.5rem', fontWeight: 800, marginBottom: 6 }}>
              {t('session.done')}
            </h2>
            <p style={{ color: 'var(--text-4)', fontSize: '.88rem', marginBottom: 4 }}>
              {participant.name}
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
    </div>
  )
}
