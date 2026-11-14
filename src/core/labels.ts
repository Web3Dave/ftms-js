import type { MachineType } from './machineData'

/** Human-readable names for the machine types, e.g. for a picker or a heading. */
export const MACHINE_LABELS: Readonly<Record<MachineType, string>> = {
  treadmill: 'Treadmill',
  crossTrainer: 'Cross Trainer',
  stepClimber: 'Step Climber',
  stairClimber: 'Stair Climber',
  rower: 'Rower',
  indoorBike: 'Indoor Bike',
}
