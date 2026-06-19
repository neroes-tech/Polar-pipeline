import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signIn } from '../lib/supabase.js'
import LanguageToggle from '../components/LanguageToggle.jsx'
import Footer from '../components/Footer.jsx'

function IconMail() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2"/>
      <path d="m2 7 9 5.5c.63.36 1.37.36 2 0L22 7"/>
    </svg>
  )
}

function IconLock() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2"/>
      <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  )
}

function IconEye({ off }) {
  if (off) return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

function EyeOfHorus() {
  return (
    <svg width="42" height="30" viewBox="0 0 96 68" fill="none" aria-hidden>
      {/* Almond */}
      <path d="M4 32 Q24 8 48 8 Q72 8 92 32 Q72 56 48 56 Q24 56 4 32Z"
            fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.7)" strokeWidth="2.5"/>
      {/* Iris */}
      <circle cx="48" cy="32" r="14" fill="rgba(255,255,255,0.1)"
              stroke="rgba(255,255,255,0.45)" strokeWidth="1.8"/>
      {/* Pupil */}
      <circle cx="48" cy="32" r="7" fill="#2BBDBD"/>
      <circle cx="48" cy="32" r="3.5" fill="white"/>
      {/* Cornea highlight */}
      <circle cx="43.5" cy="28" r="2.2" fill="white" opacity="0.6"/>
      {/* ECG trace through the eye */}
      <polyline
        points="4,32 26,32 31,28 36,39 39,24 43,45 46,32 60,32 92,32"
        fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round"/>
      {/* Horus tear mark */}
      <line x1="48" y1="56" x2="48" y2="65" stroke="rgba(255,255,255,0.55)" strokeWidth="2" strokeLinecap="round"/>
      <path d="M 48 65 Q 61 71, 72 66" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function IconShield() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}

export default function Login() {
  const { t } = useTranslation()
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [showPw,     setShowPw]     = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [emailFocus, setEmailFocus] = useState(false)
  const [pwFocus,    setPwFocus]    = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!email.trim() || !password) return
    setLoading(true)
    setError(null)
    try {
      await signIn(email.trim().toLowerCase(), password)
    } catch (_) {
      setError(t('auth.error_invalid'))
      setLoading(false)
    }
  }

  const TEAL       = '#2BBDBD'
  const FOCUS_CLR  = TEAL
  const BORDER_CLR = 'var(--border)'

  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 420,
      margin: '0 auto',
    }}>

      {/* ── Header ──────────────────────────────────────────── */}
      <header style={{ position: 'relative' }}>
        {/* 4px top accent stripe */}
        <div style={{
          height: 'calc(4px + var(--safe-top))',
          background: 'var(--teal-1)',
        }} />

        <div style={{
          background: 'var(--brand-gradient-dark)',
          padding: '22px 20px 32px',
          textAlign: 'center',
          position: 'relative',
        }}>
          {/* Language toggle — top-right */}
          <div style={{ position: 'absolute', top: 16, right: 16 }}>
            <LanguageToggle />
          </div>

          {/* Logo container */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 68,
            height: 68,
            borderRadius: 18,
            background: 'var(--brand-gradient)',
            boxShadow: '0 6px 24px rgba(43,189,189,0.35)',
            marginBottom: 16,
            marginTop: 8,
          }}>
            <EyeOfHorus />
          </div>

          <h1 style={{
            color: '#fff',
            fontSize: '1.35rem',
            fontWeight: 700,
            letterSpacing: '-.015em',
            margin: '0 0 6px',
          }}>
            Neroes HRV
          </h1>
          <p style={{
            color: 'rgba(255,255,255,0.65)',
            fontSize: '.8rem',
            fontWeight: 400,
            margin: 0,
          }}>
            {t('auth.subtitle')}
          </p>
        </div>
      </header>

      {/* ── Login card ────────────────────────────────────────── */}
      <div style={{ flex: 1, padding: '24px 16px 16px' }}>
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: 18,
          padding: '26px 22px 24px',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-card)',
        }}>
          <form onSubmit={handleSubmit} noValidate>

            {/* ── Email ──────────────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
              <span style={{
                display: 'block',
                color: 'var(--text-3)',
                fontSize: '.78rem',
                fontWeight: 600,
                marginBottom: 7,
                letterSpacing: '.025em',
              }}>
                {t('auth.email_label')}
              </span>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                height: 48,
                borderRadius: 12,
                border: `1.5px solid ${emailFocus ? FOCUS_CLR : BORDER_CLR}`,
                background: 'var(--bg-input)',
                transition: 'border-color .14s',
                paddingLeft: 13,
              }}>
                <span style={{ color: emailFocus ? TEAL : 'var(--text-4)', display: 'flex', flexShrink: 0, transition: 'color .14s' }}>
                  <IconMail />
                </span>
                <input
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onFocus={() => setEmailFocus(true)}
                  onBlur={() => setEmailFocus(false)}
                  placeholder="polar01@healme.pt"
                  required
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    padding: '0 12px',
                    fontSize: '.97rem',
                    fontWeight: 500,
                    color: 'var(--text-1)',
                    height: '100%',
                    WebkitAppearance: 'none',
                  }}
                />
              </div>
            </div>

            {/* ── Password ───────────────────────────────── */}
            <div style={{ marginBottom: 6 }}>
              <span style={{
                display: 'block',
                color: 'var(--text-3)',
                fontSize: '.78rem',
                fontWeight: 600,
                marginBottom: 7,
                letterSpacing: '.025em',
              }}>
                {t('auth.password_label')}
              </span>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                height: 48,
                borderRadius: 12,
                border: `1.5px solid ${pwFocus ? FOCUS_CLR : BORDER_CLR}`,
                background: 'var(--bg-input)',
                transition: 'border-color .14s',
                paddingLeft: 13,
                paddingRight: 4,
              }}>
                <span style={{ color: pwFocus ? TEAL : 'var(--text-4)', display: 'flex', flexShrink: 0, transition: 'color .14s' }}>
                  <IconLock />
                </span>
                <input
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onFocus={() => setPwFocus(true)}
                  onBlur={() => setPwFocus(false)}
                  placeholder="••••••••••"
                  required
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    padding: '0 8px 0 12px',
                    fontSize: '.97rem',
                    fontWeight: 500,
                    color: 'var(--text-1)',
                    height: '100%',
                    WebkitAppearance: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? t('auth.hide_password') : t('auth.show_password')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-4)',
                    cursor: 'pointer',
                    padding: '0 10px',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <IconEye off={showPw} />
                </button>
              </div>
            </div>

            {/* ── Error ──────────────────────────────────── */}
            <div style={{ minHeight: 32, display: 'flex', alignItems: 'center' }}>
              {error && (
                <span style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  color: '#DC2626',
                  fontSize: '.82rem',
                  fontWeight: 500,
                  padding: '2px 0',
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12.5"/>
                    <circle cx="12" cy="16" r=".8" fill="currentColor" stroke="none"/>
                  </svg>
                  {error}
                </span>
              )}
            </div>

            {/* ── Submit ─────────────────────────────────── */}
            <button
              type="submit"
              disabled={loading || !email || !password}
              className="btn btn-primary"
              style={{ marginTop: 4 }}
            >
              {loading ? (
                <>
                  <div className="spinner spinner-sm spinner-white" />
                  {t('auth.signing_in')}
                </>
              ) : (
                <>
                  {t('auth.sign_in')}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                </>
              )}
            </button>

          </form>

          {/* ── Security badge ─────────────────────────────── */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            marginTop: 20,
            color: 'var(--text-4)',
            fontSize: '.72rem',
            fontWeight: 500,
          }}>
            <span style={{ color: 'var(--teal-2)' }}><IconShield /></span>
            {t('auth.security_badge')}
          </div>

        </div>
      </div>

      <Footer />
    </div>
  )
}
