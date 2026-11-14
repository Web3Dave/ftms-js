import { describe, expect, it } from 'vitest'
import { defaultScenario, firmwareId, fixturePath, modelId, scenarioId } from '../scripts/fixturePath.mjs'

const capture = (info: Record<string, string> | undefined, extra: Record<string, unknown> = {}) => ({
  machineType: 'treadmill',
  recordedAt: '2026-11-14T14:04:50.401Z',
  device: { name: 'URTM030', ...(info ? { info } : {}) },
  ...extra,
})

describe('fixturePath', () => {
  it('files a capture by machine type, model and firmware', () => {
    const c = capture({ model: 'URTM030', firmware: '43.49.96' })
    expect(fixturePath(c, 'speed-control')).toBe('treadmill/URTM030/URTM030__43.49.96__speed-control.json')
  })

  it('joins a multi-line firmware string, as the Domyos reports it', () => {
    const c = capture(
      { model: '8604435', firmware: 'Console: 2.5.0\r\nBluetooth: 2.6.0\r\nB805:2.5.0' },
      { machineType: 'rower' },
    )
    expect(firmwareId(c)).toBe('Console-2.5.0_Bluetooth-2.6.0_B805-2.5.0')
    expect(fixturePath(c, 'set resistance')).toBe(
      'rower/8604435/8604435__Console-2.5.0_Bluetooth-2.6.0_B805-2.5.0__set-resistance.json',
    )
  })

  it('falls back to the advertised name when there is no model, and marks a missing firmware', () => {
    const c = capture(undefined, { device: { name: 'Domyos-ROW-0000' } })
    expect(modelId(c)).toBe('Domyos-ROW-0000')
    expect(firmwareId(c)).toBe('unknown-firmware')
    expect(modelId({})).toBe('unknown-model')
  })

  it('keeps unsafe characters out of file names', () => {
    const c = capture({ model: '../../etc/passwd', firmware: 'v1/2 beta' })
    const path = fixturePath(c, '../Weird Name!')
    expect(path).not.toContain('..')
    expect(path.split('/')).toHaveLength(3)
  })

  it('defaults the scenario to the recording time so captures never collide', () => {
    const c = capture({ model: 'URTM030', firmware: '43.49.96' })
    expect(defaultScenario(c)).toBe('20261114-140450')
    expect(fixturePath(c)).toBe('treadmill/URTM030/URTM030__43.49.96__20261114-140450.json')
    expect(scenarioId('')).toBe('capture')
  })
})
