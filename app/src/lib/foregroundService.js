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

export async function startForegroundService(sessionType) {
  const plugin = await _load()
  if (!plugin) return
  const body = sessionType === 'rest_5min' ? 'Sessão de 5 min em curso' : 'Sessão livre em curso'
  try {
    await plugin.startForegroundService({ id: 1, title: 'Neroes HRV', body, smallIcon: 'ic_launcher_round' })
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
