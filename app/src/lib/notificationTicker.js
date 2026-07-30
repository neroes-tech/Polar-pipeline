import { registerPlugin, Capacitor } from '@capacitor/core'

// Local plugin — lives in android/app/src/main/java/com/neroes/hrv/, not an
// npm package. Ticks the recording notification with a native Android
// Handler, immune to the WebView JS-timer throttling that freezes anything
// driven by setInterval once the app is backgrounded for a while. See
// NotificationTickerPlugin.java for the full rationale.
const NotificationTicker = registerPlugin('NotificationTicker')

const isNative = () => Capacitor.isNativePlatform()

/** Starts the native tick loop. startedAt is a wall-clock ms timestamp (Date.now()). */
export async function startTicker({ startedAt, sessionType }) {
  if (!isNative()) return
  try {
    await NotificationTicker.start({ startedAt, sessionType })
  } catch (e) {
    console.warn('[NotificationTicker] start failed:', e.message)
  }
}

/** Pushes the latest bpm/connection status — the ticker keeps using it on every tick until the next update. */
export async function updateTickerStatus({ bpm, status }) {
  if (!isNative()) return
  try {
    await NotificationTicker.updateBpm({ bpm, status })
  } catch (e) {
    console.warn('[NotificationTicker] updateBpm failed:', e.message)
  }
}

export async function stopTicker() {
  if (!isNative()) return
  try {
    await NotificationTicker.stop()
  } catch (e) {
    console.warn('[NotificationTicker] stop failed:', e.message)
  }
}
