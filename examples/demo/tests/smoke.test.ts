// Drives the real demo page (src/main.ts) in jsdom with the built-in simulator for every machine type.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8')
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

const cells = () =>
  Array.from($('readout').children).map((c) => [
    c.querySelector('span')!.textContent,
    c.querySelector('b')!.textContent,
  ])
const buttons = () => ({
  start: $('start').textContent,
  startOff: $<HTMLButtonElement>('start').disabled,
  pauseOff: $<HTMLButtonElement>('pause').disabled,
  stopOff: $<HTMLButtonElement>('stop').disabled,
})
const adjusters = () => Array.from($('adjust').querySelectorAll('.name')).map((n) => n.textContent)

const EXPECTED: Record<string, { labels: string[]; adjust: string[]; caps: string[] }> = {
  treadmill: {
    labels: ['km/h', 'km', 'time', 'incline %', 'kcal'],
    adjust: ['Speed', 'Incline'],
    caps: ['speed: 1 to 6 km/h (advertised step 0.1)', 'incline: 0 to 10 % (advertised step 1)'],
  },
  indoorBike: {
    labels: ['km/h', 'rpm', 'watts', 'resistance'],
    adjust: ['Resistance', 'Target power', 'Simulated grade'],
    caps: [
      'resistance: 0 to 20 (advertised step 1)',
      'power: 0 to 1000 W (advertised step 5)',
      'indoor bike simulation',
    ],
  },
  rower: {
    labels: ['strokes/min', 'strokes', '/500 m', 'watts'],
    adjust: ['Resistance'],
    caps: ['resistance: 0 to 20 (advertised step 1)'],
  },
  crossTrainer: {
    labels: ['km/h', 'steps/min', 'strides', 'watts'],
    adjust: ['Incline', 'Resistance'],
    caps: ['incline:', 'resistance:'],
  },
  stepClimber: {
    labels: ['floors', 'steps', 'steps/min', 'm climbed'],
    adjust: [],
    caps: ['nothing; start, pause and stop only'],
  },
  stairClimber: {
    labels: ['floors', 'steps/min', 'strides', 'm climbed'],
    adjust: [],
    caps: ['nothing; start, pause and stop only'],
  },
}

describe('demo page with the simulator', () => {
  beforeAll(async () => {
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'))
    await import('../src/main')
  })

  it('offers all six machine types', () => {
    const values = Array.from($<HTMLSelectElement>('machine').options).map((o) => o.value)
    expect(values).toEqual([
      'treadmill',
      'crossTrainer',
      'stepClimber',
      'stairClimber',
      'rower',
      'indoorBike',
    ])
  })

  for (const [type, want] of Object.entries(EXPECTED)) {
    it(`simulates a ${type}: right readout, right controls, live data`, async () => {
      $<HTMLSelectElement>('machine').value = type
      $('simulate').click()
      await until(() => $('state').textContent!.startsWith('Connected'))

      const labels = cells().map((c) => c[0])
      for (const l of want.labels) expect(labels).toContain(l)
      expect(adjusters()).toEqual(want.adjust)
      expect($('caps').hidden).toBe(false)
      for (const text of want.caps) expect($('capsBody').textContent).toContain(text)
      expect($('machine').hasAttribute('disabled')).toBe(true)

      // freshly connected simulator is stopped: only Start can do anything
      expect($('runState').textContent).toBe('● Stopped')
      expect(buttons()).toEqual({ start: 'Start', startOff: false, pauseOff: true, stopOff: true })

      if (type === 'treadmill') {
        // Pressing speed up before Start is the first thing people try. The machine refuses it, and the
        // page should say why instead of just "OPERATION_FAILED".
        const hint = document.querySelector<HTMLElement>('.adjust .hint')!
        expect(hint.hidden).toBe(false)
        expect(hint.textContent).toContain('Press Start first')
        const speedRow = document.querySelector('.adjust .item')!
        const out = speedRow.querySelector('output')!
        Array.from(speedRow.querySelectorAll('button'))
          .find((b) => b.textContent!.startsWith('+'))!
          .click()
        await until(() => $('message').className.includes('err'))
        expect($('message').textContent).toContain('Press Start first')
        expect($('message').textContent).toContain('OPERATION_FAILED')
        expect(out.textContent).toBe('–') // the refused value does not stay on screen
      }

      $('start').click()
      await until(() => $('message').textContent === 'Started')
      await until(() => $('runState').textContent === '● Running')
      expect(buttons()).toEqual({ start: 'Start', startOff: true, pauseOff: false, stopOff: false })
      for (const hint of Array.from(document.querySelectorAll<HTMLElement>('.adjust .hint'))) {
        expect(hint.hidden).toBe(true) // running: nothing to explain
      }
      // the simulator ticks once a second; wait for a record that has a value in every cell it fills
      await until(() => cells().some((c) => c[1] !== '–'), 3000)
      expect($('log').textContent).toContain(`machine type ${type}`)
      // reads made while connecting are recorded too (onRaw), not just later notifications
      expect($('log').textContent).toMatch(/·\s+feature/)

      // every adjuster responds
      for (const b of Array.from($('adjust').querySelectorAll('button')).filter((b) =>
        b.textContent!.startsWith('+'),
      )) {
        b.click()
        await until(
          () => !$('message').textContent!.includes('Error') && $('message').textContent !== 'Started',
        )
        expect($('message').className).not.toContain('err')
      }

      // jump straight to a value with the number box
      for (const row of Array.from($('adjust').querySelectorAll('.item'))) {
        const input = row.querySelector('input')!
        input.value = input.min
        Array.from(row.querySelectorAll('button'))
          .find((b) => b.textContent === 'Set')!
          .click()
        const name = row.querySelector('.name')!.textContent!
        await until(() => $('message').textContent!.startsWith(name))
        expect($('message').className).not.toContain('err')
      }

      // pause -> resume -> stop, each time the buttons follow the state
      $('pause').click()
      await until(() => $('runState').textContent === '● Paused')
      expect(buttons()).toEqual({ start: 'Resume', startOff: false, pauseOff: true, stopOff: false })
      $('start').click()
      await until(() => $('runState').textContent === '● Running')
      expect(buttons().start).toBe('Start')
      $('stop').click()
      if (type === 'treadmill') {
        // the simulated treadmill imitates the Urevo: a post-workout phase in which Start would be ignored
        await until(() => $('runState').textContent === '● Stopping…')
        expect(buttons()).toEqual({ start: 'Start', startOff: true, pauseOff: true, stopOff: true })
      }
      await until(() => $('runState').textContent === '● Stopped', 4000)
      expect(buttons()).toEqual({ start: 'Start', startOff: false, pauseOff: true, stopOff: true })

      $('disconnect').click()
      await until(() => $('state').textContent === 'Disconnected')
      expect($('runState').hidden).toBe(true)
      expect($<HTMLButtonElement>('start').disabled).toBe(true)
      expect($('machine').hasAttribute('disabled')).toBe(false)
    })
  }
})
