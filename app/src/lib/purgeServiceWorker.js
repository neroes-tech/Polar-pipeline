import { Capacitor } from '@capacitor/core'

const RELOAD_GUARD = 'neroes_sw_purge_reloaded'

/**
 * Removes any service worker (and its Cache Storage) from the native app.
 *
 * Native builds no longer ship one at all (see vite.config.js), but a phone
 * that ran an earlier build still has the old one registered: an APK update
 * installed over the previous version keeps app data, and the service worker
 * registration + Cache Storage live in there, keyed to https://localhost.
 * So without this, a fresh APK would still be driven by the old, broken
 * service worker — serving stale JS and, worse, stalling the `participants`
 * query forever (NetworkFirst with no timeout), which froze the app on its
 * loading spinner right after sign-in.
 *
 * Safe on the web build too: it only ever runs on native platforms, where
 * the service worker is pure downside.
 */
export async function purgeServiceWorkerOnNative() {
  if (!Capacitor.isNativePlatform()) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  try {
    const hadController = !!navigator.serviceWorker.controller

    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map(r => r.unregister().catch(() => false)))

    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k).catch(() => false)))
    }

    if (registrations.length > 0 || hadController) {
      console.log('[sw-purge] removed', registrations.length, 'registration(s) + caches')
    }

    // Unregistering doesn't detach the service worker that's already
    // controlling THIS page — it keeps intercepting fetches until a reload.
    // Reload once (guarded, so it can never loop) so this session runs clean.
    if (hadController && !sessionStorage.getItem(RELOAD_GUARD)) {
      sessionStorage.setItem(RELOAD_GUARD, '1')
      console.log('[sw-purge] reloading once to detach the active service worker')
      location.reload()
    }
  } catch (e) {
    // Never block app startup over this — worst case the old SW stays and we
    // fall back on the in-code timeouts added alongside this.
    console.warn('[sw-purge] failed:', e?.message ?? String(e))
  }
}
