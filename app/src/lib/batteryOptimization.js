import { Capacitor } from '@capacitor/core'

let _plugin = null
let _tried  = false

// Android-only. A foreground service alone is not enough on aggressive OEMs
// (Xiaomi/MIUI, Samsung, Huawei) — the OS still throttles/kills the app in
// background unless it's explicitly exempted from battery optimization.
// This is a user-visible, one-time consent flow, not something the app can
// force silently.
// Returns { plugin } rather than the plugin object directly — see the
// comment in keepAwake.js's _load() for why returning the raw plugin object
// from an awaited async function triggers a spurious "X.then() is not
// implemented" error via JS's thenable-unwrapping.
async function _load() {
  if (_tried) return { plugin: _plugin }
  _tried = true
  if (!Capacitor.isNativePlatform()) return { plugin: null }
  try {
    const mod = await import('@capawesome-team/capacitor-android-battery-optimization')
    _plugin = mod.BatteryOptimization
  } catch (e) {
    console.warn('[batteryOptimization] plugin not available:', e.message)
  }
  return { plugin: _plugin }
}

/** True if Android is likely to throttle/kill this app in background. Always false on iOS/web. */
export async function isBatteryOptimizationEnabled() {
  const { plugin } = await _load()
  if (!plugin) return false
  try {
    const { enabled } = await plugin.isBatteryOptimizationEnabled()
    return !!enabled
  } catch (e) {
    console.warn('[batteryOptimization] check failed:', e.message)
    return false
  }
}

/** Opens the system dialog asking the user to exempt this app from battery optimization. */
export async function requestDisableBatteryOptimization() {
  const { plugin } = await _load()
  if (!plugin) return
  try {
    await plugin.requestIgnoreBatteryOptimization()
  } catch (e) {
    console.warn('[batteryOptimization] request failed:', e.message)
  }
}
