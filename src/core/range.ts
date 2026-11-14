import { attempt, Reader, type Bytes } from './reader'
import type { Result } from './result'

export interface Range {
  min: number
  max: number
  /** Minimum increment. */
  step: number
}

export type RangeKind = 'speed' | 'inclination' | 'resistance' | 'power' | 'heartRate'

/**
 * Supported range characteristics (spec §4.11-4.15). Each is min, max, minimum increment.
 * Layouts from the Bluetooth SIG GSS (org.bluetooth.characteristic.supported_*_range.yaml):
 * speed 3x u16 in 0.01 km/h; inclination s16, s16, u16 in 0.1 %; resistance 3x u8; power s16, s16,
 * u16 in W; heart rate 3x u8 in bpm.
 *
 * Resistance deviates on real hardware, so it is read by payload length and scale:
 * - Width: 3 bytes (u8 each, as the GSS says) or 6 bytes (u16 each, seen on a Domyos rower).
 * - Scale: 0.1, the same unit the Control Point and Machine Status use for resistance targets (spec
 *   §4.16, Table 4.15). The Domyos reports 10 / 150 / 10 for levels 1 to 15 in steps of 1. The GSS
 *   says "unit 1" here, which that device contradicts; the data records' resistance level is unit 1.
 */
export function parseRange(bytes: Bytes, kind: RangeKind): Result<Range> {
  return attempt(() => {
    const r = new Reader(bytes)
    switch (kind) {
      case 'speed':
        return { min: r.u16() / 100, max: r.u16() / 100, step: r.u16() / 100 }
      case 'inclination':
        return { min: r.s16() / 10, max: r.s16() / 10, step: r.u16() / 10 }
      case 'resistance': {
        const wide = r.remaining >= 6
        const read = () => (wide ? r.u16() : r.u8())
        return { min: read() / 10, max: read() / 10, step: read() / 10 }
      }
      case 'power':
        return { min: r.s16(), max: r.s16(), step: r.u16() }
      case 'heartRate':
        return { min: r.u8(), max: r.u8(), step: r.u8() }
    }
  })
}
