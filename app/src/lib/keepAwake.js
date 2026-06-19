import { Capacitor } from '@capacitor/core'

let _plugin = null
let _tried  = false
let _webLock = null   // sentinel for Web Wake Lock API (web / Bluefy / iOS)

async function _load() {
  if (_tried) return _plugin
  _tried = true
  if (!Capacitor.isNativePlatform()) return null
  try {
    const mod = await import('@capacitor-community/keep-awake')
    _plugin = mod.KeepAwake
  } catch (e) {
    console.warn('[KeepAwake] plugin not available:', e.message)
  }
  return _plugin
}

// Prevent the screen from sleeping.
// Native (Android APK / iOS app): uses @capacitor-community/keep-awake.
// Web / Bluefy (iOS 16.4+): uses Screen Wake Lock API — auto-released by the
// browser when the page loses visibility, which is why activateKeepAwake() must
// be called again on every visibilitychange back to 'visible'.
export async function activateKeepAwake() {
  const plugin = await _load()
  if (plugin) {
    try { await plugin.keepAwake() } catch (e) {
      console.warn('[KeepAwake] keepAwake() failed:', e.message)
    }
    return
  }

  // Web fallback: Screen Wake Lock API (Chrome, WebKit ≥ iOS 16.4, Firefox)
  if (typeof navigator !== 'undefined' && navigator.wakeLock) {
    try {
      // Release stale lock before requesting a fresh one (idempotent)
      if (_webLock) {
        try { await _webLock.release() } catch (_) {}
        _webLock = null
      }
      _webLock = await navigator.wakeLock.request('screen')
      // When the browser auto-releases the lock (app backgrounded, tab hidden),
      // clear the reference so the next activateKeepAwake() requests a new one.
      _webLock.addEventListener('release', () => { _webLock = null })
    } catch (e) {
      // Fails silently on iOS < 16.4 or if the page is not visible at call time
      console.warn('[KeepAwake] Web Wake Lock unavailable:', e.message)
    }
  }
}

// Allow the screen to sleep normally. Always safe to call, even if
// activateKeepAwake() was never called or the lock was already released.
export async function releaseKeepAwake() {
  const plugin = await _load()
  if (plugin) {
    try { await plugin.allowSleep() } catch (e) {
      console.warn('[KeepAwake] allowSleep() failed:', e.message)
    }
  }
  if (_webLock) {
    try { await _webLock.release() } catch (_) {}
    _webLock = null
  }
}
