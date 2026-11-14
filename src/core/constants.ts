// Source of truth: Bluetooth SIG "Fitness Machine Service" v1.0.1 (docs/FTMS_v1.0.1.pdf).
//
// UNVERIFIED AGAINST THE PDF: the 16-bit UUIDs below. The spec defers them to the Bluetooth
// Assigned Numbers site, which is not part of the PDF. They are the commonly published values.

export const FTMS_SERVICE = 0x1826

export const CHARACTERISTICS = {
  feature: 0x2acc,
  treadmillData: 0x2acd,
  trainingStatus: 0x2ad3,
  supportedSpeedRange: 0x2ad4,
  supportedInclinationRange: 0x2ad5,
  supportedResistanceRange: 0x2ad6,
  supportedHeartRateRange: 0x2ad7,
  supportedPowerRange: 0x2ad8,
  controlPoint: 0x2ad9,
  machineStatus: 0x2ada,
} as const

/** One data characteristic per machine type (spec §4.4-4.9). UUIDs are UNVERIFIED AGAINST THE PDF, like the rest. */
export const DATA_CHARACTERISTICS = {
  treadmill: 0x2acd,
  crossTrainer: 0x2ace,
  stepClimber: 0x2acf,
  stairClimber: 0x2ad0,
  rower: 0x2ad1,
  indoorBike: 0x2ad2,
} as const

/** Control Point op codes (spec Table 4.15). Only the ones this library encodes. */
export const ControlOp = {
  RequestControl: 0x00,
  Reset: 0x01,
  SetTargetSpeed: 0x02,
  SetTargetInclination: 0x03,
  SetTargetResistance: 0x04,
  SetTargetPower: 0x05,
  SetTargetHeartRate: 0x06,
  StartOrResume: 0x07,
  StopOrPause: 0x08,
  SetIndoorBikeSimulation: 0x11,
  ResponseCode: 0x80,
} as const
export type ControlOpValue = (typeof ControlOp)[keyof typeof ControlOp]

/** Control Point result codes (spec Table 4.24). */
export const ResultCode = {
  Success: 0x01,
  OpCodeNotSupported: 0x02,
  InvalidParameter: 0x03,
  OperationFailed: 0x04,
  ControlNotPermitted: 0x05,
} as const
