export type FtmsErrorCode =
  | 'NO_BLUETOOTH'
  | 'CANCELLED'
  | 'BLUETOOTH_BLOCKED'
  | 'NOT_CONNECTED'
  | 'DISCONNECTED'
  | 'NO_SERVICE'
  | 'UNSUPPORTED_MACHINE'
  | 'GATT_ERROR'
  | 'PARSE_ERROR'
  // Control Point outcomes
  | 'NOT_SUPPORTED'
  | 'INVALID_PARAMETER'
  | 'OPERATION_FAILED'
  | 'CONTROL_NOT_PERMITTED'
  | 'UNKNOWN_RESULT'
  | 'TIMEOUT'

export class FtmsError extends Error {
  override readonly name = 'FtmsError'

  constructor(
    readonly code: FtmsErrorCode,
    message: string,
    options?: { cause?: unknown; resultCode?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.resultCode = options?.resultCode
  }

  /** Control Point result code, when the error came from a device response. */
  readonly resultCode: number | undefined
}
