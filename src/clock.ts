/**
 * Monotonic time for every duration the plugin measures.
 *
 * Date.now() follows the wall clock, which can jump. A Raspberry Pi without
 * a real-time clock commonly starts Homebridge before NTP has synced, then
 * steps the clock forward by hours. Measured with Date.now(), that step
 * would make every alarm look stale at once, or let the 30 minute removal
 * grace pass in seconds and unregister accessories. A backward step would
 * instead keep stale data looking fresh, the unsafe direction for a smoke
 * alarm. performance.now() never jumps.
 *
 * Date.now() is still used where a real point in time is needed, such as a
 * session's creation time saved to disk.
 */

let offsetMs = 0

/** Milliseconds on a clock that only moves forward, at a steady rate */
export function monotonicNow(): number {
  return performance.now() + offsetMs
}

/**
 * Move the monotonic clock forward. Only the test suite uses this, to
 * simulate time passing without waiting for it.
 */
export function advanceMonotonicClock(ms: number): void {
  offsetMs += ms
}
