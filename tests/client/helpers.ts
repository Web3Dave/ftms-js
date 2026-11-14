import { FtmsClient, type ClientOptions, type FtmsEvents } from '../../src'
import { createSimulatedMachine, type SimulatedMachine, type SimulatorOptions } from '../../src/testing'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Connects to a simulated machine; a treadmill unless `type` says otherwise. */
export async function connect(simOptions: Partial<SimulatorOptions> = {}, clientOptions: ClientOptions = {}) {
  const sim = createSimulatedMachine({ type: 'treadmill', ...simOptions })
  const client = await FtmsClient.connect({ bluetooth: sim.bluetooth, ...clientOptions })
  return { sim, client }
}

/** Resolve with the next payload of an event. */
export function next<K extends keyof FtmsEvents>(
  client: FtmsClient,
  type: K,
  timeoutMs = 1000,
): Promise<FtmsEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${String(type)}"`)), timeoutMs)
    client.once(type, (p) => {
      clearTimeout(timer)
      resolve(p)
    })
  })
}

/** Collect every payload of an event into an array. */
export function collect<K extends keyof FtmsEvents>(client: FtmsClient, type: K): FtmsEvents[K][] {
  const out: FtmsEvents[K][] = []
  client.on(type, (p) => out.push(p))
  return out
}

export const ops = (sim: SimulatedMachine): number[] => sim.writes.map((w) => w[0])
export const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')
