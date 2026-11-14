import { attempt, Reader, type Bytes } from './reader'
import type { Result } from './result'

/** Spec Table 4.13. */
export const TRAINING_STATUS_NAMES: Record<number, string> = {
  0x00: 'other',
  0x01: 'idle',
  0x02: 'warmingUp',
  0x03: 'lowIntensityInterval',
  0x04: 'highIntensityInterval',
  0x05: 'recoveryInterval',
  0x06: 'isometric',
  0x07: 'heartRateControl',
  0x08: 'fitnessTest',
  0x09: 'speedOutsideControlRegionLow',
  0x0a: 'speedOutsideControlRegionHigh',
  0x0b: 'coolDown',
  0x0c: 'wattControl',
  0x0d: 'manualMode',
  0x0e: 'preWorkout',
  0x0f: 'postWorkout',
}

export interface TrainingStatus {
  /** Raw status code (spec Table 4.13). */
  code: number
  /** Name from the table, or `reserved` for values the spec reserves. */
  name: string
  /** Optional human-readable string from the device. */
  text?: string
  /** True when the string was cut off and the full text needs a GATT Read Long (spec §4.10.1.1). */
  extended: boolean
}

/** Training Status characteristic (spec §4.10): flags u8, status u8, optional UTF-8 string. */
export function parseTrainingStatus(bytes: Bytes): Result<TrainingStatus> {
  return attempt(() => {
    const r = new Reader(bytes)
    const flags = r.u8()
    const code = r.u8()
    const out: TrainingStatus = {
      code,
      name: TRAINING_STATUS_NAMES[code] ?? 'reserved',
      extended: (flags & 0x02) !== 0,
    }
    if (flags & 0x01) out.text = new TextDecoder('utf-8').decode(r.rest())
    return out
  })
}
