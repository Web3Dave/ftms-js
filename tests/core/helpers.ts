import { fromHex } from '../../src'

/** Hex string -> DataView, like a notification payload. */
export const view = (hex: string): DataView => {
  const b = fromHex(hex)
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}
