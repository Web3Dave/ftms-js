// Where a capture belongs under fixtures/, derived only from the capture's own data:
//
//   <machineType>/<model>/<model>__<firmware>__<scenario>.json
//   treadmill/URTM030/URTM030__43.49.96__speed-control.json
//
// model     Device Information "model number" (falls back to the advertised name)
// firmware  Device Information "firmware revision"; multi-line values are joined with "_"
// scenario  what was recorded (the --name given to `pnpm capture`, else the recording time)
//
// Used by the capture script and by the replay test, so the layout cannot drift from the data.

/** Make a string safe as part of a file name, keeping letters, digits and dots. */
const clean = (text) =>
  String(text)
    .replace(/[^A-Za-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.') // never produce "..", which would climb out of the fixtures folder
    .replace(/^[-.]+|[-.]+$/g, '')

/** @param {{ device?: { name?: string, info?: Record<string, string> } }} capture */
export function modelId(capture) {
  const info = capture.device?.info ?? {}
  return clean(info.model || capture.device?.name || '') || 'unknown-model'
}

/** @param {{ device?: { info?: Record<string, string> } }} capture */
export function firmwareId(capture) {
  const raw = capture.device?.info?.firmware ?? ''
  const lines = String(raw).split(/\r?\n/).map(clean).filter(Boolean)
  return lines.length ? lines.join('_') : 'unknown-firmware'
}

/** Lowercase kebab-case scenario name. */
export function scenarioId(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'capture'
  )
}

/** Time-based default scenario, e.g. 20261114-140450. */
export function defaultScenario(capture) {
  const t = String(capture.recordedAt ?? '').replace(/\.\d+Z$/, '')
  return scenarioId(t.replace(/[-:T]/g, (c) => (c === 'T' ? '-' : ''))) || 'capture'
}

/**
 * Path of a capture relative to fixtures/ (always with forward slashes).
 * @param {{ machineType?: string, recordedAt?: string, device?: { name?: string, info?: Record<string, string> } }} capture
 * @param {string} [scenario]
 */
export function fixturePath(capture, scenario) {
  const model = modelId(capture)
  const name = `${model}__${firmwareId(capture)}__${scenarioId(scenario ?? defaultScenario(capture))}.json`
  return `${capture.machineType || 'unknown-machine'}/${model}/${name}`
}
