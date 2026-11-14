import { attempt, Reader, type Bytes } from './reader'
import type { Result } from './result'

/**
 * A declarative description of one machine data characteristic: a flags field followed by
 * optional field groups, each switched by one flag bit. Every FTMS data characteristic
 * (spec §4.4-4.9) has this shape, so one engine parses and encodes all of them.
 */
export type Prim = 'u8' | 's8' | 'u16' | 's16' | 'u24'

export interface FieldDef {
  /** Property name on the parsed record. */
  key: string
  type: Prim
  /** Raw value is divided by this to get the unit used in the record (e.g. 100 for 0.01 km/h). Default 1. */
  div?: number
  /** Raw "Data Not Available" value: the property is left out when seen. */
  na?: number
}

export interface GroupDef {
  /** Flag bit that controls this group. */
  bit: number
  /** True (default): present when the bit is 1. False: present when the bit is 0 (the inverted "More Data" bit 0). */
  presentWhenSet?: boolean
  fields: FieldDef[]
}

export interface DataSchema {
  /** Size of the Flags field in bytes. */
  flagBytes: 2 | 3
  groups: GroupDef[]
}

/** Properties every parsed record carries. */
export interface BaseRecord {
  /** True when the record continues in the next notification (spec §4.19). */
  moreData: boolean
  /** Raw flags field. */
  flags: number
  /** Bytes left after every spec-defined field (reserved flag bits may be used by firmware). */
  trailing?: Uint8Array
}

function read(r: Reader, type: Prim): number {
  switch (type) {
    case 'u8':
      return r.u8()
    case 's8':
      return r.s8()
    case 'u16':
      return r.u16()
    case 's16':
      return r.s16()
    case 'u24':
      return r.u24()
  }
}

export function parseWithSchema(
  bytes: Bytes,
  schema: DataSchema,
): Result<Record<string, unknown> & BaseRecord> {
  return attempt(() => {
    const r = new Reader(bytes)
    const flags = schema.flagBytes === 3 ? r.u24() : r.u16()
    const out: Record<string, unknown> = { moreData: (flags & 1) !== 0, flags }
    for (const g of schema.groups) {
      const set = (flags & (1 << g.bit)) !== 0
      if (set !== (g.presentWhenSet ?? true)) continue
      for (const f of g.fields) {
        const raw = read(r, f.type)
        if (f.na !== undefined && raw === f.na) continue
        out[f.key] = f.div ? raw / f.div : raw
      }
    }
    if (r.remaining > 0) out.trailing = r.rest()
    return out as Record<string, unknown> & BaseRecord
  })
}

const SIZE: Record<Prim, number> = { u8: 1, s8: 1, u16: 2, s16: 2, u24: 3 }

function write(out: number[], type: Prim, value: number): void {
  const size = SIZE[type]
  const v = value < 0 ? value + 2 ** (8 * size) : value
  for (let i = 0; i < size; i++) out.push(Math.floor(v / 2 ** (8 * i)) & 0xff)
}

export interface EncodeOptions {
  /** Split into two notifications using the More Data bit (spec §4.19). */
  split?: boolean
  /** Override the wire type of fields by key, to imitate devices that deviate from the GSS (e.g. 16-bit resistance). */
  fieldTypes?: Record<string, Prim>
}

/**
 * Build Data characteristic notifications from a record. A group is included when any of its
 * keys is defined; missing keys in an included group are sent as "Data Not Available" (or 0).
 * Intended for simulators and tests.
 */
export function encodeWithSchema(
  values: Record<string, unknown>,
  schema: DataSchema,
  options: EncodeOptions = {},
): Uint8Array[] {
  const included = schema.groups.filter((g) => g.fields.some((f) => typeof values[f.key] === 'number'))
  const inverted = included.filter((g) => g.presentWhenSet === false)
  const normal = included.filter((g) => g.presentWhenSet !== false)

  const build = (groups: GroupDef[], moreData: boolean): Uint8Array => {
    let flags = moreData ? 1 : 0
    const body: number[] = []
    // Fields go out in schema order, which is the order of the flag bits.
    for (const g of schema.groups) {
      if (!groups.includes(g)) continue
      if (g.presentWhenSet !== false) flags |= 1 << g.bit
      for (const f of g.fields) {
        const v = values[f.key]
        const raw = typeof v === 'number' ? Math.round(v * (f.div ?? 1)) : (f.na ?? 0)
        write(body, options.fieldTypes?.[f.key] ?? f.type, raw)
      }
    }
    const head: number[] = []
    for (let i = 0; i < schema.flagBytes; i++) head.push((flags >> (8 * i)) & 0xff)
    return Uint8Array.from([...head, ...body])
  }

  if (!options.split || normal.length < 2) return [build(included, false)]
  const half = Math.ceil(normal.length / 2)
  // Record fields that are present only when More Data = 0 belong in the last notification.
  return [build(normal.slice(0, half), true), build([...normal.slice(half), ...inverted], false)]
}
