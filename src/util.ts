import type { Logger } from 'homebridge'

let logger: Logger | undefined
let debugEnabled = false

/**
 * Store the Homebridge logger for the module-level log helpers.
 * When the plugin's "debug" option is on, debug messages are promoted to
 * info level so they show up without running Homebridge itself in debug
 * mode (-D).
 */
export function setLogger(log: Logger, debug = false): void {
  logger = log
  debugEnabled = debug
}

export function logInfo(message: string): void {
  logger?.info(message)
}

export function logWarn(message: string): void {
  logger?.warn(message)
}

export function logError(message: string): void {
  logger?.error(message)
}

export function logDebug(message: string): void {
  if (debugEnabled) {
    logger?.info(message)
  } else {
    logger?.debug(message)
  }
}

/**
 * A one-line, log-safe description of an error.
 *
 * Node's fetch reports network problems as a bare "fetch failed" TypeError
 * with the useful part (ENOTFOUND, ECONNRESET, ...) hidden in `cause`, and a
 * timeout as a DOMException. Both are unpacked here so the Homebridge log
 * says what actually went wrong.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'the request timed out'
    if (error.name === 'AbortError') return 'the request was aborted'
    const cause = (error as { cause?: unknown }).cause
    if (cause && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code
      const message = (cause as { message?: unknown }).message
      if (typeof code === 'string') return `${error.message} (${code})`
      if (typeof message === 'string' && message) {
        return `${error.message} (${message})`
      }
    }
    return error.message || error.name
  }
  return String(error)
}
