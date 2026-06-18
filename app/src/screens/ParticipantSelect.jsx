import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getParticipants } from '../lib/supabase.js'
import LanguageToggle from '../components/LanguageToggle.jsx'
import BigButton from '../components/BigButton.jsx'

// One distinct color per participant slot (cycles if >5)
const AVATAR_COLORS = ['#2B6CF4', '#7C3AED', '#059669', '#DC2626', '#D97706']

function avatarNum(code) {
  return (code.match(/\d+$/) || ['?'])[0].replace(/^0/, '') // "polar01" → "1"
}

export default function ParticipantSelect({ onSelect }) {
  const { t } = useTranslation()
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  useEffect(() => { load() }, [])

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg)', maxWidth: 520, margin: '0 auto' }}>

      {/* ── Aurora header ──────────────────────────────────────── */}
      <header style={{
        background: 'var(--aurora-gradient)',
        padding: '44px 24px 36px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Decorative aurora glow blobs */}
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
        <p style={{ color: 'var(--text-4)', fontSize: '.95rem', marginBottom: 32 }}>
          {t('participant_select.subtitle')}
        </p>

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {participants.map((p, idx) => {
              const num   = avatarNum(p.code)
              const color = AVATAR_COLORS[idx % AVATAR_COLORS.length]
              return (
                <button
                  key={p.id}
                  onClick={() => onSelect(p)}
                  className="participant-card"
                  aria-label={`Selecionar ${p.name}`}
                >
                  {/* Avatar */}
                  <div style={{
                    flexShrink: 0,
                    width: 54,
                    height: 54,
                    borderRadius: '50%',
                    background: color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: '1.25rem',
                    fontWeight: 800,
                    boxShadow: `0 3px 12px ${color}55`,
                  }}>
                    {num}
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      color: 'var(--text-1)',
                      fontSize: '1.15rem',
                      fontWeight: 700,
                      marginBottom: 3,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {p.name}
                    </div>
                    <div style={{ color: 'var(--text-4)', fontSize: '.8rem', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {p.code} · {p.device_id}
                    </div>
                  </div>

                  {/* Chevron */}
                  <svg aria-hidden width="20" height="20" viewBox="0 0 20 20" fill="none">
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
