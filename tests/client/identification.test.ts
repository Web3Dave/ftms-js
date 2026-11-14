import { describe, expect, it } from 'vitest'
import { FtmsClient, type RawEvent } from '../../src'
import { createSimulatedMachine } from '../../src/testing'
import { collect, sleep } from './helpers'

describe('onRaw', () => {
  it('sees the reads made while connecting, which on("raw") cannot', async () => {
    const sim = createSimulatedMachine({ type: 'rower' })
    const seen: RawEvent[] = []
    const client = await FtmsClient.connect({ bluetooth: sim.bluetooth, onRaw: (e) => seen.push(e) })
    const late = collect(client, 'raw')
    const reads = seen.filter((e) => e.direction === 'read').map((e) => e.characteristic)
    expect(reads).toEqual(expect.arrayContaining(['feature', 'resistanceRange']))
    expect(late.filter((e) => e.direction === 'read')).toHaveLength(0)
    await client.disconnect()
  })

  it('keeps receiving notifications and control point traffic', async () => {
    const sim = createSimulatedMachine({ type: 'rower' })
    const seen: RawEvent[] = []
    const client = await FtmsClient.connect({ bluetooth: sim.bluetooth, onRaw: (e) => seen.push(e) })
    await client.start()
    sim.tick()
    await sleep(10)
    const kinds = seen.map((e) => `${e.characteristic}/${e.direction}`)
    expect(kinds).toEqual(expect.arrayContaining(['controlPoint/out', 'controlPoint/in', 'machineData/in']))
    await client.disconnect()
  })
})

describe('deviceInfo', () => {
  it('reads manufacturer, model and firmware from the Device Information service', async () => {
    const sim = createSimulatedMachine({
      type: 'rower',
      deviceInfo: { manufacturer: 'Domyos', model: 'WOOD ROWER', firmware: '1.2.3' },
    })
    const client = await FtmsClient.connect({ bluetooth: sim.bluetooth })
    expect(client.deviceInfo).toEqual({ manufacturer: 'Domyos', model: 'WOOD ROWER', firmware: '1.2.3' })
    await client.disconnect()
  })

  it('is empty, and does not fail the connection, when the service is missing', async () => {
    const sim = createSimulatedMachine({ type: 'rower' })
    const client = await FtmsClient.connect({ bluetooth: sim.bluetooth })
    expect(client.deviceInfo).toEqual({})
    expect(client.connected).toBe(true)
    await client.disconnect()
  })
})

describe('rower that sends a 16-bit resistance level', () => {
  it('delivers correct data events end to end', async () => {
    const sim = createSimulatedMachine({ type: 'rower', wideResistance: true })
    const client = await FtmsClient.connect({ bluetooth: sim.bluetooth })
    await client.setResistance(3)
    await client.start()
    const events = collect(client, 'data')
    for (let i = 0; i < 4; i++) sim.tick(1)
    await sleep(20)
    expect(events).toHaveLength(4)
    const last = events[3]
    expect(last.type === 'rower' && last.resistanceLevel).toBe(3)
    expect(last.elapsedS).toBe(4)
    expect(last.trailing).toBeUndefined()
    await client.disconnect()
  })

  it('reads a 16-bit resistance range and sends targets in 0.1 units', async () => {
    const sim = createSimulatedMachine({
      type: 'rower',
      wideResistance: true,
      resistanceRange: { min: 1, max: 15, step: 1 },
    })
    const client = await FtmsClient.connect({ bluetooth: sim.bluetooth })
    expect(client.capabilities.resistanceRange).toEqual({ min: 1, max: 15, step: 1 })
    const status = collect(client, 'status')
    await client.setResistance(2)
    await sleep(10)
    expect(Array.from(sim.writes[sim.writes.length - 1])).toEqual([0x04, 0x14])
    expect(status).toContainEqual({ kind: 'targetResistanceChanged', level: 2 })
    await expect(client.setResistance(16)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    await client.disconnect()
  })
})
