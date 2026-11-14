import { err, ok, type Result } from './result'

export type Bytes = DataView | Uint8Array

export function toView(b: Bytes): DataView {
  return b instanceof DataView ? b : new DataView(b.buffer, b.byteOffset, b.byteLength)
}

export function toBytes(b: Bytes): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

export class ParseFailure extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message)
  }
}

/** Little-endian cursor over a DataView. Throws ParseFailure when it runs out of bytes. */
export class Reader {
  offset = 0
  readonly view: DataView

  constructor(bytes: Bytes) {
    this.view = toView(bytes)
  }

  get remaining(): number {
    return this.view.byteLength - this.offset
  }

  private take(n: number): number {
    if (this.remaining < n) {
      throw new ParseFailure(
        this.offset,
        `Expected ${n} more byte(s) at offset ${this.offset}, but only ${this.remaining} left`,
      )
    }
    const at = this.offset
    this.offset += n
    return at
  }

  u8(): number {
    return this.view.getUint8(this.take(1))
  }
  s8(): number {
    return this.view.getInt8(this.take(1))
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true)
  }
  s16(): number {
    return this.view.getInt16(this.take(2), true)
  }
  u24(): number {
    const at = this.take(3)
    return this.view.getUint8(at) | (this.view.getUint8(at + 1) << 8) | (this.view.getUint8(at + 2) << 16)
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true)
  }
  /** All bytes not yet consumed. Consumes them. */
  rest(): Uint8Array {
    const at = this.offset
    this.offset = this.view.byteLength
    return new Uint8Array(this.view.buffer, this.view.byteOffset + at, this.view.byteLength - at).slice()
  }
}

/** Run a parser body and turn thrown failures into a typed Result. Never throws. */
export function attempt<T>(body: () => T): Result<T> {
  try {
    return ok(body())
  } catch (e) {
    if (e instanceof ParseFailure) return err('TRUNCATED', e.message, e.offset)
    return err('INVALID', e instanceof Error ? e.message : String(e))
  }
}
