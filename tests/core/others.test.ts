import { describe, expect, it } from 'vitest'
import {
  ControlOp,
  ResultCode,
  encodeControl,
  fromHex,
  parseControlResponse,
  parseFeature,
  parseMachineStatus,
  parseRange,
  parseTrainingStatus,
  toHex,
} from '../../src'
import { view } from './helpers'

const hex = (b: Uint8Array) => toHex(b)

describe('parseFeature', () => {
  it('decodes both 32-bit fields', () => {
    // machine 0x0001120D: bits 0, 2, 3, 9, 12, 16. targets 0x3: speed + inclination.
    const r = parseFeature(view('0d 12 01 00  03 00 00 00'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { machine, targets, raw } = r.value
    expect(raw).toEqual({ machine: 0x0001120d, targets: 3 })
    expect(machine).toMatchObject({
      averageSpeed: true,
      cadence: false,
      totalDistance: true,
      inclination: true,
      expendedEnergy: true,
      elapsedTime: true,
      userDataRetention: true,
      heartRate: false,
    })
    expect(targets).toMatchObject({ speed: true, inclination: true, resistance: false, power: false })
  })

  it('handles bit 31 as unsigned', () => {
    const r = parseFeature(view('00 00 00 80  00 00 00 80'))
    expect(r.ok && r.value.raw).toEqual({ machine: 0x80000000, targets: 0x80000000 })
  })

  it('returns TRUNCATED for fewer than 8 bytes', () => {
    const r = parseFeature(view('0d 12 01 00  03 00 00'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })
})

describe('parseTrainingStatus', () => {
  it('parses a status without a string', () => {
    expect(parseTrainingStatus(view('00 0d'))).toEqual({
      ok: true,
      value: { code: 0x0d, name: 'manualMode', extended: false },
    })
  })

  it('parses the optional UTF-8 string and the extended flag', () => {
    const r = parseTrainingStatus(view('03 02 48 69'))
    expect(r).toEqual({ ok: true, value: { code: 2, name: 'warmingUp', text: 'Hi', extended: true } })
  })

  it('names reserved values "reserved" instead of failing', () => {
    const r = parseTrainingStatus(view('00 20'))
    expect(r.ok && r.value.name).toBe('reserved')
  })

  it('returns TRUNCATED on one byte', () => {
    const r = parseTrainingStatus(view('00'))
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })
})

describe('parseMachineStatus', () => {
  const kind = (h: string) => {
    const r = parseMachineStatus(view(h))
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }

  it('decodes the simple ops', () => {
    expect(kind('01')).toEqual({ kind: 'reset' })
    expect(kind('03')).toEqual({ kind: 'stoppedBySafetyKey' })
    expect(kind('04')).toEqual({ kind: 'startedOrResumed' })
    expect(kind('ff')).toEqual({ kind: 'controlPermissionLost' })
  })

  it('decodes stop vs pause (Table 4.16)', () => {
    expect(kind('02 01')).toMatchObject({ kind: 'stoppedOrPaused', action: 'stop' })
    expect(kind('02 02')).toMatchObject({ kind: 'stoppedOrPaused', action: 'pause' })
    expect(kind('02 09')).toMatchObject({ kind: 'stoppedOrPaused', action: 'unknown', raw: 9 })
  })

  it('decodes target changes with units', () => {
    expect(kind('05 90 01')).toEqual({ kind: 'targetSpeedChanged', kmh: 4 })
    expect(kind('06 e7 ff')).toEqual({ kind: 'targetInclineChanged', percent: -2.5 })
  })

  it('keeps unknown ops with their payload', () => {
    const s = kind('0d 10 27 00')
    expect(s).toMatchObject({ kind: 'other', opcode: 0x0d })
    expect(s.kind === 'other' && Array.from(s.data)).toEqual([0x10, 0x27, 0])
  })

  it.each([
    ['empty', ''],
    ['speed missing a byte', '05 90'],
    ['stop missing parameter', '02'],
  ])('returns TRUNCATED for %s', (_n, h) => {
    const r = parseMachineStatus(view(h))
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })
})

describe('parseRange', () => {
  it('parses a speed range (0.01 km/h)', () => {
    // min 0.50, max 6.00, step 0.10
    expect(parseRange(view('32 00 58 02 0a 00'), 'speed')).toEqual({
      ok: true,
      value: { min: 0.5, max: 6, step: 0.1 },
    })
  })

  it('parses an inclination range (0.1 %), including a negative minimum', () => {
    expect(parseRange(view('00 00 5a 00 0a 00'), 'inclination')).toEqual({
      ok: true,
      value: { min: 0, max: 9, step: 1 },
    })
    expect(parseRange(view('f6 ff 96 00 05 00'), 'inclination')).toEqual({
      ok: true,
      value: { min: -1, max: 15, step: 0.5 },
    })
  })

  it('returns TRUNCATED on short input', () => {
    const r = parseRange(view('32 00 58 02'), 'speed')
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })
})

describe('encodeControl', () => {
  it('encodes the parameterless ops', () => {
    expect(hex(encodeControl(ControlOp.RequestControl))).toBe('00')
    expect(hex(encodeControl(ControlOp.Reset))).toBe('01')
    expect(hex(encodeControl(ControlOp.StartOrResume))).toBe('07')
  })

  it('encodes stop (1) and pause (2)', () => {
    expect(hex(encodeControl(ControlOp.StopOrPause, { action: 'stop' }))).toBe('08 01')
    expect(hex(encodeControl(ControlOp.StopOrPause, { action: 'pause' }))).toBe('08 02')
  })

  it('encodes target speed as little-endian uint16 in 0.01 km/h', () => {
    expect(hex(encodeControl(ControlOp.SetTargetSpeed, { kmh: 4 }))).toBe('02 90 01')
    expect(hex(encodeControl(ControlOp.SetTargetSpeed, { kmh: 2.5 }))).toBe('02 fa 00')
    // 1.99 * 100 = 199.00000000000003 in floating point; must still send 199
    expect(hex(encodeControl(ControlOp.SetTargetSpeed, { kmh: 1.99 }))).toBe('02 c7 00')
    expect(hex(encodeControl(ControlOp.SetTargetSpeed, { kmh: 655.35 }))).toBe('02 ff ff')
  })

  it('encodes target inclination as signed int16 in 0.1 %', () => {
    expect(hex(encodeControl(ControlOp.SetTargetInclination, { percent: 9 }))).toBe('03 5a 00')
    expect(hex(encodeControl(ControlOp.SetTargetInclination, { percent: -2.5 }))).toBe('03 e7 ff')
    expect(hex(encodeControl(ControlOp.SetTargetInclination, { percent: 0 }))).toBe('03 00 00')
  })

  it('throws RangeError for values the wire format cannot hold', () => {
    expect(() => encodeControl(ControlOp.SetTargetSpeed, { kmh: -1 })).toThrow(RangeError)
    expect(() => encodeControl(ControlOp.SetTargetSpeed, { kmh: 700 })).toThrow(RangeError)
    expect(() => encodeControl(ControlOp.SetTargetSpeed, { kmh: NaN })).toThrow(RangeError)
    expect(() => encodeControl(ControlOp.SetTargetInclination, { percent: 4000 })).toThrow(RangeError)
    expect(() => encodeControl(ControlOp.SetTargetInclination, { percent: -4000 })).toThrow(RangeError)
    // @ts-expect-error invalid action on purpose
    expect(() => encodeControl(ControlOp.StopOrPause, { action: 'halt' })).toThrow(RangeError)
  })
})

describe('parseControlResponse', () => {
  it('parses a success response', () => {
    expect(parseControlResponse(view('80 02 01'))).toEqual({
      ok: true,
      value: { requestOp: 2, result: ResultCode.Success, params: new Uint8Array() },
    })
  })

  it('parses error results and trailing response parameters', () => {
    const r = parseControlResponse(view('80 03 05 aa bb'))
    expect(r.ok && r.value.result).toBe(ResultCode.ControlNotPermitted)
    expect(r.ok && Array.from(r.value.params)).toEqual([0xaa, 0xbb])
  })

  it('rejects a payload that is not a response (first byte must be 0x80)', () => {
    const r = parseControlResponse(view('07 02 01'))
    expect(!r.ok && r.error.code).toBe('INVALID')
  })

  it('returns TRUNCATED for fewer than 3 bytes', () => {
    const r = parseControlResponse(view('80 02'))
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })
})

describe('hex helpers', () => {
  it('round-trips and accepts common formats', () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe('00 0f ff')
    expect(Array.from(fromHex('00 0f ff'))).toEqual([0, 15, 255])
    expect(Array.from(fromHex('0x00,0x0F'))).toEqual([0, 15])
    expect(() => fromHex('abc')).toThrow(RangeError)
  })
})

describe('additional control ops', () => {
  it('encodes resistance as uint8 in 0.1 units', () => {
    expect(hex(encodeControl(ControlOp.SetTargetResistance, { level: 5.5 }))).toBe('04 37')
    expect(() => encodeControl(ControlOp.SetTargetResistance, { level: 26 })).toThrow(RangeError)
    expect(() => encodeControl(ControlOp.SetTargetResistance, { level: -1 })).toThrow(RangeError)
  })

  it('encodes power as signed int16 watts', () => {
    expect(hex(encodeControl(ControlOp.SetTargetPower, { watts: 200 }))).toBe('05 c8 00')
    expect(hex(encodeControl(ControlOp.SetTargetPower, { watts: -100 }))).toBe('05 9c ff')
    expect(() => encodeControl(ControlOp.SetTargetPower, { watts: 40000 })).toThrow(RangeError)
  })

  it('encodes heart rate as uint8 bpm', () => {
    expect(hex(encodeControl(ControlOp.SetTargetHeartRate, { bpm: 140 }))).toBe('06 8c')
    expect(() => encodeControl(ControlOp.SetTargetHeartRate, { bpm: 300 })).toThrow(RangeError)
  })

  it('encodes indoor bike simulation parameters (Table 4.20)', () => {
    // wind 2.5 m/s = 2500, grade 3.5 % = 350, crr 0.004 = 40, cw 0.51 = 51
    expect(
      hex(
        encodeControl(ControlOp.SetIndoorBikeSimulation, {
          windSpeedMps: 2.5,
          gradePercent: 3.5,
          crr: 0.004,
          cw: 0.51,
        }),
      ),
    ).toBe('11 c4 09 5e 01 28 33')
    // negative grade -2 % = -200 = 0xFF38
    expect(
      hex(
        encodeControl(ControlOp.SetIndoorBikeSimulation, {
          windSpeedMps: 0,
          gradePercent: -2,
          crr: 0,
          cw: 0,
        }),
      ),
    ).toBe('11 00 00 38 ff 00 00')
    expect(() =>
      encodeControl(ControlOp.SetIndoorBikeSimulation, { windSpeedMps: 0, gradePercent: 0, crr: 0.1, cw: 0 }),
    ).toThrow(RangeError)
  })
})

describe('additional machine status and ranges', () => {
  it('decodes resistance, power, heart rate and bike simulation target changes', () => {
    const k = (h: string) => {
      const r = parseMachineStatus(view(h))
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    }
    expect(k('07 32 00')).toEqual({ kind: 'targetResistanceChanged', level: 5 })
    // one-byte parameter, as sent by a Domyos rower when the level is changed on the machine
    expect(k('07 14')).toEqual({ kind: 'targetResistanceChanged', level: 2 })
    expect(k('08 c8 00')).toEqual({ kind: 'targetPowerChanged', watts: 200 })
    expect(k('09 8c')).toEqual({ kind: 'targetHeartRateChanged', bpm: 140 })
    expect(k('12 c4 09 5e 01 28 33')).toEqual({
      kind: 'indoorBikeSimulationChanged',
      windSpeedMps: 2.5,
      gradePercent: 3.5,
      crr: 0.004,
      cw: 0.51,
    })
  })

  it('parses resistance, power and heart rate ranges', () => {
    expect(parseRange(view('0a 64 0a'), 'resistance')).toEqual({
      ok: true,
      value: { min: 1, max: 10, step: 1 },
    })
    expect(parseRange(view('00 00 e8 03 05 00'), 'power')).toEqual({
      ok: true,
      value: { min: 0, max: 1000, step: 5 },
    })
    expect(parseRange(view('1e c8 01'), 'heartRate')).toEqual({
      ok: true,
      value: { min: 30, max: 200, step: 1 },
    })
    // 16-bit values, as read from a Domyos rower: levels 1 to 15 in steps of 1
    expect(parseRange(view('0a 00 96 00 0a 00'), 'resistance')).toEqual({
      ok: true,
      value: { min: 1, max: 15, step: 1 },
    })
    expect(parseRange(view('0a 64'), 'resistance').ok).toBe(false)
  })
})
