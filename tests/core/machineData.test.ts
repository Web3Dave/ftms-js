import { describe, expect, it } from 'vitest'
import {
  MACHINE_TYPES,
  encodeMachineData,
  mergeMachineData,
  parseCrossTrainerData,
  parseIndoorBikeData,
  parseMachineData,
  parseMachineTypeAdvertisement,
  parseRowerData,
  parseStairClimberData,
  parseStepClimberData,
  type MachineType,
} from '../../src'
import { view } from './helpers'

// Fixtures are built by hand from the spec's flag tables (Tables 4.6-4.10): the flag bit for each
// group, then the fields in flag-bit order. Field sizes and units are the unverified part (see
// src/core/machineData.ts).

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

describe('Indoor Bike Data (spec §4.9)', () => {
  // flags 0x0874: bit0=0 (speed), bit2 cadence, bit4 distance, bit5 resistance, bit6 power, bit11 elapsed
  const hex = '74 08  c4 09  aa 00  88 13 00  08  c8 00  2c 01'

  it('parses speed, cadence, distance, resistance, power and elapsed time', () => {
    expect(ok(parseIndoorBikeData(view(hex)))).toMatchObject({
      type: 'indoorBike',
      moreData: false,
      speedKmh: 25,
      cadenceRpm: 85, // 0.5 /min resolution: raw 170
      distanceM: 5000,
      resistanceLevel: 8,
      powerW: 200,
      elapsedS: 300,
    })
  })

  it('parses negative power (signed)', () => {
    // flags 0x0040: speed + power. power -50 = 0xFFCE
    expect(ok(parseIndoorBikeData(view('40 00  64 00  ce ff'))).powerW).toBe(-50)
  })

  it('treats power 0x7FFF as not available', () => {
    expect(ok(parseIndoorBikeData(view('40 00  64 00  ff 7f'))).powerW).toBeUndefined()
  })
})

describe('Rower Data (spec §4.8)', () => {
  // flags 0x082C: bit0=0 (stroke rate+count), bit2 distance, bit3 pace, bit5 power, bit11 elapsed
  const hex = '2c 08  30  64 00  c4 09 00  7d 00  b4 00  58 02'

  it('parses stroke rate and count, distance, pace, power and elapsed time', () => {
    expect(ok(parseRowerData(view(hex)))).toMatchObject({
      type: 'rower',
      strokeRate: 24, // 0.5 /min resolution: raw 48
      strokeCount: 100,
      distanceM: 2500,
      paceS: 125,
      powerW: 180,
      elapsedS: 600,
    })
  })

  it('omits stroke fields when More Data is set (they come in the last notification)', () => {
    const d = ok(parseRowerData(view('05 00  c4 09 00')))
    expect(d.moreData).toBe(true)
    expect(d.strokeRate).toBeUndefined()
    expect(d.strokeCount).toBeUndefined()
    expect(d.distanceM).toBe(2500)
  })
})

describe('Cross Trainer Data (spec §4.5)', () => {
  // 24-bit flags 0x00A198: bit0=0 speed, bit3 step count, bit4 stride count, bit7 resistance,
  // bit8 power, bit13 elapsed, bit15 = movement direction (backward)
  const hex = '98 a1 00  58 02  6e 00 64 00  d2 04  05  5a 00  3c 00'

  it('parses a 24-bit flags field and every selected group', () => {
    expect(ok(parseCrossTrainerData(view(hex)))).toMatchObject({
      type: 'crossTrainer',
      speedKmh: 6,
      stepsPerMinute: 110,
      averageStepRate: 100,
      strideCount: 123.4,
      resistanceLevel: 5,
      powerW: 90,
      elapsedS: 60,
      movementDirection: 'backward',
    })
  })

  it('reports forward when flag bit 15 is clear', () => {
    expect(ok(parseCrossTrainerData(view('00 00 00  58 02'))).movementDirection).toBe('forward')
  })
})

describe('Step Climber Data (spec §4.6)', () => {
  // flags 0x008A: bit0=0 (floors + step count), bit1 steps/min, bit3 elevation gain, bit7 elapsed
  const hex = '8a 00  0c 00  c0 00  3c 00  03 00  2c 01'

  it('parses floors, step count, step rate, elevation gain and elapsed time', () => {
    expect(ok(parseStepClimberData(view(hex)))).toMatchObject({
      type: 'stepClimber',
      floors: 12,
      stepCount: 192,
      stepsPerMinute: 60,
      positiveElevationGainM: 3, // whole metres: the GSS states no finer resolution
      elapsedS: 300,
    })
  })
})

describe('Stair Climber Data (spec §4.7)', () => {
  // flags 0x0112: bit0=0 (floors), bit1 steps/min, bit4 stride count, bit8 elapsed
  const hex = '12 01  05 00  46 00  08 00  78 00'

  it('parses floors, step rate, stride count and elapsed time', () => {
    expect(ok(parseStairClimberData(view(hex)))).toMatchObject({
      type: 'stairClimber',
      floors: 5,
      stepsPerMinute: 70,
      strideCount: 8,
      elapsedS: 120,
    })
  })
})

describe('shared behaviour', () => {
  const fixtures: Array<[MachineType, string]> = [
    ['indoorBike', '74 08  c4 09  aa 00  88 13 00  08  c8 00  2c 01'],
    ['rower', '2c 08  30  64 00  c4 09 00  7d 00  b4 00  58 02'],
    ['crossTrainer', '98 a1 00  58 02  6e 00 64 00  d2 04  05  5a 00  3c 00'],
    ['stepClimber', '8a 00  0c 00  c0 00  3c 00  03 00  2c 01'],
    ['stairClimber', '12 01  05 00  46 00  08 00  78 00'],
  ]

  it.each(fixtures)('%s: a packet missing its last byte returns TRUNCATED, never throws', (type, hex) => {
    const bytes = view(hex)
    const cut = new DataView(bytes.buffer, 0, bytes.byteLength - 1)
    const r = parseMachineData(type, cut)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })

  it.each(MACHINE_TYPES)('%s: empty and one-byte packets are TRUNCATED', (type) => {
    expect(parseMachineData(type, view('')).ok).toBe(false)
    expect(parseMachineData(type, view('00')).ok).toBe(false)
  })

  it.each(MACHINE_TYPES)('%s: parseMachineData tags the record with its type', (type) => {
    // flags 0 with the inverted bit 0 means the first group is present: supply plenty of zero bytes
    const r = parseMachineData(type, new Uint8Array(32))
    expect(r.ok && r.value.type).toBe(type)
  })

  it('exposes the energy fields with their "Data Not Available" sentinels (bike, flag bit 8)', () => {
    const d = ok(parseIndoorBikeData(view('00 01  64 00  ff ff ff ff ff')))
    expect(d.speedKmh).toBe(1)
    expect(d.totalEnergyKcal).toBeUndefined()
    expect(d.energyPerMinuteKcal).toBeUndefined()
    const real = ok(parseIndoorBikeData(view('00 01  64 00  34 00 2c 01 05')))
    expect(real).toMatchObject({ totalEnergyKcal: 52, energyPerHourKcal: 300, energyPerMinuteKcal: 5 })
  })
})

describe('encodeMachineData', () => {
  it.each(MACHINE_TYPES)('%s: encode then parse returns the same values', (type) => {
    const samples: Record<MachineType, Record<string, number>> = {
      treadmill: {
        speedKmh: 4.2,
        distanceM: 1500,
        inclinePercent: -1.5,
        rampAngleDeg: 0,
        totalEnergyKcal: 40,
        energyPerHourKcal: 250,
        energyPerMinuteKcal: 4,
        elapsedS: 900,
      },
      crossTrainer: {
        speedKmh: 6.5,
        distanceM: 800,
        stepsPerMinute: 110,
        strideCount: 55.5,
        resistanceLevel: 7,
        powerW: 120,
        heartRateBpm: 133,
        elapsedS: 120,
      },
      stepClimber: {
        floors: 3,
        stepCount: 48,
        stepsPerMinute: 62,
        positiveElevationGainM: 8,
        elapsedS: 77,
      },
      stairClimber: { floors: 4, stepsPerMinute: 66, strideCount: 12, heartRateBpm: 120, elapsedS: 80 },
      rower: {
        strokeRate: 22.5,
        strokeCount: 31,
        distanceM: 410,
        paceS: 130,
        powerW: 175,
        resistanceLevel: 5,
        elapsedS: 95,
      },
      indoorBike: {
        speedKmh: 28.5,
        cadenceRpm: 87.5,
        distanceM: 4000,
        resistanceLevel: 9,
        powerW: 210,
        heartRateBpm: 140,
        elapsedS: 400,
      },
    }
    const values = samples[type]
    const [packet, ...rest] = encodeMachineData(type, values)
    expect(rest).toHaveLength(0)
    expect(ok(parseMachineData(type, packet))).toMatchObject(values)
  })

  it.each(MACHINE_TYPES)('%s: a split record merges back to the same values', (type) => {
    const sample = {
      treadmill: {
        speedKmh: 3,
        distanceM: 100,
        inclinePercent: 2,
        rampAngleDeg: 0,
        elapsedS: 30,
        totalEnergyKcal: 5,
        energyPerHourKcal: 60,
        energyPerMinuteKcal: 1,
      },
      crossTrainer: {
        speedKmh: 6,
        distanceM: 90,
        stepsPerMinute: 100,
        strideCount: 10,
        resistanceLevel: 3,
        powerW: 80,
        elapsedS: 30,
      },
      stepClimber: { floors: 1, stepCount: 20, stepsPerMinute: 60, positiveElevationGainM: 3, elapsedS: 20 },
      stairClimber: {
        floors: 1,
        stepsPerMinute: 60,
        strideCount: 5,
        positiveElevationGainM: 3,
        elapsedS: 20,
      },
      rower: { strokeRate: 20, strokeCount: 10, distanceM: 50, paceS: 120, powerW: 100, elapsedS: 30 },
      indoorBike: {
        speedKmh: 20,
        cadenceRpm: 80,
        distanceM: 200,
        resistanceLevel: 4,
        powerW: 150,
        elapsedS: 40,
      },
    }[type] as Record<string, number>
    const packets = encodeMachineData(type, sample, { split: true })
    expect(packets).toHaveLength(2)
    const parsed = packets.map((p) => ok(parseMachineData(type, p)))
    expect(parsed[0].moreData).toBe(true)
    expect(parsed[1].moreData).toBe(false)
    expect(mergeMachineData(parsed)).toMatchObject({ ...sample, moreData: false })
  })

  it('encodes cross trainer movement direction in flag bit 15', () => {
    const [p] = encodeMachineData('crossTrainer', { speedKmh: 5, movementDirection: 'backward' })
    expect(ok(parseCrossTrainerData(p)).movementDirection).toBe('backward')
  })
})

describe('parseMachineTypeAdvertisement (spec §3.1)', () => {
  it('reads availability and the machine type bits', () => {
    // flags 1 (available), type 0x0021 = treadmill + indoor bike
    expect(parseMachineTypeAdvertisement(view('01 21 00'))).toEqual({
      ok: true,
      value: { available: true, types: ['treadmill', 'indoorBike'] },
    })
    // not available, rower only (bit 4)
    expect(parseMachineTypeAdvertisement(view('00 10 00'))).toEqual({
      ok: true,
      value: { available: false, types: ['rower'] },
    })
  })

  it('decodes all six bits in order', () => {
    const r = parseMachineTypeAdvertisement(view('01 3f 00'))
    expect(r.ok && r.value.types).toEqual([
      'treadmill',
      'crossTrainer',
      'stepClimber',
      'stairClimber',
      'rower',
      'indoorBike',
    ])
  })

  it('returns TRUNCATED for short payloads', () => {
    const r = parseMachineTypeAdvertisement(view('01 21'))
    expect(!r.ok && r.error.code).toBe('TRUNCATED')
  })
})

describe('rower sending a 16-bit resistance level (seen on a Domyos rower)', () => {
  // Real packets from a Domyos rower capture (10 strokes); the full set-resistance capture is replayed from fixtures/. Flags 0x0BAE; the resistance
  // field is two bytes (`01 00`) although the GSS says one, so the packet is 23 bytes, not 22.
  const idle = 'ae 0b 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00'
  const rowing = 'ae 0b 60 05 00 50 0e 00 00 d9 00 22 00 01 00 00 00 9f 00 02 00 07 00'
  const last = 'ae 0b 58 0a 00 58 34 00 00 03 01 14 00 01 00 00 00 5d 00 01 00 1a 00'

  it('lines every field up and leaves no trailing byte', () => {
    expect(ok(parseRowerData(view(rowing)))).toMatchObject({
      strokeRate: 48,
      strokeCount: 5,
      averageStrokeRate: 40,
      distanceM: 14,
      paceS: 217,
      powerW: 34,
      resistanceLevel: 1,
      totalEnergyKcal: 0,
      energyPerHourKcal: 159,
      energyPerMinuteKcal: 2,
      elapsedS: 7,
    })
    expect(ok(parseRowerData(view(rowing))).trailing).toBeUndefined()
  })

  it('decodes the idle and final packets of the capture', () => {
    expect(ok(parseRowerData(view(idle)))).toMatchObject({ strokeCount: 0, resistanceLevel: 1, elapsedS: 0 })
    expect(ok(parseRowerData(view(last)))).toMatchObject({
      strokeCount: 10,
      distanceM: 52,
      paceS: 259,
      powerW: 20,
      elapsedS: 26,
    })
  })

  it('does not change a packet that already matches the spec layout', () => {
    // same fields with a one-byte resistance level: 22 bytes
    const spec = 'ae 0b 60 05 00 50 0e 00 00 d9 00 22 00 01 00 00 9f 00 02 00 07 00'
    expect(ok(parseRowerData(view(spec)))).toMatchObject({
      resistanceLevel: 1,
      energyPerHourKcal: 159,
      elapsedS: 7,
    })
  })

  it('still reports a packet that fits neither layout as having trailing bytes', () => {
    const odd = 'ae 0b 60 05 00 50 0e 00 00 d9 00 22 00 01 00 00 00 9f 00 02 00 07 00 ff ff'
    expect(ok(parseRowerData(view(odd))).trailing).toBeDefined()
  })

  it('also applies to bikes and cross trainers', () => {
    // bike flags 0x0020 (speed + resistance), resistance 2 bytes
    expect(ok(parseIndoorBikeData(view('20 00  c4 09  05 00'))).resistanceLevel).toBe(5)
    expect(ok(parseIndoorBikeData(view('20 00  c4 09  05'))).resistanceLevel).toBe(5)
  })
})
