import { Capacitor } from '@capacitor/core'

let _plugin = null
let _tried  = false

async function _load() {
  if (_tried) return _plugin
  _tried = true
  if (!Capacitor.isNativePlatform()) return null
  try {
    const mod = await import('@capawesome-team/capacitor-android-foreground-service')
    _plugin = mod.ForegroundService
  } catch (e) {
    console.warn('[ForegroundService] plugin not available:', e.message)
  }
  return _plugin
}

// connectedDevice foreground service type (Android constant = 16).
// Required in startForeground() call on Android 14+ when the manifest
// declares foregroundServiceType="connectedDevice".
const SERVICE_TYPE_CONNECTED_DEVICE = 16

export async function startForegroundService(sessionType) {
  const plugin = await _load()
  if (!plugin) return

  // POST_NOTIFICATIONS is a runtime permission on Android 13+ (API 33+).
  // Without it the notification cannot be shown and the foreground service
  // fails to start. If denied, we warn and bail — JS recording still runs.
  try {
    const status = await plugin.checkPermissions()
    if (status.display !== 'granted') {
      const result = await plugin.requestPermissions()
      if (result.display !== 'granted') {
        console.warn('[ForegroundService] notification permission denied — recording continues without foreground service')
        return
      }
    }
  } catch (e) {
    // checkPermissions/requestPermissions may not exist on very old Android
    // versions or non-Android platforms — safe to continue.
    console.warn('[ForegroundService] permission check skipped:', e.message)
  }

  const body = sessionType === 'rest_5min' ? 'Sessão de 5 min em curso' : 'Sessão livre em curso'
  try {
    await plugin.startForegroundService({
      id:          1,
      title:       'Neroes HRV',
      body,
      smallIcon:   'ic_notification',          // res/drawable/ic_notification.xml
      serviceType: SERVICE_TYPE_CONNECTED_DEVICE, // required on Android 14+
    })
  } catch (e) {
    console.warn('[ForegroundService] start failed:', e.message)
  }
}

export async function stopForegroundService() {
  const plugin = await _load()
  if (!plugin) return
  try {
    await plugin.stopForegroundService()
  } catch (e) {
    console.warn('[ForegroundService] stop failed:', e.message)
  }
}
