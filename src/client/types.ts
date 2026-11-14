import type { Features, MachineData, MachineStatus, Range, TrainingStatus } from '../core'
import type { FtmsError } from './errors'

export interface Capabilities {
  /** Parsed Fitness Machine Feature, or null if the device did not expose/answer it. */
  features: Features | null
  speedRange: Range | null
  inclinationRange: Range | null
  resistanceRange: Range | null
  powerRange: Range | null
  heartRateRange: Range | null
  hasControlPoint: boolean
  hasTrainingStatus: boolean
  hasMachineStatus: boolean
  /** True when speed targets are supported (or unknown, because the feature read failed). */
  canSetSpeed: boolean
  canSetIncline: boolean
  canSetResistance: boolean
  canSetPower: boolean
  canSetHeartRate: boolean
  canSimulateBike: boolean
}

/** Every GATT payload the client sees, for logging, debugging and recording captures. */
export interface RawEvent {
  /** Milliseconds since the client was created. */
  t: number
  characteristic:
    | 'feature'
    | 'machineData'
    | 'trainingStatus'
    | 'machineStatus'
    | 'controlPoint'
    | 'speedRange'
    | 'inclinationRange'
    | 'resistanceRange'
    | 'powerRange'
    | 'heartRateRange'
  /** `in` = notification/indication, `out` = write, `read` = explicit read. */
  direction: 'in' | 'out' | 'read'
  bytes: Uint8Array
}

export type DisconnectReason = 'user' | 'link-lost' | 'reconnect-failed'

export interface FtmsEvents {
  /** A complete data record. Narrow on `data.type` (or `client.machineType`). */
  data: MachineData
  status: MachineStatus
  trainingStatus: TrainingStatus
  disconnected: { reason: DisconnectReason; willReconnect: boolean }
  reconnecting: { attempt: number; delayMs: number }
  reconnected: undefined
  error: FtmsError
  raw: RawEvent
}

export interface ReconnectOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  factor?: number
}

/** Identification read from the optional Device Information service (0x180A), when the device has one. */
export interface DeviceInfo {
  manufacturer?: string
  model?: string
  firmware?: string
  hardware?: string
  software?: string
}

export interface ClientOptions {
  /**
   * Called synchronously for every payload, including the reads made while connecting (feature,
   * ranges), which happen before you can attach an `on('raw')` listener. Use it to record captures.
   */
  onRaw?: (event: RawEvent) => void
  /** Timeout for each GATT operation (connect, discovery, reads, subscribe). Default 10000. */
  gattTimeoutMs?: number
  /** Timeout waiting for a Control Point response indication. Default 5000. */
  commandTimeoutMs?: number
  /** Request control automatically before the first command, and again if it is lost. Default true. */
  autoRequestControl?: boolean
  /** Reconnect with exponential backoff after a link loss. Default false. */
  autoReconnect?: boolean | ReconnectOptions
}

export interface ConnectOptions extends ClientOptions {
  /** Defaults to `globalThis.navigator?.bluetooth`. Inject one to run outside a browser. */
  bluetooth?: Bluetooth
  /** Defaults to `[{ services: [0x1826] }]`. */
  filters?: BluetoothLEScanFilter[]
  /** Extra optional services. The Fitness Machine service is always included. */
  optionalServices?: BluetoothServiceUUID[]
}

export interface ControlResult {
  requestOp: number
  result: number
  params: Uint8Array
}
