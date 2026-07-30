import { Capacitor } from '@capacitor/core'

let _plugin  = null
let _tried   = false
let _permOk  = false
let _nextId  = 9001   // local notification ids — arbitrary range, unused elsewhere in the app

// Native-only (Android + iOS, once the iOS app exists). Used as a watchdog
// alert: if the BLE connection to the band drops for too long during an
// active session, the participant may have the phone in a pocket/bag and
// not notice the "reconnecting" pill on screen — a lock-screen notification
// is the only way to reach them.
// Returns { plugin } rather than the plugin object directly — see the
// comment in keepAwake.js's _load() for why returning the raw plugin object
// from an awaited async function triggers a spurious "X.then() is not
// implemented" error via JS's thenable-unwrapping.
// Own channel, created explicitly, importance HIGH with vibration forced on.
// These alerts (BLE dropped, session finished, upload confirmed) are the
// only way a participant with the phone locked/in a pocket ever finds out
// something needs attention — relying on whatever the implicit default
// channel happens to default to on a given device/Android version isn't
// good enough here.
const CHANNEL_ID = 'neroes_alerts'

async function _load() {
  if (_tried) return { plugin: _plugin }
  _tried = true
  if (!Capacitor.isNativePlatform()) return { plugin: null }
  try {
    const mod = await import('@capacitor/local-notifications')
    _plugin = mod.LocalNotifications
    const status = await _plugin.checkPermissions()
    if (status.display === 'granted') {
      _permOk = true
    } else {
      const res = await _plugin.requestPermissions()
      _permOk = res.display === 'granted'
    }
    try {
      await _plugin.createChannel({
        id:          CHANNEL_ID,
        name:        'Alertas',
        description: 'Fim de sessão, banda desligada, sincronização',
        importance:  4, // HIGH — heads-up + sound + vibration
        vibration:   true,
      })
    } catch (e) {
      // Already exists, or pre-O device (channels don't apply) — both fine.
    }
  } catch (e) {
    console.warn('[localAlerts] plugin not available:', e.message)
  }
  return { plugin: _plugin }
}

async function _notify(body) {
  const { plugin } = await _load()
  if (!plugin || !_permOk) return
  try {
    await plugin.schedule({
      notifications: [{
        id:        _nextId++,
        title:     'Neroes HRV',
        body,
        channelId: CHANNEL_ID,
        // No `sound` override: Capacitor's docs warn that on Android 26+ a
        // missing/invalid sound file name means NO sound at all (silently),
        // whereas omitting the field entirely uses the system default sound.
        // Vibration comes from the channel's `vibration: true` above, which
        // isn't overridable per-notification on Android 26+.
        schedule: { at: new Date(Date.now() + 300) },
      }],
    })
  } catch (e) {
    console.warn('[localAlerts] schedule failed:', e.message)
  }
}

export async function notifyBleDisconnected() {
  await _notify('A banda desligou-se durante a gravação. Verifica se está bem colocada e o telemóvel próximo.')
}

/** Session finished recording and is safely saved on the phone (before/regardless of upload). */
export async function notifySessionSaved() {
  await _notify('Sessão terminada e guardada no telemóvel.')
}

/** One or more locally-saved sessions were just uploaded to Supabase. */
export async function notifySessionsSynced(count) {
  await _notify(
    count === 1
      ? 'Sessão gravada enviada com sucesso.'
      : `${count} sessões gravadas enviadas com sucesso.`
  )
}
