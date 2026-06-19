import { useEffect, useState } from 'react'
import { supabase, getCurrentParticipant, signOut, uploadSessionRecord, uploadEcgSamples, clearLocalAuth } from './lib/supabase.js'
import { syncPending, clearAllLocalSessions } from './lib/offlineQueue.js'
import Login from './screens/Login.jsx'
import Record from './screens/Record.jsx'

// Debug: window.__clearAll() — clears auth + all local sessions for a clean test
if (typeof window !== 'undefined') {
  window.__clearAll = async () => {
    const n = await clearAllLocalSessions()
    await clearLocalAuth()
    console.log('[debug] __clearAll done —', n, 'session(s) removed; reload app to sign in again')
  }
}

// Combined upload wrapper: handles both session data and ECG samples
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
      background: 'var(--aurora-gradient)',
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
        <circle cx="48" cy="32" r="6" fill="#2B6CF4"/>
        <polyline points="4,32 28,32 33,28 37,39 40,24 43,45 46,32 60,32 92,32"
                  fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <div className="spinner" style={{ borderColor: 'rgba(255,255,255,.3)', borderTopColor: '#fff', width: 28, height: 28 }} />
    </div>
  )
}

export default function App() {
  const [screen,      setScreen]      = useState('loading')  // loading | login | record
  const [participant, setParticipant] = useState(null)

  async function loadParticipant() {
    setScreen('loading')
    try {
      const p = await getCurrentParticipant()
      if (p) {
        setParticipant(p)
        setScreen('record')
        // Silently flush any pending sessions now that we're online + authenticated
        syncPending(uploadAll).catch(() => {})
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

  if (screen === 'loading') return <LoadingScreen />
  if (screen === 'login')   return <Login />
  return <Record participant={participant} onBack={handleLogout} />
}
