export interface CaptureIdentity {
  machineType?: string
  recordedAt?: string
  device?: { name?: string; info?: Record<string, string> }
}
export function modelId(capture: CaptureIdentity): string
export function firmwareId(capture: CaptureIdentity): string
export function scenarioId(text: string): string
export function defaultScenario(capture: CaptureIdentity): string
export function fixturePath(capture: CaptureIdentity, scenario?: string): string
