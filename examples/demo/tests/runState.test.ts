import { describe, expect, it } from 'vitest'
import type { TrainingStatus } from 'ftms-js'
import { beltView, needsStartHint, startHintText, stateFromStatus, stateFromTraining } from '../src/runState'

describe('stateFromStatus', () => {
  it('maps Machine Status events to a run state', () => {
    expect(stateFromStatus({ kind: 'startedOrResumed' })).toBe('running')
    expect(stateFromStatus({ kind: 'stoppedOrPaused', action: 'stop', raw: 1 })).toBe('stopped')
    expect(stateFromStatus({ kind: 'stoppedOrPaused', action: 'pause', raw: 2 })).toBe('paused')
    expect(stateFromStatus({ kind: 'stoppedOrPaused', action: 'unknown', raw: 9 })).toBe('stopped')
    expect(stateFromStatus({ kind: 'stoppedBySafetyKey' })).toBe('stopped')
    expect(stateFromStatus({ kind: 'reset' })).toBe('stopped')
  })

  it('ignores events that are not about running', () => {
    expect(stateFromStatus({ kind: 'targetSpeedChanged', kmh: 4 })).toBeNull()
    expect(stateFromStatus({ kind: 'controlPermissionLost' })).toBeNull()
  })
})

const training = (name: string): TrainingStatus => ({ code: 0, name, extended: false })

describe('stateFromTraining', () => {
  it('post-workout means stopping, and idle ends it', () => {
    expect(stateFromTraining(training('postWorkout'), 'running')).toBe('stopping')
    expect(stateFromTraining(training('idle'), 'stopping')).toBe('stopped')
  })

  it('idle on its own changes nothing: a Domyos sends it together with a pause', () => {
    expect(stateFromTraining(training('idle'), 'paused')).toBeNull()
    expect(stateFromTraining(training('idle'), 'running')).toBeNull()
    expect(stateFromTraining(training('manualMode'), 'stopping')).toBeNull()
  })
})

describe('beltView', () => {
  it('stopping: Start is held back until the machine is idle again', () => {
    const v = beltView('stopping', true, true)
    expect([v.start.disabled, v.pause.disabled, v.stop.disabled]).toEqual([true, true, true])
    expect(v.badge).toMatchObject({ text: '● Stopping…', kind: 'stopping' })
  })

  it('stopped: only Start is available', () => {
    const v = beltView('stopped', true, true)
    expect([v.start.disabled, v.pause.disabled, v.stop.disabled]).toEqual([false, true, true])
    expect(v.start.label).toBe('Start')
    expect(v.badge).toMatchObject({ text: '● Stopped', kind: 'stopped', hidden: false })
    expect(v.stop.current).toBe(true)
  })

  it('running: Start is disabled, Pause and Stop are available', () => {
    const v = beltView('running', true, true)
    expect([v.start.disabled, v.pause.disabled, v.stop.disabled]).toEqual([true, false, false])
    expect(v.start.current).toBe(true)
  })

  it('paused: Start becomes Resume, Pause is disabled, Stop is available', () => {
    const v = beltView('paused', true, true)
    expect(v.start).toMatchObject({ label: 'Resume', disabled: false })
    expect([v.pause.disabled, v.stop.disabled]).toEqual([true, false])
    expect(v.pause.current).toBe(true)
  })

  it('unknown: assumes nothing, so everything stays enabled', () => {
    const v = beltView('unknown', true, true)
    expect([v.start.disabled, v.pause.disabled, v.stop.disabled]).toEqual([false, false, false])
    expect(v.badge.text).toBe('● State unknown')
  })

  it('hides Pause when the machine does not support it, leaving Start and Stop', () => {
    const v = beltView('running', true, false)
    expect(v.pause.hidden).toBe(true)
    expect([v.start.disabled, v.stop.disabled]).toEqual([true, false])
  })

  it('disables everything while disconnected or while a command is in flight, and hides the badge offline', () => {
    const off = beltView('running', false, true)
    expect([off.start.disabled, off.pause.disabled, off.stop.disabled]).toEqual([true, true, true])
    expect(off.badge.hidden).toBe(true)
    const busy = beltView('stopped', true, true, true)
    expect([busy.start.disabled, busy.pause.disabled, busy.stop.disabled]).toEqual([true, true, true])
  })
})

describe('start hints', () => {
  it('tells the user what to do for each state, and nothing while running', () => {
    expect(startHintText('stopped')).toBe(
      'Press Start first: the machine has to be running before its speed can be changed.',
    )
    expect(startHintText('unknown')).toContain('Press Start first')
    expect(startHintText('paused')).toBe('The machine is paused. Press Resume first, then change the speed.')
    expect(startHintText('stopping')).toContain('still finishing the last workout')
    expect(startHintText('running')).toBeNull()
  })

  it('names the thing being changed', () => {
    expect(startHintText('stopped', 'resistance')).toContain('its resistance can be changed')
  })

  it('explains an OPERATION_FAILED answer while the machine is not running', () => {
    const refused = { code: 'OPERATION_FAILED' }
    expect(needsStartHint(refused, 'stopped')).toContain('Press Start first')
    expect(needsStartHint(refused, 'paused')).toContain('Resume')
  })

  it('leaves other failures, and failures while running, with their real message', () => {
    expect(needsStartHint({ code: 'OPERATION_FAILED' }, 'running')).toBeNull()
    expect(needsStartHint({ code: 'INVALID_PARAMETER' }, 'stopped')).toBeNull()
    expect(needsStartHint({ code: 'TIMEOUT' }, 'stopped')).toBeNull()
    expect(needsStartHint(new Error('boom'), 'stopped')).toBeNull()
    expect(needsStartHint(null, 'stopped')).toBeNull()
  })
})
