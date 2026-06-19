import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getParticipants, uploadSessionRecord, uploadEcgSamples } from '../lib/supabase.js'
import { getPendingCount, syncPending } from '../lib/offlineQueue.js'
import LanguageToggle from '../components/LanguageToggle.jsx'
import BigButton from '../components/BigButton.jsx'

// 11 distinct colors cycling across 22 bands (each color repeats exactly twice)
const AVATAR_COLORS = [
  '#2BBDBD', '#3D6EF5', '#059669', '#DC2626', '#D97706',
  '#0891B2', '#BE185D', '#065F46', '#7C2D12', '#4338CA', '#0F766E',
]

function avatarNum(code) {
  // "HM01" → "1", "HM22" → "22"
  return (code.match(/\d+$/) || ['?'])[0].replace(/^0+/, '') || '?'
}

export default function ParticipantSelect({ onSelect }) {
  const { t } = useTranslation()
  const [participants,  setParticipants]  = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [pendingCount,  setPendingCount]  = useState(0)
  const [syncing,       setSyncing]       = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await getParticipants()
      setParticipants(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function refreshPendingCount() {
    try { setPendingCount(await getPendingCount()) } catch (_) {}
  }

  // Upload a pending session record including its ECG data (if any)
  async function uploadAll(record) {
    await uploadSessionRecord(record)
    if (record.ecg_samples?.length > 0) {
      await uploadEcgSamples(record.id, record.ecg_samples).catch(e =>
        console.warn('[sync] ECG upload failed for', record.id, e.message)
      )
    }
  }

  async function handleSyncNow() {
    setSyncing(true)
    try {
      await syncPending(uploadAll)
      await refreshPendingCount()
    } catch (_) {}
    setSyncing(false)
  }

  useEffect(() => {
    load()
    refreshPendingCount()
    // On mount, silently flush any pending sessions (including ECG)
    syncPending(uploadAll).then(() => refreshPendingCount()).catch(() => {})
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)', maxWidth: 520, margin: '0 auto' }}>

      {/* ── Brand header ──────────────────────────────────────── */}
      <header style={{
        background: 'var(--brand-gradient)',
        padding: '44px 24px 36px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Decorative glow blobs */}
        <div aria-hidden style={{
          position: 'absolute', top: -50, right: -30,
          width: 220, height: 220, borderRadius: '50%',
          background: 'rgba(255,255,255,.07)', filter: 'blur(48px)',
        }} />
        <div aria-hidden style={{
          position: 'absolute', bottom: -60, left: 20,
          width: 160, height: 160, borderRadius: '50%',
          background: 'rgba(255,255,255,.05)', filter: 'blur(40px)',
        }} />

        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ color: 'rgba(255,255,255,.75)', fontSize: '.82rem', fontWeight: 600, letterSpacing: '.08em', marginBottom: 6 }}>
              NEROES · HE26
            </div>
            <h1 style={{ color: '#fff', fontSize: '1.9rem', fontWeight: 800, lineHeight: 1.15 }}>
              {t('app_title')}
            </h1>
          </div>
          <LanguageToggle />
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────── */}
      <div style={{ padding: '32px 20px 40px' }}>
        <h2 style={{ color: 'var(--text-1)', fontSize: '1.45rem', fontWeight: 800, marginBottom: 6 }}>
          {t('participant_select.title')}
        </h2>
        <p style={{ color: 'var(--text-4)', fontSize: '.95rem', marginBottom: pendingCount > 0 ? 16 : 32 }}>
          {t('participant_select.subtitle')}
        </p>

        {/* Pending sync banner */}
        {pendingCount > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'var(--warning-light, #FFFBEB)',
            border: '1.5px solid var(--warning, #D97706)',
            borderRadius: 'var(--r-md)', padding: '12px 16px', marginBottom: 24,
          }}>
            <span style={{ color: 'var(--warning, #D97706)', fontSize: '.88rem', fontWeight: 700 }}>
              {t('session_status.pending_sync', { count: pendingCount })}
            </span>
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              style={{
                background: 'none', border: 'none',
                color: 'var(--warning, #D97706)', fontSize: '.85rem', fontWeight: 700,
                cursor: syncing ? 'default' : 'pointer', opacity: syncing ? .6 : 1,
              }}
            >
              {syncing ? '…' : t('session_status.sync_now')}
            </button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '40px 0' }}>
            <div className="spinner" />
            <p style={{ color: 'var(--text-4)', fontSize: '.95rem' }}>
              {t('participant_select.loading')}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: 'var(--error-light)',
            border: '1.5px solid #FECACA',
            borderRadius: 'var(--r-md)',
            padding: '20px 24px',
            marginBottom: 24,
          }}>
            <p style={{ color: 'var(--error)', fontWeight: 700, fontSize: '1rem', marginBottom: 16 }}>
              {t('participant_select.error')}
            </p>
            <BigButton onClick={load} variant="secondary">
              {t('participant_select.retry')}
            </BigButton>
          </div>
        )}

        {/* Participant cards */}
        {!loading && !error && (
          <div className="participant-list">
            {participants.map((p, idx) => {
              const num   = avatarNum(p.code)
              const color = AVATAR_COLORS[idx % AVATAR_COLORS.length]
              return (
                <button
                  key={p.id}
                  onClick={() => onSelect(p)}
                  className="participant-card"
                  aria-label={`Selecionar banda ${p.code}`}
                >
                  {/* Avatar */}
                  <div style={{
                    flexShrink: 0,
                    width: 50,
                    height: 50,
                    borderRadius: '50%',
                    background: color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: num.length > 1 ? '1rem' : '1.2rem',
                    fontWeight: 800,
                    boxShadow: `0 3px 12px ${color}55`,
                    letterSpacing: '-.01em',
                  }}>
                    {num}
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      color: 'var(--text-1)',
                      fontSize: '1.1rem',
                      fontWeight: 800,
                      marginBottom: 3,
                      fontVariantNumeric: 'tabular-nums',
                      letterSpacing: '.01em',
                    }}>
                      {p.code}
                    </div>
                    <div style={{
                      color: 'var(--text-4)',
                      fontSize: '.75rem',
                      fontWeight: 500,
                      fontVariantNumeric: 'tabular-nums',
                      letterSpacing: '.04em',
                    }}>
                      {p.device_id}
                    </div>
                  </div>

                  {/* Chevron */}
                  <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M7 5l5 5-5 5" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
