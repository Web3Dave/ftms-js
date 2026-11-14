#!/usr/bin/env node
// Validate an exported demo capture and file it under fixtures/ for replay in tests.
//   pnpm capture <exported.json> [--name <scenario>]
//
// The location comes from the capture itself: <machineType>/<model>/<model>__<firmware>__<scenario>.json
// (see scripts/fixturePath.mjs in the library). --name describes what was recorded, e.g. "speed-control".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from '../../../scripts/fixturePath.mjs'

const args = process.argv.slice(2)
const nameFlag = args.indexOf('--name')
const scenario = nameFlag >= 0 ? args.splice(nameFlag, 2)[1] : undefined
const input = args[0]
if (!input) {
  console.error('usage: pnpm capture <exported.json> [--name <scenario>]')
  process.exit(1)
}

const capture = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), input), 'utf8'))
if (capture.version !== 1 || !Array.isArray(capture.entries)) {
  console.error('Not a capture exported by the ftms-js demo (expected version 1 with entries[]).')
  process.exit(1)
}

const hexOk = (h) => typeof h === 'string' && /^([0-9a-f]{2}\s?)+$/i.test(h.trim())
const bad = capture.entries.findIndex((e) => !e.characteristic || !hexOk(e.hex))
if (bad >= 0) {
  console.error(`Entry #${bad} is malformed: ${JSON.stringify(capture.entries[bad])}`)
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures')
const relative = fixturePath(capture, scenario)
const out = join(root, relative)
if (existsSync(out)) {
  console.error(`${relative} already exists. Use --name to give this capture a different scenario name.`)
  process.exit(1)
}
if (!capture.device?.info?.model) {
  console.warn('Note: this capture has no Device Information model, so the advertised name is used instead.')
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(capture, null, 2) + '\n')
console.log(`Saved ${capture.entries.length} entries to fixtures/${relative}`)
console.log('Run `pnpm test` in the library to replay them.')
