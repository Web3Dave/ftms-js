import type { MachineStatus, TrainingStatus } from 'ftms-js'

/**
 * What the machine is doing. `unknown` until the machine reports it or a command succeeds.
 * `stopping` is the post-workout phase after a stop: some machines (the Urevo Strol 2E) acknowledge
 * Start with success but ignore it until they are back to idle.
 */
export type RunState = 'unknown' | 'stopped' | 'running' | 'paused' | 'stopping'

/**
 * State change implied by a Machine Status notification, or null if it does not affect it.
 * Training Status is deliberately not used: some machines send "idle" together with a pause.
 */
export function stateFromStatus(s: MachineStatus): RunState | null {
  switch (s.kind) {
    case 'startedOrResumed':
      return 'running'
    case 'stoppedOrPaused':
      return s.action === 'pause' ? 'paused' : 'stopped'
    case 'stoppedBySafetyKey':
    case 'reset':
      return 'stopped'
    default:
      return null
  }
}

/**
 * State change implied by a Training Status notification. Only the post-workout phase matters:
 * `postWorkout` means stopping, and `idle` ends it. Idle alone says nothing otherwise, because some
 * machines send it together with a pause.
 */
export function stateFromTraining(t: TrainingStatus, current: RunState): RunState | null {
  if (t.name === 'postWorkout') return 'stopping'
  if (t.name === 'idle' && current === 'stopping') return 'stopped'
  return null
}

export interface BeltView {
  start: { label: string; disabled: boolean; current: boolean }
  pause: { disabled: boolean; hidden: boolean; current: boolean }
  stop: { disabled: boolean; current: boolean }
  badge: { text: string; kind: RunState; hidden: boolean }
}

const BADGE: Record<RunState, string> = {
  running: '● Running',
  paused: '● Paused',
  stopped: '● Stopped',
  stopping: '● Stopping…',
  unknown: '● State unknown',
}

/**
 * What the Start / Pause / Stop buttons should look like. Each button is disabled when pressing it
 * would do nothing (Start while running, Pause unless running, Stop while stopped). While the state
 * is unknown nothing is assumed, so every button the machine supports stays enabled.
 */
export function beltView(
  state: RunState,
  connected: boolean,
  pauseSupported: boolean,
  busy = false,
): BeltView {
  const off = !connected || busy
  const known = state !== 'unknown'
  return {
    start: {
      label: state === 'paused' ? 'Resume' : 'Start',
      disabled: off || state === 'running' || state === 'stopping',
      current: state === 'running',
    },
    pause: {
      disabled: off || (known && state !== 'running'),
      hidden: !pauseSupported,
      current: state === 'paused',
    },
    stop: {
      disabled: off || state === 'stopped' || state === 'stopping',
      current: state === 'stopped' || state === 'stopping',
    },
    badge: { text: BADGE[state], kind: state, hidden: !connected },
  }
}

/**
 * What to tell someone whose target change needs a running machine. Null when the machine is already
 * running, because then the hint would be wrong.
 */
export function startHintText(state: RunState, what = 'speed'): string | null {
  switch (state) {
    case 'running':
      return null
    case 'stopping':
      return `The machine is still finishing the last workout. Wait for it to stop, press Start, then change the ${what}.`
    case 'paused':
      return `The machine is paused. Press Resume first, then change the ${what}.`
    default:
      return `Press Start first: the machine has to be running before its ${what} can be changed.`
  }
}

/**
 * A friendlier explanation for a refused target change. Machines answer "operation failed" when you ask
 * for a speed while stopped, which says nothing useful. Any other error, or a failure while the machine
 * is running, is left alone (null) so the real message shows.
 */
export function needsStartHint(error: unknown, state: RunState, what = 'speed'): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'OPERATION_FAILED' ? startHintText(state, what) : null
}
