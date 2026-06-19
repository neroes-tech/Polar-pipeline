import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signIn } from '../lib/supabase.js'
import LanguageToggle from '../components/LanguageToggle.jsx'
import Footer from '../components/Footer.jsx'

// ── Inline icons ─────────────────────────────────────────────────────────────
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
            fill="rgba(244,211,94,0.12)" stroke="rgba(244,211,94,0.65)" strokeWidth="2.5"/>
      {/* Iris */}
      <circle cx="48" cy="32" r="14" fill="rgba(244,211,94,0.08)"
              stroke="rgba(244,211,94,0.4)" strokeWidth="1.8"/>
      {/* Pupil */}
      <circle cx="48" cy="32" r="7" fill="#E63946"/>
      <circle cx="48" cy="32" r="3.5" fill="#0A1628"/>
      {/* Cornea highlight */}
      <circle cx="43.5" cy="28" r="2.2" fill="white" opacity="0.55"/>
      {/* ECG trace through the eye */}
      <polyline
        points="4,32 26,32 31,28 36,39 39,24 43,45 46,32 60,32 92,32"
        fill="none" stroke="rgba(244,211,94,0.75)" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round"/>
      {/* Horus tear mark */}
      <line x1="48" y1="56" x2="48" y2="65" stroke="rgba(244,211,94,0.55)" strokeWidth="2" strokeLinecap="round"/>
      <path d="M 48 65 Q 61 71, 72 66" fill="none" stroke="rgba(244,211,94,0.55)" strokeWidth="1.8" strokeLinecap="round"/>
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
      // Success: App.jsx onAuthStateChange drives navigation
    } catch (_) {
      setError(t('auth.error_invalid'))
      setLoading(false)
    }
  }

  const BLUE       = '#2B6CF4'
  const BLUE_DIM   = 'rgba(43,108,244,0.45)'
  const FOCUS_CLR  = BLUE
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

      {/* ── Compact header ────────────────────────────────────── */}
      <header style={{
        background: '#1D3557',
        padding: 'calc(18px + var(--safe-top)) 20px 28px',
        position: 'relative',
        textAlign: 'center',
      }}>
        {/* Language toggle — top-right, unobtrusive */}
        <div style={{ position: 'absolute', top: 'calc(14px + var(--safe-top))', right: 16 }}>
          <LanguageToggle />
        </div>

        {/* Eye of Horus in gold-tinted rounded square */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64,
          height: 64,
          borderRadius: 16,
          background: 'rgba(244,211,94,0.08)',
          border: '1px solid rgba(244,211,94,0.18)',
          marginBottom: 14,
          marginTop: 6,
        }}>
          <EyeOfHorus />
        </div>

        <h1 style={{
          color: '#fff',
          fontSize: '1.3rem',
          fontWeight: 500,
          letterSpacing: '-.01em',
          margin: '0 0 5px',
        }}>
          Neroes HRV
        </h1>
        <p style={{
          color: '#9FB3D1',
          fontSize: '.78rem',
          fontWeight: 400,
          margin: 0,
        }}>
          {t('auth.subtitle')}
        </p>
      </header>

      {/* ── Login card ────────────────────────────────────────── */}
      <div style={{ flex: 1, padding: '24px 16px 16px' }}>
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: 16,
          padding: '26px 22px 24px',
          border: '1px solid var(--border)',
          boxShadow: '0 2px 20px rgba(0,0,0,0.07)',
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
                height: 46,
                borderRadius: 12,
                border: `1.5px solid ${emailFocus ? FOCUS_CLR : BORDER_CLR}`,
                background: 'var(--bg-input, var(--bg))',
                transition: 'border-color .14s',
                paddingLeft: 13,
              }}>
                <span style={{ color: 'var(--text-4)', display: 'flex', flexShrink: 0 }}>
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
                height: 46,
                borderRadius: 12,
                border: `1.5px solid ${pwFocus ? FOCUS_CLR : BORDER_CLR}`,
                background: 'var(--bg-input, var(--bg))',
                transition: 'border-color .14s',
                paddingLeft: 13,
                paddingRight: 4,
              }}>
                <span style={{ color: 'var(--text-4)', display: 'flex', flexShrink: 0 }}>
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

            {/* ── Error (elegant, inline) ─────────────────── */}
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
              style={{
                width: '100%',
                height: 50,
                marginTop: 4,
                background: loading || !email || !password ? BLUE_DIM : BLUE,
                color: '#fff',
                border: 'none',
                borderRadius: 12,
                fontSize: '1rem',
                fontWeight: 700,
                cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                transition: 'background .15s',
                letterSpacing: '.01em',
              }}
            >
              {loading ? (
                <>
                  <div className="spinner" style={{
                    width: 18, height: 18,
                    borderWidth: 2,
                    borderColor: 'rgba(255,255,255,.3)',
                    borderTopColor: '#fff',
                  }} />
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
        </div>
      </div>

      <Footer />
    </div>
  )
}
