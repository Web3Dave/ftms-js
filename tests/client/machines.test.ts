import { describe, expect, it } from 'vitest'
import {
  FtmsClient,
  MACHINE_LABELS,
  MACHINE_TYPES,
  encodeMachineData,
  parseMachineData,
  type MachineType,
} from '../../src'
import { createSimulatedMachine, type SimulatorOptions } from '../../src/testing'
import { collect, hexOf, next, ops, sleep } from './helpers'

async function connect(type: MachineType, options: Omit<SimulatorOptions, 'type'> = {}) {
  const sim = createSimulatedMachine({ type, ...options })
  const client = await FtmsClient.connect({ bluetooth: sim.bluetooth })
  return { sim, client }
}

// What each simulated machine can be controlled with, and one field that proves its data parsed.
const EXPECT: Record<MachineType, { key: string; can: Record<string, boolean> }> = {
  treadmill: {
    key: 'speedKmh',
    can: { speed: true, incline: true, resistance: false, power: false, bike: false },
  },
  crossTrainer: {
    key: 'stepsPerMinute',
    can: { speed: false, incline: true, resistance: true, power: false, bike: false },
  },
  stepClimber: {
    key: 'stepCount',
    can: { speed: false, incline: false, resistance: false, power: false, bike: false },
  },
  stairClimber: {
    key: 'floors',
    can: { speed: false, incline: false, resistance: false, power: false, bike: false },
  },
  rower: {
    key: 'strokeCount',
    can: { speed: false, incline: false, resistance: true, power: false, bike: false },
  },
  indoorBike: {
    key: 'cadenceRpm',
    can: { speed: false, incline: false, resistance: true, power: true, bike: true },
  },
}

describe.each(MACHINE_TYPES)('%s', (type) => {
  it('connects, identifies its machine type and reports what it can be controlled with', async () => {
    const { client } = await connect(type)
    const c = client.capabilities
    expect(client.machineType).toBe(type)
    expect(client.deviceName).toBe(`Simulated ${MACHINE_LABELS[type]}`)
    expect({
      speed: c.canSetSpeed,
      incline: c.canSetIncline,
      resistance: c.canSetResistance,
      power: c.canSetPower,
      bike: c.canSimulateBike,
    }).toEqual(EXPECT[type].can)
    await client.disconnect()
  })

  it('emits typed data records while the machine runs', async () => {
    const { sim, client } = await connect(type)
    await client.start()
    const events = collect(client, 'data')
    for (let i = 0; i < 6; i++) sim.tick(1)
    await sleep(30)
    expect(events.length).toBe(6)
    const last = events[events.length - 1]
    expect(last.type).toBe(type)
    expect(last.elapsedS).toBeGreaterThan(0)
    expect(EXPECT[type].key in last).toBe(true)
    await client.disconnect()
  })

  it('merges split records into one typed event', async () => {
    const { sim, client } = await connect(type, { splitRecords: true })
    await client.start()
    sim.tick(1)
    const events = collect(client, 'data')
    sim.tick(1)
    await sleep(20)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type, moreData: false })
    expect(EXPECT[type].key in events[0]).toBe(true)
    await client.disconnect()
  })

  it('start, pause, resume and stop work', async () => {
    const { sim, client } = await connect(type)
    await client.start()
    await client.pause()
    await client.start()
    await client.stop()
    expect(sim.writes.map(hexOf)).toEqual(['00', '07', '08 02', '07', '08 01'])
    await client.disconnect()
  })

  it('refuses commands the machine does not support, without sending anything', async () => {
    const { sim, client } = await connect(type)
    const can = EXPECT[type].can
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['speed', () => client.setSpeed(3)],
      ['incline', () => client.setIncline(1)],
      ['resistance', () => client.setResistance(1)],
      ['power', () => client.setPower(100)],
      [
        'bike',
        () => client.setIndoorBikeSimulation({ windSpeedMps: 0, gradePercent: 0, crr: 0.004, cw: 0.5 }),
      ],
    ]
    for (const [what, run] of attempts) {
      if (!can[what]) await expect(run()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    }
    expect(sim.writes).toHaveLength(0)
    await client.disconnect()
  })

  it('round-trips the simulator data through the parser with no loss of fields', async () => {
    const sim = createSimulatedMachine({ type })
    sim.running = true
    for (let i = 0; i < 10; i++) sim.tick(1)
    const record = sim.record()
    const [bytes] = encodeMachineData(type, record)
    const parsed = parseMachineData(type, bytes)
    expect(parsed.ok).toBe(true)
    // Every field the simulator sends must come back (allowing for wire rounding)
    for (const [k, v] of Object.entries(record)) {
      const got = (parsed.ok ? (parsed.value as unknown as Record<string, unknown>)[k] : undefined) as
        number | undefined
      expect(got, `${type}.${k}`).toBeDefined()
      expect(Math.abs((got as number) - (v as number)), `${type}.${k}`).toBeLessThanOrEqual(0.5)
    }
  })
})

describe('indoor bike controls', () => {
  it('sets resistance (uint8 in 0.1 units) and reports it', async () => {
    const { sim, client } = await connect('indoorBike')
    expect(client.capabilities.resistanceRange).toEqual({ min: 0, max: 20, step: 1 })
    await client.setResistance(5)
    expect(sim.writes.map(hexOf)).toEqual(['00', '04 32'])
    expect(sim.resistance).toBe(5)
    await client.disconnect()
  })

  it('sets a target power (ERG) and the bike follows it', async () => {
    const { sim, client } = await connect('indoorBike')
    expect(client.capabilities.powerRange).toEqual({ min: 0, max: 1000, step: 5 })
    const status = next(client, 'status')
    await client.start()
    await client.setPower(150)
    expect(await status).toEqual({ kind: 'startedOrResumed' })
    for (let i = 0; i < 10; i++) sim.tick(1)
    expect(sim.targetPower).toBe(150)
    expect(Math.round(sim.power)).toBe(150)
    await client.disconnect()
  })

  it('applies indoor bike simulation parameters and emits the status', async () => {
    const { sim, client } = await connect('indoorBike')
    const seen = collect(client, 'status')
    await client.setIndoorBikeSimulation({ windSpeedMps: 1.5, gradePercent: 4, crr: 0.004, cw: 0.51 })
    await sleep(10)
    expect(sim.bikeSim).toEqual({ windSpeedMps: 1.5, gradePercent: 4, crr: 0.004, cw: 0.51 })
    expect(seen).toContainEqual({
      kind: 'indoorBikeSimulationChanged',
      windSpeedMps: 1.5,
      gradePercent: 4,
      crr: 0.004,
      cw: 0.51,
    })
    await client.disconnect()
  })

  it('rejects out-of-range power before sending', async () => {
    const { sim, client } = await connect('indoorBike')
    await expect(client.setPower(5000)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    await expect(client.setResistance(99)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    expect(sim.writes).toHaveLength(0)
    await client.disconnect()
  })
})

describe('absolute targets', () => {
  it('jumps straight to a resistance level with a single write, not step by step', async () => {
    const { sim, client } = await connect('rower')
    await client.setResistance(1)
    const before = sim.writes.length
    await client.setResistance(5)
    expect(sim.writes.slice(before).map(hexOf)).toEqual(['04 32'])
    expect(sim.resistance).toBe(5)
    await client.disconnect()
  })
})

describe('other machine controls', () => {
  it('rower: sets resistance', async () => {
    const { sim, client } = await connect('rower')
    await client.setResistance(4)
    expect(ops(sim)).toEqual([0, 4])
    expect(sim.resistance).toBe(4)
    await client.disconnect()
  })

  it('cross trainer: sets resistance and incline', async () => {
    const { sim, client } = await connect('crossTrainer')
    await client.setResistance(6)
    await client.setIncline(3)
    expect(ops(sim)).toEqual([0, 4, 3])
    expect(sim.resistance).toBe(6)
    expect(sim.inclinePct).toBe(3)
    await client.disconnect()
  })

  it('heart rate targets are refused when the machine does not advertise them', async () => {
    const { sim, client } = await connect('indoorBike')
    await expect(client.setTargetHeartRate(140)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(sim.writes).toHaveLength(0)
    await client.disconnect()
  })
})
