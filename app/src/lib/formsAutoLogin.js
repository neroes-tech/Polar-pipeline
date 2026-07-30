// Builds a short-lived, signed link into the separate "Healme Egypt Forms"
// app (a different Next.js project + Supabase project — see
// Healme-egyt-forms/app/auth/auto-login/route.ts) so a participant tapping
// "Questionário" never sees that app's own login form. The signature proves
// the link really came from this app moments ago; the target route trusts
// it and signs the participant in with the same shared password used here.
const FORMS_BASE_URL = 'https://healme-forms-neroes.vercel.app'
const AUTOLOGIN_SECRET = import.meta.env.VITE_FORMS_AUTOLOGIN_SECRET
const LINK_LIFETIME_S = 90

/** "HM07" -> "polar07@healme.pt" (mirrors resolveLoginIdentity in supabase.js). */
export function participantCodeToEmail(code) {
  const digits = (code || '').match(/\d+$/)
  if (!digits) return null
  return `polar${digits[0].padStart(2, '0')}@healme.pt`
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Builds the auto-login URL for the given participant email. Throws if
 * VITE_FORMS_AUTOLOGIN_SECRET isn't configured — better to fail loudly than
 * silently send the participant to a login form they can't get past
 * (they were never given this shared account's password).
 */
export async function buildFormsAutoLoginUrl(email) {
  if (!AUTOLOGIN_SECRET) throw new Error('forms_autologin_not_configured')
  const exp = Math.floor(Date.now() / 1000) + LINK_LIFETIME_S
  const sig = await hmacSha256Hex(AUTOLOGIN_SECRET, `${email}.${exp}`)
  const params = new URLSearchParams({ email, exp: String(exp), sig })
  return `${FORMS_BASE_URL}/auth/auto-login?${params.toString()}`
}
