/**
 * Account scan for the settings page.
 *
 * Signs in with the email and password currently in the settings form,
 * lists every location and the smoke alarms at each, and reports them in
 * the same shape as the plugin's device cache. This is what the "Sign In &
 * Find Alarms" button runs: it both proves the credentials work and shows
 * the ids the Device Settings and Locations options need.
 *
 * It lives apart from server.ts so it can be tested: server.ts starts the
 * settings server as a side effect of being imported.
 */

import type { KiddeClient } from '../kidde-api/client.js'
import { KiddeAuthError } from '../kidde-api/client.js'
import { cachedDeviceFrom, type CachedDevice, type CachedLocation } from '../kidde-api/device-cache.js'
import { detectKinds, locationInfo } from '../kidde-api/types.js'
import { describeError } from '../util.js'

export interface ScanResult {
  devices: CachedDevice[]
  locations: CachedLocation[]
  /** Names of locations whose alarms could not be read */
  failedLocations: string[]
  /** Kidde devices that are not smoke alarms (CO-only, water leak, ...) */
  otherDevices: number
}

export async function scanAccount(client: KiddeClient): Promise<ScanResult> {
  const locations: CachedLocation[] = []
  for (const raw of await client.getLocations()) {
    const info = locationInfo(raw)
    if (info) locations.push(info)
  }

  const devices: CachedDevice[] = []
  const failedLocations: string[] = []
  let otherDevices = 0
  for (const location of locations) {
    try {
      for (const device of await client.getDevices(location.id)) {
        const entry = cachedDeviceFrom(device, location)
        if (entry) devices.push(entry)
        else if (!detectKinds(device).smoke) otherDevices++
      }
    } catch (error) {
      if (error instanceof KiddeAuthError) throw error
      failedLocations.push(`${location.name} (${describeError(error)})`)
    }
  }
  return { devices, locations, failedLocations, otherDevices }
}
