import { attempt, Reader, type Bytes } from './reader'
import type { Result } from './result'

/** Fitness Machine Status notification (spec §4.17, Table 4.26). */
export type MachineStatus =
  | { kind: 'reset' }
  | { kind: 'stoppedOrPaused'; action: 'stop' | 'pause' | 'unknown'; raw: number }
  | { kind: 'stoppedBySafetyKey' }
  | { kind: 'startedOrResumed' }
  | { kind: 'targetSpeedChanged'; kmh: number }
  | { kind: 'targetInclineChanged'; percent: number }
  | { kind: 'targetResistanceChanged'; level: number }
  | { kind: 'targetPowerChanged'; watts: number }
  | { kind: 'targetHeartRateChanged'; bpm: number }
  | {
      kind: 'indoorBikeSimulationChanged'
      windSpeedMps: number
      gradePercent: number
      crr: number
      cw: number
    }
  | { kind: 'controlPermissionLost' }
  /** An op code this library does not decode (resistance, power, targets, bike, spin down...). */
  | { kind: 'other'; opcode: number; data: Uint8Array }

export function parseMachineStatus(bytes: Bytes): Result<MachineStatus> {
  return attempt((): MachineStatus => {
    const r = new Reader(bytes)
    const opcode = r.u8()
    switch (opcode) {
      case 0x01:
        return { kind: 'reset' }
      case 0x02: {
        const raw = r.u8() // Table 4.16: 1 = stop, 2 = pause
        return { kind: 'stoppedOrPaused', action: raw === 1 ? 'stop' : raw === 2 ? 'pause' : 'unknown', raw }
      }
      case 0x03:
        return { kind: 'stoppedBySafetyKey' }
      case 0x04:
        return { kind: 'startedOrResumed' }
      case 0x05:
        return { kind: 'targetSpeedChanged', kmh: r.u16() / 100 }
      case 0x06:
        return { kind: 'targetInclineChanged', percent: r.s16() / 10 }
      case 0x07:
        // Table 4.26 says SINT16 in 0.1 units. A Domyos rower sends one byte (`07 14` = level 2.0), so
        // read the width from the payload length.
        return { kind: 'targetResistanceChanged', level: (r.remaining === 1 ? r.u8() : r.s16()) / 10 }
      case 0x08:
        return { kind: 'targetPowerChanged', watts: r.s16() }
      case 0x09:
        return { kind: 'targetHeartRateChanged', bpm: r.u8() }
      case 0x12:
        return {
          kind: 'indoorBikeSimulationChanged',
          windSpeedMps: r.s16() / 1000,
          gradePercent: r.s16() / 100,
          crr: r.u8() / 10000,
          cw: r.u8() / 100,
        }
      case 0xff:
        return { kind: 'controlPermissionLost' }
      default:
        return { kind: 'other', opcode, data: r.rest() }
    }
  })
}
