/**
 * Kidde HomeSafe data model and its interpretation.
 *
 * The HomeSafe API is private and undocumented. Every field below comes from
 * payloads captured on real hardware and shared in the community projects
 * this plugin credits (kidde-homesafe, homeassistant-kidde, homebridge-kidde,
 * kidde-collector). Fields vary by model and firmware, so all of them are
 * optional, and every reader here tolerates a field being absent or having
 * an unexpected type.
 *
 * Everything in this file is a pure function of a device document, which is
 * what lets the test suite pin down the alarm, battery and fault rules
 * without a Kidde account.
 */

/** A location (home) on the Kidde account */
export interface KiddeLocation {
  id: number | string
  name?: string
  label?: string
  [key: string]: unknown
}

/** One device document from GET /location/{id}/device */
export interface KiddeDevice {
  id: number | string
  location_id?: number | string
  label?: string
  model?: string
  serial_number?: string
  hwrev?: string
  fwrev?: Record<string, unknown> | string
  ver_mb?: string
  /** Hardware capabilities, e.g. ["smoke", "co"] or ["Smoke"] */
  capabilities?: unknown
  /** Sensor capabilities, e.g. ["Smoke", "IAQ", "CO"] */
  cap_sensor?: unknown

  smoke_alarm?: boolean
  /** An interconnected (hardwired) alarm elsewhere is sounding for smoke */
  hardwire_smoke?: boolean
  too_much_smoke?: boolean
  smoke_hushed?: boolean
  smoke_level?: number

  co_alarm?: boolean
  /** An interconnected (hardwired) alarm elsewhere is sounding for CO */
  hardwire_co?: boolean
  co_level?: number
  co_ppm?: number

  battery_state?: string
  battery_level?: number
  low_battery_alarm?: boolean

  offline?: boolean
  lost?: boolean
  contact_lost?: boolean

  /** Remaining service life (days, by all observed values) */
  life?: number
  /** 0 or 1 normal, 2 warning, 3 critical */
  end_of_life_status?: number
  errors?: unknown

  last_seen?: string
  last_test_time?: string

  [key: string]: unknown
}

/** Commands accepted by POST /location/{l}/device/{d}/{command} */
export type KiddeCommand = 'identify' | 'identifycancel' | 'test' | 'hush'

/** String form of a Kidde id, used as the key everywhere in the plugin */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

/** The serial number, trimmed, when the document has a usable one */
export function serialOf(device: KiddeDevice): string | undefined {
  const serial = device.serial_number
  return typeof serial === 'string' && serial.trim() ? serial.trim() : undefined
}

/**
 * The key an alarm is known by across polls and restarts, and the source
 * of its HomeKit identity: its serial number, which belongs to the
 * hardware, or its Kidde id when it has none. Kidde's device id belongs to
 * the account's record of the alarm, which can be replaced (the alarm
 * removed in the Kidde app and added again); the serial number cannot, so
 * the alarm keeps its HomeKit accessory, room, name and automations.
 */
export function alarmKey(device: KiddeDevice): string | undefined {
  const serial = serialOf(device)
  if (serial) return `sn:${serial.toUpperCase()}`
  const id = idOf(device.id)
  return id ? `id:${id}` : undefined
}

/** A location reduced to what the plugin uses */
export interface LocationInfo {
  id: string
  name: string
}

export function locationInfo(location: KiddeLocation): LocationInfo | undefined {
  const id = idOf(location.id)
  if (!id) return undefined
  const name =
    (typeof location.name === 'string' && location.name.trim()) ||
    (typeof location.label === 'string' && location.label.trim()) ||
    `Location ${id}`
  return { id, name }
}

/** Whether the document carries a capability list at all */
export function hasCapabilityList(device: KiddeDevice): boolean {
  return Array.isArray(device.capabilities) || Array.isArray(device.cap_sensor)
}

function capabilitySet(device: KiddeDevice): Set<string> | undefined {
  const values: string[] = []
  let sawList = false
  for (const list of [device.capabilities, device.cap_sensor]) {
    if (!Array.isArray(list)) continue
    sawList = true
    for (const item of list) {
      if (typeof item === 'string') values.push(item.trim().toLowerCase())
    }
  }
  return sawList ? new Set(values) : undefined
}

/** Models known to be smoke alarms, for documents without capability lists */
const SMOKE_MODELS = new Set(['wifidetector', 'wifiiaqdetector', 'esswfac'])

/** What a device can sense, as far as this plugin is concerned */
export interface DeviceKinds {
  smoke: boolean
  co: boolean
}

/**
 * Decide whether a device is a smoke alarm and whether it also senses CO.
 *
 * The capability lists are the source of truth, compared case-insensitively
 * because both spellings occur ("smoke" on wifidetector, "Smoke" on
 * EssWFAC). The model name cannot decide CO on its own: EssWFAC covers both
 * the smoke-only 20SAR-W and the smoke + CO 30CUAR-W. Only when a document
 * carries no capability list at all does the plugin fall back to the model
 * and to which alarm fields are present.
 *
 * Devices that are not smoke alarms (CO-only alarms, water leak sensors) get
 * smoke: false and are skipped by the platform.
 */
export function detectKinds(device: KiddeDevice): DeviceKinds {
  const caps = capabilitySet(device)
  if (caps) {
    return { smoke: caps.has('smoke'), co: caps.has('co') }
  }
  const model = typeof device.model === 'string' ? device.model.toLowerCase() : ''
  const smoke = SMOKE_MODELS.has(model) || 'smoke_alarm' in device
  return { smoke, co: smoke && 'co_alarm' in device }
}

/** Friendly description for the HomeKit Model field and the settings page */
export function describeModel(device: KiddeDevice, kinds = detectKinds(device)): string {
  const base = kinds.co ? 'Smart Smoke + CO Alarm' : 'Smart Smoke Alarm'
  const model = typeof device.model === 'string' && device.model ? ` (${device.model})` : ''
  // HomeKit truncates long Model strings; keep well under its 64 character limit
  return `${base}${model}`.slice(0, 64)
}

// --- Alarms ---------------------------------------------------------------

/**
 * Smoke is reported in any of three fields. For a life-safety alert, any one
 * of them being true wins:
 * - smoke_alarm: this alarm detected smoke
 * - hardwire_smoke: an interconnected alarm elsewhere in the home detected
 *   smoke and this one is sounding with it
 * - too_much_smoke: the smoke level is too high to hush, which only happens
 *   while alarming
 */
export const SMOKE_FIELDS = ['smoke_alarm', 'hardwire_smoke', 'too_much_smoke'] as const

/** CO from this alarm, or from an interconnected alarm sounding through it */
export const CO_FIELDS = ['co_alarm', 'hardwire_co'] as const

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', 'active', 'alarm'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', 'inactive', 'clear', 'normal', 'none', ''])

/**
 * Read one alarm field. Kidde sends booleans, but this is a private API and
 * the reading must not depend on that: a 1 or "true" is an alarm, not
 * "no smoke". A value that cannot be read either way is 'unreadable'.
 */
export function readAlarmField(value: unknown): boolean | 'absent' | 'unreadable' {
  if (value === undefined || value === null) return 'absent'
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()
    if (TRUE_WORDS.has(word)) return true
    if (FALSE_WORDS.has(word)) return false
  }
  return 'unreadable'
}

/**
 * Whether a status flag (offline, a fault, a low-battery alarm) is set.
 * Read as leniently as the alarm fields, for the same reason: a 1 or "true"
 * where Kidde normally sends a boolean must still count. Missing a flag is
 * the costly direction here, most of all for the offline flags, which are
 * what stop frozen readings from being shown as live.
 */
export function isFlagSet(value: unknown): boolean {
  return readAlarmField(value) === true
}

/**
 * Any field set means alarm. Otherwise, any field that cannot be read means
 * the state is unknown (undefined), which HomeKit shows as No Response
 * rather than guessing "no smoke".
 */
function alarmState(device: KiddeDevice, fields: readonly string[]): boolean | undefined {
  let unreadable = false
  for (const field of fields) {
    const state = readAlarmField(device[field])
    if (state === true) return true
    if (state === 'unreadable') unreadable = true
  }
  return unreadable ? undefined : false
}

/** Smoke detected: true, false, or undefined when Kidde's value is unreadable */
export function isSmokeDetected(device: KiddeDevice): boolean | undefined {
  return alarmState(device, SMOKE_FIELDS)
}

/** CO detected: true, false, or undefined when Kidde's value is unreadable */
export function isCoDetected(device: KiddeDevice): boolean | undefined {
  return alarmState(device, CO_FIELDS)
}

/** Alarm fields whose value could not be read, for the log */
export function unreadableAlarmFields(device: KiddeDevice): string[] {
  return [...SMOKE_FIELDS, ...CO_FIELDS].filter(
    (field) => readAlarmField(device[field]) === 'unreadable',
  )
}

/** CO concentration in ppm, if the firmware reports one */
export function coPpm(device: KiddeDevice): number | undefined {
  for (const value of [device.co_ppm, device.co_level]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

// --- Battery ---------------------------------------------------------------

/** Spellings observed for a healthy battery, lowercased */
const BATTERY_GOOD = new Set(['ok', 'good', 'normal', 'full', 'high'])
/** Spellings that mean the battery needs attention, lowercased */
const BATTERY_LOW = new Set(['low', 'warning', 'critical', 'very low', 'empty', 'replace'])
/** Spellings that mean "no information", lowercased */
const BATTERY_UNKNOWN = new Set(['unknown', 'none', 'n/a', ''])

export type BatteryCategory = 'good' | 'low' | 'unknown' | 'unrecognized' | 'absent'

/**
 * Classify battery_state. The API is inconsistent about case ("ok" and
 * "Good" both occur, depending on model and firmware), so it is compared
 * lowercased. A value outside the known spellings is 'unrecognized', which
 * the accessory logs once and never treats as low: guessing "low" is how
 * other integrations ended up showing every detector with a low battery.
 */
export function batteryCategory(device: KiddeDevice): BatteryCategory {
  const raw = device.battery_state
  if (raw === undefined || raw === null) return 'absent'
  if (typeof raw !== 'string') return 'unrecognized'
  const state = raw.trim().toLowerCase()
  if (BATTERY_GOOD.has(state)) return 'good'
  if (BATTERY_LOW.has(state)) return 'low'
  if (BATTERY_UNKNOWN.has(state)) return 'unknown'
  return 'unrecognized'
}

/** A numeric battery level (0 to 100) when the firmware reports one */
export function batteryPercentReported(device: KiddeDevice): number | undefined {
  const level = device.battery_level
  if (typeof level !== 'number' || !Number.isFinite(level)) return undefined
  if (level < 0 || level > 100) return undefined
  return Math.round(level)
}

/** Fault flags that are about the battery, reported as low battery instead */
const BATTERY_FAULT_FLAGS = new Set(['flt_lwbat_mb', 'flt_lwbat_wb', 'flt_fat_lwbat'])

/**
 * Whether the battery needs attention: the low category, an explicit
 * low-battery alarm or fault flag, or a numeric level at or below the
 * threshold.
 */
export function isLowBattery(device: KiddeDevice, threshold: number): boolean {
  if (batteryCategory(device) === 'low') return true
  if (isFlagSet(device.low_battery_alarm)) return true
  for (const flag of BATTERY_FAULT_FLAGS) {
    if (isFlagSet(device[flag])) return true
  }
  const level = batteryPercentReported(device)
  return level !== undefined && level <= threshold
}

/**
 * Approximate battery percentage, or undefined when it cannot be known.
 * Most Kidde alarms report only a category, so this maps good to 100 and
 * low to 10. A numeric battery_level is preferred whenever present.
 */
export function batteryPercent(device: KiddeDevice, threshold: number): number | undefined {
  const level = batteryPercentReported(device)
  if (level !== undefined) return level
  switch (batteryCategory(device)) {
    case 'good':
      return isLowBattery(device, threshold) ? 10 : 100
    case 'low':
      return 10
    default:
      return isLowBattery(device, threshold) ? 10 : undefined
  }
}

// --- Health ----------------------------------------------------------------

/**
 * Kidde keeps unresponsive devices on the account and keeps returning their
 * frozen last-known readings with one of these flags set. A detector in this
 * state is not actually being heard from, so it must not read as "no smoke".
 */
export const OFFLINE_FLAGS = ['offline', 'contact_lost', 'lost'] as const

export function isOffline(device: KiddeDevice): boolean {
  return OFFLINE_FLAGS.some((flag) => isFlagSet(device[flag]))
}

/**
 * Everything wrong with the device that HomeKit should show as a fault,
 * as short human-readable labels (empty when healthy).
 *
 * - end_of_life_status 2 (warning) or 3 (critical), or life used up: the
 *   sensor is past its rated service life and must be replaced
 * - any true flt_* / gflt_* flag (photo chamber, CO sensor, end of life,
 *   internal bus, test button), except the low-battery flags, which are
 *   reported through the battery instead. The numeric *_bm fields next to
 *   them (flt_pho_bm and so on) are detail, not faults of their own: what
 *   a non-zero value means is unknown, and the true/false flags beside
 *   them are what reports the fault.
 * - a non-empty errors list
 */
export function faultReasons(device: KiddeDevice): string[] {
  const reasons: string[] = []
  const eol = device.end_of_life_status
  if (eol === 2) reasons.push('end of life warning')
  if (typeof eol === 'number' && eol >= 3) reasons.push('end of life')
  if (typeof device.life === 'number' && Number.isFinite(device.life) && device.life <= 0) {
    reasons.push('service life used up')
  }
  for (const [key, value] of Object.entries(device)) {
    if (!/^g?flt_/.test(key) || key.endsWith('_bm') || BATTERY_FAULT_FLAGS.has(key)) continue
    if (!isFlagSet(value)) continue
    reasons.push(FAULT_LABELS[key] ?? key)
  }
  const errors = device.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const shown = errors
      .slice(0, 3)
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
      .join(', ')
    reasons.push(`device errors: ${shown}`)
  }
  return reasons
}

const FAULT_LABELS: Record<string, string> = {
  flt_pho: 'smoke sensor fault',
  flt_co: 'CO sensor fault',
  flt_eol: 'end of life fault',
  flt_fat_eol: 'end of life (fatal)',
  flt_i2c: 'internal communication fault',
  gflt_pttbtn: 'test button fault',
  gflt_enbtn: 'button fault',
}

// --- Display ---------------------------------------------------------------

/**
 * Firmware version in the x.y.z form HomeKit requires. Kidde reports
 * strings such as "01.00.79" or "V02.11", which HAP would reject with a
 * warning. Only the first three numeric groups are kept.
 */
export function firmwareRevision(device: KiddeDevice): string | undefined {
  const fw = device.fwrev
  const candidates: unknown[] = []
  if (fw && typeof fw === 'object') candidates.push(fw.alarm, fw.wm, fw.net)
  else candidates.push(fw)
  candidates.push(device.ver_mb)
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const match = candidate.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    if (!match) continue
    const [, major, minor, patch] = match
    return `${Number(major)}.${Number(minor ?? 0)}.${Number(patch ?? 0)}`
  }
  return undefined
}

/**
 * Longest base name. Service names add a suffix of up to 8 characters
 * (" Battery"), and HomeKit allows 64.
 */
export const MAX_NAME_LENGTH = 55

/** Trim anything that is not a letter or number off both ends */
function trimToAlphanumeric(value: string): string {
  return value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * HomeKit-safe name. Only letters, numbers, spaces and apostrophes are
 * kept, because that is all the HAP versions bundled with every supported
 * Homebridge accept without warning (newer ones allow more, older ones do
 * not). A name must start and end with a letter or number, so the ends are
 * trimmed again after cutting to length.
 */
export function sanitizeName(name: string): string {
  const cleaned = trimToAlphanumeric(
    name
      .replace(/[^\p{L}\p{N} ']/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  return trimToAlphanumeric(cleaned.slice(0, MAX_NAME_LENGTH)) || 'Smoke Alarm'
}
