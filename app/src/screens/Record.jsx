import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Capacitor } from '@capacitor/core'
import { PolarBle } from '../lib/polarBle.js'
import { SessionRecorder } from '../lib/sessionRecorder.js'
import { uploadSessionRecord, uploadEcgSamples } from '../lib/supabase.js'
import { beginSession, appendRr, appendEcg, finishSession, discardSession, markSynced, getSessionArrays } from '../lib/localSessionStore.js'
import { computeSessionMetrics } from '../lib/hrvCalc.js'
import { EcgRecorder } from '../lib/ecgRecorder.js'
import { startForegroundService, stopForegroundService } from '../lib/foregroundService.js'
import { startTicker, updateTickerStatus, stopTicker } from '../lib/notificationTicker.js'
import { primeAudioContext, playSessionEndAlert } from '../lib/sessionAlert.js'
import { activateKeepAwake, releaseKeepAwake } from '../lib/keepAwake.js'
import { isBatteryOptimizationEnabled, requestDisableBatteryOptimization } from '../lib/batteryOptimization.js'
import { notifyBleDisconnected, notifySessionSaved, notifySessionsSynced } from '../lib/localAlerts.js'
import { buildFormsAutoLoginUrl, participantCodeToEmail } from '../lib/formsAutoLogin.js'
import { Preferences } from '@capacitor/preferences'
import { Browser } from '@capacitor/browser'
import EcgCanvas from '../components/EcgCanvas.jsx'
import BigButton from '../components/BigButton.jsx'
import LanguageToggle from '../components/LanguageToggle.jsx'
import Footer from '../components/Footer.jsx'

const CHART_MAX_POINTS = 300
const IS_WEB = !Capacitor.isNativePlatform()
const REST_DURATION_S = 300      // 5 minutes
const FLUSH_INTERVAL_MS = 4000   // how often in-progress RR/ECG buffers are written to local SQLite
const DISCONNECT_ALERT_MS = 90000 // BLE disconnected this long during a session → local notification
const BATTERY_PROMPT_KEY = 'neroes_battery_prompt_done_v1'

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
  const isError    = status === 'error' || status === 'permission_denied' || status === 'scan_blocked'

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
export default function Record({ participant, onBack, recoveredCount = 0, resumeSession = null }) {
  const { t } = useTranslation()

  // ── State (logic unchanged) ──────────────────────────────
  const [bleStatus,    setBleStatus]    = useState('idle')
  const [bleError,     setBleError]     = useState(null)
  const [questionnaireError, setQuestionnaireError] = useState(null)
  // If App.jsx found a local session still sitting in 'recording' state
  // (Activity/WebView was torn down mid-recording, foreground service kept
  // going), start straight into the recording UI instead of the picker —
  // see the resume-setup effect below for the rest of the rehydration.
  const [phase,        setPhase]        = useState(() => resumeSession ? 'recording' : 'idle')  // idle|recording|uploading|done
  const [elapsed,      setElapsed]      = useState(0)
  const [nRr,          setNRr]          = useState(0)
  const [liveLnRmssd,  setLiveLnRmssd]  = useState(null)  // kept for legacy BLE pill label
  const [hrBpm,        setHrBpm]        = useState(null)
  const [chartData,    setChartData]    = useState([])
  const [hrStats,      setHrStats]      = useState({ min: null, avg: null, max: null })
  const [uploadError,    setUploadError]    = useState(null)
  const [uploadStatus,   setUploadStatus]   = useState(null)  // 'synced' | 'pending'
  const [sessionSummary, setSessionSummary] = useState(null)
  const [sessionMode,    setSessionMode]    = useState(() => resumeSession?.session_type ?? null)   // null | 'rest_5min' | 'free'
  const [liveHrv,        setLiveHrv]        = useState({})    // live metrics snapshot
  // ECG — always attempted, gracefully degrades if PMD unavailable
  const [ecgActive,   setEcgActive]   = useState(false)  // ECG stream actually running
  const [ecgSettling, setEcgSettling] = useState(true)   // first 2 s of signal
  const [ecgCount,    setEcgCount]    = useState(0)      // sample count for display
  const [showBatteryPrompt, setShowBatteryPrompt] = useState(false)  // one-time background-reliability nudge (Android)

  const bleRef                = useRef(null)
  const recorderRef           = useRef(null)
  const sessionModeRef        = useRef(resumeSession?.session_type ?? null)   // mirror of sessionMode for use in callbacks
  const phaseRef              = useRef(resumeSession ? 'recording' : 'idle') // mirror of phase — read by the BLE onReconnected callback, fixed at mount time
  const initialEcgKickRef     = useRef(false)  // fires resumeEcgAfterReconnect() once on the very first successful connect, to restart ECG when resuming a session
  const autoStoppedRef        = useRef(false)  // guard: prevent double-trigger of auto-stop
  // wall-clock ms at session start (elapsed is always computed from this, never
  // from a timer — see onRecorderUpdate). Restored from the ORIGINAL start
  // time when resuming, so elapsed correctly includes time before the reset.
  const sessionStartWallClock = useRef(resumeSession ? new Date(resumeSession.started_at).getTime() : null)
  // ECG refs (read by canvas RAF loop and stopAndUpload — never trigger re-renders)
  const ecgRecRef      = useRef(null)    // EcgRecorder instance
  const ecgSettlingRef = useRef(true)    // mirrors ecgSettling for use in callbacks
  const hrBpmRef       = useRef(null)    // mirrors hrBpm — read by flushBuffers' setInterval closure, which never sees state updates
  const bleStatusRef   = useRef('idle')  // mirrors bleStatus — same stale-closure reason as hrBpmRef, used to show connection state in the notification

  // Crash-safe incremental persistence — see localSessionStore.js
  const sessionIdRef      = useRef(resumeSession?.id ?? null)   // id of the local SQLite session row for the in-progress recording
  const rrFlushCursorRef  = useRef(0)      // index of the next un-flushed RR interval, WITHIN THIS JS SESSION's recorder
  const ecgFlushCursorRef = useRef(0)      // index of the next un-flushed ECG sample, WITHIN THIS JS SESSION's recorder
  // How many RR/ECG rows already existed in SQLite for this session before
  // this JS instance started (0 for a fresh recording; >0 when resuming).
  // The in-memory recorder always starts counting from 0, so every SQLite
  // write and every "how many total beats so far" display must add this in.
  const rrSeqBaseRef      = useRef(0)
  const ecgSeqBaseRef     = useRef(0)
  const flushIntervalRef  = useRef(null)

  // BLE disconnect watchdog — tracks total time disconnected during a session
  // (gap_s, uploaded with the session for QA) and fires a local notification
  // if the band has been unreachable long enough that the participant may
  // not have noticed the on-screen "reconnecting" pill (e.g. phone in a bag).
  const disconnectedSinceRef = useRef(null)
  const gapAccumRef          = useRef(0)
  const watchdogTimeoutRef   = useRef(null)
  const watchdogFiredRef     = useRef(false)

  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { bleStatusRef.current = bleStatus }, [bleStatus])

  // Rehydrate a session that survived an Activity/WebView reset while it was
  // still recording (see App.jsx — this is the resumable orphan it found).
  // The SQLite rows are the only durable record of what's already been
  // captured; everything JS-side (the recorder, the ECG buffer, the flush
  // interval, the foreground notification) has to be rebuilt from scratch.
  useEffect(() => {
    if (!resumeSession) return
    ;(async () => {
      const { rr, ecg } = await getSessionArrays(resumeSession.id).catch(() => ({ rr: [], ecg: [] }))
      rrSeqBaseRef.current  = rr.length
      ecgSeqBaseRef.current = ecg.length
      setNRr(rr.length)
      setEcgCount(ecg.length)
      setElapsed(Math.floor((Date.now() - sessionStartWallClock.current) / 1000))

      gapAccumRef.current           = resumeSession.gap_s || 0
      disconnectedSinceRef.current  = null
      watchdogFiredRef.current      = false
      rrFlushCursorRef.current      = 0
      ecgFlushCursorRef.current     = 0

      const recorder = new SessionRecorder(onRecorderUpdate)
      recorderRef.current = recorder
      recorder.start()

      const ecgRec = new EcgRecorder()
      ecgRecRef.current      = ecgRec
      ecgSettlingRef.current = true
      setEcgSettling(true)

      flushIntervalRef.current = setInterval(flushBuffers, FLUSH_INTERVAL_MS)
      startForegroundService(resumeSession.session_type)
      startTicker({ startedAt: sessionStartWallClock.current, sessionType: resumeSession.session_type })
      activateKeepAwake()
      // BLE reconnects on its own (see the mount effect below); once
      // connected, the onStatus handler calls resumeEcgAfterReconnect() to
      // restart the PMD stream, same as any other mid-session reconnect.
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resume the ECG stream after a BLE reconnect mid-session. The GATT
  // disconnect tears down the PMD subscription entirely — HR/RR resume on
  // their own (see PolarBle's reconnect loop), but ECG does not, so without
  // this a dropped-and-recovered connection would silently record HR only
  // for the rest of the session.
  async function resumeEcgAfterReconnect() {
    if (phaseRef.current !== 'recording') return
    ecgSettlingRef.current = true
    setEcgSettling(true)
    try {
      await bleRef.current.startEcg(onEcgSamples)
      setEcgActive(true)
    } catch (e) {
      console.warn('[ECG] resume after reconnect failed:', e.message)
      setEcgActive(false)
    }
  }

  // The persistent notification's live text (elapsed/countdown + bpm) is
  // ticked entirely natively now — see notificationTicker.js/
  // NotificationTickerPlugin.java. A first attempt drove it from JS (a
  // setInterval, then from BLE onHrm events) but Chromium's background timer
  // throttling and, worse, cases where the WebView itself stops running JS
  // for stretches while hidden, could still freeze it. A native Handler
  // sidesteps the WebView entirely, so it can't be affected by that. JS's
  // only remaining job is pushing bpm/connection status via
  // updateTickerStatus() (see onHrm/onStatus below) whenever it gets a
  // chance to run — the ticker keeps using the last value it got even if JS
  // goes quiet for a while, instead of freezing the whole notification.

  async function flushBuffers() {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    try {
      const recorder = recorderRef.current
      if (recorder) {
        const rr = recorder.getRrIntervals()
        const from = rrFlushCursorRef.current
        if (rr.length > from) {
          // rrSeqBaseRef offsets past whatever this session already had in
          // SQLite before this JS instance existed (0 unless resuming) —
          // without it, a resumed session would overwrite seq 0, 1, 2... on
          // top of the rows already written before the reset.
          await appendRr(sessionId, rr.slice(from), rrSeqBaseRef.current + from)
          rrFlushCursorRef.current = rr.length
        }
      }
      const ecgRec = ecgRecRef.current
      if (ecgRec) {
        const all = ecgRec.getAll()
        const from = ecgFlushCursorRef.current
        if (all.length > from) {
          await appendEcg(sessionId, all.slice(from), ecgSeqBaseRef.current + from)
          ecgFlushCursorRef.current = all.length
        }
      }
    } catch (e) {
      console.warn('[flushBuffers] failed:', e.message)
    }
  }

  // ── BLE initialization (logic unchanged) ─────────────────
  useEffect(() => {
    const ble = new PolarBle({
      deviceIdHint: participant.device_id,
      onStatus: (s) => {
        setBleStatus(s)
        bleStatusRef.current = s
        if (s === 'error') setBleError(t('error.device_not_found'))
        else setBleError(null)
        // Push the status change immediately — don't wait for the next
        // heartbeat, which won't come at all while disconnected. Without
        // this the ticker would keep showing a stale bpm as if nothing
        // were wrong right through a disconnect.
        updateTickerStatus({ bpm: hrBpmRef.current, status: s })
        // The very first connect() (as opposed to an automatic reconnect,
        // which already goes through onReconnected) doesn't otherwise start
        // ECG on its own when resuming a session found already 'recording'
        // at launch — resumeEcgAfterReconnect() is a no-op unless phase is
        // already 'recording', so this is harmless for a fresh session.
        if (s === 'connected' && !initialEcgKickRef.current) {
          initialEcgKickRef.current = true
          resumeEcgAfterReconnect()
        }
      },
      onHrm: ({ hr_bpm, rr_ms }) => {
        setHrBpm(hr_bpm)
        hrBpmRef.current = hr_bpm
        recorderRef.current?.addBeat(rr_ms, hr_bpm)
        setChartData(prev => [...prev, { t: prev.length, hr: hr_bpm }].slice(-CHART_MAX_POINTS))
        setHrStats(prev => {
          const vals = [...(prev._raw || []), hr_bpm].slice(-CHART_MAX_POINTS)
          return { _raw: vals, min: Math.min(...vals), avg: Math.round(vals.reduce((a,b)=>a+b,0)/vals.length), max: Math.max(...vals) }
        })
        // Pushes the fresh bpm to the native ticker (see notificationTicker.js).
        updateTickerStatus({ bpm: hr_bpm, status: bleStatusRef.current })
      },
      onDisconnect: () => { setHrBpm(null); hrBpmRef.current = null; setEcgActive(false) },
      onReconnected: resumeEcgAfterReconnect,
    })
    bleRef.current = ble

    async function init() {
      try {
        await ble.initialize()
        connectBle()  // auto-connect on mount; errors handled inside connectBle()
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

  // ── Layer A: correct elapsed + reconnect BLE on app resume ───────────────
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      // Correct elapsed from wall clock if JS was frozen in background
      if (phase === 'recording' && sessionStartWallClock.current) {
        const wallElapsed = Math.floor((Date.now() - sessionStartWallClock.current) / 1000)
        setElapsed(prev => (wallElapsed > prev ? wallElapsed : prev))
      }
      // Reconnect BLE if disconnected while in background
      if (phase === 'recording' && bleStatus !== 'connected' && bleStatus !== 'connecting' && bleStatus !== 'reconnecting') {
        connectBle()
      }
      // Re-request wake lock: the Web Wake Lock API auto-releases when the page
      // loses visibility (iOS/browser behaviour), so we must re-acquire it here.
      // The native plugin (Android APK) is idempotent — safe to call again.
      if (phase === 'recording') activateKeepAwake()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [phase, bleStatus])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── BLE disconnect watchdog — accumulate gap_s, alert if disconnected too long ──
  useEffect(() => {
    if (phase !== 'recording') return
    const isDown = bleStatus === 'reconnecting' || bleStatus === 'error' || bleStatus === 'permission_denied' || bleStatus === 'scan_blocked'

    if (isDown) {
      if (!disconnectedSinceRef.current) {
        disconnectedSinceRef.current = Date.now()
        watchdogFiredRef.current = false
      }
      if (!watchdogTimeoutRef.current) {
        watchdogTimeoutRef.current = setTimeout(() => {
          if (!watchdogFiredRef.current) {
            watchdogFiredRef.current = true
            notifyBleDisconnected()
          }
        }, DISCONNECT_ALERT_MS)
      }
    } else if (bleStatus === 'connected') {
      if (disconnectedSinceRef.current) {
        gapAccumRef.current += Math.round((Date.now() - disconnectedSinceRef.current) / 1000)
        disconnectedSinceRef.current = null
      }
      if (watchdogTimeoutRef.current) {
        clearTimeout(watchdogTimeoutRef.current)
        watchdogTimeoutRef.current = null
      }
    }
  }, [phase, bleStatus])

  // ── One-time background-reliability nudge (Android) ──────────────────────
  // A foreground service alone doesn't survive aggressive OEM battery savers —
  // ask the participant once, right after the first successful pairing, to
  // exempt the app from battery optimization.
  useEffect(() => {
    if (bleStatus !== 'connected') return
    let cancelled = false
    ;(async () => {
      const { value } = await Preferences.get({ key: BATTERY_PROMPT_KEY })
      if (value || cancelled) return
      if (await isBatteryOptimizationEnabled()) {
        if (!cancelled) setShowBatteryPrompt(true)
      } else {
        await Preferences.set({ key: BATTERY_PROMPT_KEY, value: '1' })
      }
    })()
    return () => { cancelled = true }
  }, [bleStatus])

  async function confirmBatteryPrompt() {
    await requestDisableBatteryOptimization()
    await Preferences.set({ key: BATTERY_PROMPT_KEY, value: '1' })
    setShowBatteryPrompt(false)
  }

  async function dismissBatteryPrompt() {
    await Preferences.set({ key: BATTERY_PROMPT_KEY, value: '1' })
    setShowBatteryPrompt(false)
  }

  // ── Handlers ─────────────────────────────────────────────
  async function selectAndStart(mode) {
    primeAudioContext()
    sessionModeRef.current = mode
    setSessionMode(mode)
    await startRecording()
  }

  // Opens the separate "Questionário Matinal" app already signed in as this
  // participant — see src/lib/formsAutoLogin.js for why this is safe (short
  // -lived signed link, verified server-side, never exposes the password).
  async function openQuestionnaire() {
    setQuestionnaireError(null)
    try {
      const email = participantCodeToEmail(participant.code)
      if (!email) throw new Error('no_participant_email')
      const url = await buildFormsAutoLoginUrl(email)
      await Browser.open({ url })
    } catch (e) {
      console.warn('[questionnaire] failed to open:', e.message)
      setQuestionnaireError(t('error.questionnaire_failed'))
    }
  }

  async function connectBle() {
    setBleError(null)
    try {
      await bleRef.current.connect()
    } catch (e) {
      if (e.message === 'permission_denied') {
        setBleStatus('permission_denied')
      } else if (e.message === 'scan_blocked') {
        setBleStatus('scan_blocked')
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

  function onRecorderUpdate({ n_rr, live_metrics }) {
    // Elapsed always comes from the wall clock, not the recorder's own
    // timer — the recorder restarts at 0 on every JS reload (e.g. resuming
    // a session after the Activity was recreated), but the session's real
    // elapsed time is anchored to sessionStartWallClock, its original start.
    if (sessionStartWallClock.current) {
      setElapsed(Math.floor((Date.now() - sessionStartWallClock.current) / 1000))
    }
    // rrSeqBaseRef: beats already in SQLite before this JS instance started
    // (0 for a fresh recording) — the recorder only counts what it has seen
    // itself, so the displayed total must add the pre-existing count back in.
    setNRr(n_rr + rrSeqBaseRef.current)
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
    sessionStartWallClock.current = Date.now()

    const sessionId = crypto.randomUUID()
    sessionIdRef.current        = sessionId
    rrFlushCursorRef.current    = 0
    ecgFlushCursorRef.current   = 0
    rrSeqBaseRef.current        = 0  // brand-new session — nothing pre-existing to offset past
    ecgSeqBaseRef.current       = 0
    disconnectedSinceRef.current = null
    gapAccumRef.current          = 0
    watchdogFiredRef.current     = false

    const recorder = new SessionRecorder(onRecorderUpdate)
    recorderRef.current = recorder
    recorder.start()
    setPhase('recording')
    setChartData([])
    setHrStats({ min: null, avg: null, max: null })

    // Create the local (SQLite) session row NOW, before any beat/sample
    // arrives. This is what makes the recording crash-safe: if the app dies
    // mid-session, this row — plus whatever was periodically flushed — is
    // recovered on the next launch instead of being silently lost.
    const startedAt = new Date(sessionStartWallClock.current)
    beginSession({
      id:             sessionId,
      participant_id: participant.id,
      session_date:   startedAt.toISOString().slice(0, 10),
      session_time:   startedAt.toTimeString().slice(0, 8),
      session_type:   sessionModeRef.current,
    }).catch(e => console.error('[startRecording] beginSession failed:', e))

    // Periodically flush accumulated RR/ECG data to local SQLite — never
    // wait until the session ends to persist what's been recorded so far.
    flushIntervalRef.current = setInterval(flushBuffers, FLUSH_INTERVAL_MS)

    // Start Android foreground service (keeps process alive in background; no-op on web/iOS)
    startForegroundService(sessionModeRef.current)
    startTicker({ startedAt: sessionStartWallClock.current, sessionType: sessionModeRef.current })

    // Prevent screen sleep while recording (native plugin on Android/iOS app;
    // Web Wake Lock API as fallback for Bluefy/iOS 16.4+)
    activateKeepAwake()

    // ECG — always attempted; isolated so failure never affects HR/RR recording
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
    }
  }

  function cancelRecording() {
    autoStoppedRef.current = false
    sessionStartWallClock.current = null
    if (flushIntervalRef.current)  { clearInterval(flushIntervalRef.current); flushIntervalRef.current = null }
    if (watchdogTimeoutRef.current) { clearTimeout(watchdogTimeoutRef.current); watchdogTimeoutRef.current = null }
    disconnectedSinceRef.current = null
    gapAccumRef.current = 0
    if (sessionIdRef.current) {
      discardSession(sessionIdRef.current).catch(e => console.warn('[cancelRecording] discardSession failed:', e.message))
      sessionIdRef.current = null
    }
    stopForegroundService()
    stopTicker()
    releaseKeepAwake()
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

  // Returns to idle after a completed session — no logout, BLE stays connected.
  function resetToIdle() {
    setPhase('idle')
    setSessionMode(null)
    sessionModeRef.current = null
    autoStoppedRef.current = false
    sessionStartWallClock.current = null
    ecgSettlingRef.current = true
    setElapsed(0)
    setNRr(0)
    setLiveLnRmssd(null)
    setLiveHrv({})
    setHrBpm(null)
    setChartData([])
    setHrStats({ min: null, avg: null, max: null })
    setUploadError(null)
    setUploadStatus(null)
    setSessionSummary(null)
    setEcgActive(false)
    setEcgSettling(true)
    setEcgCount(0)
    ecgRecRef.current = null
    recorderRef.current = null
    sessionIdRef.current = null
  }

  async function stopAndUpload() {
    const recorder = recorderRef.current
    if (!recorder) return
    recorder.stop()
    const startedAt = sessionStartWallClock.current ? new Date(sessionStartWallClock.current) : new Date()
    sessionStartWallClock.current = null
    if (flushIntervalRef.current)  { clearInterval(flushIntervalRef.current); flushIntervalRef.current = null }
    if (watchdogTimeoutRef.current) { clearTimeout(watchdogTimeoutRef.current); watchdogTimeoutRef.current = null }
    stopForegroundService()
    stopTicker()
    releaseKeepAwake()
    setPhase('uploading')
    setUploadError(null)

    if (ecgActive) {
      try { await bleRef.current.stopEcg() } catch (_) {}
      setEcgActive(false)
    }

    const sessionId = sessionIdRef.current
    // Duration is always wall-clock, anchored to the session's true start —
    // never the recorder's own timer, which restarts at 0 whenever the JS
    // context reloads (e.g. resuming after the Activity was recreated).
    const durationS = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000))

    // gap_s: total time the band was disconnected during this session,
    // including any disconnect episode still ongoing right at stop time.
    let gapS = gapAccumRef.current
    if (disconnectedSinceRef.current) {
      gapS += Math.round((Date.now() - disconnectedSinceRef.current) / 1000)
      disconnectedSinceRef.current = null
    }

    // ── Step 1: flush whatever hasn't reached local SQLite yet, then read
    //    back the FULL rr/ecg arrays from there — SQLite, not the in-memory
    //    recorder/ECG buffer, is the only complete record when a session was
    //    resumed (those only ever know about data collected since the last
    //    JS reload) — then finalize the local session row. ─────────────────
    let rr = []
    let ecgSamples = []
    let metrics = {}
    let localSaved = false
    try {
      await flushBuffers()
      const arrays = await getSessionArrays(sessionId)
      rr = arrays.rr
      ecgSamples = arrays.ecg
      metrics = computeSessionMetrics(rr)
      await finishSession(sessionId, { duration_s: durationS, metrics, has_ecg: ecgSamples.length > 0, gap_s: gapS })
      localSaved = true
    } catch (e) {
      console.error('[stopAndUpload] local save failed:', e)
    }

    const sessionData = {
      id:             sessionId,
      participant_id: participant.id,
      session_date:   startedAt.toISOString().slice(0, 10),
      session_time:   startedAt.toTimeString().slice(0, 8),
      duration_s:     durationS,
      rr_intervals:   rr,
      metrics,
      session_type:   sessionModeRef.current,
      has_ecg:        ecgSamples.length > 0,
      gap_s:          gapS,
    }

    // ── Step 2: Try Supabase upload right away (best case: still online) ────
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
      // No internet — session (and ECG) stays pending, synced on next app launch
      // or as soon as the network listener in App.jsx sees connectivity return.
    }

    // Notify: only one buzz per session. If it went straight to Supabase,
    // that's the meaningful "done" signal; otherwise confirm it's at least
    // safe on the phone — the "sent" notification follows later, from
    // wherever the deferred sync actually succeeds (App.jsx).
    if (remoteSynced) {
      notifySessionsSynced(1)
    } else if (localSaved) {
      notifySessionSaved()
    }

    // ── Step 3: Critical failure (neither local nor remote worked) ────────────
    // Keep sessionIdRef intact so a retry reuses the same local row instead
    // of orphaning the data already flushed to it.
    if (!localSaved && !remoteSynced) {
      setUploadError(t('error.save_failed'))
      setPhase('recording')
      return
    }
    sessionIdRef.current = null

    // Beep + vibrate only on auto-stop (5-min session reached its target)
    if (autoStoppedRef.current) playSessionEndAlert()

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
  const bleScanning  = bleStatus === 'scanning' || bleStatus === 'connecting' || bleStatus === 'reconnecting'

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

        {/* Recovered-sessions notice — surfaced once, right after login, for
            sessions rescued from a crash/kill during a previous recording */}
        {recoveredCount > 0 && phase === 'idle' && (
          <div style={{
            background: 'var(--warning-light, #FFFBEB)', border: '1.5px solid var(--warning, #D97706)',
            borderRadius: 'var(--r-md)', padding: '12px 16px', marginBottom: 16,
            color: 'var(--warning, #D97706)', fontSize: '.85rem', fontWeight: 600,
          }}>
            {t('session_status.recovered_banner', { count: recoveredCount })}
          </div>
        )}

        {/* One-time background-reliability nudge (Android battery optimization) */}
        {showBatteryPrompt && (
          <div style={{
            background: '#FFF7ED', border: '1.5px solid var(--warning, #D97706)',
            borderRadius: 'var(--r-md)', padding: '16px 18px', marginBottom: 16,
          }}>
            <p style={{ color: 'var(--text-1)', fontWeight: 700, margin: '0 0 4px' }}>
              {t('battery.prompt_title')}
            </p>
            <p style={{ color: 'var(--text-3)', fontSize: '.85rem', margin: '0 0 12px', lineHeight: 1.45 }}>
              {t('battery.prompt_body')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <BigButton variant="secondary" onClick={confirmBatteryPrompt}>
                {t('battery.prompt_confirm')}
              </BigButton>
              <BigButton variant="ghost" onClick={dismissBatteryPrompt}>
                {t('battery.prompt_dismiss')}
              </BigButton>
            </div>
          </div>
        )}

        {/* ══ IDLE ══════════════════════════════════════════ */}
        {phase === 'idle' && (
          <>
            {/* Live HR — visible once BLE is connected */}
            <HrDisplay bpm={hrBpm} />

            {bleConnected ? (
              /* ── BLE ligado: selecciona modo → começa imediatamente ── */
              <div className="animate-fade-up">
                <p style={{ color: 'var(--text-3)', fontWeight: 700, fontSize: '.85rem', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 14 }}>
                  {t('session.mode_title')}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <ModeCard
                    onClick={() => selectAndStart('rest_5min')}
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
                    onClick={() => selectAndStart('free')}
                    title={t('session.mode_free')}
                    desc={t('session.mode_free_desc')}
                    icon={
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M12 12c-2-2.5-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.5 6-4z" stroke="var(--teal-2)" strokeWidth="2" strokeLinejoin="round"/>
                        <path d="M12 12c2 2.5 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.5-6 4z" stroke="var(--teal-2)" strokeWidth="2" strokeLinejoin="round"/>
                      </svg>
                    }
                  />
                  <ModeCard
                    onClick={openQuestionnaire}
                    title={t('session.mode_questionnaire')}
                    desc={t('session.mode_questionnaire_desc')}
                    icon={
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <rect x="5" y="3.5" width="14" height="17" rx="2" stroke="var(--teal-2)" strokeWidth="2"/>
                        <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="var(--teal-2)" strokeWidth="1.7" strokeLinecap="round"/>
                      </svg>
                    }
                  />
                </div>
                {questionnaireError && (
                  <p style={{ color: 'var(--error)', fontSize: '.82rem', fontWeight: 600, marginTop: 10 }}>
                    {questionnaireError}
                  </p>
                )}
              </div>
            ) : (
              /* ── BLE não ligado: a ligar / erro / retry ── */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>

                {bleScanning && (
                  <p style={{ textAlign: 'center', color: 'var(--text-4)', fontSize: '.9rem' }}>
                    {t('ble.auto_connecting', { defaultValue: 'A ligar automaticamente à banda…' })}
                  </p>
                )}

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

                {bleStatus === 'scan_blocked' && (
                  <div style={{ background: '#FFF0F0', border: '1px solid var(--error)', borderRadius: 14, padding: '16px 18px' }}>
                    <p style={{ color: 'var(--error)', fontWeight: 700, margin: '0 0 6px' }}>
                      {t('error.scan_blocked')}
                    </p>
                    <p style={{ color: 'var(--text-3)', fontSize: '.88rem', margin: '0 0 14px', lineHeight: 1.5 }}>
                      {t('error.scan_blocked_hint')}
                    </p>
                    <BigButton onClick={connectBle} variant="secondary">
                      {t('ble.connect_btn')}
                    </BigButton>
                  </div>
                )}

                {!bleScanning && bleStatus !== 'permission_denied' && bleStatus !== 'scan_blocked' && (
                  <BigButton onClick={connectBle} variant="secondary">
                    {t('ble.connect_btn')}
                  </BigButton>
                )}
              </div>
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

            <BigButton onClick={resetToIdle}>
              {t('session.new')}
            </BigButton>
          </div>
        )}
      </div>

      <Footer />
    </div>
  )
}
