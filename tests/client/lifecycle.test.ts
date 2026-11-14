import { describe, expect, it } from 'vitest'
import { collect, connect, next, sleep } from './helpers'

describe('disconnect()', () => {
  it('stops notifications, removes every listener, drops the link and emits "disconnected"', async () => {
    const { sim, client } = await connect()
    const chars = Object.values(sim.characteristics).filter((c) => c !== null)
    expect(chars.every((c) => c.isNotifying && c.listenerCount() === 1)).toBe(true)
    expect(sim.device.listenerCount()).toBe(1)

    const events = collect(client, 'disconnected')
    await client.disconnect()

    expect(
      chars.every((c) => !c.isNotifying && c.stopNotificationsCalls === 1 && c.listenerCount() === 0),
    ).toBe(true)
    expect(sim.device.listenerCount()).toBe(0)
    expect(sim.device.gatt.connected).toBe(false)
    expect(client.connected).toBe(false)
    expect(events).toEqual([{ reason: 'user', willReconnect: false }])
  })

  it('is idempotent', async () => {
    const { client } = await connect()
    const events = collect(client, 'disconnected')
    await client.disconnect()
    await client.disconnect()
    expect(events).toHaveLength(1)
  })

  it('makes later commands fail with NOT_CONNECTED', async () => {
    const { client } = await connect()
    await client.disconnect()
    await expect(client.start()).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('rejects a command that is waiting for a response with DISCONNECTED', async () => {
    const { client } = await connect({ responses: { 0x07: 'silent' } }, { commandTimeoutMs: 5000 })
    const pending = client.start().catch((e) => e)
    await sleep(30)
    await client.disconnect()
    expect(await pending).toMatchObject({ code: 'DISCONNECTED' })
  })
})

describe('link loss', () => {
  it('emits "disconnected", cleans up, and fails in-flight commands', async () => {
    const { sim, client } = await connect({ responses: { 0x07: 'silent' } }, { commandTimeoutMs: 5000 })
    const gone = next(client, 'disconnected')
    const pending = client.start().catch((e) => e)
    await sleep(30)
    sim.device.simulateLinkLoss()
    expect(await gone).toEqual({ reason: 'link-lost', willReconnect: false })
    expect(await pending).toMatchObject({ code: 'DISCONNECTED' })
    expect(client.connected).toBe(false)
    expect(sim.characteristics.data.listenerCount()).toBe(0)
    await expect(client.setSpeed(3)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })
})

describe('autoReconnect', () => {
  it('retries with exponential backoff, resubscribes, and resumes data', async () => {
    const { sim, client } = await connect(
      {},
      { autoReconnect: { initialDelayMs: 10, factor: 2, maxAttempts: 4 } },
    )
    const timeline: string[] = []
    const reconnecting: Array<{ attempt: number; delayMs: number }> = []
    client.on('disconnected', (d) => timeline.push(`disconnected willReconnect=${d.willReconnect}`))
    client.on('reconnecting', (r) => {
      reconnecting.push(r)
      timeline.push(`reconnecting ${r.attempt}`)
    })
    client.on('error', (e) => timeline.push(`error ${e.code}`))
    const back = next(client, 'reconnected', 2000)

    sim.device.failNextConnects = 2
    sim.device.simulateLinkLoss()
    await back

    expect(timeline).toEqual([
      'disconnected willReconnect=true',
      'reconnecting 1',
      'error GATT_ERROR',
      'reconnecting 2',
      'error GATT_ERROR',
      'reconnecting 3',
    ])
    expect(reconnecting.map((r) => r.delayMs)).toEqual([10, 20, 40])
    expect(client.connected).toBe(true)
    expect(client.hasControl).toBe(false)

    const d = next(client, 'data')
    sim.tick()
    expect((await d).moreData).toBe(false)
    await client.start() // control is requested again on the new connection
    expect(sim.running).toBe(true)
    await client.disconnect()
  })

  it('gives up after maxAttempts with reason "reconnect-failed"', async () => {
    const { sim, client } = await connect(
      {},
      { autoReconnect: { initialDelayMs: 5, factor: 1, maxAttempts: 2 } },
    )
    const events = collect(client, 'disconnected')
    sim.device.failNextConnects = 10
    sim.device.simulateLinkLoss()
    await sleep(150)
    expect(events).toEqual([
      { reason: 'link-lost', willReconnect: true },
      { reason: 'reconnect-failed', willReconnect: false },
    ])
    expect(sim.device.connectCalls).toBe(1 + 2)
  })

  it('stops retrying when disconnect() is called during backoff', async () => {
    const { sim, client } = await connect({}, { autoReconnect: { initialDelayMs: 50, maxAttempts: 5 } })
    sim.device.simulateLinkLoss()
    await sleep(10)
    await client.disconnect()
    await sleep(120)
    expect(sim.device.connectCalls).toBe(1)
    expect(sim.device.gatt.connected).toBe(false)
  })
})
