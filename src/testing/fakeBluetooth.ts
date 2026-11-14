// A small in-memory Web Bluetooth implementation for tests and demos. It implements just the
// surface FtmsClient uses, and rejects overlapping GATT operations like Chrome does.

type Handler = (event: Event) => void

class Listeners {
  readonly #map = new Map<string, Set<Handler>>()
  add(type: string, fn: Handler): void {
    let set = this.#map.get(type)
    if (!set) this.#map.set(type, (set = new Set()))
    set.add(fn)
  }
  remove(type: string, fn: Handler): void {
    this.#map.get(type)?.delete(fn)
  }
  count(type: string): number {
    return this.#map.get(type)?.size ?? 0
  }
  dispatch(type: string, target: unknown): void {
    const event = { type, target } as unknown as Event
    for (const fn of [...(this.#map.get(type) ?? [])]) fn(event)
  }
}

export const normalizeUuid = (uuid: number | string): string =>
  typeof uuid === 'number'
    ? `0000${uuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`
    : uuid.toLowerCase()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const domError = (message: string, name: string) => new DOMException(message, name)

export interface CharacteristicInit {
  uuid: number
  /** Value returned by readValue(). */
  value?: Uint8Array
  /** Called for writes; may throw to simulate an ATT error. */
  onWrite?: (bytes: Uint8Array) => void
}

export class FakeCharacteristic {
  readonly uuid: string
  value: DataView | undefined
  isNotifying = false
  startNotificationsCalls = 0
  stopNotificationsCalls = 0
  readonly #listeners = new Listeners()
  readonly #onWrite?: (bytes: Uint8Array) => void

  constructor(
    readonly service: FakeService,
    init: CharacteristicInit,
  ) {
    this.uuid = normalizeUuid(init.uuid)
    this.#onWrite = init.onWrite
    if (init.value) this.value = new DataView(init.value.slice().buffer)
  }

  addEventListener(type: string, fn: Handler): void {
    this.#listeners.add(type, fn)
  }
  removeEventListener(type: string, fn: Handler): void {
    this.#listeners.remove(type, fn)
  }
  listenerCount(type = 'characteristicvaluechanged'): number {
    return this.#listeners.count(type)
  }

  /** Set the readable value (used by readValue). */
  setReadValue(bytes: Uint8Array): void {
    this.value = new DataView(bytes.slice().buffer)
  }

  /** Deliver a notification/indication to subscribers. Dropped if nobody enabled notifications. */
  emitValue(bytes: Uint8Array): void {
    if (!this.isNotifying) return
    this.value = new DataView(bytes.slice().buffer)
    this.#listeners.dispatch('characteristicvaluechanged', this)
  }

  readValue(): Promise<DataView> {
    return this.#op(async () => {
      if (!this.value) throw domError('Read not permitted', 'NotSupportedError')
      return this.value
    })
  }

  writeValueWithResponse(data: BufferSource): Promise<void> {
    const bytes = toBytes(data)
    return this.#op(async () => {
      this.#onWrite?.(bytes)
    })
  }

  writeValue(data: BufferSource): Promise<void> {
    return this.writeValueWithResponse(data)
  }

  startNotifications(): Promise<FakeCharacteristic> {
    return this.#op(async () => {
      this.startNotificationsCalls++
      this.isNotifying = true
      return this
    })
  }

  stopNotifications(): Promise<FakeCharacteristic> {
    return this.#op(async () => {
      this.stopNotificationsCalls++
      this.isNotifying = false
      return this
    })
  }

  async #op<T>(body: () => Promise<T>): Promise<T> {
    const device = this.service.server.device
    device.beginOp()
    try {
      await sleep(device.latencyMs)
      if (!this.service.server.connected) throw domError('GATT Server is disconnected.', 'NetworkError')
      return await body()
    } finally {
      device.endOp()
    }
  }
}

function toBytes(data: BufferSource): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data.slice(0))
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
}

export class FakeService {
  readonly uuid: string
  readonly characteristics = new Map<string, FakeCharacteristic>()

  constructor(
    readonly server: FakeGattServer,
    uuid: number,
  ) {
    this.uuid = normalizeUuid(uuid)
  }

  addCharacteristic(init: CharacteristicInit): FakeCharacteristic {
    const c = new FakeCharacteristic(this, init)
    this.characteristics.set(c.uuid, c)
    return c
  }

  getCharacteristic(uuid: number | string): Promise<FakeCharacteristic> {
    return this.server.device.guard(async () => {
      const c = this.characteristics.get(normalizeUuid(uuid))
      if (!c) throw domError('No Characteristics matching UUID found in Service.', 'NotFoundError')
      return c
    })
  }
}

export class FakeGattServer {
  connected = false
  readonly services = new Map<string, FakeService>()

  constructor(readonly device: FakeDevice) {}

  addService(uuid: number): FakeService {
    const s = new FakeService(this, uuid)
    this.services.set(s.uuid, s)
    return s
  }

  async connect(): Promise<FakeGattServer> {
    const d = this.device
    d.connectCalls++
    await sleep(d.latencyMs)
    if (d.failNextConnects > 0) {
      d.failNextConnects--
      throw domError('Connection attempt failed.', 'NetworkError')
    }
    this.connected = true
    return this
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.device.dropNotifications()
    this.device.dispatchDisconnected()
  }

  getPrimaryService(uuid: number | string): Promise<FakeService> {
    return this.device.guard(async () => {
      if (!this.connected) throw domError('GATT Server is disconnected.', 'NetworkError')
      const s = this.services.get(normalizeUuid(uuid))
      if (!s) throw domError('No Services matching UUID found in Device.', 'NotFoundError')
      return s
    })
  }
}

export class FakeDevice {
  readonly id: string
  readonly gatt: FakeGattServer
  /** Simulated latency of every GATT operation. */
  latencyMs = 1
  /** Number of upcoming gatt.connect() calls that should fail. */
  failNextConnects = 0
  connectCalls = 0
  /** How many times two GATT operations overlapped (Chrome rejects these). Should stay 0. */
  overlaps = 0
  #busy = 0
  readonly #listeners = new Listeners()

  constructor(
    readonly name: string,
    id = 'fake-device-1',
  ) {
    this.id = id
    this.gatt = new FakeGattServer(this)
  }

  addEventListener(type: string, fn: Handler): void {
    this.#listeners.add(type, fn)
  }
  removeEventListener(type: string, fn: Handler): void {
    this.#listeners.remove(type, fn)
  }
  listenerCount(type = 'gattserverdisconnected'): number {
    return this.#listeners.count(type)
  }

  beginOp(): void {
    if (this.#busy > 0) {
      this.overlaps++
      throw domError('GATT operation already in progress.', 'NetworkError')
    }
    this.#busy++
  }
  endOp(): void {
    this.#busy = Math.max(0, this.#busy - 1)
  }
  async guard<T>(body: () => Promise<T>): Promise<T> {
    this.beginOp()
    try {
      await sleep(this.latencyMs)
      return await body()
    } finally {
      this.endOp()
    }
  }

  dropNotifications(): void {
    for (const s of this.gatt.services.values())
      for (const c of s.characteristics.values()) c.isNotifying = false
  }
  dispatchDisconnected(): void {
    this.#listeners.dispatch('gattserverdisconnected', this)
  }

  /** Simulate walking out of range or the machine powering off. */
  simulateLinkLoss(): void {
    this.gatt.disconnect()
  }
}

export interface RequestDeviceCall {
  filters?: BluetoothLEScanFilter[]
  optionalServices?: BluetoothServiceUUID[]
}

export class FakeBluetooth {
  readonly requests: RequestDeviceCall[] = []
  /** Set to make requestDevice reject (e.g. a NotFoundError for "user cancelled"). */
  rejectWith: Error | null = null

  constructor(readonly device: FakeDevice) {}

  async requestDevice(options: RequestDeviceCall): Promise<FakeDevice> {
    this.requests.push(options)
    if (this.rejectWith) throw this.rejectWith
    return this.device
  }
}
