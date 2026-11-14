import { toBytes, type Bytes } from './reader'

export function toHex(bytes: Bytes): string {
  return Array.from(toBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** Accepts "0a 1b", "0a1b" or "0x0a,0x1b". */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (clean.length % 2 !== 0) throw new RangeError('Hex string has an odd number of digits')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
