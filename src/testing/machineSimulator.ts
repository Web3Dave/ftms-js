import { CHARACTERISTICS, ControlOp, DATA_CHARACTERISTICS, FTMS_SERVICE, ResultCode } from '../core/constants'
import { MACHINE_LABELS } from '../core/labels'
import { encodeMachineData, type MachineType } from '../core/machineData'
import { FakeBluetooth, FakeDevice, type FakeCharacteristic } from './fakeBluetooth'

export interface RangeInit {
  min: number
  max: number
  step: number
}

export interface SimulatorOptions {
  /** Which machine to simulate. */
  type: MachineType
  name?: string
  /** Latency of every GATT operation. Default 1 ms. */
  latencyMs?: number
  /** Interval for startClock(). Default 1000 ms. */
  tickMs?: number
  /** Delay before a control point indication is sent. Default 1 ms. */
  responseDelayMs?: number
  /** Override the feature bit fields (what the Feature characteristic reports). */
  features?: { machine?: number; targets?: number }
  speedRange?: RangeInit
  inclinationRange?: RangeInit
  resistanceRange?: RangeInit
  powerRange?: RangeInit
  /** Omit the control point (read-only machine). */
  controlPoint?: boolean
  trainingStatus?: boolean
  machineStatus?: boolean
  /** Force a result for an op code, or 'silent' to never answer (to test timeouts). */
  responses?: Record<number, number | 'silent'>
  /** Send each data record as two notifications using the More Data bit. */
  splitRecords?: boolean
  /** Send resistance level as 16 bits, like a Domyos rower does (the GSS says 8 bits). */
  wideResistance?: boolean
  /** Add a Device Information service with these strings. */
  deviceInfo?: {
    manufacturer?: string
    model?: string
    firmware?: string
    hardware?: string
    software?: string
  }
  /**
   * Imitate a machine that, after a Stop, shows a post-workout summary for this many milliseconds
   * (Training Status `postWorkout`, then `idle`). Start commands received meanwhile are acknowledged
   * with success but ignored, like the Urevo Strol 2E does.
   */
  postWorkoutMs?: number
  /** Refuse to grant control (Request Control returns Control Not Permitted). */
  denyControl?: boolean
}

export interface BikeSimState {
  windSpeedMps: number
  gradePercent: number
  crr: number
  cw: number
}

// Fitness Machine Feature bits (spec Table 4.3) and Target Setting bits (Table 4.4).
const M = {
  cadence: 1,
  distance: 2,
  inclination: 3,
  stepCount: 6,
  resistance: 7,
  stride: 8,
  energy: 9,
  hr: 10,
  elapsed: 12,
  power: 14,
}
const T = { speed: 0, incline: 1, resistance: 2, power: 3, bikeSim: 13 }
const bits = (...n: number[]) => n.reduce((a, b) => a | (1 << b), 0)

interface Profile {
  machineFeatures: number
  targets: number
  speed: boolean
  incline: boolean
  resistance: boolean
  power: boolean
  bikeSim: boolean
  /** Nominal energy burn at full activity, kcal per hour. */
  kcalPerHour: number
}

const PROFILES: Record<MachineType, Profile> = {
  treadmill: {
    machineFeatures: bits(M.distance, M.inclination, M.energy, M.elapsed),
    targets: bits(T.speed, T.incline),
    speed: true,
    incline: true,
    resistance: false,
    power: false,
    bikeSim: false,
    kcalPerHour: 0,
  },
  crossTrainer: {
    machineFeatures: bits(
      M.distance,
      M.stepCount,
      M.stride,
      M.inclination,
      M.resistance,
      M.power,
      M.energy,
      M.hr,
      M.elapsed,
    ),
    targets: bits(T.incline, T.resistance),
    speed: false,
    incline: true,
    resistance: true,
    power: false,
    bikeSim: false,
    kcalPerHour: 450,
  },
  stepClimber: {
    machineFeatures: bits(M.stepCount, M.energy, M.hr, M.elapsed),
    targets: 0,
    speed: false,
    incline: false,
    resistance: false,
    power: false,
    bikeSim: false,
    kcalPerHour: 500,
  },
  stairClimber: {
    machineFeatures: bits(M.stepCount, M.stride, M.energy, M.hr, M.elapsed),
    targets: 0,
    speed: false,
    incline: false,
    resistance: false,
    power: false,
    bikeSim: false,
    kcalPerHour: 550,
  },
  rower: {
    machineFeatures: bits(M.cadence, M.distance, M.resistance, M.power, M.energy, M.hr, M.elapsed),
    targets: bits(T.resistance),
    speed: false,
    incline: false,
    resistance: true,
    power: false,
    bikeSim: false,
    kcalPerHour: 500,
  },
  indoorBike: {
    machineFeatures: bits(M.cadence, M.distance, M.resistance, M.power, M.energy, M.hr, M.elapsed),
    targets: bits(T.resistance, T.power, T.bikeSim),
    speed: false,
    incline: false,
    resistance: true,
    power: true,
    bikeSim: true,
    kcalPerHour: 400,
  },
}

const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const approach = (v: number, target: number, maxDelta: number) =>
  target > v ? Math.min(target, v + maxDelta) : Math.max(target, v - maxDelta)

/**
 * An in-memory fitness machine speaking FTMS over the fake Bluetooth objects, for any machine
 * type. Use it in tests, and in demos to develop without hardware. Call `tick()` manually, or
 * `startClock()` for a live feed.
 */
export class SimulatedMachine {
  readonly type: MachineType
  readonly device: FakeDevice
  readonly fake: FakeBluetooth
  /** Typed as the real Web Bluetooth interface, ready to pass as `{ bluetooth }`. */
  readonly bluetooth: Bluetooth
  /** Every control point write received, in order. */
  readonly writes: Uint8Array[] = []

  running = false
  paused = false
  hasControl = false
  /** 0..1: how "active" the machine is (ramps up after start, down after stop). */
  activity = 0

  speedKmh = 0
  /** Target belt speed (treadmill). */
  targetKmh = 0
  inclinePct = 0
  distanceM = 0
  elapsedS = 0
  energyKcal = 0
  heartRate = 70
  resistance = 0
  /** Target power in watts (ERG), or null. */
  targetPower: number | null = null
  power = 0
  cadenceRpm = 0
  strokeRate = 0
  strokeCount = 0
  stepsPerMinute = 0
  stepCount = 0
  floors = 0
  strideCount = 0
  bikeSim: BikeSimState = { windSpeedMps: 0, gradePercent: 0, crr: 0.004, cw: 0.51 }

  readonly options: SimulatorOptions
  readonly profile: Profile
  readonly speedRange: RangeInit
  readonly inclinationRange: RangeInit
  readonly resistanceRange: RangeInit
  readonly powerRange: RangeInit

  readonly #cp: FakeCharacteristic | null
  readonly #data: FakeCharacteristic
  readonly #training: FakeCharacteristic | null
  readonly #machine: FakeCharacteristic | null
  #clock: ReturnType<typeof setInterval> | undefined
  #postWorkoutUntil = 0

  constructor(options: SimulatorOptions) {
    this.options = options
    this.type = options.type
    this.profile = PROFILES[this.type]
    this.speedRange = options.speedRange ?? { min: 1, max: 6, step: 0.1 }
    this.inclinationRange = options.inclinationRange ?? { min: 0, max: 10, step: 1 }
    this.resistanceRange = options.resistanceRange ?? { min: 0, max: 20, step: 1 }
    this.powerRange = options.powerRange ?? { min: 0, max: 1000, step: 5 }

    this.device = new FakeDevice(options.name ?? `Simulated ${MACHINE_LABELS[this.type]}`)
    this.device.latencyMs = options.latencyMs ?? 1
    const service = this.device.gatt.addService(FTMS_SERVICE)
    const p = this.profile

    const feature = new Uint8Array(8)
    new DataView(feature.buffer).setUint32(0, options.features?.machine ?? p.machineFeatures, true)
    new DataView(feature.buffer).setUint32(4, options.features?.targets ?? p.targets, true)
    service.addCharacteristic({ uuid: CHARACTERISTICS.feature, value: feature })

    if (p.speed) {
      const r = this.speedRange
      service.addCharacteristic({
        uuid: CHARACTERISTICS.supportedSpeedRange,
        value: Uint8Array.of(
          ...le16(Math.round(r.min * 100)),
          ...le16(Math.round(r.max * 100)),
          ...le16(Math.round(r.step * 100)),
        ),
      })
    }
    if (p.incline) {
      const r = this.inclinationRange
      service.addCharacteristic({
        uuid: CHARACTERISTICS.supportedInclinationRange,
        value: Uint8Array.of(
          ...le16(Math.round(r.min * 10) & 0xffff),
          ...le16(Math.round(r.max * 10) & 0xffff),
          ...le16(Math.round(r.step * 10)),
        ),
      })
    }
    if (p.resistance) {
      const r = this.resistanceRange
      service.addCharacteristic({
        uuid: CHARACTERISTICS.supportedResistanceRange,
        // Scale 0.1 like the Control Point; 16-bit values when imitating the Domyos.
        value: options.wideResistance
          ? Uint8Array.of(
              ...le16(Math.round(r.min * 10)),
              ...le16(Math.round(r.max * 10)),
              ...le16(Math.round(r.step * 10)),
            )
          : Uint8Array.of(Math.round(r.min * 10), Math.round(r.max * 10), Math.round(r.step * 10)),
      })
    }
    if (p.power) {
      const r = this.powerRange
      service.addCharacteristic({
        uuid: CHARACTERISTICS.supportedPowerRange,
        value: Uint8Array.of(...le16(r.min & 0xffff), ...le16(r.max & 0xffff), ...le16(r.step)),
      })
    }

    if (options.deviceInfo) {
      const info = this.device.gatt.addService(0x180a)
      const enc = (v: string) => new TextEncoder().encode(v)
      const d = options.deviceInfo
      if (d.manufacturer) info.addCharacteristic({ uuid: 0x2a29, value: enc(d.manufacturer) })
      if (d.model) info.addCharacteristic({ uuid: 0x2a24, value: enc(d.model) })
      if (d.hardware) info.addCharacteristic({ uuid: 0x2a27, value: enc(d.hardware) })
      if (d.firmware) info.addCharacteristic({ uuid: 0x2a26, value: enc(d.firmware) })
      if (d.software) info.addCharacteristic({ uuid: 0x2a28, value: enc(d.software) })
    }

    this.#data = service.addCharacteristic({ uuid: DATA_CHARACTERISTICS[this.type] })
    this.#training =
      options.trainingStatus === false
        ? null
        : service.addCharacteristic({ uuid: CHARACTERISTICS.trainingStatus, value: Uint8Array.of(0, 0x01) })
    this.#machine =
      options.machineStatus === false
        ? null
        : service.addCharacteristic({ uuid: CHARACTERISTICS.machineStatus })
    this.#cp =
      options.controlPoint === false
        ? null
        : service.addCharacteristic({
            uuid: CHARACTERISTICS.controlPoint,
            onWrite: (b) => this.#onControlWrite(b),
          })

    this.fake = new FakeBluetooth(this.device)
    this.bluetooth = this.fake as unknown as Bluetooth
  }

  /** Characteristic accessors for assertions. */
  get characteristics() {
    return {
      data: this.#data,
      controlPoint: this.#cp,
      trainingStatus: this.#training,
      machineStatus: this.#machine,
    }
  }

  // ---- Simulation ---------------------------------------------------------------------

  /** Advance the simulation by `dtSeconds` and notify a data record. */
  tick(dtSeconds = 1): void {
    const active = this.running && !this.paused
    this.activity = approach(this.activity, active ? 1 : 0, (active ? 0.5 : 1) * dtSeconds)
    if (active) this.elapsedS += dtSeconds
    this.#physics(dtSeconds)
    this.distanceM += (this.speedKmh / 3.6) * dtSeconds
    if (this.type !== 'treadmill') {
      this.energyKcal += (this.activity * this.profile.kcalPerHour * dtSeconds) / 3600
      this.heartRate = approach(this.heartRate, 70 + 75 * this.activity, 5 * dtSeconds)
    } else {
      this.energyKcal += ((this.speedKmh * 20) / 3600) * dtSeconds
    }
    this.notifyData()
  }

  #physics(dt: number): void {
    const a = this.activity
    switch (this.type) {
      case 'treadmill': {
        const target = this.running && !this.paused ? this.targetKmh : 0
        this.speedKmh = approach(this.speedKmh, target, (target > this.speedKmh ? 0.5 : 1) * dt)
        break
      }
      case 'indoorBike': {
        this.cadenceRpm = 85 * a
        this.power =
          this.targetPower !== null ? this.targetPower * a : this.cadenceRpm * (1.2 + this.resistance * 0.25)
        const grade = this.bikeSim.gradePercent
        this.speedKmh = Math.max(
          0,
          3.6 * Math.cbrt(Math.max(this.power, 0) / 0.4) * (1 - clamp(grade, -10, 20) * 0.03),
        )
        break
      }
      case 'rower': {
        this.strokeRate = 24 * a
        this.strokeCount += (this.strokeRate / 60) * dt
        this.power = a * (70 + this.resistance * 12)
        this.speedKmh = 3.6 * Math.cbrt(this.power / 2.8)
        break
      }
      case 'crossTrainer': {
        this.stepsPerMinute = 120 * a
        this.strideCount += (this.stepsPerMinute / 2 / 60) * dt
        this.power = a * (40 + this.resistance * 8)
        this.speedKmh = 7 * a
        break
      }
      case 'stepClimber':
      case 'stairClimber': {
        this.stepsPerMinute = (this.type === 'stepClimber' ? 60 : 70) * a
        this.stepCount += (this.stepsPerMinute / 60) * dt
        this.floors = this.stepCount / 16
        this.strideCount = this.stepCount / 2
        break
      }
    }
  }

  startClock(): void {
    this.stopClock()
    this.#clock = setInterval(() => this.tick(1), this.options.tickMs ?? 1000)
  }
  stopClock(): void {
    clearInterval(this.#clock)
    this.#clock = undefined
  }

  /** The current state as a data record (display units), as the machine would report it. */
  record(): Record<string, unknown> {
    const kcal = Math.round(this.energyKcal)
    const common = {
      totalEnergyKcal: kcal,
      energyPerHourKcal: Math.round(this.activity * this.profile.kcalPerHour || this.speedKmh * 20),
      energyPerMinuteKcal: Math.round((this.activity * this.profile.kcalPerHour || this.speedKmh * 20) / 60),
      elapsedS: Math.round(this.elapsedS),
    }
    const withHr = { ...common, heartRateBpm: Math.round(this.heartRate) }
    const elevationM = Math.round(this.stepCount * 0.17)
    switch (this.type) {
      case 'treadmill':
        return {
          speedKmh: this.speedKmh,
          distanceM: this.distanceM,
          inclinePercent: this.inclinePct,
          rampAngleDeg: 0,
          ...common,
        }
      case 'indoorBike':
        return {
          speedKmh: this.speedKmh,
          cadenceRpm: this.cadenceRpm,
          distanceM: this.distanceM,
          resistanceLevel: Math.round(this.resistance),
          powerW: Math.round(this.power),
          ...withHr,
        }
      case 'rower': {
        const v = this.speedKmh / 3.6
        return {
          strokeRate: this.strokeRate,
          strokeCount: Math.round(this.strokeCount),
          distanceM: this.distanceM,
          paceS: v > 0.1 ? Math.round(500 / v) : 0,
          powerW: Math.round(this.power),
          resistanceLevel: Math.round(this.resistance),
          ...withHr,
        }
      }
      case 'crossTrainer':
        return {
          speedKmh: this.speedKmh,
          distanceM: this.distanceM,
          stepsPerMinute: Math.round(this.stepsPerMinute),
          strideCount: this.strideCount,
          inclinePercent: this.inclinePct,
          rampAngleDeg: 0,
          resistanceLevel: Math.round(this.resistance),
          powerW: Math.round(this.power),
          ...withHr,
        }
      case 'stepClimber':
        return {
          floors: Math.floor(this.floors),
          stepCount: Math.round(this.stepCount),
          stepsPerMinute: Math.round(this.stepsPerMinute),
          positiveElevationGainM: elevationM,
          ...withHr,
        }
      case 'stairClimber':
        return {
          floors: Math.floor(this.floors),
          stepsPerMinute: Math.round(this.stepsPerMinute),
          positiveElevationGainM: elevationM,
          strideCount: Math.round(this.strideCount),
          ...withHr,
        }
    }
  }

  /** Send the current state as a data notification (one or two packets). */
  notifyData(): void {
    for (const packet of encodeMachineData(this.type, this.record(), {
      split: this.options.splitRecords,
      fieldTypes: this.options.wideResistance ? { resistanceLevel: 's16' } : undefined,
    })) {
      this.#data.emitValue(packet)
    }
  }

  // ---- Control point ------------------------------------------------------------------

  #onControlWrite(bytes: Uint8Array): void {
    if (!this.#cp?.isNotifying) {
      // Spec §4.16.3: writing without indications enabled is an ATT error.
      throw new DOMException(
        'Client Characteristic Configuration Descriptor Improperly Configured',
        'NotSupportedError',
      )
    }
    this.writes.push(bytes.slice())
    const op = bytes[0]
    const forced = this.options.responses?.[op]
    if (forced === 'silent') return
    const result = forced ?? this.#apply(op, bytes)
    setTimeout(
      () => this.#cp?.emitValue(Uint8Array.of(ControlOp.ResponseCode, op, result)),
      this.options.responseDelayMs ?? 1,
    )
  }

  #status(...bytes: number[]): void {
    setTimeout(() => this.#machine?.emitValue(Uint8Array.from(bytes)), 1)
  }
  #trainingStatus(code: number): void {
    setTimeout(() => this.#training?.emitValue(Uint8Array.of(0, code)), 1)
  }

  /** Revoke control, as another client or the console would. */
  loseControl(): void {
    this.hasControl = false
    this.#status(0xff)
  }

  #supports(op: number): boolean {
    const p = this.profile
    switch (op) {
      case ControlOp.RequestControl:
      case ControlOp.Reset:
      case ControlOp.StartOrResume:
      case ControlOp.StopOrPause:
        return true
      case ControlOp.SetTargetSpeed:
        return p.speed
      case ControlOp.SetTargetInclination:
        return p.incline
      case ControlOp.SetTargetResistance:
        return p.resistance
      case ControlOp.SetTargetPower:
        return p.power
      case ControlOp.SetIndoorBikeSimulation:
        return p.bikeSim
      default:
        return false
    }
  }

  #apply(op: number, b: Uint8Array): number {
    if (op === ControlOp.RequestControl) {
      if (this.options.denyControl) return ResultCode.ControlNotPermitted
      this.hasControl = true
      return ResultCode.Success
    }
    if (!this.#supports(op)) return ResultCode.OpCodeNotSupported
    if (!this.hasControl) return ResultCode.ControlNotPermitted

    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    switch (op) {
      case ControlOp.Reset:
        this.hasControl = false
        this.running = this.paused = false
        this.targetKmh = 0
        this.inclinePct = 0
        this.resistance = 0
        this.targetPower = null
        this.#status(0x01)
        this.#trainingStatus(0x01)
        return ResultCode.Success
      case ControlOp.StartOrResume:
        // Acknowledged but ignored while the post-workout summary is showing.
        if (Date.now() < this.#postWorkoutUntil) return ResultCode.Success
        if (this.running && !this.paused) return ResultCode.OperationFailed
        this.running = true
        this.paused = false
        if (this.type === 'treadmill') this.targetKmh = Math.max(this.targetKmh, this.speedRange.min)
        this.#status(0x04)
        this.#trainingStatus(0x0d)
        return ResultCode.Success
      case ControlOp.StopOrPause: {
        if (b.length !== 2 || (b[1] !== 1 && b[1] !== 2)) return ResultCode.InvalidParameter
        if (!this.running) return ResultCode.OperationFailed
        if (b[1] === 1) {
          this.running = this.paused = false
          this.targetKmh = 0
          const summary = this.options.postWorkoutMs
          if (summary) {
            this.#postWorkoutUntil = Date.now() + summary
            this.#trainingStatus(0x0f)
            setTimeout(() => this.#trainingStatus(0x01), summary)
          } else {
            this.#trainingStatus(0x01)
          }
        } else {
          this.paused = true
        }
        this.#status(0x02, b[1])
        return ResultCode.Success
      }
      case ControlOp.SetTargetSpeed: {
        if (b.length !== 3) return ResultCode.InvalidParameter
        const kmh = view.getUint16(1, true) / 100
        if (kmh < this.speedRange.min - 1e-9 || kmh > this.speedRange.max + 1e-9)
          return ResultCode.InvalidParameter
        if (!this.running || this.paused) return ResultCode.OperationFailed
        this.targetKmh = kmh
        this.#status(0x05, b[1], b[2])
        return ResultCode.Success
      }
      case ControlOp.SetTargetInclination: {
        if (b.length !== 3) return ResultCode.InvalidParameter
        const pct = view.getInt16(1, true) / 10
        const { min, max } = this.inclinationRange
        if (pct < min - 1e-9 || pct > max + 1e-9) return ResultCode.InvalidParameter
        this.inclinePct = pct
        this.#status(0x06, b[1], b[2])
        return ResultCode.Success
      }
      case ControlOp.SetTargetResistance: {
        if (b.length !== 2) return ResultCode.InvalidParameter
        const level = b[1] / 10
        const { min, max } = this.resistanceRange
        if (level < min - 1e-9 || level > max + 1e-9) return ResultCode.InvalidParameter
        this.resistance = level
        this.#status(0x07, ...(this.options.wideResistance ? [b[1]] : le16(b[1])))
        return ResultCode.Success
      }
      case ControlOp.SetTargetPower: {
        if (b.length !== 3) return ResultCode.InvalidParameter
        const watts = view.getInt16(1, true)
        const { min, max } = this.powerRange
        if (watts < min || watts > max) return ResultCode.InvalidParameter
        this.targetPower = watts
        this.#status(0x08, b[1], b[2])
        return ResultCode.Success
      }
      default: {
        // SetIndoorBikeSimulation
        if (b.length !== 7) return ResultCode.InvalidParameter
        this.bikeSim = {
          windSpeedMps: view.getInt16(1, true) / 1000,
          gradePercent: view.getInt16(3, true) / 100,
          crr: b[5] / 10000,
          cw: b[6] / 100,
        }
        this.targetPower = null
        this.#status(0x12, ...b.subarray(1))
        return ResultCode.Success
      }
    }
  }
}

export function createSimulatedMachine(options: SimulatorOptions): SimulatedMachine {
  return new SimulatedMachine(options)
}
