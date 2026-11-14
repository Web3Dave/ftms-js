import {
  FtmsClient,
  FtmsError,
  MACHINE_LABELS,
  MACHINE_TYPES,
  toHex,
  type MachineData,
  type MachineType,
  type RawEvent,
  type Range,
} from 'ftms-js'
import {
  beltView,
  needsStartHint,
  startHintText,
  stateFromStatus,
  stateFromTraining,
  type RunState,
} from './runState'
import './style.css'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const els = {
  connect: $<HTMLButtonElement>('connect'),
  simulate: $<HTMLButtonElement>('simulate'),
  disconnect: $<HTMLButtonElement>('disconnect'),
  machine: $<HTMLSelectElement>('machine'),
  state: $('state'),
  message: $('message'),
  readout: $('readout'),
  adjust: $('adjust'),
  log: $('log'),
  export: $<HTMLButtonElement>('export'),
  clear: $<HTMLButtonElement>('clear'),
  start: $<HTMLButtonElement>('start'),
  pause: $<HTMLButtonElement>('pause'),
  stop: $<HTMLButtonElement>('stop'),
  runState: $('runState'),
}

// ---- What to show for each machine type ----------------------------------------------------

interface Metric {
  key: string
  label: string
  format: (v: number) => string
}
const fixed = (n: number) => (v: number) => v.toFixed(n)
const int = (v: number) => String(Math.round(v))
const clock = (v: number) => `${Math.floor(v / 60)}:${String(Math.round(v) % 60).padStart(2, '0')}`
const km = (v: number) => (v / 1000).toFixed(2)

const speed: Metric = { key: 'speedKmh', label: 'km/h', format: fixed(1) }
const distance: Metric = { key: 'distanceM', label: 'km', format: km }
const time: Metric = { key: 'elapsedS', label: 'time', format: clock }
const power: Metric = { key: 'powerW', label: 'watts', format: int }
const resistance: Metric = { key: 'resistanceLevel', label: 'resistance', format: int }
const incline: Metric = { key: 'inclinePercent', label: 'incline %', format: fixed(1) }
const kcal: Metric = { key: 'totalEnergyKcal', label: 'kcal', format: int }
const hr: Metric = { key: 'heartRateBpm', label: 'bpm', format: int }

const METRICS: Record<MachineType, Metric[]> = {
  treadmill: [speed, distance, time, incline, kcal],
  indoorBike: [
    speed,
    { key: 'cadenceRpm', label: 'rpm', format: fixed(0) },
    power,
    resistance,
    distance,
    time,
    hr,
    kcal,
  ],
  rower: [
    { key: 'strokeRate', label: 'strokes/min', format: fixed(0) },
    { key: 'strokeCount', label: 'strokes', format: int },
    { key: 'paceS', label: '/500 m', format: clock },
    power,
    resistance,
    distance,
    time,
    hr,
    kcal,
  ],
  crossTrainer: [
    speed,
    { key: 'stepsPerMinute', label: 'steps/min', format: int },
    { key: 'strideCount', label: 'strides', format: fixed(0) },
    power,
    resistance,
    incline,
    time,
    hr,
    kcal,
  ],
  stepClimber: [
    { key: 'floors', label: 'floors', format: int },
    { key: 'stepCount', label: 'steps', format: int },
    { key: 'stepsPerMinute', label: 'steps/min', format: int },
    { key: 'positiveElevationGainM', label: 'm climbed', format: fixed(1) },
    time,
    hr,
    kcal,
  ],
  stairClimber: [
    { key: 'floors', label: 'floors', format: int },
    { key: 'stepsPerMinute', label: 'steps/min', format: int },
    { key: 'strideCount', label: 'strides', format: fixed(0) },
    { key: 'positiveElevationGainM', label: 'm climbed', format: fixed(1) },
    time,
    hr,
    kcal,
  ],
}

// ---- State ----------------------------------------------------------------------------------

let client: FtmsClient | null = null
let stopSimulator: (() => void) | null = null
let recorded: RawEvent[] = []
let latest: MachineData | null = null
/** Last requested value per adjuster, so rapid +/- clicks build on each other. */
const targets = new Map<string, number>()

for (const t of MACHINE_TYPES) els.machine.add(new Option(MACHINE_LABELS[t], t))

const bluetoothAvailable = 'bluetooth' in navigator
if (!bluetoothAvailable) {
  const s = $('support')
  s.hidden = false
  s.className = 'note err'
  s.textContent =
    'This browser has no Web Bluetooth (use Chrome/Edge over https or localhost; Brave needs brave://flags/#brave-web-bluetooth-api). The simulator still works.'
  els.connect.disabled = true
}

function log(line: string) {
  const t = new Date().toLocaleTimeString()
  els.log.textContent += `${t}  ${line}\n`
  els.log.scrollTop = els.log.scrollHeight
}

function say(text: string, error = false) {
  els.message.textContent = text
  els.message.className = error ? 'note err' : 'note'
}

let isConnected = false
let runState: RunState = 'unknown'
let pauseSupported = true
let beltBusy = false

/** Redraw Start / Pause / Stop and the state badge from the current state. */
function renderBelt() {
  const v = beltView(runState, isConnected, pauseSupported, beltBusy)
  els.start.textContent = v.start.label
  els.start.disabled = v.start.disabled
  els.start.setAttribute('aria-pressed', String(v.start.current))
  els.pause.disabled = v.pause.disabled
  els.pause.hidden = v.pause.hidden
  els.pause.setAttribute('aria-pressed', String(v.pause.current))
  els.stop.disabled = v.stop.disabled
  els.stop.setAttribute('aria-pressed', String(v.stop.current))
  els.runState.textContent = v.badge.text
  els.runState.className = `badge ${v.badge.kind}`
  els.runState.hidden = v.badge.hidden
  renderStartHints()
}

/** How long to wait for a machine to leave its post-workout phase before offering Start anyway. */
const STOPPING_TIMEOUT_MS = 15_000
let stoppingTimer: ReturnType<typeof setTimeout> | undefined

function setRunState(next: RunState) {
  clearTimeout(stoppingTimer)
  runState = next
  if (next === 'stopped') targets.clear()
  if (next === 'stopping') {
    targets.clear()
    stoppingTimer = setTimeout(() => setRunState('stopped'), STOPPING_TIMEOUT_MS)
  }
  renderBelt()
}

/** Wait for the run state to become `wanted`, polling briefly. Resolves false on timeout. */
async function waitForRunState(wanted: RunState, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (runState !== wanted) {
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

function setConnected(connected: boolean, label: string) {
  isConnected = connected
  if (!connected) runState = 'unknown'
  els.state.textContent = label
  els.connect.disabled = connected || !bluetoothAvailable
  els.simulate.disabled = connected
  els.machine.disabled = connected
  els.disconnect.disabled = !connected
  els.export.disabled = !connected && recorded.length === 0
  renderBelt()
  for (const b of els.adjust.querySelectorAll('button, input')) (b as HTMLButtonElement).disabled = !connected
}

// ---- Readout --------------------------------------------------------------------------------

let cells = new Map<string, { metric: Metric; el: HTMLElement }>()

function buildReadout(type: MachineType) {
  els.readout.replaceChildren()
  cells = new Map()
  for (const metric of METRICS[type]) {
    const box = document.createElement('div')
    const value = document.createElement('b')
    value.textContent = '–'
    const label = document.createElement('span')
    label.textContent = metric.label
    box.append(value, label)
    els.readout.append(box)
    cells.set(metric.key, { metric, el: value })
  }
}

function show(d: MachineData) {
  latest = d
  const record = d as unknown as Record<string, unknown>
  for (const { metric, el } of cells.values()) {
    const v = record[metric.key]
    el.textContent = typeof v === 'number' ? metric.format(v) : '–'
  }
}

// ---- Capabilities: what the machine says it reports and what it lets you set -----------------------

const words = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase()
const range = (r: Range | null, unit: string) =>
  r
    ? `${r.min} to ${r.max}${unit ? ` ${unit}` : ''} (advertised step ${r.step})`
    : 'range not reported by the machine'

function renderCapabilities(c: FtmsClient) {
  const caps = c.capabilities
  const rows: Array<[string, string]> = [
    ['Machine', `${MACHINE_LABELS[c.machineType]} · ${c.deviceName || 'unnamed'}`],
  ]
  const info = Object.entries(c.deviceInfo).map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ')}`)
  if (info.length) rows.push(['Device info', info.join(' · ')])

  const f = caps.features
  rows.push([
    'Reports',
    f
      ? Object.entries(f.machine)
          .filter(([, on]) => on)
          .map(([k]) => words(k))
          .join(', ') || 'nothing advertised'
      : 'unknown (feature read failed)',
  ])

  const settable: string[] = []
  if (caps.canSetSpeed) settable.push(`speed: ${range(caps.speedRange, 'km/h')}`)
  if (caps.canSetIncline) settable.push(`incline: ${range(caps.inclinationRange, '%')}`)
  if (caps.canSetResistance) settable.push(`resistance: ${range(caps.resistanceRange, '')}`)
  if (caps.canSetPower) settable.push(`power: ${range(caps.powerRange, 'W')}`)
  if (caps.canSetHeartRate) settable.push(`heart rate: ${range(caps.heartRateRange, 'bpm')}`)
  if (caps.canSimulateBike) settable.push('indoor bike simulation (wind, grade, rolling resistance)')
  rows.push([
    'You can set',
    settable.length
      ? settable.join(' · ')
      : caps.hasControlPoint
        ? 'nothing; start, pause and stop only'
        : 'nothing (read-only machine)',
  ])
  rows.push([
    'Also',
    [
      `control point: ${caps.hasControlPoint ? 'yes' : 'no'}`,
      `training status: ${caps.hasTrainingStatus ? 'yes' : 'no'}`,
      `machine status: ${caps.hasMachineStatus ? 'yes' : 'no'}`,
    ].join(' · '),
  ])

  const dl = document.createElement('dl')
  for (const [k, v] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.textContent = v
    dl.append(dt, dd)
  }
  $('capsBody').replaceChildren(dl)
  $('caps').hidden = false
}

// ---- Adjusters: only the controls this machine supports --------------------------------------

interface Adjuster {
  id: string
  name: string
  unit: string
  step: number
  range: Range | null
  /** True when machines only accept this target while running (speed). The page hints at it. */
  needsRunning?: boolean
  /** Current value shown before any target has been set. */
  current: () => number
  apply: (c: FtmsClient, value: number) => Promise<unknown>
}

function adjustersFor(c: FtmsClient): Adjuster[] {
  const caps = c.capabilities
  const list: Adjuster[] = []
  const fromData = (key: string) => () => {
    const v = (latest as unknown as Record<string, unknown> | null)?.[key]
    return typeof v === 'number' ? v : 0
  }
  if (caps.canSetSpeed) {
    list.push({
      id: 'speed',
      name: 'Speed',
      unit: 'km/h',
      step: 0.1,
      needsRunning: true,
      range: caps.speedRange,
      current: fromData('speedKmh'),
      apply: (c, v) => c.setSpeed(v),
    })
  }
  if (caps.canSetIncline) {
    list.push({
      id: 'incline',
      name: 'Incline',
      unit: '%',
      step: caps.inclinationRange?.step || 1,
      range: caps.inclinationRange,
      current: fromData('inclinePercent'),
      apply: (c, v) => c.setIncline(v),
    })
  }
  if (caps.canSetResistance) {
    list.push({
      id: 'resistance',
      name: 'Resistance',
      unit: '',
      step: caps.resistanceRange?.step || 1,
      range: caps.resistanceRange,
      current: fromData('resistanceLevel'),
      apply: (c, v) => c.setResistance(v),
    })
  }
  if (caps.canSetPower) {
    list.push({
      id: 'power',
      name: 'Target power',
      unit: 'W',
      step: caps.powerRange?.step || 5,
      range: caps.powerRange,
      current: fromData('powerW'),
      apply: (c, v) => c.setPower(v),
    })
  }
  if (caps.canSimulateBike) {
    list.push({
      id: 'grade',
      name: 'Simulated grade',
      unit: '%',
      step: 1,
      range: { min: -10, max: 20, step: 1 },
      current: () => 0,
      apply: (c, v) => c.setIndoorBikeSimulation({ windSpeedMps: 0, gradePercent: v, crr: 0.004, cw: 0.51 }),
    })
  }
  return list
}

/** One hint per control that needs a running machine, shown or hidden as the run state changes. */
let startHints: Array<{ el: HTMLElement; what: string }> = []

function renderStartHints() {
  for (const { el, what } of startHints) {
    const text = startHintText(runState, what)
    el.hidden = text === null
    if (text) el.textContent = text
  }
}

function buildAdjusters(c: FtmsClient) {
  els.adjust.replaceChildren()
  startHints = []
  targets.clear()
  const list = adjustersFor(c)
  if (list.length === 0) {
    const p = document.createElement('p')
    p.className = 'note'
    p.textContent = 'This machine has no adjustable targets. Start, pause and stop only.'
    els.adjust.append(p)
    return
  }
  for (const a of list) {
    const row = document.createElement('div')
    row.className = 'item'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = a.name
    const out = document.createElement('output')
    out.textContent = '–'
    const minus = document.createElement('button')
    minus.textContent = `− ${a.step}`
    const plus = document.createElement('button')
    plus.textContent = `+ ${a.step}`
    const attempt = (value: number, text: string) => {
      targets.set(a.id, value)
      out.textContent = text
      const explain = a.needsRunning
        ? (e: unknown) => needsStartHint(e, runState, a.name.toLowerCase())
        : undefined
      void run(`${a.name} ${text}`.trim(), (c) => a.apply(c, value), explain).then((error) => {
        // A refused target must not stay on screen, or the next click would build on it.
        if (error === null) return
        targets.delete(a.id)
        out.textContent = '–'
      })
    }
    const nudge = (dir: 1 | -1) => {
      const base = targets.get(a.id) ?? a.current()
      let next = Math.round((base + dir * a.step) / a.step) * a.step
      next = Math.round(next * 1000) / 1000
      if (a.range) next = Math.min(Math.max(next, a.range.min), a.range.max)
      attempt(next, `${next} ${a.unit}`.trim())
    }
    minus.onclick = () => nudge(-1)
    plus.onclick = () => nudge(1)

    // Jump straight to a value. Not clamped here, so an out-of-range value shows the library's error.
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'target'
    input.step = String(a.step)
    input.placeholder = 'value'
    input.setAttribute('aria-label', `${a.name} value`)
    if (a.range) {
      input.min = String(a.range.min)
      input.max = String(a.range.max)
    }
    const set = document.createElement('button')
    set.textContent = 'Set'
    set.onclick = () => {
      if (input.value === '') return
      const value = Number(input.value)
      attempt(value, `${value} ${a.unit}`.trim())
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') set.click()
    }
    row.append(name, minus, out, plus, input, set)
    els.adjust.append(row)
    if (a.needsRunning) {
      const hint = document.createElement('p')
      hint.className = 'note hint'
      els.adjust.append(hint)
      startHints.push({ el: hint, what: a.name.toLowerCase() })
    }
  }
}

// ---- Connection -----------------------------------------------------------------------------

function attach(c: FtmsClient, name: string, initial: RunState) {
  client = c
  latest = null
  pauseSupported = true
  runState = initial
  buildReadout(c.machineType)
  buildAdjusters(c)
  renderCapabilities(c)
  setConnected(true, `Connected · ${name} (${MACHINE_LABELS[c.machineType]})`)

  c.on('data', show)
  c.on('status', (s) => {
    log(`status      ${JSON.stringify(s)}`)
    // A stop reported while we already know the machine is winding down must not end that phase.
    const next = stateFromStatus(s)
    if (next && !(next === 'stopped' && runState === 'stopping')) setRunState(next)
  })
  c.on('trainingStatus', (t) => {
    log(`training    ${JSON.stringify(t)}`)
    const next = stateFromTraining(t, runState)
    if (next) setRunState(next)
  })
  c.on('error', (e) => log(`ERROR       ${e.code}: ${e.message}`))
  c.on('disconnected', (d) => {
    setConnected(false, d.willReconnect ? 'Link lost, reconnecting…' : 'Disconnected')
    if (!d.willReconnect) $('caps').hidden = true
    stopSimulator?.()
    stopSimulator = null
  })
  c.on('reconnected', () => {
    setConnected(true, `Connected · ${name}`)
    setRunState('unknown')
  })
  log(`device ${JSON.stringify({ name: c.deviceName, ...c.deviceInfo })}`)
  log(`machine type ${c.machineType}`)
  log(`capabilities ${JSON.stringify({ ...c.capabilities, features: c.capabilities.features?.raw })}`)
}

/** Passed to connect() so the reads made while connecting are recorded and logged too. */
function onRaw(r: RawEvent) {
  recorded.push(r)
  const arrow = r.direction === 'out' ? '→' : r.direction === 'in' ? '←' : '·'
  log(`${arrow} ${r.characteristic.padEnd(16)} ${toHex(r.bytes)}`)
}

async function connect(simulated: boolean) {
  say('')
  recorded = []
  try {
    if (simulated) {
      const type = els.machine.value as MachineType
      els.state.textContent = 'Loading simulator…'
      els.connect.disabled = els.simulate.disabled = true
      // Only needed here, so it is fetched on demand and stays out of the first page load.
      const { createSimulatedMachine } = await import('ftms-js/testing')
      const sim = createSimulatedMachine({ type, postWorkoutMs: type === 'treadmill' ? 1200 : undefined })
      sim.startClock()
      stopSimulator = () => sim.stopClock()
      attach(await FtmsClient.connect({ bluetooth: sim.bluetooth, onRaw }), sim.device.name, 'stopped')
    } else {
      els.state.textContent = 'Connecting…'
      attach(await FtmsClient.connect({ autoReconnect: true, onRaw }), 'device', 'unknown')
    }
  } catch (e) {
    stopSimulator?.()
    stopSimulator = null
    setConnected(false, 'Not connected')
    if (e instanceof FtmsError && e.code === 'CANCELLED') return
    say(e instanceof Error ? e.message : String(e), true)
  }
}

/** Runs a command and reports the outcome. Resolves to null on success, otherwise the error. */
async function run(
  label: string,
  action: (c: FtmsClient) => Promise<unknown>,
  /** Optionally turns a failure into a plainer explanation; return null to keep the real message. */
  explain?: (error: unknown) => string | null,
): Promise<unknown> {
  if (!client) return new Error('Not connected')
  try {
    await action(client)
    say(label)
    return null
  } catch (e) {
    const hint = explain?.(e)
    const detail =
      e instanceof FtmsError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)
    say(hint ? `${hint} (${detail})` : detail, true)
    return e
  }
}

/** A Start / Pause / Stop command: the buttons lock while it is in flight so a double click cannot repeat it. */
async function beltCommand(label: string, action: (c: FtmsClient) => Promise<unknown>): Promise<unknown> {
  beltBusy = true
  renderBelt()
  try {
    return await run(label, action)
  } finally {
    beltBusy = false
    renderBelt()
  }
}

els.connect.onclick = () => void connect(false)
els.simulate.onclick = () => void connect(true)
els.disconnect.onclick = () => void client?.disconnect()
els.start.onclick = async () => {
  const resuming = runState === 'paused'
  await beltCommand(resuming ? 'Resumed' : 'Started', async (c) => {
    await c.start()
    // A machine can acknowledge Start and still ignore it (for example during its post-workout
    // phase). If it can report status, trust only what it reports, not the acknowledgement.
    if (!c.capabilities.hasMachineStatus) return setRunState('running')
    if (!(await waitForRunState('running', 2500))) {
      throw new Error(
        'The machine acknowledged Start but did not start. It may still be finishing the last workout: wait a few seconds and try again.',
      )
    }
  })
}
els.pause.onclick = async () => {
  const error = await beltCommand('Paused', (c) => c.pause())
  if (error === null) return setRunState('paused')
  // Pause is optional in practice. If the machine says it is not supported, stop offering it.
  if (error instanceof FtmsError && error.code === 'NOT_SUPPORTED') {
    pauseSupported = false
    renderBelt()
    say('This machine does not support pause. Use Stop.', true)
  }
}
els.stop.onclick = async () => {
  // The machine may already have reported that it is winding down; do not overwrite that.
  if ((await beltCommand('Stopped', (c) => c.stop())) === null && runState !== 'stopping')
    setRunState('stopped')
}
els.clear.onclick = () => (els.log.textContent = '')

// Download everything seen so far as JSON, for `pnpm capture`.
els.export.onclick = () => {
  const capture = {
    version: 1,
    device: { name: client?.deviceName ?? '', info: client?.deviceInfo ?? {} },
    machineType: client?.machineType,
    recordedAt: new Date().toISOString(),
    entries: recorded.map((r) => ({
      t: r.t,
      characteristic: r.characteristic,
      direction: r.direction,
      hex: toHex(r.bytes),
    })),
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: 'application/json' }))
  a.download = `ftms-capture-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

els.readout.replaceChildren() // filled in once a machine is connected and its type is known
setConnected(false, 'Not connected')
