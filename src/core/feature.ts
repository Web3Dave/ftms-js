import { attempt, Reader, type Bytes } from './reader'
import type { Result } from './result'

// Spec Table 4.3 (Fitness Machine Features) and Table 4.4 (Target Setting Features): bit N = names[N].
const MACHINE_FEATURES = [
  'averageSpeed',
  'cadence',
  'totalDistance',
  'inclination',
  'elevationGain',
  'pace',
  'stepCount',
  'resistanceLevel',
  'strideCount',
  'expendedEnergy',
  'heartRate',
  'metabolicEquivalent',
  'elapsedTime',
  'remainingTime',
  'powerMeasurement',
  'forceOnBeltAndPower',
  'userDataRetention',
] as const

const TARGET_FEATURES = [
  'speed',
  'inclination',
  'resistance',
  'power',
  'heartRate',
  'expendedEnergy',
  'steps',
  'strides',
  'distance',
  'trainingTime',
  'twoHeartRateZones',
  'threeHeartRateZones',
  'fiveHeartRateZones',
  'indoorBikeSimulation',
  'wheelCircumference',
  'spinDown',
  'cadence',
] as const

export type MachineFeatureName = (typeof MACHINE_FEATURES)[number]
export type TargetFeatureName = (typeof TARGET_FEATURES)[number]

export interface Features {
  machine: Record<MachineFeatureName, boolean>
  targets: Record<TargetFeatureName, boolean>
  /** Raw 32-bit fields, kept so unknown/future bits are not lost. */
  raw: { machine: number; targets: number }
}

function decode<N extends string>(names: readonly N[], bits: number): Record<N, boolean> {
  const out = {} as Record<N, boolean>
  names.forEach((name, i) => {
    out[name] = ((bits >>> i) & 1) === 1
  })
  return out
}

/** Fitness Machine Feature characteristic: two little-endian uint32 bit fields (spec §4.3). */
export function parseFeature(bytes: Bytes): Result<Features> {
  return attempt(() => {
    const r = new Reader(bytes)
    const machine = r.u32()
    const targets = r.u32()
    return {
      machine: decode(MACHINE_FEATURES, machine),
      targets: decode(TARGET_FEATURES, targets),
      raw: { machine, targets },
    }
  })
}
