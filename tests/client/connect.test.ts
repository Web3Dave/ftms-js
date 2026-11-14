import { describe, expect, it } from 'vitest'
import { FtmsClient, FtmsError } from '../../src'
import { FakeDevice, FakeBluetooth, createSimulatedMachine } from '../../src/testing'
import { connect } from './helpers'

const failure = async (p: Promise<unknown>): Promise<FtmsError> => {
  try {
    await p
  } catch (e) {
    return e as FtmsError
  }
  throw new Error('expected rejection')
}

describe('FtmsClient.connect', () => {
  it('throws NO_BLUETOOTH when there is no Bluetooth object (importing never threw either)', async () => {
    const e = await failure(FtmsClient.connect())
    expect(e).toBeInstanceOf(FtmsError)
    expect(e.code).toBe('NO_BLUETOOTH')
  })

  it('requests the Fitness Machine service filter and always lists it as an optional service', async () => {
    const { sim, client } = await connect()
    expect(sim.fake.requests[0]).toEqual({
      filters: [{ services: [0x1826] }],
      optionalServices: [0x1826, 0x180a],
    })
    await client.disconnect()
  })

  it('keeps custom filters and extras, and still includes the FTMS optional service', async () => {
    const sim = createSimulatedMachine({ type: 'treadmill' })
    const client = await FtmsClient.connect({
      bluetooth: sim.bluetooth,
      filters: [{ namePrefix: 'Sim' }],
      optionalServices: ['battery_service'],
    })
    expect(sim.fake.requests[0]).toEqual({
      filters: [{ namePrefix: 'Sim' }],
      optionalServices: [0x1826, 0x180a, 'battery_service'],
    })
    await client.disconnect()
  })

  it('maps a dismissed chooser to CANCELLED and a blocked permission to BLUETOOTH_BLOCKED', async () => {
    const sim = createSimulatedMachine({ type: 'treadmill' })
    sim.fake.rejectWith = new DOMException('User cancelled', 'NotFoundError')
    expect((await failure(FtmsClient.connect({ bluetooth: sim.bluetooth }))).code).toBe('CANCELLED')
    sim.fake.rejectWith = new DOMException('blocked', 'SecurityError')
    expect((await failure(FtmsClient.connect({ bluetooth: sim.bluetooth }))).code).toBe('BLUETOOTH_BLOCKED')
  })

  it('exposes capabilities read from the device', async () => {
    const { client } = await connect()
    const c = client.capabilities
    expect(client.connected).toBe(true)
    expect(client.deviceName).toBe('Simulated Treadmill')
    expect(c.features?.targets).toMatchObject({ speed: true, inclination: true, power: false })
    expect(c.speedRange).toEqual({ min: 1, max: 6, step: 0.1 })
    expect(c.inclinationRange).toEqual({ min: 0, max: 10, step: 1 })
    expect(c).toMatchObject({ hasControlPoint: true, canSetSpeed: true, canSetIncline: true })
    await client.disconnect()
  })

  it('rejects a device without the FTMS service with NO_SERVICE and leaves no listeners behind', async () => {
    const device = new FakeDevice('Not a treadmill')
    device.gatt.addService(0x180f)
    const bt = new FakeBluetooth(device) as unknown as Bluetooth
    const e = await failure(FtmsClient.connect({ bluetooth: bt }))
    expect(e.code).toBe('NO_SERVICE')
    expect(device.listenerCount()).toBe(0)
    expect(device.gatt.connected).toBe(false)
  })

  it('connects to a non-treadmill machine and reports its type', async () => {
    const device = new FakeDevice('Bike')
    device.gatt.addService(0x1826).addCharacteristic({ uuid: 0x2ad2 })
    const client = await FtmsClient.connect({ bluetooth: new FakeBluetooth(device) as unknown as Bluetooth })
    expect(client.machineType).toBe('indoorBike')
    await client.disconnect()
  })

  it('rejects a service with no machine data characteristic as UNSUPPORTED_MACHINE', async () => {
    const device = new FakeDevice('Odd')
    device.gatt.addService(0x1826).addCharacteristic({ uuid: 0x2acc })
    const e = await failure(
      FtmsClient.connect({ bluetooth: new FakeBluetooth(device) as unknown as Bluetooth }),
    )
    expect(e.code).toBe('UNSUPPORTED_MACHINE')
    expect(device.listenerCount()).toBe(0)
  })

  it('times out a stuck GATT operation (configurable)', async () => {
    const sim = createSimulatedMachine({ type: 'treadmill', latencyMs: 200 })
    const e = await failure(FtmsClient.connect({ bluetooth: sim.bluetooth, gattTimeoutMs: 20 }))
    expect(e.code).toBe('TIMEOUT')
  })

  it('survives a feature read that cannot be parsed: capabilities unknown, commands not pre-refused', async () => {
    const { sim, client } = await connect({ features: undefined })
    // Simulate a device with a broken Feature characteristic by connecting to a fresh one.
    await client.disconnect()
    const device = sim.device
    const feature = [...device.gatt.services.values()][0].characteristics.get(
      '00002acc-0000-1000-8000-00805f9b34fb',
    )!
    feature.setReadValue(Uint8Array.of(1, 2, 3))
    const again = await FtmsClient.connect({ bluetooth: sim.bluetooth })
    expect(again.capabilities.features).toBeNull()
    expect(again.capabilities.canSetSpeed).toBe(true)
    await again.disconnect()
  })
})
