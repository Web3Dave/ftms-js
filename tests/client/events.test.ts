import { describe, expect, it } from 'vitest'
import { FtmsError } from '../../src'
import { collect, connect, next, sleep } from './helpers'

describe('events', () => {
  it('emits parsed treadmill data', async () => {
    const { sim, client } = await connect()
    const p = next(client, 'data')
    sim.speedKmh = 3.2
    sim.distanceM = 500
    sim.notifyData()
    const d = await p
    expect(d).toMatchObject({
      speedKmh: 3.2,
      distanceM: 500,
      inclinePercent: 0,
      elapsedS: 0,
      moreData: false,
    })
    await client.disconnect()
  })

  it('merges a record split over two notifications into one data event (spec §4.19)', async () => {
    const { sim, client } = await connect({ splitRecords: true })
    const events = collect(client, 'data')
    sim.speedKmh = 4
    sim.distanceM = 1000
    sim.elapsedS = 60
    sim.notifyData()
    await sleep(20)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ speedKmh: 4, distanceM: 1000, elapsedS: 60, moreData: false })
    await client.disconnect()
  })

  it('emits machine status and training status', async () => {
    const { client } = await connect()
    const status = collect(client, 'status')
    const training = collect(client, 'trainingStatus')
    await client.start()
    await sleep(20)
    expect(status).toEqual([{ kind: 'startedOrResumed' }])
    expect(training[0]).toMatchObject({ name: 'manualMode' })
    await client.disconnect()
  })

  it('reports unparseable packets as PARSE_ERROR events without throwing or emitting data', async () => {
    const { sim, client } = await connect()
    const errors = collect(client, 'error')
    const data = collect(client, 'data')
    sim.characteristics.data.emitValue(Uint8Array.of(0x04, 0x00, 0x64)) // distance flag, speed cut short
    await sleep(5)
    expect(data).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(FtmsError)
    expect(errors[0].code).toBe('PARSE_ERROR')
    await client.disconnect()
  })

  it('emits raw hex events for notifications and control point traffic, in both directions', async () => {
    const { sim, client } = await connect()
    const raw = collect(client, 'raw')
    await client.requestControl()
    sim.notifyData()
    await sleep(5)
    const summary = raw.map((r) => `${r.characteristic}/${r.direction}`)
    expect(summary).toContain('controlPoint/out')
    expect(summary).toContain('controlPoint/in')
    expect(summary).toContain('machineData/in')
    expect(
      Array.from(raw.find((r) => r.characteristic === 'controlPoint' && r.direction === 'out')!.bytes),
    ).toEqual([0])
    expect(
      Array.from(raw.find((r) => r.characteristic === 'controlPoint' && r.direction === 'in')!.bytes),
    ).toEqual([0x80, 0, 1])
    await client.disconnect()
  })

  it('a throwing listener does not stop other listeners', async () => {
    const { sim, client } = await connect()
    const seen: string[] = []
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.once('uncaughtException', onUncaught)
    client.on('data', () => {
      throw new Error('boom')
    })
    client.on('data', (d) => seen.push(d.type))
    sim.notifyData()
    await sleep(10)
    process.off('uncaughtException', onUncaught)
    expect(seen).toHaveLength(1)
    expect(uncaught).toHaveLength(1)
    await client.disconnect()
  })
})
