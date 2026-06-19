import { Preferences } from '@capacitor/preferences'

const KEY = 'neroes_active_session_v1'

export async function saveActiveSession(data) {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(data) })
  } catch (e) {
    console.warn('[sessionPersistence] save failed:', e.message)
  }
}

export async function loadActiveSession() {
  try {
    const { value } = await Preferences.get({ key: KEY })
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

export async function clearActiveSession() {
  try {
    await Preferences.remove({ key: KEY })
  } catch (e) {
    console.warn('[sessionPersistence] clear failed:', e.message)
  }
}
