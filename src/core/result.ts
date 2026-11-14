export type ParseErrorCode = 'TRUNCATED' | 'INVALID'

export interface ParseError {
  code: ParseErrorCode
  message: string
  /** Byte offset where parsing failed, when known. */
  offset?: number
}

export type Result<T, E = ParseError> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = (code: ParseErrorCode, message: string, offset?: number): Result<never> => ({
  ok: false,
  error: offset === undefined ? { code, message } : { code, message, offset },
})
