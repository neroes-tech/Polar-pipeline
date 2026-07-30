import { Capacitor } from '@capacitor/core'

let _plugin  = null
let _tried   = false
let _running = false

// Returns { plugin } rather than the plugin object directly. Capacitor's
// plugin proxy answers ANY property access with a callable (including
// `.then`), so an async function that resolves directly to the plugin
// object looks "thenable" to the JS engine — it tries to unwrap it by
// calling `plugin.then(...)`, which Capacitor treats as a call to a native
// method literally named "then" and rejects with "X.then() is not
// implemented". Wrapping in a plain object avoids that trap entirely.
async function _load() {
  if (_tried) return { plugin: _plugin }
  _tried = true
  if (!Capacitor.isNativePlatform()) return { plugin: null }
  try {
    const mod = await import('@capawesome-team/capacitor-android-foreground-service')
    _plugin = mod.ForegroundService
  } catch (e) {
    console.warn('[ForegroundService] plugin not available:', e.message)
  }
  return { plugin: _plugin }
}

// connectedDevice foreground service type (Android constant = 16).
// Required in startForeground() call on Android 14+ when the manifest
// declares foregroundServiceType="connectedDevice".
const SERVICE_TYPE_CONNECTED_DEVICE = 16
const NOTIFICATION_ID  = 1

// Own channel, created explicitly. Relying on the plugin's implicit
// "default" channel is fragile: it only auto-creates one if the app has
// ZERO notification channels at all, and @capacitor/local-notifications
// (used elsewhere for the BLE-disconnect watchdog) creates its own channel
// on load — so by the time a recording starts, the implicit default is
// silently skipped and the foreground notification never posts (Android
// drops notifications posted to a non-existent channel, no error thrown).
const CHANNEL_ID = 'neroes_recording'

async function _ensureChannel(plugin) {
  try {
    await plugin.createNotificationChannel({
      id:          CHANNEL_ID,
      name:        'Gravação em curso',
      description: 'Notificação persistente enquanto uma sessão está a ser gravada',
      importance:  3, // IMPORTANCE_DEFAULT
    })
  } catch (e) {
    // Already exists, or pre-O device (channels don't apply) — both fine.
  }
}

export async function startForegroundService(sessionType) {
  const { plugin } = await _load()
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

  await _ensureChannel(plugin)

  const body = sessionType === 'rest_5min' ? 'Sessão de 5 min em curso' : 'Sessão livre em curso'
  try {
    await plugin.startForegroundService({
      id:                    NOTIFICATION_ID,
      title:                 'Neroes HRV',
      body,
      smallIcon:             'ic_notification',          // res/drawable/ic_notification.xml
      serviceType:           SERVICE_TYPE_CONNECTED_DEVICE, // required on Android 14+
      notificationChannelId: CHANNEL_ID,
    })
    _running = true
  } catch (e) {
    console.warn('[ForegroundService] start failed:', e.message)
    _running = false
  }
}

/**
 * Update the persistent notification's text while a session is recording —
 * e.g. elapsed time + live HR. Doubles as a "yes, it's still running" signal
 * the participant can see on the lock screen without opening the app, since
 * a real home-screen widget isn't available for this without native code.
 * No-op if the foreground service never started (e.g. the SDK/permission
 * checks above failed).
 */
export async function updateForegroundServiceStatus(body) {
  if (!_running) return
  const { plugin } = await _load()
  if (!plugin) return
  try {
    await plugin.updateForegroundService({
      id:        NOTIFICATION_ID,
      title:     'Neroes HRV',
      body,
      smallIcon: 'ic_notification',
      // Without this, the Android notification plumbing re-alerts (sound +
      // vibration) on every single update — and this is called every 4s for
      // the whole session. `silent: true` here means "don't re-alert for an
      // update to an already-showing notification"; it does NOT silence the
      // very first posting in startForegroundService() above, which has no
      // `silent` flag and still gives the participant one confirmation buzz
      // when recording actually starts.
      silent: true,
    })
  } catch (e) {
    console.warn('[ForegroundService] update failed:', e.message)
  }
}

export async function stopForegroundService() {
  _running = false
  const { plugin } = await _load()
  if (!plugin) return
  try {
    await plugin.stopForegroundService()
  } catch (e) {
    console.warn('[ForegroundService] stop failed:', e.message)
  }
}
