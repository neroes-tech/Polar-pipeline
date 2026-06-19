import { Capacitor } from '@capacitor/core'

let _ctx = null

// Call once during a user gesture (mode card tap) to unlock AudioContext on iOS/Android.
export function primeAudioContext() {
  if (_ctx) return
  try {
    _ctx = new (window.AudioContext || window.webkitAudioContext)()
    // Suspended on some browsers until resumed in a user gesture — do that now.
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
  } catch (_) {}
}

// Plays a short double-beep (two 440 Hz tones, 0.18 s each) and vibrates on Android.
export async function playSessionEndAlert() {
  _beep()
  await _vibrate()
}

function _beep() {
  if (!_ctx) {
    // Last-resort attempt — may be blocked on iOS but harmless to try.
    try { _ctx = new (window.AudioContext || window.webkitAudioContext)() } catch (_) { return }
  }
  try {
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})

    const now = _ctx.currentTime
    const beepDuration = 0.18
    const gap = 0.08

    for (let i = 0; i < 2; i++) {
      const t0 = now + i * (beepDuration + gap)
      const t1 = t0 + beepDuration

      const osc  = _ctx.createOscillator()
      const gain = _ctx.createGain()

      osc.type      = 'sine'
      osc.frequency.value = 880

      // Smooth fade in/out to avoid clicks
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(0.4, t0 + 0.02)
      gain.gain.setValueAtTime(0.4, t1 - 0.03)
      gain.gain.linearRampToValueAtTime(0, t1)

      osc.connect(gain)
      gain.connect(_ctx.destination)

      osc.start(t0)
      osc.stop(t1)
    }
  } catch (_) {}
}

async function _vibrate() {
  // navigator.vibrate works on Android Chrome/WebView
  try {
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200])
      return
    }
  } catch (_) {}

  // Capacitor Haptics on native (Android APK)
  if (Capacitor.isNativePlatform()) {
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
      await Haptics.impact({ style: ImpactStyle.Heavy })
      await new Promise(r => setTimeout(r, 150))
      await Haptics.impact({ style: ImpactStyle.Heavy })
    } catch (_) {}
  }
}
