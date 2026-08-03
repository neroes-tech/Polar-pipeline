import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { supabase, getCurrentParticipant, signOut, uploadSessionRecord, uploadEcgSamples, clearLocalAuth } from './lib/supabase.js'
import { initLocalStore, recoverOrphanedSessions, getOrphanedSessions, syncPending, clearAllLocalSessions } from './lib/localSessionStore.js'
import { notifySessionsSynced } from './lib/localAlerts.js'
import { withTimeout } from './lib/withTimeout.js'
import Login from './screens/Login.jsx'
import Record from './screens/Record.jsx'

// Guards concurrent sync attempts (app-launch sync + a network reconnect
// firing at nearly the same time) from both racing over the same rows.
let _syncing = false

async function syncNowAndNotify() {
  if (_syncing) return
  _syncing = true
  try {
    const { synced } = await syncPending(uploadAll)
    if (synced > 0) notifySessionsSynced(synced)
  } catch (_) {
    // offline again mid-sync — sessions stay 'pending', retried on the next trigger
  } finally {
    _syncing = false
  }
}

// Debug: window.__clearAll() — clears auth + all local sessions for a clean test
if (typeof window !== 'undefined') {
  window.__clearAll = async () => {
    const n = await clearAllLocalSessions()
    await clearLocalAuth()
    console.log('[debug] __clearAll done —', n, 'session(s) removed; reload app to sign in again')
  }
}

// Combined upload wrapper: handles both session data and ECG samples.
// record.recovered / record.gap_s come from localSessionStore.getPendingSessions()
// (recovered = rescued from a crash/kill; gap_s = total BLE disconnect time
// during the session) and are forwarded to Supabase for QA visibility.
async function uploadAll(record) {
  await uploadSessionRecord(record)
  if (record.ecg_samples?.length > 0) {
    await uploadEcgSamples(record.id, record.ecg_samples).catch(e =>
      console.warn('[sync] ECG upload failed for', record.id?.slice(0, 8), e.message)
    )
  }
}

function LoadingScreen() {
  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--brand-gradient)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 20,
    }}>
      <svg width="64" height="44" viewBox="0 0 96 64" fill="none" aria-hidden>
        <path d="M4 32 Q24 8 48 8 Q72 8 92 32 Q72 56 48 56 Q24 56 4 32Z"
              fill="rgba(255,255,255,.15)" stroke="rgba(255,255,255,.6)" strokeWidth="3"/>
        <circle cx="48" cy="32" r="11" fill="rgba(255,255,255,.9)"/>
        <circle cx="48" cy="32" r="6" fill="#2BBDBD"/>
        <polyline points="4,32 28,32 33,28 37,39 40,24 43,45 46,32 60,32 92,32"
                  fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <div className="spinner" style={{ borderColor: 'rgba(255,255,255,.3)', borderTopColor: '#fff', width: 28, height: 28 }} />
    </div>
  )
}

export default function App() {
  const [screen,        setScreen]        = useState('loading')  // loading | login | record
  const [participant,   setParticipant]   = useState(null)
  const [recoveredCount, setRecoveredCount] = useState(0)
  const [resumeSession,  setResumeSession]  = useState(null)  // an in-progress local session to resume live, instead of closing it out

  async function loadParticipant() {
    setScreen('loading')
    try {
      // Time-bounded: this gates the loading screen, and the SQLite plugin
      // bridge can stall without ever rejecting. A local session store that
      // won't open is bad (sessions can't be saved locally) but silently
      // freezing the app on launch is worse — let it fall through to the
      // catch and at least reach a usable screen.
      await withTimeout(initLocalStore(), 10000, 'init_local_store')
      const p = await getCurrentParticipant()

      // If the app's Activity/WebView got torn down mid-recording (Android
      // reclaiming memory from a backgrounded app — a foreground service
      // prevents the PROCESS from dying, but not this), there's a session
      // still sitting in 'recording' state. Resume it live in Record.jsx
      // instead of unconditionally closing it out as "done" — the whole
      // point of surviving in the pyramid/desert is picking back up where
      // it left off, not silently starting a fresh, disconnected session.
      let resumable = null
      if (p) {
        const orphans = await getOrphanedSessions().catch(() => [])
        resumable = orphans.find(o => o.participant_id === p.id) || null
      }

      // Any OTHER orphaned session (a stale one from a different participant,
      // or a genuine leftover the app couldn't resume) still gets finalized
      // as before — this is the crash-safety net, unchanged.
      const recovered = await recoverOrphanedSessions(resumable?.id ?? null).catch(e => {
        console.warn('[App] recoverOrphanedSessions failed:', e.message)
        return 0
      })
      if (recovered > 0) setRecoveredCount(recovered)

      if (p) {
        setParticipant(p)
        setResumeSession(resumable)
        setScreen('record')
        // Silently flush any pending sessions now that we're online + authenticated
        syncNowAndNotify()
      } else {
        setScreen('login')
      }
    } catch (_) {
      setScreen('login')
    }
  }

  async function handleLogout() {
    await signOut()
    // onAuthStateChange SIGNED_OUT event flips screen to 'login'
  }

  useEffect(() => {
    // onAuthStateChange fires immediately with INITIAL_SESSION on first render —
    // handles auto-login (persisted session) without a separate getSession() call.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
        if (session?.user) {
          loadParticipant()
        } else {
          setScreen('login')
        }
      } else if (event === 'SIGNED_OUT') {
        setParticipant(null)
        setScreen('login')
      }
    })
    return () => subscription.unsubscribe()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-sync the moment connectivity returns — previously this only ran on
  // app launch or a manual tap, so a session recorded fully offline (no
  // network at all inside a pyramid/desert) would sit "pending" until the
  // investigator remembered to reopen the app once back in range.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle
    ;(async () => {
      const { Network } = await import('@capacitor/network')
      handle = await Network.addListener('networkStatusChange', (status) => {
        if (status.connected) syncNowAndNotify()
      })
    })()
    return () => { handle?.remove() }
  }, [])

  if (screen === 'loading') return <LoadingScreen />
  if (screen === 'login')   return <Login />
  return <Record participant={participant} onBack={handleLogout} recoveredCount={recoveredCount} resumeSession={resumeSession} />
}
