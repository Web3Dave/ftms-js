import { describe, expect, it } from 'vitest'
import { mergeTreadmillData, parseTreadmillData, type TreadmillData } from '../../src'
import { view } from './helpers'

function ok(hex: string): TreadmillData {
  const r = parseTreadmillData(view(hex))
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.value
}

describe('parseTreadmillData', () => {
  it('parses a speed-only packet (flags 0, speed 400 = 4.00 km/h)', () => {
    const d = ok('00 00 90 01')
    expect(d.speedKmh).toBe(4)
    expect(d.moreData).toBe(false)
    expect(d.distanceM).toBeUndefined()
    expect(d.elapsedS).toBeUndefined()
    expect(d.trailing).toBeUndefined()
  })

  it('parses distance + energy + elapsed time (flags 0x0484)', () => {
    // speed 2.50, distance 1234 m (u24), energy 52 / 300 per hour / 5 per min, elapsed 600 s
    const d = ok('84 04  fa 00  d2 04 00  34 00 2c 01 05  58 02')
    expect(d.speedKmh).toBe(2.5)
    expect(d.distanceM).toBe(1234)
    expect(d.totalEnergyKcal).toBe(52)
    expect(d.energyPerHourKcal).toBe(300)
    expect(d.energyPerMinuteKcal).toBe(5)
    expect(d.elapsedS).toBe(600)
    expect(d.inclinePercent).toBeUndefined()
  })

  it('reads a distance larger than 16 bits (u24)', () => {
    // 0x0F4240 = 1,000,000 m
    expect(ok('04 00  00 00  40 42 0f').distanceM).toBe(1_000_000)
  })

  it('parses negative inclination and ramp angle (signed 0.1 units)', () => {
    // incline -25 -> -2.5 %, ramp -14 -> -1.4 deg
    const d = ok('08 00  64 00  e7 ff  f2 ff')
    expect(d.speedKmh).toBe(1)
    expect(d.inclinePercent).toBe(-2.5)
    expect(d.rampAngleDeg).toBe(-1.4)
  })

  it('treats 0x7FFF inclination / ramp angle as "Data Not Available"', () => {
    const d = ok('08 00  64 00  ff 7f  ff 7f')
    expect(d.inclinePercent).toBeUndefined()
    expect(d.rampAngleDeg).toBeUndefined()
  })

  it('treats energy sentinels (0xFFFF, 0xFFFF, 0xFF) as "Data Not Available"', () => {
    const d = ok('80 00  64 00  ff ff ff ff ff')
    expect(d.totalEnergyKcal).toBeUndefined()
    expect(d.energyPerHourKcal).toBeUndefined()
    expect(d.energyPerMinuteKcal).toBeUndefined()
  })

  it('handles the inverted More Data bit: no speed field when bit 0 is set', () => {
    const d = ok('05 00  10 27 00')
    expect(d.moreData).toBe(true)
    expect(d.speedKmh).toBeUndefined()
    expect(d.distanceM).toBe(10_000)
  })

  it('parses every defined field in spec order (flags 0x1FFE)', () => {
    const d = ok(
      [
        'fe 1f',
        '90 01', // speed 4.00
        '2c 01', // average speed 3.00
        '10 27 00', // distance 10000
        '0a 00 05 00', // incline 1.0 %, ramp 0.5 deg
        '64 00 32 00', // elevation +10.0 m / -5.0 m
        '78 00', // pace 120 s
        '7d 00', // average pace 125 s
        '34 00 2c 01 05', // energy
        '78', // heart rate 120
        '32', // METs 5.0
        '58 02', // elapsed 600
        '2c 01', // remaining 300
        'f4 01 c8 00', // force 500 N, power 200 W
      ].join(' '),
    )
    expect(d).toMatchObject({
      speedKmh: 4,
      averageSpeedKmh: 3,
      distanceM: 10_000,
      inclinePercent: 1,
      rampAngleDeg: 0.5,
      positiveElevationGainM: 10,
      negativeElevationGainM: 5,
      paceS: 120,
      averagePaceS: 125,
      totalEnergyKcal: 52,
      energyPerHourKcal: 300,
      energyPerMinuteKcal: 5,
      heartRateBpm: 120,
      mets: 5,
      elapsedS: 600,
      remainingS: 300,
      forceOnBeltN: 500,
      powerW: 200,
    })
    expect(d.trailing).toBeUndefined()
  })

  it('keeps bytes after the known fields instead of failing (reserved flag bits)', () => {
    const d = ok('00 20  64 00  01 02 03')
    expect(d.speedKmh).toBe(1)
    expect(Array.from(d.trailing ?? [])).toEqual([1, 2, 3])
  })

  it('accepts a Uint8Array view with a non-zero byteOffset', () => {
    const backing = Uint8Array.of(0xaa, 0xbb, 0x00, 0x00, 0x90, 0x01)
    const r = parseTreadmillData(backing.subarray(2))
    expect(r).toMatchObject({ ok: true, value: { speedKmh: 4 } })
  })

  describe('truncated input returns a typed error and never throws', () => {
    it.each([
      ['empty', ''],
      ['one byte', '00'],
      ['speed cut in half', '00 00 90'],
      ['distance cut short', '04 00 64 00 10 27'],
      ['elapsed time missing', '00 04 64 00'],
    ])('%s', (_name, hex) => {
      const r = parseTreadmillData(view(hex))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe('TRUNCATED')
        expect(typeof r.error.message).toBe('string')
      }
    })

    it('reports the offset where bytes ran out', () => {
      const r = parseTreadmillData(view('00 00 90'))
      expect(r.ok === false && r.error.offset).toBe(2)
    })
  })
})

describe('mergeTreadmillData', () => {
  it('combines a split record (spec §4.19): first has More Data = 1, last has speed', () => {
    const first = ok('05 00  10 27 00') // distance only
    const last = ok('00 04  90 01  58 02') // speed + elapsed
    const merged = mergeTreadmillData([first, last])
    expect(merged).toMatchObject({ speedKmh: 4, distanceM: 10_000, elapsedS: 600, moreData: false })
  })
})
