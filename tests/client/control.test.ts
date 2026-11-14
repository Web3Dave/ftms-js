import { describe, expect, it } from 'vitest'
import { FtmsError, ResultCode } from '../../src'
import { collect, connect, hexOf, ops, sleep } from './helpers'

describe('control commands', () => {
  it('requests control once, then sends the command', async () => {
    const { sim, client } = await connect()
    await client.start()
    await client.setSpeed(3.5)
    await client.setIncline(4)
    expect(sim.writes.map(hexOf)).toEqual(['00', '07', '02 5e 01', '03 28 00'])
    expect(client.hasControl).toBe(true)
    expect(sim.running).toBe(true)
    expect(sim.targetKmh).toBe(3.5)
    expect(sim.inclinePct).toBe(4)
    await client.disconnect()
  })

  it('encodes pause and stop', async () => {
    const { sim, client } = await connect()
    await client.start()
    await client.pause()
    await client.start() // resume
    await client.stop()
    expect(sim.writes.map(hexOf)).toEqual(['00', '07', '08 02', '07', '08 01'])
    await client.disconnect()
  })

  it('resolves with the op and result code', async () => {
    const { client } = await connect()
    expect(await client.requestControl()).toMatchObject({ requestOp: 0, result: ResultCode.Success })
    await client.disconnect()
  })

  it('does not request control automatically when autoRequestControl is false', async () => {
    const { sim, client } = await connect({}, { autoRequestControl: false })
    await expect(client.start()).rejects.toMatchObject({ code: 'CONTROL_NOT_PERMITTED' })
    expect(sim.writes.map(hexOf)).toEqual(['07'])
    await client.requestControl()
    await client.start()
    await client.disconnect()
  })

  it('maps device result codes to typed errors', async () => {
    const cases: Array<[number, string]> = [
      [ResultCode.OpCodeNotSupported, 'NOT_SUPPORTED'],
      [ResultCode.InvalidParameter, 'INVALID_PARAMETER'],
      [ResultCode.OperationFailed, 'OPERATION_FAILED'],
      [ResultCode.ControlNotPermitted, 'CONTROL_NOT_PERMITTED'],
      [0x09, 'UNKNOWN_RESULT'],
    ]
    for (const [result, code] of cases) {
      const { client } = await connect({ responses: { 0x07: result } })
      const e = (await client.start().catch((x) => x)) as FtmsError
      expect(e).toBeInstanceOf(FtmsError)
      expect(e.code).toBe(code)
      expect(e.resultCode).toBe(result)
      await client.disconnect()
    }
  })

  it('surfaces a device-side failure (e.g. setting speed while the belt is stopped)', async () => {
    const { client } = await connect()
    await expect(client.setSpeed(3)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await client.disconnect()
  })

  it('refuses out-of-range targets before sending anything', async () => {
    const { sim, client } = await connect()
    await expect(client.setSpeed(10)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    await expect(client.setSpeed(0.2)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    await expect(client.setSpeed(NaN)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    await expect(client.setIncline(11)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' })
    expect(sim.writes).toHaveLength(0)
    await client.disconnect()
  })

  it('refuses commands the machine does not support before sending anything', async () => {
    const { sim, client } = await connect({ features: { targets: 0b01 } }) // speed only
    expect(client.capabilities).toMatchObject({ canSetSpeed: true, canSetIncline: false })
    await expect(client.setIncline(2)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(sim.writes).toHaveLength(0)
    await client.disconnect()

    const none = await connect({ features: { targets: 0 } })
    await expect(none.client.setSpeed(3)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(none.sim.writes).toHaveLength(0)
    await none.client.disconnect()
  })

  it('reports NOT_SUPPORTED for every command when the machine has no control point', async () => {
    const { client } = await connect({ controlPoint: false })
    expect(client.capabilities.hasControlPoint).toBe(false)
    await expect(client.start()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(client.setSpeed(3)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await client.disconnect()
  })

  it('times out when the device never answers, and the next command still works', async () => {
    const { sim, client } = await connect({ responses: { 0x07: 'silent' } }, { commandTimeoutMs: 40 })
    await expect(client.start()).rejects.toMatchObject({ code: 'TIMEOUT' })
    await expect(client.requestControl()).resolves.toMatchObject({ result: ResultCode.Success })
    expect(ops(sim)).toEqual([0, 7, 0])
    await client.disconnect()
  })

  it('serializes overlapping calls: no overlapping GATT operations, strict order', async () => {
    const { sim, client } = await connect()
    const results = await Promise.all([
      client.start(),
      client.setSpeed(3),
      client.setIncline(2),
      client.requestControl(),
    ])
    expect(results).toHaveLength(4)
    expect(sim.device.overlaps).toBe(0)
    expect(ops(sim)).toEqual([0x00, 0x07, 0x02, 0x03, 0x00])
    await client.disconnect()
  })

  it('does not overlap commands with notification traffic either', async () => {
    const { sim, client } = await connect()
    sim.startClock()
    await Promise.all([client.start(), client.setSpeed(2)])
    sim.stopClock()
    expect(sim.device.overlaps).toBe(0)
    await client.disconnect()
  })

  describe('control permission', () => {
    it('clears hasControl when the machine reports Control Permission Lost, and re-requests next time', async () => {
      const { sim, client } = await connect()
      await client.start()
      expect(client.hasControl).toBe(true)
      sim.loseControl()
      await sleep(10)
      expect(client.hasControl).toBe(false)
      await client.pause()
      expect(ops(sim)).toEqual([0, 7, 0, 8])
      await client.disconnect()
    })

    it('retries once after "control not permitted" when it lost control silently', async () => {
      const { sim, client } = await connect()
      await client.start()
      sim.hasControl = false // revoked without any notification reaching us
      await client.pause()
      expect(ops(sim)).toEqual([0, 7, 8, 0, 8])
      expect(sim.paused).toBe(true)
      await client.disconnect()
    })

    it('gives up with CONTROL_NOT_PERMITTED when control is genuinely denied', async () => {
      const { sim, client } = await connect({ denyControl: true })
      await expect(client.start()).rejects.toMatchObject({ code: 'CONTROL_NOT_PERMITTED' })
      expect(ops(sim)).toEqual([0])
      await client.disconnect()
    })

    it('needs control again after reset()', async () => {
      const { sim, client } = await connect()
      await client.start()
      await client.reset()
      expect(client.hasControl).toBe(false)
      await client.start()
      expect(ops(sim)).toEqual([0, 7, 1, 0, 7])
      await client.disconnect()
    })
  })
})

describe('a machine that ignores Start during its post-workout summary (Urevo Strol 2E)', () => {
  it('acknowledges Start with success but does nothing until the machine reports idle', async () => {
    const { sim, client } = await connect({ postWorkoutMs: 120 })
    const training = collect(client, 'trainingStatus')
    const status = collect(client, 'status')
    await client.start()
    await client.stop()
    await sleep(20)
    expect(training.map((t) => t.name)).toEqual(['manualMode', 'postWorkout'])

    status.length = 0
    await expect(client.start()).resolves.toMatchObject({ result: 1 }) // success...
    await sleep(20)
    expect(sim.running).toBe(false) // ...but nothing happened
    expect(status.some((s) => s.kind === 'startedOrResumed')).toBe(false)

    await sleep(140)
    expect(training.map((t) => t.name)).toEqual(['manualMode', 'postWorkout', 'idle'])
    await client.start()
    await sleep(20)
    expect(sim.running).toBe(true)
    expect(status.some((s) => s.kind === 'startedOrResumed')).toBe(true)
    await client.disconnect()
  })
})
