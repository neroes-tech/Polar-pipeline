import { Capacitor } from '@capacitor/core'
import { BleClient } from '@capacitor-community/bluetooth-le'
import { Preferences } from '@capacitor/preferences'

// Reconnecting to an already-known device without an interactive picker
// works differently per platform: Android exposes getBondedDevices() (the
// OS's own persistent pairing list, no bookkeeping needed on our side), but
// iOS has no equivalent — CoreBluetooth doesn't let apps enumerate paired
// devices freely, for privacy reasons. On iOS the only silent path is
// getDevices([id]), which needs an id we saw before — so we persist it
// ourselves the first time a connection succeeds.
const DEVICE_ID_KEY = 'neroes_ble_device_id'

// A JS-driven setTimeout retry loop stalls whenever the WebView is
// backgrounded — Chromium throttles self-scheduled timers the same way it
// throttled the recording notification (see notificationTicker.js). Android
// autoConnect=true (patched into the plugin's connectGatt call, see
// patches/@capacitor-community+bluetooth-le+7.3.2.patch) hands reconnection
// to the OS Bluetooth stack itself, which keeps retrying silently in the
// background with no JS timer involved — Android-only, see the platform
// check in _reconnectNativeAuto() below; iOS has no such concept, and the
// plugin serializes ALL BLE calls through one queue (bleClient.js's
// this.queue(...)), so a pending connect() here blocks every other BLE call
// (disconnect, startNotifications, stopEcg...) until it settles. Bounded to
// under a minute rather than left open-ended, and on timeout the plugin
// closes the underlying GATT object (see setConnectionTimeout in the
// patched Device.kt) — so this can't hang the queue indefinitely; the
// fallback JS retry loop below picks up from there.
const NATIVE_AUTOCONNECT_TIMEOUT_MS = 60 * 1000

// ── HRM (Heart Rate Measurement) ─────────────────────────────────────────────
const HRM_SERVICE     = '0000180d-0000-1000-8000-00805f9b34fb'
const HRM_CHAR        = '00002a37-0000-1000-8000-00805f9b34fb'
const HRM_SERVICE_NUM = 0x180D
const HRM_CHAR_NUM    = 0x2A37

// ── PMD (Polar Measurement Data) — ECG at 130 Hz ─────────────────────────────
const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8'
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8'
const PMD_DATA    = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8'

// START ECG — op=0x02, type=ECG(0x00), TLV: SampleRate=130Hz, Resolution=14bit
const ECG_START = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00])
// STOP  ECG — op=0x03, type=ECG(0x00)
const ECG_STOP  = new Uint8Array([0x03, 0x00])

/**
 * Parse Heart Rate Measurement GATT notification (spec §3.106).
 * Returns { hr_bpm: number, rr_ms: number[] }
 *   Byte 0: flags — bit0=HR format (0=uint8, 1=uint16), bit4=RR present
 *   RR intervals: uint16 LE in 1/1024 s units → ms = raw × 1000 / 1024
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

/**
 * Parse a PMD Data ECG notification frame.
 *
 * Frame layout:
 *   Byte 0      : measurement type — must be 0x00 (ECG)
 *   Bytes 1–8   : timestamp uint64 LE, nanoseconds since 2000-01-01T00:00:00 UTC
 *   Byte 9      : frame type — must be 0x00 (uncompressed)
 *   Bytes 10+   : N × 3-byte signed int24 LE samples in µV
 *
 * Returns array of µV integers (signed).
 */
export function parsePmdEcgFrame(dataView) {
  const u8 = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength)
  if (u8.length < 10) return []
  if (u8[0] !== 0x00) return []   // not ECG
  if (u8[9] !== 0x00) return []   // not uncompressed
  const out = []
  for (let i = 10; i + 3 <= u8.length; i += 3) {
    let v = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16)
    if (v & 0x800000) v -= 0x1000000   // sign-extend 24→32 bit
    out.push(v)
  }
  return out
}

export class PolarBle {
  constructor({ onStatus, onHrm, onDisconnect, onReconnected }) {
    this._onStatus      = onStatus
    this._onHrm         = onHrm
    this._onDisconnect   = onDisconnect
    this._onReconnected = onReconnected || (() => {})
    this._reconnecting     = false
    this._reconnectAttempt = 0
    // Set on explicit disconnect() so an in-flight retry loop stops instead
    // of fighting a deliberate stop/logout. Cleared again on the next connect().
    this._stopReconnecting = false

    // Native state
    this._deviceId   = null
    this._deviceName = null

    // Web Bluetooth state
    this._webDevice     = null
    this._webServer     = null
    this._webChar       = null        // HRM characteristic
    this._webHrmHandler = null
    this._webPmdControl = null        // PMD Control characteristic
    this._webPmdData    = null        // PMD Data characteristic
    this._webEcgHandler = null
  }

  get isWeb() {
    return !Capacitor.isNativePlatform()
  }

  async initialize() {
    if (!this.isWeb) {
      try {
        await BleClient.initialize({ androidNeverForLocation: true })
      } catch (e) {
        if ((e.message || '').toLowerCase().includes('permission')) {
          throw new Error('permission_denied')
        }
        throw e
      }
    }
  }

  async openSettings() {
    if (!this.isWeb) {
      try { await BleClient.openAppSettings() } catch (_) {}
    }
  }

  async connect() {
    this._stopReconnecting = false
    if (this.isWeb) {
      await this._connectWeb()
    } else {
      await this._connectNative()
    }
  }

  async disconnect() {
    this._stopReconnecting = true
    if (this.isWeb) {
      try { await this._stopEcgWeb() } catch (_) {}
      try { if (this._webChar) await this._webChar.stopNotifications() } catch (_) {}
      try { if (this._webServer) this._webServer.disconnect() } catch (_) {}
      this._webDevice = this._webServer = this._webChar = this._webHrmHandler = null
      this._webPmdControl = this._webPmdData = this._webEcgHandler = null
    } else {
      if (!this._deviceId) return
      try { await this._stopEcgNative() } catch (_) {}
      try {
        await BleClient.stopNotifications(this._deviceId, HRM_SERVICE, HRM_CHAR)
        await BleClient.disconnect(this._deviceId)
      } catch (_) {}
      this._deviceId = null
    }
    this._onStatus('idle')
  }

  // ── ECG public API ─────────────────────────────────────────────────────────

  /**
   * Start ECG stream at 130 Hz.
   * onSample(µVArray) is called per PMD Data notification with an array of µV values.
   * Throws 'pmd_unavailable' if the PMD service was not discovered at connect time.
   * Caller MUST wrap in try/catch — ECG failure must not crash the HR/RR session.
   */
  async startEcg(onSample) {
    if (this.isWeb) {
      await this._startEcgWeb(onSample)
    } else {
      await this._startEcgNative(onSample)
    }
  }

  /**
   * Stop ECG stream. Always safe to call even if not started.
   */
  async stopEcg() {
    try {
      if (this.isWeb) {
        await this._stopEcgWeb()
      } else {
        await this._stopEcgNative()
      }
    } catch (_) {}
  }

  // ── Web Bluetooth path ─────────────────────────────────────────────────────

  async _connectWeb() {
    if (!navigator.bluetooth) throw new Error('ble_unavailable')

    this._onStatus('scanning')

    let device
    try {
      // namePrefix + full UUID strings: only format Bluefy (iOS) reliably accepts.
      // { services: [0x180D] } and numeric values in optionalServices both cause
      // "Request payload could not be parsed" in Bluefy — use strings throughout.
      device = await navigator.bluetooth.requestDevice({
        filters:          [{ namePrefix: 'Polar' }],
        optionalServices: [HRM_SERVICE, PMD_SERVICE],
      })
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'NotAllowedError') {
        throw new Error('device_not_found')
      }
      throw new Error(e.message)
    }

    this._webDevice = device
    device.addEventListener('gattserverdisconnected', () => this._handleWebDisconnect())

    this._onStatus('connecting')
    await this._webGattConnect()
    this._onStatus('connected')
  }

  async _webGattConnect() {
    const server = await this._webDevice.gatt.connect()
    this._webServer = server

    // HRM — always required
    const hrmService = await server.getPrimaryService(HRM_SERVICE_NUM)
    const hrmChar    = await hrmService.getCharacteristic(HRM_CHAR_NUM)
    this._webChar    = hrmChar
    if (this._webHrmHandler) hrmChar.removeEventListener('characteristicvaluechanged', this._webHrmHandler)
    this._webHrmHandler = (e) => this._onHrm(parseHrmNotification(e.target.value))
    hrmChar.addEventListener('characteristicvaluechanged', this._webHrmHandler)
    await hrmChar.startNotifications()

    // PMD — best-effort (H10 always has it; guard in case of unexpected device)
    try {
      const pmdService    = await server.getPrimaryService(PMD_SERVICE)
      this._webPmdControl = await pmdService.getCharacteristic(PMD_CONTROL)
      this._webPmdData    = await pmdService.getCharacteristic(PMD_DATA)
    } catch (_) {
      this._webPmdControl = this._webPmdData = null
    }
  }

  async _startEcgWeb(onSample) {
    if (!this._webPmdControl || !this._webPmdData) throw new Error('pmd_unavailable')

    // Register ECG data handler
    if (this._webEcgHandler) {
      this._webPmdData.removeEventListener('characteristicvaluechanged', this._webEcgHandler)
    }
    this._webEcgHandler = (e) => {
      const samples = parsePmdEcgFrame(e.target.value)
      if (samples.length > 0) onSample(samples)
    }
    this._webPmdData.addEventListener('characteristicvaluechanged', this._webEcgHandler)
    await this._webPmdData.startNotifications()

    // Enable indications on control point to receive command ACKs
    await this._webPmdControl.startNotifications()

    // Send START command — Uint8Array accepted by Web Bluetooth
    await this._webPmdControl.writeValueWithResponse(ECG_START)
  }

  async _stopEcgWeb() {
    try {
      if (this._webPmdControl) {
        await this._webPmdControl.writeValueWithResponse(ECG_STOP)
      }
    } catch (_) {}
    try {
      if (this._webPmdData) {
        if (this._webEcgHandler) {
          this._webPmdData.removeEventListener('characteristicvaluechanged', this._webEcgHandler)
          this._webEcgHandler = null
        }
        await this._webPmdData.stopNotifications()
      }
    } catch (_) {}
    try {
      if (this._webPmdControl) await this._webPmdControl.stopNotifications()
    } catch (_) {}
  }

  _handleWebDisconnect() {
    if (this._reconnecting) return
    this._reconnecting = true
    this._reconnectAttempt = 0
    this._onStatus('reconnecting')
    this._onDisconnect()
    this._scheduleWebReconnect()
  }

  // Retries forever (band in a pocket/bag can be out of range for minutes at
  // a time during a long field session) with capped exponential backoff, so
  // a single failed attempt never leaves the band silently disconnected —
  // the old behaviour gave up after one try and required reopening the app.
  _scheduleWebReconnect() {
    const delay = Math.min(3000 + this._reconnectAttempt * 2000, 15000)
    setTimeout(async () => {
      if (this._stopReconnecting || !this._webDevice) { this._reconnecting = false; return }
      this._reconnectAttempt++
      try {
        await this._webGattConnect()
        this._reconnecting = false
        this._reconnectAttempt = 0
        this._onStatus('connected')
        this._onReconnected()
      } catch (_) {
        this._onStatus('reconnecting')
        this._scheduleWebReconnect()
      }
    }, delay)
  }

  // ── Capacitor BLE (native Android/iOS) path ───────────────────────────────
  //
  // requestLEScan() requires BLUETOOTH_PRIVILEGED (system apps only) → CRASH.
  // requestDevice() opens the native OS picker — no special permission needed.
  // After first connection we store deviceId (MAC on Android) for reconnect.

  async _connectNative() {
    this._onStatus('scanning')

    // Strategy 1: connect silently to an already-known Polar H10, no picker.
    // The actual lookup differs per platform (see DEVICE_ID_KEY comment above).
    try {
      const knownId = await this._findKnownDeviceId()
      if (knownId) {
        await this._connectToKnownDevice(knownId)
        return
      }
    } catch (_) {}

    // Strategy 2: native OS picker (requires BLUETOOTH_SCAN at runtime on
    // Android; on iOS this is the only way to discover a device the first
    // time, since there is no bonded-devices list to read).
    let device
    try {
      device = await BleClient.requestDevice({
        services:   [HRM_SERVICE],
        namePrefix: 'Polar H10',
      })
    } catch (e) {
      const msg = (e.message || '').toLowerCase()
      // Seen on Android 16 (Pixel 8 Pro): the scan-based picker itself gets
      // rejected with "...has android.permission.BLUETOOTH_PRIVILEGED" even
      // though the app holds the normal BLUETOOTH_SCAN runtime permission —
      // an OS-level restriction on this scan API that no permission prompt
      // can fix. A plain GATT connect (no scanning) is unaffected, so the
      // real fix is pairing the band once via Android's own Bluetooth
      // settings — that makes it show up in getBondedDevices() next launch,
      // bypassing this scan path entirely. Checked before the generic
      // 'permission' branch below, which is for an actually-revocable denial.
      if (msg.includes('privileged')) {
        throw new Error('scan_blocked')
      }
      if (msg.includes('cancel') || msg.includes('denied') || msg.includes('not found')) {
        throw new Error('device_not_found')
      }
      if (msg.includes('permission')) {
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
    this._reconnecting     = false
    this._reconnectAttempt = 0
    this._onStatus('connected')

    // Remember this device so the NEXT app launch can reconnect silently on
    // iOS too (see _findKnownDeviceId). Harmless no-op benefit on Android,
    // which already has getBondedDevices() as its own persistent record.
    Preferences.set({ key: DEVICE_ID_KEY, value: this._deviceId }).catch(() => {})
  }

  /** Returns a deviceId we can connect to directly without a picker, or null if none is known. */
  async _findKnownDeviceId() {
    if (Capacitor.getPlatform() === 'android') {
      const bonded = await BleClient.getBondedDevices()
      const h10 = bonded.find(d => (d.name || '').toLowerCase().includes('polar'))
      return h10 ? h10.deviceId : null
    }
    // iOS (and web, though web uses a separate _connectWeb path entirely):
    // getBondedDevices() doesn't exist here — CoreBluetooth doesn't let apps
    // enumerate paired devices for privacy reasons. getDevices([id]) can
    // still retrieve a specific device we already know the id of.
    const { value: savedId } = await Preferences.get({ key: DEVICE_ID_KEY })
    if (!savedId) return null
    const known = await BleClient.getDevices([savedId])
    return known.length > 0 ? known[0].deviceId : null
  }

  async _connectToKnownDevice(deviceId) {
    this._deviceId   = deviceId
    this._deviceName = 'Polar H10'
    this._onStatus('connecting')
    // Defensive: if the app's Activity/process was recreated mid-session,
    // the OS Bluetooth stack can be left believing this device is still
    // connected from the now-gone plugin instance. Connecting again on top
    // of that silently fails, which used to fall through to the manual
    // device picker — clear it first.
    try { await BleClient.disconnect(deviceId) } catch (_) {}
    try {
      await BleClient.connect(this._deviceId, () => this._handleNativeDisconnect())
      await BleClient.startNotifications(
        this._deviceId, HRM_SERVICE, HRM_CHAR,
        (dv) => this._onHrm(parseHrmNotification(dv))
      )
      this._reconnecting     = false
      this._reconnectAttempt = 0
      this._onStatus('connected')
    } catch (_) {
      // Band isn't in range right now (still on, but in a bag/pocket a few
      // metres away). A band already paired to this phone must end up
      // connected on its own — never fall through to the interactive
      // picker here, hand off to the OS's own autoConnect instead.
      this._onStatus('reconnecting')
      await this._reconnectNativeAuto()
    }
  }

  /**
   * Reconnect to the current _deviceId via the OS's own autoConnect
   * mechanism (Android — see NATIVE_AUTOCONNECT_TIMEOUT_MS above) instead
   * of a JS setTimeout retry loop, which stalls in the background. Safe to
   * call repeatedly — each call re-registers the disconnect listener too.
   */
  async _reconnectNativeAuto() {
    if (this._stopReconnecting || !this._deviceId) { this._reconnecting = false; return }
    this._reconnecting = true

    // autoConnect is an Android BluetoothGatt concept with no iOS
    // equivalent — passing it there gains nothing and just spends this
    // platform's turn holding the BLE call queue for no benefit. iOS keeps
    // using the plain short-timeout retry loop, unchanged from before.
    if (Capacitor.getPlatform() !== 'android') {
      this._onStatus('reconnecting')
      this._scheduleNativeReconnect()
      return
    }

    try {
      await BleClient.connect(this._deviceId, () => this._handleNativeDisconnect(), {
        autoConnect: true,
        timeout:     NATIVE_AUTOCONNECT_TIMEOUT_MS,
      })
      await BleClient.startNotifications(
        this._deviceId, HRM_SERVICE, HRM_CHAR,
        (dv) => this._onHrm(parseHrmNotification(dv))
      )
      this._reconnecting     = false
      this._reconnectAttempt = 0
      this._onStatus('connected')
      this._onReconnected()
    } catch (_) {
      // The native attempt itself failed or timed out — fall back to the
      // short-interval JS retry loop rather than leaving the band
      // disconnected with nothing retrying at all.
      this._onStatus('reconnecting')
      this._scheduleNativeReconnect()
    }
  }

  async _startEcgNative(onSample) {
    if (!this._deviceId) throw new Error('not_connected')
    console.log('[ECG native] starting on device', this._deviceId)

    // 1. Subscribe PMD_CONTROL indications to receive command ACKs
    try {
      await BleClient.startNotifications(this._deviceId, PMD_SERVICE, PMD_CONTROL, (dv) => {
        console.log('[ECG native] PMD_CONTROL ack received, len=', dv.byteLength)
      })
      console.log('[ECG native] PMD_CONTROL subscribed')
    } catch (e) {
      // Some firmware versions don't need this — log and continue
      console.warn('[ECG native] PMD_CONTROL subscribe failed (non-fatal):', e.message)
    }

    // 2. Subscribe PMD_DATA notifications to receive ECG frames
    console.log('[ECG native] subscribing PMD_DATA...')
    await BleClient.startNotifications(
      this._deviceId, PMD_SERVICE, PMD_DATA,
      (dv) => {
        const samples = parsePmdEcgFrame(dv)
        if (samples.length > 0) onSample(samples)
      }
    )
    console.log('[ECG native] PMD_DATA subscribed')

    // 3. Write START command — must use BleClient.write (write-with-response)
    //    New DataView each call — never mutate the shared constant
    console.log('[ECG native] writing ECG_START command...')
    await BleClient.write(
      this._deviceId, PMD_SERVICE, PMD_CONTROL,
      new DataView(ECG_START.slice().buffer)
    )
    console.log('[ECG native] ECG_START sent — stream running')
  }

  async _stopEcgNative() {
    if (!this._deviceId) return
    try {
      await BleClient.write(
        this._deviceId, PMD_SERVICE, PMD_CONTROL,
        new DataView(ECG_STOP.slice().buffer)
      )
      console.log('[ECG native] ECG_STOP sent')
    } catch (e) {
      console.warn('[ECG native] ECG_STOP write failed:', e.message)
    }
    try { await BleClient.stopNotifications(this._deviceId, PMD_SERVICE, PMD_DATA)    } catch (_) {}
    try { await BleClient.stopNotifications(this._deviceId, PMD_SERVICE, PMD_CONTROL) } catch (_) {}
  }

  _handleNativeDisconnect() {
    if (this._reconnecting) return
    this._reconnecting = true
    this._reconnectAttempt = 0
    this._onStatus('reconnecting')
    this._onDisconnect()
    this._reconnectNativeAuto()
  }

  // Fallback only — used when the native autoConnect attempt itself throws
  // synchronously (e.g. adapter off). Retries forever (band in a pocket/bag
  // can be out of range for minutes at a time during a long field session)
  // with capped exponential backoff, so a single failed attempt never
  // leaves the band silently disconnected — the old behaviour gave up after
  // one try and required reopening the app.
  // On success, fires onReconnected() so the caller can resume the ECG
  // stream, which does NOT survive a GATT disconnect on its own.
  _scheduleNativeReconnect() {
    const delay = Math.min(3000 + this._reconnectAttempt * 2000, 15000)
    setTimeout(async () => {
      if (this._stopReconnecting || !this._deviceId) { this._reconnecting = false; return }
      this._reconnectAttempt++
      try {
        await BleClient.connect(this._deviceId, () => this._handleNativeDisconnect())
        await BleClient.startNotifications(
          this._deviceId, HRM_SERVICE, HRM_CHAR,
          (dv) => this._onHrm(parseHrmNotification(dv))
        )
        this._reconnecting     = false
        this._reconnectAttempt = 0
        this._onStatus('connected')
        this._onReconnected()
      } catch (_) {
        this._onStatus('reconnecting')
        this._scheduleNativeReconnect()
      }
    }, delay)
  }
}
