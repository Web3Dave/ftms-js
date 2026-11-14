import { ControlOp, ResultCode } from './constants'
import { attempt, Reader, type Bytes } from './reader'
import { err, type Result } from './result'

/** Indoor Bike Simulation Parameters (spec Table 4.20). */
export interface BikeSimulation {
  /** Meters per second (0.001 resolution). Positive = headwind. */
  windSpeedMps: number
  /** Percent (0.01 resolution). */
  gradePercent: number
  /** Coefficient of rolling resistance (0.0001 resolution). */
  crr: number
  /** Wind resistance coefficient, kg/m (0.01 resolution). */
  cw: number
}

const le16 = (v: number): [number, number] => [v & 0xff, (v >> 8) & 0xff]

function intIn(name: string, value: number, min: number, max: number): number {
  const n = Math.round(value)
  if (!Number.isFinite(value) || n < min || n > max) {
    throw new RangeError(`${name} is out of range for the wire format`)
  }
  return n
}

/**
 * Build a Fitness Machine Control Point write (spec Table 4.15).
 * Throws RangeError when a parameter cannot be represented on the wire.
 */
export function encodeControl(op: typeof ControlOp.RequestControl): Uint8Array
export function encodeControl(op: typeof ControlOp.Reset): Uint8Array
export function encodeControl(op: typeof ControlOp.StartOrResume): Uint8Array
export function encodeControl(op: typeof ControlOp.SetTargetSpeed, params: { kmh: number }): Uint8Array
export function encodeControl(
  op: typeof ControlOp.SetTargetInclination,
  params: { percent: number },
): Uint8Array
export function encodeControl(
  op: typeof ControlOp.StopOrPause,
  params: { action: 'stop' | 'pause' },
): Uint8Array
export function encodeControl(op: typeof ControlOp.SetTargetResistance, params: { level: number }): Uint8Array
export function encodeControl(op: typeof ControlOp.SetTargetPower, params: { watts: number }): Uint8Array
export function encodeControl(op: typeof ControlOp.SetTargetHeartRate, params: { bpm: number }): Uint8Array
export function encodeControl(
  op: typeof ControlOp.SetIndoorBikeSimulation,
  params: BikeSimulation,
): Uint8Array
export function encodeControl(op: number, rawParams?: unknown): Uint8Array {
  const params = rawParams as Record<string, unknown> | undefined
  switch (op) {
    case ControlOp.RequestControl:
    case ControlOp.Reset:
    case ControlOp.StartOrResume:
      return Uint8Array.of(op)
    case ControlOp.SetTargetSpeed: {
      // UINT16, 0.01 km/h (Table 4.15)
      const v = intIn('Target speed', (params?.kmh as number) * 100, 0, 0xffff)
      return Uint8Array.of(op, ...le16(v))
    }
    case ControlOp.SetTargetInclination: {
      // SINT16, 0.1 % (Table 4.15)
      const v = intIn('Target inclination', (params?.percent as number) * 10, -0x8000, 0x7fff)
      return Uint8Array.of(op, ...le16(v & 0xffff))
    }
    case ControlOp.SetTargetResistance: {
      // UINT8, unitless, 0.1 resolution (Table 4.15)
      const v = intIn('Target resistance', (params?.level as number) * 10, 0, 0xff)
      return Uint8Array.of(op, v)
    }
    case ControlOp.SetTargetPower: {
      // SINT16, watts (Table 4.15)
      const v = intIn('Target power', params?.watts as number, -0x8000, 0x7fff)
      return Uint8Array.of(op, ...le16(v & 0xffff))
    }
    case ControlOp.SetTargetHeartRate: {
      // UINT8, bpm (Table 4.15)
      const v = intIn('Target heart rate', params?.bpm as number, 0, 0xff)
      return Uint8Array.of(op, v)
    }
    case ControlOp.SetIndoorBikeSimulation: {
      // SINT16 wind 0.001 m/s, SINT16 grade 0.01 %, UINT8 crr 0.0001, UINT8 cw 0.01 (Table 4.20)
      const p = params as unknown as BikeSimulation
      const wind = intIn('Wind speed', p.windSpeedMps * 1000, -0x8000, 0x7fff)
      const grade = intIn('Grade', p.gradePercent * 100, -0x8000, 0x7fff)
      const crr = intIn('Crr', p.crr * 10000, 0, 0xff)
      const cw = intIn('Cw', p.cw * 100, 0, 0xff)
      return Uint8Array.of(op, ...le16(wind & 0xffff), ...le16(grade & 0xffff), crr, cw)
    }
    case ControlOp.StopOrPause: {
      // Table 4.16: 1 = stop, 2 = pause
      const action = params?.action
      if (action !== 'stop' && action !== 'pause') throw new RangeError("action must be 'stop' or 'pause'")
      return Uint8Array.of(op, action === 'stop' ? 1 : 2)
    }
    default:
      throw new RangeError(`Unsupported control op code 0x${op.toString(16)}`)
  }
}

export interface ControlResponse {
  /** The op code this is a response to. */
  requestOp: number
  /** Result code (spec Table 4.24). */
  result: number
  /** Response parameter bytes (empty for the op codes this library sends). */
  params: Uint8Array
}

/** Parse a Control Point indication: 0x80, request op code, result code, optional parameters (spec §4.16.2.22). */
export function parseControlResponse(bytes: Bytes): Result<ControlResponse> {
  const parsed = attempt(() => {
    const r = new Reader(bytes)
    const code = r.u8()
    const requestOp = r.u8()
    const result = r.u8()
    return { code, requestOp, result, params: r.rest() }
  })
  if (!parsed.ok) return parsed
  const { code, ...rest } = parsed.value
  if (code !== ControlOp.ResponseCode) {
    return err('INVALID', `Expected response code 0x80, got 0x${code.toString(16).padStart(2, '0')}`, 0)
  }
  return { ok: true, value: rest }
}

export const isSuccess = (r: ControlResponse): boolean => r.result === ResultCode.Success
