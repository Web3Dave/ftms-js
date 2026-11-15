import { CHARACTERISTICS, ControlOp, DATA_CHARACTERISTICS, FTMS_SERVICE, ResultCode } from '../core/constants'
import {
  encodeControl,
  parseControlResponse,
  type BikeSimulation,
  type ControlResponse,
} from '../core/control'
import { parseFeature } from '../core/feature'
import {
  MACHINE_TYPES,
  mergeMachineData,
  parseMachineData,
  type MachineData,
  type MachineType,
} from '../core/machineData'
import { parseMachineStatus } from '../core/machineStatus'
import { parseRange, type Range, type RangeKind } from '../core/range'
import { parseTrainingStatus } from '../core/trainingStatus'
import { Emitter } from './emitter'
import { FtmsError } from './errors'
import { SerialQueue, withTimeout } from './queue'
import type {
  Capabilities,
  ClientOptions,
  ConnectOptions,
  ControlResult,
  DeviceInfo,
  FtmsEvents,
  RawEvent,
  ReconnectOptions,
} from './types'

const DEVICE_INFORMATION_SERVICE = 0x180a
// Device Information characteristics (Bluetooth assigned numbers): manufacturer, model, hardware, firmware, software.
const DEVICE_INFO_CHARACTERISTICS: Array<[keyof DeviceInfo, number]> = [
  ['manufacturer', 0x2a29],
  ['model', 0x2a24],
  ['hardware', 0x2a27],
  ['firmware', 0x2a26],
  ['software', 0x2a28],
]

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  factor: 2,
}

/** Never let a record that is never completed grow without bound. */
const MAX_PARTIAL_RECORDS = 16

interface Pending {
  op: number
  resolve: (r: ControlResponse) => void
  reject: (e: FtmsError) => void
  timer?: ReturnType<typeof setTimeout>
}

interface Characteristics {
  data: BluetoothRemoteGATTCharacteristic
  controlPoint: BluetoothRemoteGATTCharacteristic | null
  trainingStatus: BluetoothRemoteGATTCharacteristic | null
  machineStatus: BluetoothRemoteGATTCharacteristic | null
}

const isNotFound = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'NotFoundError'

function wrapGatt(e: unknown, what: string): FtmsError {
  if (e instanceof FtmsError) return e
  const msg = e instanceof Error ? e.message : String(e)
  return new FtmsError('GATT_ERROR', `${what} failed: ${msg}`, { cause: e })
}

function errorForResult(resp: ControlResponse): FtmsError {
  const hex = `0x${resp.requestOp.toString(16).padStart(2, '0')}`
  const opts = { resultCode: resp.result }
  switch (resp.result) {
    case ResultCode.OpCodeNotSupported:
      return new FtmsError('NOT_SUPPORTED', `Machine does not support op code ${hex}`, opts)
    case ResultCode.InvalidParameter:
      return new FtmsError('INVALID_PARAMETER', `Machine rejected the parameter for op code ${hex}`, opts)
    case ResultCode.OperationFailed:
      return new FtmsError('OPERATION_FAILED', `Operation failed for op code ${hex}`, opts)
    case ResultCode.ControlNotPermitted:
      return new FtmsError('CONTROL_NOT_PERMITTED', `Control not permitted for op code ${hex}`, opts)
    default:
      return new FtmsError('UNKNOWN_RESULT', `Unknown result code ${resp.result} for op code ${hex}`, opts)
  }
}

/**
 * A connection to a Bluetooth FTMS fitness machine of any type: treadmill, bike, rower, cross trainer,
 * step climber or stair climber. The type is available as `machineType`.
 * Create one with `FtmsClient.connect()` (call it from a user gesture in browsers).
 */
export class FtmsClient extends Emitter<FtmsEvents> {
  /** Ask the browser for a device and connect to it. */
  static async connect(options: ConnectOptions = {}): Promise<FtmsClient> {
    const bluetooth =
      options.bluetooth ?? (globalThis as { navigator?: { bluetooth?: Bluetooth } }).navigator?.bluetooth
    if (!bluetooth) {
      throw new FtmsError(
        'NO_BLUETOOTH',
        'Web Bluetooth is not available here. Use Chrome/Edge over https or localhost, or pass { bluetooth } explicitly.',
      )
    }
    let device: BluetoothDevice
    try {
      device = await bluetooth.requestDevice({
        filters: options.filters ?? [{ services: [FTMS_SERVICE] }],
        optionalServices: [FTMS_SERVICE, DEVICE_INFORMATION_SERVICE, ...(options.optionalServices ?? [])],
      })
    } catch (e) {
      const name = (e as { name?: string } | null)?.name
      if (name === 'NotFoundError') throw new FtmsError('CANCELLED', 'No device was chosen', { cause: e })
      if (name === 'SecurityError' || name === 'NotAllowedError') {
        throw new FtmsError('BLUETOOTH_BLOCKED', `Bluetooth is blocked: ${(e as Error).message}`, {
          cause: e,
        })
      }
      throw wrapGatt(e, 'requestDevice')
    }
    return FtmsClient.fromDevice(device, options)
  }

  /** Connect to a device you already hold (e.g. from `navigator.bluetooth.getDevices()`). */
  static async fromDevice(device: BluetoothDevice, options: ClientOptions = {}): Promise<FtmsClient> {
    const client = new FtmsClient(device, options)
    try {
      await client.#open()
    } catch (e) {
      client.#closed = true
      await client.#dispose({ stopNotifications: false })
      device.removeEventListener('gattserverdisconnected', client.#onLinkLost)
      throw e
    }
    return client
  }

  readonly #device: BluetoothDevice
  readonly #gattTimeoutMs: number
  readonly #commandTimeoutMs: number
  readonly #autoRequestControl: boolean
  readonly #reconnect: Required<ReconnectOptions> | null
  readonly #onRaw: ((event: RawEvent) => void) | undefined
  readonly #queue = new SerialQueue()
  readonly #t0 = Date.now()

  #deviceInfo: DeviceInfo = {}
  #machineType: MachineType = 'treadmill'
  #chars: Characteristics | null = null
  #cleanups: Array<() => void> = []
  #caps: Capabilities = {
    features: null,
    speedRange: null,
    inclinationRange: null,
    resistanceRange: null,
    powerRange: null,
    heartRateRange: null,
    hasControlPoint: false,
    hasTrainingStatus: false,
    hasMachineStatus: false,
    canSetSpeed: false,
    canSetIncline: false,
    canSetResistance: false,
    canSetPower: false,
    canSetHeartRate: false,
    canSimulateBike: false,
  }
  #pending: Pending | null = null
  #hasControl = false
  #ready = false
  #closed = false
  #reconnecting = false
  #partial: MachineData[] = []
  #sleepTimer: ReturnType<typeof setTimeout> | undefined
  #cancelSleep: (() => void) | undefined

  private constructor(device: BluetoothDevice, options: ClientOptions) {
    super()
    this.#device = device
    this.#gattTimeoutMs = options.gattTimeoutMs ?? 10_000
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 5_000
    this.#autoRequestControl = options.autoRequestControl ?? true
    this.#onRaw = options.onRaw
    this.#reconnect =
      options.autoReconnect === true
        ? DEFAULT_RECONNECT
        : options.autoReconnect
          ? { ...DEFAULT_RECONNECT, ...options.autoReconnect }
          : null
    device.addEventListener('gattserverdisconnected', this.#onLinkLost)
  }

  /** The kind of machine, taken from which data characteristic the device exposes. */
  get machineType(): MachineType {
    return this.#machineType
  }
  /** Manufacturer, model and firmware from the Device Information service, if the device has one. */
  get deviceInfo(): DeviceInfo {
    return this.#deviceInfo
  }
  get deviceName(): string {
    return this.#device.name ?? ''
  }
  get deviceId(): string {
    return this.#device.id
  }
  get connected(): boolean {
    return this.#ready && !!this.#device.gatt?.connected
  }
  get capabilities(): Capabilities {
    return this.#caps
  }
  /** Whether this client currently holds control of the machine. */
  get hasControl(): boolean {
    return this.#hasControl
  }

  // ---- Commands -------------------------------------------------------------------------

  requestControl(): Promise<ControlResult> {
    return this.#execute(encodeControl(ControlOp.RequestControl), false)
  }

  /** Reset controllable settings to defaults. Control must be requested again afterwards. */
  reset(): Promise<ControlResult> {
    return this.#execute(encodeControl(ControlOp.Reset), true)
  }

  /** Start or resume the belt. */
  start(): Promise<ControlResult> {
    return this.#execute(encodeControl(ControlOp.StartOrResume), true)
  }

  stop(): Promise<ControlResult> {
    return this.#execute(encodeControl(ControlOp.StopOrPause, { action: 'stop' }), true)
  }

  pause(): Promise<ControlResult> {
    return this.#execute(encodeControl(ControlOp.StopOrPause, { action: 'pause' }), true)
  }

  setSpeed(kmh: number): Promise<ControlResult> {
    return this.#setTarget({
      label: 'speed',
      unit: 'km/h',
      value: kmh,
      supported: (c) => c.canSetSpeed,
      range: (c) => c.speedRange,
      encode: () => encodeControl(ControlOp.SetTargetSpeed, { kmh }),
    })
  }

  setIncline(percent: number): Promise<ControlResult> {
    return this.#setTarget({
      label: 'incline',
      unit: '%',
      value: percent,
      supported: (c) => c.canSetIncline,
      range: (c) => c.inclinationRange,
      encode: () => encodeControl(ControlOp.SetTargetInclination, { percent }),
    })
  }

  /** Resistance level (units as reported by `capabilities.resistanceRange`). Bikes, rowers, cross trainers. */
  setResistance(level: number): Promise<ControlResult> {
    return this.#setTarget({
      label: 'resistance',
      unit: '',
      value: level,
      supported: (c) => c.canSetResistance,
      range: (c) => c.resistanceRange,
      encode: () => encodeControl(ControlOp.SetTargetResistance, { level }),
    })
  }

  /** Target power in watts (ERG mode on bikes). */
  setPower(watts: number): Promise<ControlResult> {
    return this.#setTarget({
      label: 'power',
      unit: 'W',
      value: watts,
      supported: (c) => c.canSetPower,
      range: (c) => c.powerRange,
      encode: () => encodeControl(ControlOp.SetTargetPower, { watts }),
    })
  }

  /** Target heart rate in bpm. */
  setTargetHeartRate(bpm: number): Promise<ControlResult> {
    return this.#setTarget({
      label: 'heart rate',
      unit: 'bpm',
      value: bpm,
      supported: (c) => c.canSetHeartRate,
      range: (c) => c.heartRateRange,
      encode: () => encodeControl(ControlOp.SetTargetHeartRate, { bpm }),
    })
  }

  /** Indoor bike simulation: wind, grade and resistance coefficients. */
  async setIndoorBikeSimulation(params: BikeSimulation): Promise<ControlResult> {
    if (!this.#caps.canSimulateBike) {
      throw new FtmsError('NOT_SUPPORTED', 'Machine does not support indoor bike simulation')
    }
    return this.#execute(
      this.#encode(() => encodeControl(ControlOp.SetIndoorBikeSimulation, params)),
      true,
    )
  }

  /** Stop notifications, remove listeners and disconnect. Safe to call more than once. */
  async disconnect(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#cancelSleep?.()
    await this.#dispose({ stopNotifications: true })
    this.#device.removeEventListener('gattserverdisconnected', this.#onLinkLost)
    this.emit('disconnected', { reason: 'user', willReconnect: false })
  }

  // ---- Connection -----------------------------------------------------------------------

  async #open(): Promise<void> {
    const gatt = this.#device.gatt
    if (!gatt) throw new FtmsError('GATT_ERROR', 'Device has no GATT server')
    const server = await this.#gatt('connect', () => gatt.connect())

    let service: BluetoothRemoteGATTService
    try {
      service = await this.#gatt('getPrimaryService', () => server.getPrimaryService(FTMS_SERVICE))
    } catch (e) {
      if (e instanceof FtmsError && e.code === 'GATT_ERROR' && isNotFound(e.cause)) {
        throw new FtmsError('NO_SERVICE', 'Device does not expose the Fitness Machine service (0x1826)', {
          cause: e,
        })
      }
      throw e
    }

    const find = async (uuid: number): Promise<BluetoothRemoteGATTCharacteristic | null> => {
      try {
        return await this.#gatt(`getCharacteristic 0x${uuid.toString(16)}`, () =>
          service.getCharacteristic(uuid),
        )
      } catch (e) {
        if (e instanceof FtmsError && isNotFound(e.cause)) return null
        throw e
      }
    }

    // The data characteristic identifies the machine type. Prefer the first type that is exposed.
    let data: BluetoothRemoteGATTCharacteristic | null = null
    let machineType: MachineType | null = null
    for (const type of MACHINE_TYPES) {
      data = await find(DATA_CHARACTERISTICS[type])
      if (data) {
        machineType = type
        break
      }
    }
    if (!data || !machineType) {
      throw new FtmsError(
        'UNSUPPORTED_MACHINE',
        'No machine data characteristic found (treadmill, cross trainer, step/stair climber, rower or indoor bike)',
      )
    }
    this.#machineType = machineType

    const [
      feature,
      speedRangeChar,
      inclineRangeChar,
      resistanceRangeChar,
      powerRangeChar,
      hrRangeChar,
      cp,
      training,
      machine,
    ] = [
      await find(CHARACTERISTICS.feature),
      await find(CHARACTERISTICS.supportedSpeedRange),
      await find(CHARACTERISTICS.supportedInclinationRange),
      await find(CHARACTERISTICS.supportedResistanceRange),
      await find(CHARACTERISTICS.supportedPowerRange),
      await find(CHARACTERISTICS.supportedHeartRateRange),
      await find(CHARACTERISTICS.controlPoint),
      await find(CHARACTERISTICS.trainingStatus),
      await find(CHARACTERISTICS.machineStatus),
    ]

    const readRange = (
      char: BluetoothRemoteGATTCharacteristic | null,
      name: RawEvent['characteristic'],
      kind: RangeKind,
    ) => (char ? this.#readParsed(char, name, (b) => parseRange(b, kind)) : Promise.resolve(null))

    const features = feature ? await this.#readParsed(feature, 'feature', parseFeature) : null
    const speedRange = await readRange(speedRangeChar, 'speedRange', 'speed')
    const inclinationRange = await readRange(inclineRangeChar, 'inclinationRange', 'inclination')
    const resistanceRange = await readRange(resistanceRangeChar, 'resistanceRange', 'resistance')
    const powerRange = await readRange(powerRangeChar, 'powerRange', 'power')
    const heartRateRange = await readRange(hrRangeChar, 'heartRateRange', 'heartRate')

    // If the feature read failed we cannot know, so do not refuse up front: let the device answer.
    const can = (target: keyof NonNullable<typeof features>['targets']) =>
      cp !== null && (features ? features.targets[target] : true)
    this.#caps = {
      features,
      speedRange,
      inclinationRange,
      resistanceRange,
      powerRange,
      heartRateRange,
      hasControlPoint: cp !== null,
      hasTrainingStatus: training !== null,
      hasMachineStatus: machine !== null,
      canSetSpeed: can('speed'),
      canSetIncline: can('inclination'),
      canSetResistance: can('resistance'),
      canSetPower: can('power'),
      canSetHeartRate: can('heartRate'),
      canSimulateBike: can('indoorBikeSimulation'),
    }
    this.#chars = { data, controlPoint: cp, trainingStatus: training, machineStatus: machine }

    this.#deviceInfo = await this.#readDeviceInfo(server)

    // The control point must be subscribed first so no response can be missed.
    if (cp) await this.#subscribe(cp, this.#onControlPoint)
    if (machine) await this.#subscribe(machine, this.#onMachineStatus)
    if (training) await this.#subscribe(training, this.#onTrainingStatus)
    await this.#subscribe(data, this.#onData)

    this.#hasControl = false
    this.#ready = true
  }

  /** Best effort: a missing service or a failed read never fails the connection. */
  async #readDeviceInfo(server: BluetoothRemoteGATTServer): Promise<DeviceInfo> {
    const info: DeviceInfo = {}
    try {
      const service = await this.#gatt('getPrimaryService device information', () =>
        server.getPrimaryService(DEVICE_INFORMATION_SERVICE),
      )
      for (const [key, uuid] of DEVICE_INFO_CHARACTERISTICS) {
        try {
          const char = await this.#gatt(`getCharacteristic 0x${uuid.toString(16)}`, () =>
            service.getCharacteristic(uuid),
          )
          const view = await this.#gatt(`read device info ${key}`, () => char.readValue())
          const text = new TextDecoder('utf-8').decode(view).replace(/\0+$/, '').trim()
          if (text) info[key] = text
        } catch {
          /* this field is simply not available */
        }
      }
    } catch {
      /* no Device Information service */
    }
    return info
  }

  async #subscribe(char: BluetoothRemoteGATTCharacteristic, handler: (e: Event) => void): Promise<void> {
    char.addEventListener('characteristicvaluechanged', handler)
    this.#cleanups.push(() => char.removeEventListener('characteristicvaluechanged', handler))
    await this.#gatt('startNotifications', () => char.startNotifications())
  }

  async #readParsed<T>(
    char: BluetoothRemoteGATTCharacteristic,
    name: RawEvent['characteristic'],
    parse: (b: Uint8Array) => { ok: true; value: T } | { ok: false },
  ): Promise<T | null> {
    const view = await this.#gatt(`read ${name}`, () => char.readValue())
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
    this.#emitRaw(name, 'read', bytes)
    const r = parse(bytes)
    return r.ok ? r.value : null
  }

  /** Remove characteristic listeners (and optionally stop notifications), then drop the link. */
  async #dispose(opts: { stopNotifications: boolean }): Promise<void> {
    this.#rejectPending(new FtmsError('DISCONNECTED', 'Disconnected'))
    const chars = this.#chars
    if (opts.stopNotifications && chars && this.#device.gatt?.connected) {
      const subscribed = [chars.controlPoint, chars.machineStatus, chars.trainingStatus, chars.data]
      await Promise.allSettled(
        subscribed.map((c) => (c ? this.#gatt('stopNotifications', () => c.stopNotifications()) : undefined)),
      )
    }
    this.#detach()
    this.#ready = false
    this.#hasControl = false
    this.#partial = []
    if (this.#device.gatt?.connected) this.#device.gatt.disconnect()
  }

  #detach(): void {
    for (const fn of this.#cleanups.splice(0)) fn()
    this.#chars = null
  }

  /** One serialized, time-limited GATT operation. */
  #gatt<T>(what: string, op: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      try {
        return await withTimeout(
          op(),
          this.#gattTimeoutMs,
          () => new FtmsError('TIMEOUT', `GATT ${what} timed out`),
        )
      } catch (e) {
        throw wrapGatt(e, what)
      }
    })
  }

  // ---- Link loss and reconnect ----------------------------------------------------------

  #onLinkLost = (): void => {
    if (this.#closed || this.#reconnecting) return
    this.#ready = false
    this.#hasControl = false
    this.#partial = []
    this.#rejectPending(new FtmsError('DISCONNECTED', 'Device disconnected'))
    this.#detach()
    const willReconnect = this.#reconnect !== null
    this.emit('disconnected', { reason: 'link-lost', willReconnect })
    if (willReconnect) void this.#reconnectLoop()
  }

  async #reconnectLoop(): Promise<void> {
    const o = this.#reconnect
    if (!o) return
    this.#reconnecting = true
    try {
      for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
        const delayMs = Math.min(o.maxDelayMs, o.initialDelayMs * o.factor ** (attempt - 1))
        this.emit('reconnecting', { attempt, delayMs })
        await this.#sleep(delayMs)
        if (this.#closed) return
        try {
          await this.#open()
          this.emit('reconnected', undefined)
          return
        } catch (e) {
          this.#detach()
          this.#ready = false
          try {
            this.#device.gatt?.disconnect()
          } catch {
            /* already down */
          }
          if (this.#closed) return
          this.emit('error', wrapGatt(e, 'reconnect'))
        }
      }
      this.emit('disconnected', { reason: 'reconnect-failed', willReconnect: false })
    } finally {
      this.#reconnecting = false
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#cancelSleep = () => {
        clearTimeout(this.#sleepTimer)
        resolve()
      }
      this.#sleepTimer = setTimeout(resolve, ms)
    })
  }

  // ---- Control point --------------------------------------------------------------------

  /**
   * Shared path of the targets that have a supported range: refuse a target the machine does not offer,
   * refuse a value outside its advertised range, then encode and send it. Nothing is written on a refusal.
   */
  async #setTarget(t: {
    /** Name used in error messages, e.g. "speed". */
    label: string
    unit: string
    value: number
    supported: (caps: Capabilities) => boolean
    range: (caps: Capabilities) => Range | null
    encode: () => Uint8Array
  }): Promise<ControlResult> {
    if (!t.supported(this.#caps)) {
      throw new FtmsError('NOT_SUPPORTED', `Machine does not support ${t.label} targets`)
    }
    this.#checkRange(t.label, t.value, t.range(this.#caps), t.unit)
    return this.#execute(this.#encode(t.encode), true)
  }

  #encode(build: () => Uint8Array): Uint8Array {
    try {
      return build()
    } catch (e) {
      throw new FtmsError('INVALID_PARAMETER', e instanceof Error ? e.message : String(e), { cause: e })
    }
  }

  #checkRange(what: string, value: number, range: Range | null, unit: string): void {
    if (!Number.isFinite(value)) throw new FtmsError('INVALID_PARAMETER', `${what} must be a finite number`)
    if (range && (value < range.min - 1e-9 || value > range.max + 1e-9)) {
      throw new FtmsError(
        'INVALID_PARAMETER',
        `${what} ${value} ${unit} is outside the supported range ${range.min} to ${range.max} ${unit}`,
      )
    }
  }

  #execute(bytes: Uint8Array, needsControl: boolean): Promise<ControlResult> {
    return this.#queue.run(async () => {
      if (!this.connected) throw new FtmsError('NOT_CONNECTED', 'Not connected')
      if (!this.#chars?.controlPoint) throw new FtmsError('NOT_SUPPORTED', 'Machine has no control point')
      const op = bytes[0]
      if (needsControl && this.#autoRequestControl && !this.#hasControl) await this.#grabControl()

      let resp = await this.#exchange(bytes)
      if (resp.result === ResultCode.ControlNotPermitted && needsControl && this.#autoRequestControl) {
        // Control was lost (another client, a reset, the console). Ask again and retry once.
        this.#hasControl = false
        await this.#grabControl()
        resp = await this.#exchange(bytes)
      }
      if (resp.result !== ResultCode.Success) throw errorForResult(resp)

      if (op === ControlOp.RequestControl) this.#hasControl = true
      if (op === ControlOp.Reset) this.#hasControl = false
      return { requestOp: resp.requestOp, result: resp.result, params: resp.params }
    })
  }

  async #grabControl(): Promise<void> {
    const resp = await this.#exchange(encodeControl(ControlOp.RequestControl))
    if (resp.result !== ResultCode.Success) throw errorForResult(resp)
    this.#hasControl = true
  }

  /** Write one command and wait for its response indication. Must run inside the queue. */
  async #exchange(bytes: Uint8Array): Promise<ControlResponse> {
    const cp = this.#chars?.controlPoint
    if (!cp) throw new FtmsError('NOT_CONNECTED', 'Not connected')

    // Register before writing: some devices indicate before the write promise resolves.
    const pending = {} as Pending
    const response = new Promise<ControlResponse>((resolve, reject) => {
      Object.assign(pending, { op: bytes[0], resolve, reject })
    })
    response.catch(() => undefined)
    this.#pending = pending

    this.#emitRaw('controlPoint', 'out', bytes)
    try {
      await withTimeout(
        typeof cp.writeValueWithResponse === 'function'
          ? cp.writeValueWithResponse(bytes as BufferSource)
          : cp.writeValue(bytes as BufferSource),
        this.#gattTimeoutMs,
        () => new FtmsError('TIMEOUT', 'Control point write timed out'),
      )
    } catch (e) {
      if (this.#pending === pending) this.#pending = null
      throw wrapGatt(e, 'control point write')
    }

    // The procedure starts when the write completes (spec §4.16.4); time the response from here.
    if (this.#pending === pending) {
      pending.timer = setTimeout(() => {
        if (this.#pending !== pending) return
        this.#pending = null
        pending.reject(
          new FtmsError(
            'TIMEOUT',
            `No response to op code 0x${bytes[0].toString(16)} within ${this.#commandTimeoutMs} ms`,
          ),
        )
      }, this.#commandTimeoutMs)
    }
    return response
  }

  #rejectPending(error: FtmsError): void {
    const p = this.#pending
    if (!p) return
    this.#pending = null
    clearTimeout(p.timer)
    p.reject(error)
  }

  // ---- Notification handlers ------------------------------------------------------------

  #bytesOf(e: Event): Uint8Array | null {
    const view = (e.target as BluetoothRemoteGATTCharacteristic | null)?.value
    return view ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice() : null
  }

  #emitRaw(
    characteristic: RawEvent['characteristic'],
    direction: RawEvent['direction'],
    bytes: Uint8Array,
  ): void {
    const event: RawEvent = { t: Date.now() - this.#t0, characteristic, direction, bytes: bytes.slice() }
    try {
      this.#onRaw?.(event)
    } catch (e) {
      queueMicrotask(() => {
        throw e
      })
    }
    this.emit('raw', event)
  }

  #parseFailure(what: string, message: string): void {
    this.emit('error', new FtmsError('PARSE_ERROR', `Could not parse ${what}: ${message}`))
  }

  #onData = (e: Event): void => {
    const bytes = this.#bytesOf(e)
    if (!bytes) return
    this.#emitRaw('machineData', 'in', bytes)
    const r = parseMachineData(this.#machineType, bytes)
    if (!r.ok) return this.#parseFailure(`${this.#machineType} data`, r.error.message)
    this.#partial.push(r.value)
    if (r.value.moreData) {
      if (this.#partial.length > MAX_PARTIAL_RECORDS) this.#partial.shift()
      return
    }
    const record = this.#partial.length === 1 ? r.value : mergeMachineData(this.#partial)
    this.#partial = []
    this.emit('data', record)
  }

  #onTrainingStatus = (e: Event): void => {
    const bytes = this.#bytesOf(e)
    if (!bytes) return
    this.#emitRaw('trainingStatus', 'in', bytes)
    const r = parseTrainingStatus(bytes)
    if (!r.ok) return this.#parseFailure('training status', r.error.message)
    this.emit('trainingStatus', r.value)
  }

  #onMachineStatus = (e: Event): void => {
    const bytes = this.#bytesOf(e)
    if (!bytes) return
    this.#emitRaw('machineStatus', 'in', bytes)
    const r = parseMachineStatus(bytes)
    if (!r.ok) return this.#parseFailure('machine status', r.error.message)
    if (r.value.kind === 'controlPermissionLost') this.#hasControl = false
    this.emit('status', r.value)
  }

  #onControlPoint = (e: Event): void => {
    const bytes = this.#bytesOf(e)
    if (!bytes) return
    this.#emitRaw('controlPoint', 'in', bytes)
    const r = parseControlResponse(bytes)
    if (!r.ok) return this.#parseFailure('control point response', r.error.message)
    const p = this.#pending
    if (p && p.op === r.value.requestOp) {
      this.#pending = null
      clearTimeout(p.timer)
      p.resolve(r.value)
    }
  }
}
