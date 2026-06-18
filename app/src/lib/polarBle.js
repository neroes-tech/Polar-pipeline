import { Capacitor } from '@capacitor/core'
import { BleClient } from '@capacitor-community/bluetooth-le'

const HRM_SERVICE     = '0000180d-0000-1000-8000-00805f9b34fb'
const HRM_CHAR        = '00002a37-0000-1000-8000-00805f9b34fb'
const HRM_SERVICE_NUM = 0x180D   // short UUID for Web Bluetooth API
const HRM_CHAR_NUM    = 0x2A37
const SCAN_TIMEOUT_MS = 15000

/**
 * Parse a Heart Rate Measurement GATT notification (spec §3.106).
 * Returns { hr_bpm: number, rr_ms: number[] }
 *   Byte 0: flags — bit0=HR format (0=uint8, 1=uint16), bit4=RR present
 *   RR intervals: uint16 LE in 1/1024 s units → ms = raw * 1000 / 1024
 */
export function parseHrmNotification(dataView) {
  const flags      = dataView.getUint8(0)
  const hrFormat16 = (flags & 0x01) !== 0
  const rrPresent  = (flags & 0x10) !== 0

  let offset = 1
  let hr_bpm
  if (hrFormat16) {
    hr_bpm = dataView.getUint16(offset, true); offset += 2
  } else {
    hr_bpm = dataView.getUint8(offset);        offset += 1
  }

  const rr_ms = []
  if (rrPresent) {
    while (offset + 1 < dataView.byteLength) {
      rr_ms.push(Math.round(dataView.getUint16(offset, true) * 1000 / 1024))
      offset += 2
    }
  }

  return { hr_bpm, rr_ms }
}

export class PolarBle {
  constructor({ onStatus, onHrm, onDisconnect }) {
    this._onStatus     = onStatus      // (status: string) => void
    this._onHrm        = onHrm         // ({ hr_bpm, rr_ms }) => void
    this._onDisconnect = onDisconnect  // () => void
    this._reconnecting = false

    // Native (Capacitor) state
    this._deviceId   = null
    this._deviceName = null

    // Web Bluetooth state
    this._webDevice     = null
    this._webServer     = null
    this._webChar       = null
    this._webHrmHandler = null
  }

  /** true when running in browser (not Android/iOS Capacitor shell) */
  get isWeb() {
    return !Capacitor.isNativePlatform()
  }

  async initialize() {
    if (!this.isWeb) {
      try {
        // initialize() requests BLUETOOTH_SCAN + BLUETOOTH_CONNECT at runtime (Android 12+)
        await BleClient.initialize({ androidNeverForLocation: true })
      } catch (e) {
        if ((e.message || '').toLowerCase().includes('permission')) {
          throw new Error('permission_denied')
        }
        throw e
      }
    }
    // Web Bluetooth requires no initialization
  }

  /** Open Android app settings so the user can manually grant Bluetooth permission. */
  async openSettings() {
    if (!this.isWeb) {
      try { await BleClient.openAppSettings() } catch (_) {}
    }
  }

  /**
   * Connect to a Polar H10.
   * Both web and native open a device picker — MUST be called from a user gesture.
   * Web:    navigator.bluetooth.requestDevice()
   * Native: BleClient.requestDevice()  (no BLUETOOTH_PRIVILEGED required)
   */
  async connect() {
    if (this.isWeb) {
      await this._connectWeb()
    } else {
      await this._connectNative()
    }
  }

  async disconnect() {
    if (this.isWeb) {
      try { if (this._webChar) await this._webChar.stopNotifications() } catch (_) {}
      try { if (this._webServer) this._webServer.disconnect() } catch (_) {}
      this._webDevice = this._webServer = this._webChar = this._webHrmHandler = null
    } else {
      if (!this._deviceId) return
      try {
        await BleClient.stopNotifications(this._deviceId, HRM_SERVICE, HRM_CHAR)
        await BleClient.disconnect(this._deviceId)
      } catch (_) {}
      this._deviceId = null
    }
    this._onStatus('idle')
  }

  // ── Web Bluetooth path ─────────────────────────────────────────────────────

  async _connectWeb() {
    if (!navigator.bluetooth) throw new Error('ble_unavailable')

    this._onStatus('scanning')

    let device
    try {
      // Opens native browser picker — user selects their H10 visually
      device = await navigator.bluetooth.requestDevice({
        filters:          [{ services: [HRM_SERVICE_NUM] }],
        optionalServices: [HRM_SERVICE_NUM],
      })
    } catch (e) {
      // NotFoundError = user cancelled picker
      throw new Error(e.name === 'NotFoundError' ? 'device_not_found' : e.message)
    }

    this._webDevice = device
    device.addEventListener('gattserverdisconnected', () => this._handleWebDisconnect())

    this._onStatus('connecting')
    await this._webGattConnect()
    this._onStatus('connected')
  }

  async _webGattConnect() {
    const server  = await this._webDevice.gatt.connect()
    this._webServer = server

    const service = await server.getPrimaryService(HRM_SERVICE_NUM)
    const char    = await service.getCharacteristic(HRM_CHAR_NUM)
    this._webChar = char

    // Remove previous listener to avoid duplicates after reconnect
    if (this._webHrmHandler) char.removeEventListener('characteristicvaluechanged', this._webHrmHandler)
    this._webHrmHandler = (e) => this._onHrm(parseHrmNotification(e.target.value))
    char.addEventListener('characteristicvaluechanged', this._webHrmHandler)

    await char.startNotifications()
  }

  _handleWebDisconnect() {
    if (this._reconnecting) return
    this._reconnecting = true
    this._onStatus('reconnecting')
    this._onDisconnect()

    setTimeout(async () => {
      if (!this._webDevice) { this._reconnecting = false; return }
      try {
        await this._webGattConnect()  // re-use existing device ref, no new picker
        this._reconnecting = false
        this._onStatus('connected')
      } catch (_) {
        this._reconnecting = false
        this._onStatus('error')
      }
    }, 3000)
  }

  // ── Capacitor BLE (native Android/iOS) path ───────────────────────────────
  //
  // requestLEScan() requires BLUETOOTH_PRIVILEGED (system apps only) → CRASH.
  // requestDevice() opens the native OS picker — no special permission needed.
  // After first connection we store deviceId (MAC on Android) so reconnect
  // can call connect(deviceId) directly without showing the picker again.

  async _connectNative() {
    this._onStatus('scanning')

    // Strategy 1: connect directly to a Polar H10 already bonded in Android Settings.
    // Bonded = paired. Uses only BLUETOOTH_CONNECT (no BLUETOOTH_SCAN required).
    // This avoids the BLUETOOTH_PRIVILEGED crash on devices where scan permission
    // hasn't been granted yet, and is faster for repeat sessions.
    try {
      const bonded = await BleClient.getBondedDevices()
      const h10 = bonded.find(d => (d.name || '').toLowerCase().includes('polar'))
      if (h10) {
        this._deviceId   = h10.deviceId
        this._deviceName = h10.name || 'Polar H10'
        this._onStatus('connecting')
        await BleClient.connect(this._deviceId, () => this._handleNativeDisconnect())
        await BleClient.startNotifications(
          this._deviceId, HRM_SERVICE, HRM_CHAR,
          (dv) => this._onHrm(parseHrmNotification(dv))
        )
        this._reconnecting = false
        this._onStatus('connected')
        return
      }
    } catch (_) {
      // getBondedDevices failed (permission not yet granted, or device OS issue) — fall through
    }

    // Strategy 2: open native OS picker (requires BLUETOOTH_SCAN at runtime).
    // MUST be called from a user gesture.
    let device
    try {
      device = await BleClient.requestDevice({
        services:   [HRM_SERVICE],
        namePrefix: 'Polar H10',
      })
    } catch (e) {
      const msg = (e.message || '').toLowerCase()
      if (msg.includes('cancel') || msg.includes('denied') || msg.includes('not found')) {
        throw new Error('device_not_found')
      }
      if (msg.includes('permission') || msg.includes('privileged')) {
        throw new Error('permission_denied')
      }
      throw e
    }

    this._deviceId   = device.deviceId
    this._deviceName = device.name || 'Polar H10'
    this._onStatus('connecting')

    await BleClient.connect(this._deviceId, () => this._handleNativeDisconnect())
    await BleClient.startNotifications(
      this._deviceId, HRM_SERVICE, HRM_CHAR,
      (dv) => this._onHrm(parseHrmNotification(dv))
    )

    this._reconnecting = false
    this._onStatus('connected')
  }

  _handleNativeDisconnect() {
    if (this._reconnecting) return
    this._reconnecting = true
    this._onStatus('reconnecting')
    this._onDisconnect()

    // Reconnect directly using stored deviceId — no picker needed.
    setTimeout(async () => {
      if (!this._deviceId) { this._reconnecting = false; return }
      try {
        await BleClient.connect(this._deviceId, () => this._handleNativeDisconnect())
        await BleClient.startNotifications(
          this._deviceId, HRM_SERVICE, HRM_CHAR,
          (dv) => this._onHrm(parseHrmNotification(dv))
        )
        this._reconnecting = false
        this._onStatus('connected')
      } catch (_) {
        this._reconnecting = false
        this._onStatus('error')
      }
    }, 3000)
  }
}
