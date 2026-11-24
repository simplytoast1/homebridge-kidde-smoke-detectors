/**
 * Discovered device cache for the settings page.
 *
 * The running plugin writes the alarms and locations it found to this file
 * in the Homebridge storage directory. The settings page reads it to show
 * the "Discovered Alarms" list (with the ids the Device Settings and
 * Locations options need) without signing in to Kidde every time the page
 * opens.
 *
 * It holds NO credentials, only names, ids and model information for
 * display, so it is a plain JSON file. Writes are atomic so a reader never
 * sees a half-written file.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  batteryCategory,
  describeModel,
  detectKinds,
  idOf,
  isOffline,
  sanitizeName,
  type KiddeDevice,
  type LocationInfo,
} from './types.js'

export const DEVICE_CACHE_FILE = 'kidde-smoke-detectors.devices.json'

/** An alarm as shown on the settings page (display only, no alarm state) */
export interface CachedDevice {
  id: string
  /** The name in the Kidde app */
  name: string
  /** The name HomeKit gets unless the user sets one (the Kidde name made HomeKit-safe) */
  homeKitName?: string
  serialNumber?: string
  model?: string
  description: string
  hasCo: boolean
  locationId: string
  locationName: string
  batteryState?: string
  online: boolean
}

/** A location (home) on the account, whether or not it has alarms */
export interface CachedLocation {
  id: string
  name: string
}

export interface DeviceCache {
  devices: CachedDevice[]
  locations: CachedLocation[]
  /** Epoch ms of the last write, 0 when there is no cache */
  updatedAt: number
}

const EMPTY: DeviceCache = { devices: [], locations: [], updatedAt: 0 }

/** The settings-page summary of one smoke alarm, or undefined for anything else */
export function cachedDeviceFrom(device: KiddeDevice, location: LocationInfo): CachedDevice | undefined {
  const id = idOf(device.id)
  if (!id) return undefined
  const kinds = detectKinds(device)
  if (!kinds.smoke) return undefined
  const label = typeof device.label === 'string' ? device.label.trim() : ''
  return {
    id,
    name: label || `Alarm ${id}`,
    homeKitName: sanitizeName(label),
    serialNumber: typeof device.serial_number === 'string' ? device.serial_number : undefined,
    model: typeof device.model === 'string' ? device.model : undefined,
    description: describeModel(device, kinds),
    hasCo: kinds.co,
    locationId: location.id,
    locationName: location.name,
    batteryState: batteryCategory(device) === 'absent' ? undefined : String(device.battery_state),
    online: !isOffline(device),
  }
}

function cachePath(storagePath: string): string {
  return join(storagePath, DEVICE_CACHE_FILE)
}

let writeSeq = 0

export async function writeDeviceCache(
  storagePath: string,
  devices: CachedDevice[],
  locations: CachedLocation[],
): Promise<void> {
  const finalPath = cachePath(storagePath)
  const tmpPath = `${finalPath}.${process.pid}.${writeSeq++}.tmp`
  const cache = { version: 1, updatedAt: Date.now(), locations, devices }
  await writeFile(tmpPath, JSON.stringify(cache), 'utf-8')
  try {
    await rename(tmpPath, finalPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/** Read the cache, or an empty one if it is absent or invalid. */
export async function readDeviceCache(storagePath: string): Promise<DeviceCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(storagePath), 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY }
    const devices = Array.isArray(parsed.devices)
      ? (parsed.devices as unknown[]).filter(
          (d): d is CachedDevice =>
            typeof (d as CachedDevice | null)?.id === 'string' &&
            typeof (d as CachedDevice | null)?.name === 'string',
        )
      : []
    const locations = Array.isArray(parsed.locations)
      ? (parsed.locations as unknown[]).filter(
          (l): l is CachedLocation =>
            typeof (l as CachedLocation | null)?.id === 'string' &&
            typeof (l as CachedLocation | null)?.name === 'string',
        )
      : []
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    return { devices, locations, updatedAt }
  } catch {
    return { ...EMPTY }
  }
}
