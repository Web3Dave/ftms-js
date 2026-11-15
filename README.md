<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Web3Dave/ftms-js/main/.github/ftms-js-white.svg">
    <img alt="ftms-js" src="https://raw.githubusercontent.com/Web3Dave/ftms-js/main/.github/ftms-js-black.svg" width="auto" height="60">
  </picture>
</p>
<p align="center">
  Browser TypeScript client for Bluetooth FTMS fitness machines
</p>
<p align="center">
  <a href="https://github.com/Web3Dave/ftms-js/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Web3Dave/ftms-js/ci.yml?branch=main"/></a>
  <a href="https://codecov.io/gh/Web3Dave/ftms-js"><img alt="coverage" src="https://codecov.io/gh/Web3Dave/ftms-js/graph/badge.svg"/></a>
  <a href="https://www.npmjs.com/package/ftms-js"><img alt="npm" src="https://img.shields.io/npm/v/ftms-js"/></a>
  <a href="https://github.com/Web3Dave/ftms-js/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"/></a>
  <a href="https://bundlejs.com/?q=ftms-js"><img alt="size" src="https://img.shields.io/bundlejs/size/ftms-js"/></a>
</p>

Implements the Bluetooth SIG's [Fitness Machine Service (FTMS) specification](https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/),
the standard GATT service that treadmills, bikes, rowers and other fitness machines use to report live data and accept control commands.

**[Try it in your browser](https://web3dave.github.io/ftms-js/)** with a real machine over Web Bluetooth, or with the built-in simulator.

## Features

- **Every FTMS machine type** - treadmill, indoor bike, rower, cross trainer, step climber, stair climber.
- **Zero dependencies** - ESM only, strict TypeScript.
- **Simple client** - connect, read typed live data, control start/stop and targets.
- **Test without hardware** - parsers are pure functions and a built-in simulator fakes Web Bluetooth.

> **v0.1.** Verified on real hardware only for the devices in [Compatibility](#compatibility).

## Install

```sh
npm install ftms-js
npm install -D @types/web-bluetooth   # types for the Web Bluetooth API (TypeScript users)
```

Works with pnpm and yarn too.

## Quick start

Call `connect()` from a user gesture such as a click. Browsers won't open the device chooser otherwise.

```ts
import { FtmsClient } from 'ftms-js'

button.onclick = async () => {
  const machine = await FtmsClient.connect({ autoReconnect: true })

  machine.on('data', (d) => console.log(d.type, d.elapsedS, d.heartRateBpm))
  machine.on('disconnected', ({ reason }) => console.log('gone:', reason))

  await machine.start() // requests control automatically

  // Only set what this machine supports.
  const { canSetSpeed, canSetResistance, speedRange, resistanceRange } = machine.capabilities
  if (canSetSpeed) await machine.setSpeed(speedRange?.min ?? 3) // km/h
  if (canSetResistance) await machine.setResistance(resistanceRange?.min ?? 1)

  await machine.stop()
  await machine.disconnect()
}
```

Speeds are always **km/h** and inclines **percent**.

`data` events are a union; narrow on `type`:

```ts
machine.on('data', (d) => {
  switch (d.type) {
    case 'indoorBike':
      return console.log(d.powerW, d.cadenceRpm)
    case 'rower':
      return console.log(d.strokeRate, d.paceS) // seconds per 500 m
    case 'treadmill':
      return console.log(d.speedKmh, d.inclinePercent)
  }
})
```

All fields are optional: `undefined` means the machine didn't send it.

## Machine types

`machine.machineType` is detected from the device. Control targets depend on what the device supports.

| `machineType`  | Data                                                                | Control targets                                |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| `treadmill`    | speed, distance, incline, ramp angle, elevation gain, pace, power   | speed, incline                                 |
| `indoorBike`   | speed, cadence, distance, resistance, power                         | resistance, power, heart rate, bike simulation |
| `rower`        | stroke rate/count, distance, pace, power, resistance                | resistance                                     |
| `crossTrainer` | speed, step rate, stride count, elevation gain, incline, resistance | incline, resistance                            |
| `stepClimber`  | floors, step count, step rate, elevation gain                       | none                                           |
| `stairClimber` | floors, step rate, stride count, elevation gain                     | none                                           |

All types also report energy, heart rate, METs, and elapsed/remaining time.

## Capabilities

`machine.capabilities` describes what this machine can do, read from the device itself:

```ts
const c = machine.capabilities
c.canSetSpeed // also canSetIncline, canSetResistance, canSetPower
c.resistanceRange // { min: 1, max: 15, step: 1 }, or null if the device doesn't say
c.speedRange // km/h; also inclinationRange, powerRange, heartRateRange
c.features?.machine.resistanceLevel // what it reports (cadence, power, pace, heartRate, ...)
c.features?.targets.resistance // what you can set
```

Targets are absolute: `setResistance(5)` sends one write, whatever the current level. If a range is
`null`, values aren't checked up front and the machine decides.

## API

### `FtmsClient`

| Member                                                    | Description                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `FtmsClient.connect(opts)`                                | Open the chooser and connect.                                                        |
| `FtmsClient.fromDevice(device, opts)`                     | Connect to a `BluetoothDevice` you already have.                                     |
| `requestControl()` `reset()` `start()` `pause()` `stop()` | Control commands. `start()` also resumes.                                            |
| `setSpeed` `setIncline` `setResistance` `setPower`        | Set targets. Refused before sending if unsupported or out of range.                  |
| `setTargetHeartRate` `setIndoorBikeSimulation`            | More targets, where the machine supports them.                                       |
| `machineType` `capabilities` `deviceName` `deviceInfo`    | What you're connected to.                                                            |
| `connected` `hasControl`                                  | State.                                                                               |
| `on(event, fn)` → unsubscribe, `once`, `off`              | Typed events.                                                                        |
| `disconnect()`                                            | Stops notifications, removes listeners, drops the link. Safe to call more than once. |

**Events:** `data`, `status` (machine status), `trainingStatus`, `disconnected` (`reason`: `user`,
`link-lost`, `reconnect-failed`), `reconnecting`, `reconnected`, `error`, `raw` (every payload, for logging).

**Options:**

| Option               | Default                    | Notes                                                            |
| -------------------- | -------------------------- | ---------------------------------------------------------------- |
| `autoReconnect`      | off                        | `true`, or `{ maxAttempts, initialDelayMs, maxDelayMs, factor }` |
| `autoRequestControl` | `true`                     | Request control before the first command                         |
| `gattTimeoutMs`      | `10000`                    |                                                                  |
| `commandTimeoutMs`   | `5000`                     |                                                                  |
| `filters`            | `[{ services: [0x1826] }]` | Chooser filters                                                  |
| `bluetooth`          | `navigator.bluetooth`      | Inject your own implementation                                   |
| `onRaw(event)`       |                            | Like `on('raw')`, but also sees the reads made while connecting  |

### Errors

Commands run one at a time and reject with an `FtmsError` whose `code` is one of:

- Device replies: `NOT_SUPPORTED`, `INVALID_PARAMETER`, `OPERATION_FAILED`, `CONTROL_NOT_PERMITTED`,
  `TIMEOUT`, `UNKNOWN_RESULT` (these carry `resultCode`).
- Connection and environment: `NO_BLUETOOTH`, `CANCELLED` (chooser dismissed), `BLUETOOTH_BLOCKED`,
  `NOT_CONNECTED`, `DISCONNECTED`, `NO_SERVICE`, `UNSUPPORTED_MACHINE`, `GATT_ERROR`, `PARSE_ERROR`.

```ts
import { FtmsClient, FtmsError } from 'ftms-js'

async function connect() {
  try {
    return await FtmsClient.connect()
  } catch (e) {
    if (e instanceof FtmsError && e.code === 'CANCELLED') return null // user closed the chooser
    throw e
  }
}
```

### Parsers

Pure functions with no Bluetooth or globals, also exported from `ftms-js`. They accept
`DataView | Uint8Array`, never throw on bad input, and return
`{ ok: true, value } | { ok: false, error: { code: 'TRUNCATED' | 'INVALID', … } }`.

`parseMachineData(type, bytes)`, `parseFeature`, `parseTrainingStatus`, `parseMachineStatus`,
`parseRange`, `parseControlResponse`, `parseMachineTypeAdvertisement`, `encodeControl`, `toHex`, `fromHex`,
and more. See the type definitions.

## Testing without a device

`ftms-js/testing` provides a simulated machine of any type with a fake `Bluetooth` object:

```ts
import { FtmsClient } from 'ftms-js'
import { createSimulatedMachine } from 'ftms-js/testing'

const sim = createSimulatedMachine({ type: 'indoorBike' })
sim.startClock() // emits plausible data every second
const machine = await FtmsClient.connect({ bluetooth: sim.bluetooth })
```

Options let you script behaviour: forced result codes, silence per op code, split records, no control
point, restricted features.

## Browser requirements

- Chrome or Edge (desktop and Android). Safari and Firefox have no Web Bluetooth.
- Brave: enable `brave://flags/#brave-web-bluetooth-api` and relaunch.
- Serve over **https** or from **localhost**.
- `connect()` must run in a **user gesture**.
- Most machines accept one Bluetooth connection at a time. Close the vendor app first.
- In a cross-origin iframe, the parent must grant `allow="bluetooth"`.

Node isn't supported or tested, but you can pass a shim via `bluetooth`.

## Compatibility

Only combinations verified on hardware are listed. Everything else (other bikes, rowers, cross
trainers, climbers) has only run against the simulator. Tried another machine? Please [open an issue](https://github.com/Web3Dave/ftms-js/issues).

| Device                                | Machine   | Verified                                                        |
| ------------------------------------- | --------- | --------------------------------------------------------------- |
| Domyos Wood Rower (Decathlon 8604435) | rower     | connect, live data, start/stop, resistance                      |
| Urevo Strol 2E (`URTM030`)            | treadmill | connect, live data, start/stop/pause/resume, speed (no incline) |

## License

MIT
