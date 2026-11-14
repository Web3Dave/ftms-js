import { DATA_CHARACTERISTICS } from './constants'
import {
  encodeWithSchema,
  parseWithSchema,
  type BaseRecord,
  type DataSchema,
  type EncodeOptions,
  type FieldDef,
  type GroupDef,
} from './dataSchema'
import type { Bytes } from './reader'
import type { Result } from './result'

export type MachineType =
  'treadmill' | 'crossTrainer' | 'stepClimber' | 'stairClimber' | 'rower' | 'indoorBike'

export const MACHINE_TYPES = /* @__PURE__ */ Object.keys(DATA_CHARACTERISTICS) as MachineType[]

/** Fields shared by every machine type. Present only when the machine sends them. */
export interface CommonFields {
  totalEnergyKcal?: number
  energyPerHourKcal?: number
  energyPerMinuteKcal?: number
  heartRateBpm?: number
  mets?: number
  elapsedS?: number
  remainingS?: number
}

export interface TreadmillData extends BaseRecord, CommonFields {
  type: 'treadmill'
  speedKmh?: number
  averageSpeedKmh?: number
  distanceM?: number
  inclinePercent?: number
  rampAngleDeg?: number
  positiveElevationGainM?: number
  negativeElevationGainM?: number
  /** Seconds (GSS gives the unit as "second"; the distance it is per is not stated). */
  paceS?: number
  averagePaceS?: number
  forceOnBeltN?: number
  powerW?: number
}

export interface CrossTrainerData extends BaseRecord, CommonFields {
  type: 'crossTrainer'
  speedKmh?: number
  averageSpeedKmh?: number
  distanceM?: number
  stepsPerMinute?: number
  averageStepRate?: number
  strideCount?: number
  positiveElevationGainM?: number
  negativeElevationGainM?: number
  inclinePercent?: number
  rampAngleDeg?: number
  resistanceLevel?: number
  powerW?: number
  averagePowerW?: number
  movementDirection: 'forward' | 'backward'
}

export interface StepClimberData extends BaseRecord, CommonFields {
  type: 'stepClimber'
  floors?: number
  stepCount?: number
  stepsPerMinute?: number
  averageStepRate?: number
  positiveElevationGainM?: number
}

export interface StairClimberData extends BaseRecord, CommonFields {
  type: 'stairClimber'
  floors?: number
  stepsPerMinute?: number
  averageStepRate?: number
  positiveElevationGainM?: number
  strideCount?: number
}

export interface RowerData extends BaseRecord, CommonFields {
  type: 'rower'
  strokeRate?: number
  strokeCount?: number
  averageStrokeRate?: number
  distanceM?: number
  /** Seconds per 500 m. */
  paceS?: number
  averagePaceS?: number
  powerW?: number
  averagePowerW?: number
  resistanceLevel?: number
}

export interface IndoorBikeData extends BaseRecord, CommonFields {
  type: 'indoorBike'
  speedKmh?: number
  averageSpeedKmh?: number
  cadenceRpm?: number
  averageCadenceRpm?: number
  distanceM?: number
  resistanceLevel?: number
  powerW?: number
  averagePowerW?: number
}

export type MachineData =
  TreadmillData | CrossTrainerData | StepClimberData | StairClimberData | RowerData | IndoorBikeData

export type MachineDataFor<T extends MachineType> = Extract<MachineData, { type: T }>

// ---------------------------------------------------------------------------------------------
// Schemas.
//
// Flag bits, polarity, field order and the "Data Not Available" sentinels come from the FTMS spec
// PDF (Tables 4.5-4.10, §4.4.1). Field sizes, units, resolutions and Flags widths come from the
// Bluetooth SIG GATT Specification Supplement (GSS) files, the machine-readable source the PDF
// defers to: https://bitbucket.org/bluetooth-SIG/public/src/main/gss/
// (org.bluetooth.characteristic.{treadmill,cross_trainer,step_climber,stair_climber,rower,indoor_bike}_data.yaml).
// Cross Trainer Data has a 24-bit Flags field; the others are 16-bit.
//
// Where the GSS gives a unit but no resolution, no scaling is applied (for example elevation gain
// outside the treadmill is whole metres, and the stair climber stride count is whole strides).
// The treadmill's metabolic equivalent has no stated resolution; 0.1 is used like every other type.
// The GSS defines no "Data Not Available" values; the sentinels below are the PDF's.
// ---------------------------------------------------------------------------------------------

const NA16 = 0xffff
const NAS16 = 0x7fff

const f = (key: string, type: FieldDef['type'], div?: number, na?: number): FieldDef => ({
  key,
  type,
  ...(div ? { div } : {}),
  ...(na === undefined ? {} : { na }),
})
const g = (bit: number, ...fields: FieldDef[]): GroupDef => ({ bit, fields })

const energy = (bit: number): GroupDef =>
  g(
    bit,
    f('totalEnergyKcal', 'u16', 1, NA16),
    f('energyPerHourKcal', 'u16', 1, NA16),
    f('energyPerMinuteKcal', 'u8', 1, 0xff),
  )
const heartRate = (bit: number) => g(bit, f('heartRateBpm', 'u8'))
const mets = (bit: number) => g(bit, f('mets', 'u8', 10))
const elapsed = (bit: number) => g(bit, f('elapsedS', 'u16'))
const remaining = (bit: number) => g(bit, f('remainingS', 'u16'))

// The tables are built by calls, which a bundler cannot prove free of side effects. Doing it inside a
// function and marking the single call pure lets an app that never touches machine data drop all of it.
const buildSchemas = (): Record<MachineType, DataSchema> => ({
  // Spec §4.4, Table 4.5
  treadmill: {
    flagBytes: 2,
    groups: [
      { bit: 0, presentWhenSet: false, fields: [f('speedKmh', 'u16', 100)] },
      g(1, f('averageSpeedKmh', 'u16', 100)),
      g(2, f('distanceM', 'u24')),
      g(3, f('inclinePercent', 's16', 10, NAS16), f('rampAngleDeg', 's16', 10, NAS16)),
      g(4, f('positiveElevationGainM', 'u16', 10), f('negativeElevationGainM', 'u16', 10)),
      g(5, f('paceS', 'u16')),
      g(6, f('averagePaceS', 'u16')),
      energy(7),
      heartRate(8),
      mets(9),
      elapsed(10),
      remaining(11),
      g(12, f('forceOnBeltN', 's16', 1, NAS16), f('powerW', 's16', 1, NAS16)),
    ],
  },
  // Spec §4.5, Table 4.6. Bit 15 = movement direction (no field).
  crossTrainer: {
    flagBytes: 3,
    groups: [
      { bit: 0, presentWhenSet: false, fields: [f('speedKmh', 'u16', 100)] },
      g(1, f('averageSpeedKmh', 'u16', 100)),
      g(2, f('distanceM', 'u24')),
      g(3, f('stepsPerMinute', 'u16'), f('averageStepRate', 'u16')),
      g(4, f('strideCount', 'u16', 10)),
      g(5, f('positiveElevationGainM', 'u16'), f('negativeElevationGainM', 'u16')),
      g(6, f('inclinePercent', 's16', 10, NAS16), f('rampAngleDeg', 's16', 10, NAS16)),
      g(7, f('resistanceLevel', 'u8')),
      g(8, f('powerW', 's16', 1, NAS16)),
      g(9, f('averagePowerW', 's16', 1, NAS16)),
      energy(10),
      heartRate(11),
      mets(12),
      elapsed(13),
      remaining(14),
    ],
  },
  // Spec §4.6, Table 4.7: bit 0 = 0 means Floors and Step Count are present.
  stepClimber: {
    flagBytes: 2,
    groups: [
      { bit: 0, presentWhenSet: false, fields: [f('floors', 'u16'), f('stepCount', 'u16')] },
      g(1, f('stepsPerMinute', 'u16')),
      g(2, f('averageStepRate', 'u16')),
      g(3, f('positiveElevationGainM', 'u16')),
      energy(4),
      heartRate(5),
      mets(6),
      elapsed(7),
      remaining(8),
    ],
  },
  // Spec §4.7, Table 4.8: bit 0 = 0 means Floors is present.
  stairClimber: {
    flagBytes: 2,
    groups: [
      { bit: 0, presentWhenSet: false, fields: [f('floors', 'u16')] },
      g(1, f('stepsPerMinute', 'u16')),
      g(2, f('averageStepRate', 'u16')),
      g(3, f('positiveElevationGainM', 'u16')),
      g(4, f('strideCount', 'u16')),
      energy(5),
      heartRate(6),
      mets(7),
      elapsed(8),
      remaining(9),
    ],
  },
  // Spec §4.8, Table 4.9: bit 0 = 0 means Stroke Rate and Stroke Count are present.
  rower: {
    flagBytes: 2,
    groups: [
      { bit: 0, presentWhenSet: false, fields: [f('strokeRate', 'u8', 2), f('strokeCount', 'u16')] },
      g(1, f('averageStrokeRate', 'u8', 2)),
      g(2, f('distanceM', 'u24')),
      g(3, f('paceS', 'u16')),
      g(4, f('averagePaceS', 'u16')),
      g(5, f('powerW', 's16', 1, NAS16)),
      g(6, f('averagePowerW', 's16', 1, NAS16)),
      g(7, f('resistanceLevel', 'u8')),
      energy(8),
      heartRate(9),
      mets(10),
      elapsed(11),
      remaining(12),
    ],
  },
  // Spec §4.9, Table 4.10
  indoorBike: {
    flagBytes: 2,
    groups: [
      { bit: 0, presentWhenSet: false, fields: [f('speedKmh', 'u16', 100)] },
      g(1, f('averageSpeedKmh', 'u16', 100)),
      g(2, f('cadenceRpm', 'u16', 2)),
      g(3, f('averageCadenceRpm', 'u16', 2)),
      g(4, f('distanceM', 'u24')),
      g(5, f('resistanceLevel', 'u8')),
      g(6, f('powerW', 's16', 1, NAS16)),
      g(7, f('averagePowerW', 's16', 1, NAS16)),
      energy(8),
      heartRate(9),
      mets(10),
      elapsed(11),
      remaining(12),
    ],
  },
})

export const SCHEMAS: Record<MachineType, DataSchema> = /* @__PURE__ */ buildSchemas()

/**
 * Some real machines send the Resistance Level field as 16 bits although the GSS says uint8
 * (observed on a Domyos rower; reported by others for bikes). The packet length gives it away:
 * parsed to the spec the packet comes up short or has bytes left over. We then retry with a 16-bit
 * resistance field and keep that only if it consumes the packet exactly.
 */
const wideCache: Partial<Record<MachineType, DataSchema | null>> = {}

/** The schema with a 16-bit resistance field, or null for machine types that have no resistance. Built on first use. */
function wideResistanceSchema(type: MachineType): DataSchema | null {
  if (!(type in wideCache)) {
    const schema = SCHEMAS[type]
    wideCache[type] = schema.groups.some((g) => g.fields.some((fl) => fl.key === 'resistanceLevel'))
      ? {
          ...schema,
          groups: schema.groups.map((g) => ({
            ...g,
            fields: g.fields.map((fl) =>
              fl.key === 'resistanceLevel' ? { ...fl, type: 's16' as const } : fl,
            ),
          })),
        }
      : null
  }
  return wideCache[type] ?? null
}

function parseAs<T extends MachineType>(type: T, bytes: Bytes): Result<MachineDataFor<T>> {
  let r = parseWithSchema(bytes, SCHEMAS[type])
  const wide = wideResistanceSchema(type)
  if (wide && (!r.ok || r.value.trailing)) {
    const retry = parseWithSchema(bytes, wide)
    if (retry.ok && !retry.value.trailing) r = retry
  }
  if (!r.ok) return r
  const record = { type, ...r.value } as Record<string, unknown> & BaseRecord
  if (type === 'crossTrainer') {
    // Bit 15 of the Flags field: 0 = forward, 1 = backward (Table 4.6).
    record.movementDirection = (record.flags & (1 << 15)) !== 0 ? 'backward' : 'forward'
  }
  return { ok: true, value: record as unknown as MachineDataFor<T> }
}

export const parseTreadmillData = (bytes: Bytes) => parseAs('treadmill', bytes)
export const parseCrossTrainerData = (bytes: Bytes) => parseAs('crossTrainer', bytes)
export const parseStepClimberData = (bytes: Bytes) => parseAs('stepClimber', bytes)
export const parseStairClimberData = (bytes: Bytes) => parseAs('stairClimber', bytes)
export const parseRowerData = (bytes: Bytes) => parseAs('rower', bytes)
export const parseIndoorBikeData = (bytes: Bytes) => parseAs('indoorBike', bytes)

/** Parse a data characteristic notification for any machine type. */
export function parseMachineData<T extends MachineType>(type: T, bytes: Bytes): Result<MachineDataFor<T>> {
  return parseAs(type, bytes)
}

/**
 * Combine the notifications of one split Data Record (spec §4.19). Later values win; `moreData`
 * and `flags` come from the last notification.
 */
export function mergeMachineData<T extends MachineData>(records: readonly T[]): T {
  const merged: Record<string, unknown> = {}
  for (const rec of records) {
    for (const [k, v] of Object.entries(rec)) if (v !== undefined) merged[k] = v
  }
  const last = records[records.length - 1]
  return { ...merged, moreData: last?.moreData ?? false, flags: last?.flags ?? 0 } as unknown as T
}

export const mergeTreadmillData = mergeMachineData<TreadmillData>

/** Encode a record into one or two data notifications. For simulators and tests. */
export function encodeMachineData(
  type: MachineType,
  values: Record<string, unknown>,
  options?: EncodeOptions,
): Uint8Array[] {
  const out = encodeWithSchema(values, SCHEMAS[type], options)
  if (type === 'crossTrainer' && values.movementDirection === 'backward') {
    out[out.length - 1][1] |= 0x80 // flags bit 15
  }
  return out
}

/** Identify the machine type from which data characteristic UUID a device exposes. */
export function machineTypeForCharacteristic(uuid: number): MachineType | undefined {
  return MACHINE_TYPES.find((t) => DATA_CHARACTERISTICS[t] === uuid)
}

/**
 * Service Data AD Type payload (spec §3.1): Flags (u8) then Fitness Machine Type (u16, one bit
 * per type, bit order = treadmill, cross trainer, step climber, stair climber, rower, indoor bike).
 * This is what `BluetoothDevice.watchAdvertisements()` exposes as `serviceData` for 0x1826.
 */
export function parseMachineTypeAdvertisement(
  bytes: Bytes,
): Result<{ available: boolean; types: MachineType[] }> {
  const b =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length < 3) {
    return {
      ok: false,
      error: { code: 'TRUNCATED', message: `Expected 3 bytes of service data, got ${b.length}` },
    }
  }
  const mask = b[1] | (b[2] << 8)
  const order: MachineType[] = [
    'treadmill',
    'crossTrainer',
    'stepClimber',
    'stairClimber',
    'rower',
    'indoorBike',
  ]
  return { ok: true, value: { available: (b[0] & 1) !== 0, types: order.filter((_, i) => (mask >> i) & 1) } }
}
