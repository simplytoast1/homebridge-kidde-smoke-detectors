/**
 * Plugin identity and configuration.
 *
 * Every option is edited through the standard Homebridge settings form
 * (config.schema.json), and users can also edit config.json by hand. So
 * every value is normalized here before the rest of the plugin sees it:
 * numbers are clamped to safe ranges, ids are coerced to strings, and
 * unexpected shapes fall back to the defaults instead of crashing the
 * platform.
 */

import type { PlatformConfig } from 'homebridge'

export const PLATFORM_NAME = 'KiddeSmokeDetectors'
export const PLUGIN_NAME = 'homebridge-kidde-smoke-detectors'

/** One entry of the "Device Settings" list */
export interface DeviceOverrideConfig {
  /** Kidde device id or serial number */
  id?: string | number
  /** Name to use in HomeKit instead of the name from the Kidde app */
  name?: string
  /** Keep this alarm out of HomeKit */
  hidden?: boolean
}

/** The plugin's block in config.json */
export interface KiddeSmokeDetectorsConfig extends PlatformConfig {
  /** Kidde HomeSafe account email */
  email?: string
  /** Kidde HomeSafe account password */
  password?: string
  /** Expose a momentary "Hush" switch per alarm */
  hushSwitch?: boolean
  /** Expose a momentary "Test" switch per alarm */
  testSwitch?: boolean
  /** Make the alarm locate itself when HomeKit's Identify is used */
  identifyLocate?: boolean
  /** Per-device name overrides and hiding */
  devices?: DeviceOverrideConfig[]
  /** Seconds between polls of the Kidde cloud */
  pollingInterval?: number
  /** Numeric battery level (percent) at or below which the battery is low */
  lowBatteryThreshold?: number
  /** Limit the plugin to these Kidde location ids */
  locationIds?: Array<string | number>
  /** Log debug messages at info level */
  debug?: boolean
}

export const DEFAULT_POLLING_INTERVAL_SECONDS = 15
export const MIN_POLLING_INTERVAL_SECONDS = 10
export const MAX_POLLING_INTERVAL_SECONDS = 300
export const DEFAULT_LOW_BATTERY_THRESHOLD = 20

/** A resolved device override */
export interface DeviceOverride {
  name?: string
  hidden: boolean
}

/** The configuration after validation, with every default applied */
export interface PluginOptions {
  email: string
  password: string
  hushSwitch: boolean
  testSwitch: boolean
  identifyLocate: boolean
  /** Keyed by lowercased device id or serial number */
  devices: Map<string, DeviceOverride>
  pollingIntervalMs: number
  lowBatteryThreshold: number
  /** Empty means every location on the account */
  locationIds: Set<string>
  debug: boolean
}

/** Normalize an id or serial number for matching */
export function overrideKey(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase()
  return undefined
}

function toIdSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  const ids = new Set<string>()
  for (const item of value) {
    const key = overrideKey(item)
    if (key) ids.add(key)
  }
  return ids
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function resolveDevices(value: unknown): Map<string, DeviceOverride> {
  const devices = new Map<string, DeviceOverride>()
  if (!Array.isArray(value)) return devices
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, hidden } = entry as DeviceOverrideConfig
    const key = overrideKey(id)
    if (!key) continue
    devices.set(key, {
      name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      hidden: hidden === true,
    })
  }
  return devices
}

export function resolveOptions(config: KiddeSmokeDetectorsConfig): PluginOptions {
  return {
    email: typeof config.email === 'string' ? config.email.trim() : '',
    password: typeof config.password === 'string' ? config.password : '',
    hushSwitch: config.hushSwitch === true,
    testSwitch: config.testSwitch === true,
    identifyLocate: config.identifyLocate !== false,
    devices: resolveDevices(config.devices),
    pollingIntervalMs:
      clampInt(
        config.pollingInterval,
        DEFAULT_POLLING_INTERVAL_SECONDS,
        MIN_POLLING_INTERVAL_SECONDS,
        MAX_POLLING_INTERVAL_SECONDS,
      ) * 1000,
    lowBatteryThreshold: clampInt(
      config.lowBatteryThreshold,
      DEFAULT_LOW_BATTERY_THRESHOLD,
      0,
      100,
    ),
    locationIds: toIdSet(config.locationIds),
    debug: config.debug === true,
  }
}
