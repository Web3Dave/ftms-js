import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fromHex,
  parseControlResponse,
  parseFeature,
  parseMachineStatus,
  parseRange,
  parseTrainingStatus,
  parseMachineData,
  type MachineType,
} from '../src'
import { fixturePath } from '../scripts/fixturePath.mjs'

describe('package', () => {
  it('imports under Node (no navigator/window access at load time) and exposes the API', async () => {
    const lib = await import('../src')
    expect(typeof lib.FtmsClient.connect).toBe('function')
    expect(typeof lib.parseTreadmillData).toBe('function')
    const testing = await import('../src/testing')
    expect(typeof testing.createSimulatedMachine).toBe('function')
  })
})

// Replay real-device captures recorded with the demo (`pnpm capture`). Every recorded packet
// must parse. Add captures under fixtures/ to grow this suite.
interface Capture {
  device?: { name?: string; info?: Record<string, string> }
  machineType?: MachineType
  recordedAt?: string
  entries: Array<{ characteristic: string; direction: string; hex: string }>
}

const dir = join(__dirname, '..', 'fixtures')
// Fixtures are filed as <machineType>/<model>/<model>__<firmware>__<scenario>.json
// fixtures/ is git-ignored (captures carry device names), so a fresh clone has none: skip then.
const files = (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]) : [])
  .map((f) => f.split('\\').join('/'))
  .filter((f) => f.endsWith('.json'))
  .sort()

describe.skipIf(files.length === 0)('replay of recorded captures', () => {
  for (const file of files) {
    it(file, () => {
      const cap = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Capture

      // The path must say what the capture is: machine type, model and firmware come from its own data.
      const scenario = basename(file, '.json').split('__')[2]
      expect(file, 'file is not where its own device data says it belongs').toBe(fixturePath(cap, scenario))

      const failures: string[] = []
      for (const [i, e] of cap.entries.entries()) {
        const bytes = fromHex(e.hex)
        const result =
          e.characteristic === 'machineData' || e.characteristic === 'treadmillData'
            ? parseMachineData(cap.machineType ?? 'treadmill', bytes)
            : e.characteristic === 'trainingStatus'
              ? parseTrainingStatus(bytes)
              : e.characteristic === 'machineStatus'
                ? parseMachineStatus(bytes)
                : e.characteristic === 'feature'
                  ? parseFeature(bytes)
                  : e.characteristic === 'speedRange'
                    ? parseRange(bytes, 'speed')
                    : e.characteristic === 'inclinationRange'
                      ? parseRange(bytes, 'inclination')
                      : e.characteristic === 'resistanceRange'
                        ? parseRange(bytes, 'resistance')
                        : e.characteristic === 'powerRange'
                          ? parseRange(bytes, 'power')
                          : e.characteristic === 'heartRateRange'
                            ? parseRange(bytes, 'heartRate')
                            : e.characteristic === 'controlPoint' && e.direction === 'in'
                              ? parseControlResponse(bytes)
                              : { ok: true as const, value: {} }
        if (!result.ok) failures.push(`#${i} ${e.characteristic}: ${e.hex}`)
        // A data packet with bytes left over means a field is misread (this caught a 16-bit resistance level).
        else if ((result.value as { trailing?: unknown }).trailing) {
          failures.push(`#${i} ${e.characteristic} left unparsed bytes: ${e.hex}`)
        }
      }
      expect(failures).toEqual([])
    })
  }
})
