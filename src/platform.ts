/**
 * Kidde Smoke Detectors Platform
 *
 * The Homebridge DynamicPlatformPlugin that ties everything together:
 *
 * 1. SIGN IN: reuse the saved Kidde session, or sign in with the configured
 *    email and password (see client.ts for the login safety rules)
 * 2. POLL: every pollingInterval seconds, read the locations and each
 *    location's devices. Kidde offers no push channel to third parties, so
 *    polling is the only way to learn about an alarm.
 * 3. MAP: every smoke alarm becomes a HomeKit accessory with a Smoke Sensor,
 *    plus a Carbon Monoxide Sensor on smoke + CO models. Other Kidde
 *    devices (CO-only alarms, water leak sensors) are skipped.
 * 4. PUSH: each accessory recomputes its characteristics from the new
 *    document and pushes changes to HomeKit, so alerts fire on their own.
 *
 * RESILIENCE: nothing here is fatal. A failed poll is retried (at the
 * normal interval at first, then with backoff up to five minutes); a failed
 * location does not stop the others; an auth failure waits for the
 * client's login backoff. Through all of it, an alarm that has not been
 * seen in a successful poll for three polling intervals (at least 90
 * seconds) shows as No Response. That is checked on its own timer and
 * at every HomeKit read, not only after polls, so an outage or a held-up
 * poll can never leave HomeKit claiming "no smoke" on stale data.
 *
 * REMOVAL is deliberately slow. An accessory is only unregistered (which
 * destroys its room, name and automations in HomeKit) when the user asked
 * for it (Hide from HomeKit, or its location excluded), or when the alarm
 * has been missing from at least three complete polls spanning thirty
 * minutes. A poll that returns no alarms at all never removes anything, and
 * a Locations filter that matches nothing is ignored rather than obeyed.
 *
 * IDENTITY: an alarm is known by its serial number (alarmKey in types.ts),
 * not by its Kidde device id, so removing an alarm in the Kidde app and
 * adding it again keeps the same HomeKit accessory. If Kidde lists the same
 * alarm twice (an old record next to the new one), the live record wins.
 *
 * TIME is measured on the monotonic clock (clock.ts): a wall clock step on
 * a Raspberry Pi syncing its time must not make data look fresh or let the
 * removal grace pass early.
 */

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'
import { hap } from './hap.js'
import { monotonicNow } from './clock.js'
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  overrideKey,
  resolveOptions,
  type DeviceOverride,
  type KiddeSmokeDetectorsConfig,
  type PluginOptions,
} from './settings.js'
import { describeError, logDebug, logError, logInfo, logWarn, setLogger } from './util.js'
import {
  KiddeAuthError,
  KiddeApiError,
  KiddeClient,
  type KiddeSession,
  type SessionChange,
} from './kidde-api/client.js'
import { loadSession, saveSession } from './kidde-api/session-store.js'
import {
  cachedDeviceFrom,
  writeDeviceCache,
  type CachedDevice,
  type CachedLocation,
} from './kidde-api/device-cache.js'
import {
  alarmKey,
  describeModel,
  detectKinds,
  hasCapabilityList,
  idOf,
  isOffline,
  locationInfo,
  sanitizeName,
  serialOf,
  type DeviceKinds,
  type KiddeCommand,
  type KiddeDevice,
  type LocationInfo,
} from './kidde-api/types.js'
import { SmokeAlarmAccessory, type AccessoryOptions } from './accessories/smoke-alarm.js'

/** Floor for "not seen recently enough to trust" */
const MIN_STALE_AFTER_MS = 90_000
/** How often availability is re-checked against the clock */
const FRESHNESS_CHECK_MS = 5000
/** Polls in a row at the normal interval before backing off */
const FAILURES_BEFORE_BACKOFF = 3
/** Cap for the failed-poll backoff */
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000
/** Retry delay after an auth failure that carries no retry time */
const AUTH_RETRY_MS = 15 * 60_000
/** Cap for any single wait */
const MAX_WAIT_MS = 60 * 60_000
/** A missing alarm is removed only after this long ... */
const REMOVAL_GRACE_MS = 30 * 60_000
/** ... and after at least this many complete polls without it */
const REMOVAL_MIN_POLLS = 3
/** Poll again this soon after a command, to show its effect */
const POST_COMMAND_POLL_MS = 3000
/** A refreshed (not new) session cookie is saved at most this often */
const SESSION_REFRESH_SAVE_MS = 10 * 60_000

/** What the platform last heard about one alarm */
interface DeviceRecord {
  /** The alarm's current Kidde device id, which commands are sent to */
  id: string
  device: KiddeDevice
  location: LocationInfo
  /** Monotonic time a successful poll last included this alarm */
  lastSeenAt: number
}

/**
 * Of two documents for the same alarm, the one to believe: an online one
 * over an offline one, then the one Kidde heard from most recently, then
 * the newer record (the higher id).
 */
function preferredRecord<T extends { device: KiddeDevice }>(a: T, b: T): T {
  const aOnline = !isOffline(a.device)
  const bOnline = !isOffline(b.device)
  if (aOnline !== bOnline) return aOnline ? a : b
  const aSeen = Date.parse(String(a.device.last_seen ?? ''))
  const bSeen = Date.parse(String(b.device.last_seen ?? ''))
  if (Number.isFinite(aSeen) && Number.isFinite(bSeen) && aSeen !== bSeen) return aSeen > bSeen ? a : b
  return Number(idOf(b.device.id)) > Number(idOf(a.device.id)) ? b : a
}

export class KiddeSmokeDetectorsPlatform implements DynamicPlatformPlugin {
  private readonly options: PluginOptions
  private readonly storagePath: string
  private readonly staleAfterMs: number

  /** Accessories restored from the Homebridge cache or registered, by UUID */
  private readonly accessories = new Map<string, PlatformAccessory>()
  /** Live accessory handlers, by alarm key (serial number, see alarmKey) */
  private readonly handlers = new Map<string, SmokeAlarmAccessory>()
  /** Latest document and freshness per alarm, by alarm key */
  private readonly records = new Map<string, DeviceRecord>()
  /** Alarms missing from complete polls, by alarm key: since when, and for how many polls */
  private readonly missing = new Map<string, { since: number; polls: number }>()

  private client: KiddeClient | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private freshnessTimer: ReturnType<typeof setInterval> | null = null
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null
  private pollInFlight: Promise<void> | null = null
  private sessionWrite: Promise<void> = Promise.resolve()
  private consecutiveFailures = 0
  private authProblem = false
  private firstPollDone = false
  private shuttingDown = false
  private allLocations: LocationInfo[] = []
  private cacheSnapshot = ''
  /** Conditions currently warned about, so each is logged once per occurrence */
  private readonly activeWarnings = new Set<string>()
  /** Device ids already logged as skipped or hidden, to log each once */
  private readonly loggedSkips = new Set<string>()

  constructor(
    log: Logger,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.options = resolveOptions(config as KiddeSmokeDetectorsConfig)
    setLogger(log, this.options.debug)
    this.storagePath = api.user.storagePath()
    this.staleAfterMs = Math.max(MIN_STALE_AFTER_MS, 3 * this.options.pollingIntervalMs)

    if (!this.options.email || !this.options.password) {
      logWarn(
        'Not set up yet: open the plugin settings in the Homebridge UI and enter your Kidde email and password.',
      )
      // Accessories restored from cache would otherwise keep answering with
      // the last session's values, so an alarm nobody is watching would
      // still read as "no smoke".
      api.on('didFinishLaunching', () => this.markUnhandledAccessoriesUnavailable())
      return
    }

    api.on('didFinishLaunching', () => {
      // Homebridge restores cached characteristic VALUES but not whether
      // they are live, so a restored alarm would answer with last session's
      // reading. Start everything as not responding; polling clears it.
      this.markUnhandledAccessoriesUnavailable()
      this.start().catch((error) => logError(`Could not start: ${describeError(error)}`))
    })
    api.on('shutdown', () => this.shutdown())
  }

  /** Called by Homebridge for each cached accessory at startup */
  configureAccessory(accessory: PlatformAccessory): void {
    logDebug(`Restoring cached accessory: ${accessory.displayName}`)
    this.accessories.set(accessory.UUID, accessory)
  }

  // --- Lifecycle ---------------------------------------------------------------

  private async start(): Promise<void> {
    let session: KiddeSession | undefined
    try {
      session = await loadSession(this.storagePath, this.options.email)
    } catch (error) {
      logDebug(`Could not read the saved Kidde session: ${describeError(error)}`)
    }
    if (this.shuttingDown) return
    if (session) logDebug('Reusing the saved Kidde session')

    this.client = new KiddeClient({
      email: this.options.email,
      password: this.options.password,
      session,
      onSessionChange: (next, change) => this.onSessionChange(next, change),
    })

    // unref: background work must never hold a child bridge open on exit
    this.freshnessTimer = setInterval(() => this.checkFreshness(), FRESHNESS_CHECK_MS)
    this.freshnessTimer.unref()

    await this.pollNow()
  }

  private shutdown(): void {
    this.shuttingDown = true
    this.clearPollTimer()
    if (this.freshnessTimer) clearInterval(this.freshnessTimer)
    this.freshnessTimer = null
    // Save a refreshed cookie that was waiting for its turn (best effort)
    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer)
      this.sessionSaveTimer = null
      this.saveSessionNow(this.client?.currentSession)
    }
    // Abort requests in flight so nothing keeps working after shutdown
    this.client?.close()
    for (const handler of this.handlers.values()) handler.destroy()
    this.handlers.clear()
  }

  /**
   * Persist session changes. A new sign-in or an ended session is saved
   * immediately. A cookie refresh is saved at most every ten minutes: some
   * servers rotate a cookie on every response, and writing the file each
   * poll would wear out an SD card for no benefit.
   */
  private onSessionChange(session: KiddeSession | undefined, change: SessionChange): void {
    if (change === 'refresh') {
      if (this.sessionSaveTimer) return
      this.sessionSaveTimer = setTimeout(() => {
        this.sessionSaveTimer = null
        this.saveSessionNow(this.client?.currentSession)
      }, SESSION_REFRESH_SAVE_MS)
      this.sessionSaveTimer.unref()
      return
    }
    if (this.sessionSaveTimer) clearTimeout(this.sessionSaveTimer)
    this.sessionSaveTimer = null
    this.saveSessionNow(session)
  }

  /** Save in order, so an older write can never land last */
  private saveSessionNow(session: KiddeSession | undefined): void {
    this.sessionWrite = this.sessionWrite
      .then(() => saveSession(this.storagePath, this.options.email, session))
      .catch((error) => logError(`Could not save the Kidde session: ${describeError(error)}`))
  }

  // --- Warnings ----------------------------------------------------------------

  /** Log a warning once for as long as its condition lasts */
  private warnWhile(key: string, message: string): void {
    if (this.activeWarnings.has(key)) {
      logDebug(message)
      return
    }
    this.activeWarnings.add(key)
    logWarn(message)
  }

  /** The condition behind a warning has cleared */
  private cleared(key: string, message?: string): void {
    if (this.activeWarnings.delete(key) && message) logInfo(message)
  }

  // --- Polling -----------------------------------------------------------------

  /**
   * Run one poll now (or join the one in flight) and schedule the next.
   * Never rejects: every failure is handled and logged inside.
   */
  async pollNow(): Promise<void> {
    if (this.shuttingDown || !this.client) return
    if (this.pollInFlight) return this.pollInFlight
    this.clearPollTimer()
    this.pollInFlight = this.runPoll()
      .catch((error) => logError(`Unexpected error while polling Kidde: ${describeError(error)}`))
      .finally(() => {
        this.pollInFlight = null
      })
    return this.pollInFlight
  }

  private clearPollTimer(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private scheduleNext(delayMs: number): void {
    if (this.shuttingDown) return
    this.clearPollTimer()
    // unref: background polling must never hold a child bridge open on exit
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollNow()
    }, delayMs)
    this.pollTimer.unref()
  }

  private async runPoll(): Promise<void> {
    let nextDelay = this.options.pollingIntervalMs
    try {
      await this.poll()
      if (this.shuttingDown) return
      this.onPollSuccess()
    } catch (error) {
      if (this.shuttingDown) return
      nextDelay = this.onPollFailure(error)
    } finally {
      try {
        this.checkFreshness()
      } finally {
        this.scheduleNext(nextDelay)
      }
    }
  }

  private async poll(): Promise<void> {
    const client = this.client
    if (!client) return

    const locations: LocationInfo[] = []
    for (const raw of await client.getLocations()) {
      const info = locationInfo(raw)
      if (info) locations.push(info)
    }
    if (this.shuttingDown) return
    this.allLocations = locations

    if (locations.length === 0) this.warnWhile('no-locations', 'Kidde reports no locations on this account.')
    else this.cleared('no-locations')

    // A Locations filter that matches nothing is almost certainly a typo (or
    // a location name instead of its id). Obeying it would drop every alarm
    // from HomeKit, so it is ignored until it matches something.
    let included = locations
    let filterActive = false
    if (this.options.locationIds.size > 0 && locations.length > 0) {
      const matching = locations.filter((l) => this.options.locationIds.has(l.id.toLowerCase()))
      if (matching.length > 0) {
        included = matching
        filterActive = true
        this.cleared('filter-none', 'The configured Locations match this Kidde account again.')
      } else {
        this.warnWhile(
          'filter-none',
          'None of the configured Locations exist on this Kidde account, so the filter is ignored and ' +
            'every location is included. Check Advanced > Locations: it takes location IDs, which ' +
            'Sign In & Find Alarms lists.',
        )
      }
    }

    const now = monotonicNow()
    const seen = new Set<string>()
    /** One document per alarm, by alarm key */
    const found = new Map<string, { device: KiddeDevice; location: LocationInfo }>()
    let complete = true
    let failedLocations = 0

    for (const location of included) {
      if (this.shuttingDown) return
      let devices: KiddeDevice[]
      try {
        devices = await client.getDevices(location.id)
      } catch (error) {
        if (error instanceof KiddeAuthError || this.shuttingDown) throw error
        complete = false
        failedLocations++
        this.warnWhile(
          `location:${location.id}`,
          `Could not read the alarms at "${location.name}": ${describeError(error)}`,
        )
        continue
      }
      if (this.shuttingDown) return
      this.cleared(`location:${location.id}`, `Alarms at "${location.name}" can be read again`)
      for (const device of devices) {
        try {
          this.collect(device, location, found)
        } catch (error) {
          // One unexpected document must not stop the rest of the poll
          logError(`Skipping a device at "${location.name}" that could not be processed: ${describeError(error)}`)
        }
      }
    }

    if (included.length > 0 && failedLocations === included.length) {
      throw new KiddeApiError('Kidde did not return the alarms for any location.')
    }

    for (const [key, { device, location }] of found) {
      if (this.shuttingDown) return
      try {
        this.applyDevice(key, device, location, now, seen)
      } catch (error) {
        logError(`Skipping a device at "${location.name}" that could not be processed: ${describeError(error)}`)
      }
    }

    if (complete && seen.size === 0 && locations.length > 0) {
      this.warnWhile(
        'no-alarms',
        'No Kidde smoke alarms were found. Make sure they are set up and online in the Kidde app.',
      )
    } else if (seen.size > 0) {
      this.cleared('no-alarms')
    }

    const knownLocationIds = new Set(locations.map((l) => l.id.toLowerCase()))
    this.reconcileRemovals(complete, seen, now, filterActive, knownLocationIds)
    this.writeCache()

    if (!this.firstPollDone) {
      this.firstPollDone = true
      const shown = [...seen].filter((id) => this.handlers.has(id)).length
      logInfo(
        `Found ${seen.size} smoke alarm${seen.size === 1 ? '' : 's'} at ${included.length} ` +
          `location${included.length === 1 ? '' : 's'} (${shown} in HomeKit)`,
      )
    }
  }

  private onPollSuccess(): void {
    if (this.authProblem) logInfo('Signed in to Kidde')
    else if (this.consecutiveFailures > 0) logInfo('Connection to Kidde restored')
    this.authProblem = false
    this.consecutiveFailures = 0
  }

  /** Log a failed poll and return how long to wait before the next one */
  private onPollFailure(error: unknown): number {
    this.consecutiveFailures++
    const interval = this.options.pollingIntervalMs

    if (error instanceof KiddeAuthError) {
      if (!this.authProblem) {
        logError(`Kidde sign-in failed: ${error.message} Alarms show as No Response until it succeeds.`)
      } else {
        logDebug(`Kidde sign-in still failing: ${error.message}`)
      }
      this.authProblem = true
      const wait = error.retryAt !== undefined ? error.retryAt - monotonicNow() + 1000 : AUTH_RETRY_MS
      return Math.min(MAX_WAIT_MS, Math.max(interval, wait))
    }

    const message = describeError(error)
    if (this.consecutiveFailures === 1) {
      logWarn(`Could not update from Kidde: ${message} Retrying.`)
    } else if (
      this.consecutiveFailures === FAILURES_BEFORE_BACKOFF ||
      this.consecutiveFailures % 20 === 0
    ) {
      logError(
        `Still cannot update from Kidde after ${this.consecutiveFailures} attempts (${message}). ` +
          'Alarms show as No Response until it recovers.',
      )
    } else {
      logDebug(`Kidde update failed again: ${message}`)
    }

    if (this.consecutiveFailures <= FAILURES_BEFORE_BACKOFF) return interval
    return Math.min(
      MAX_FAILURE_BACKOFF_MS,
      interval * 2 ** (this.consecutiveFailures - FAILURES_BEFORE_BACKOFF),
    )
  }

  // --- Devices -----------------------------------------------------------------

  private overrideFor(id: string, serial: unknown): DeviceOverride | undefined {
    const byId = this.options.devices.get(id.toLowerCase())
    if (byId) return byId
    const serialKey = overrideKey(serial)
    return serialKey ? this.options.devices.get(serialKey) : undefined
  }

  /**
   * Note one device from a poll, keeping one document per alarm. Kidde can
   * list the same alarm twice, for example the old record of an alarm that
   * was removed and added again next to its new one; the live one is kept.
   */
  private collect(
    device: KiddeDevice,
    location: LocationInfo,
    found: Map<string, { device: KiddeDevice; location: LocationInfo }>,
  ): void {
    const id = idOf(device.id)
    const key = alarmKey(device)
    if (!id || !key) return
    if (!detectKinds(device).smoke) {
      if (!this.loggedSkips.has(`skip:${id}`)) {
        this.loggedSkips.add(`skip:${id}`)
        logDebug(
          `Skipping "${device.label ?? id}" (${device.model ?? 'unknown model'}): not a smoke alarm`,
        )
      }
      return
    }
    const entry = { device, location }
    const existing = found.get(key)
    if (!existing) {
      found.set(key, entry)
      return
    }
    const kept = preferredRecord(existing, entry)
    logDebug(
      `Kidde lists the same alarm twice (ids ${idOf(existing.device.id)} and ${id}); ` +
        `using id ${idOf(kept.device.id)}`,
    )
    found.set(key, kept)
  }

  private applyDevice(
    key: string,
    device: KiddeDevice,
    location: LocationInfo,
    now: number,
    seen: Set<string>,
  ): void {
    const id = idOf(device.id)
    if (!id) return
    const kinds = detectKinds(device)
    seen.add(key)
    this.records.set(key, { id, device, location, lastSeenAt: now })

    const override = this.overrideFor(id, device.serial_number)
    if (override?.hidden) {
      this.removeAccessory(key, 'hidden in the plugin settings')
      if (!this.loggedSkips.has(`hidden:${key}`)) {
        this.loggedSkips.add(`hidden:${key}`)
        logInfo(`"${device.label ?? id}" (id ${id}) is hidden from HomeKit by the plugin settings`)
      }
      return
    }
    this.loggedSkips.delete(`hidden:${key}`)

    const name = sanitizeName(override?.name || (typeof device.label === 'string' ? device.label : ''))
    let handler = this.handlers.get(key)
    // Capabilities can be gained at runtime (the CO sensor is added) but
    // never lost: one document without a capability list must not remove
    // a service and the user's automations with it. A real change is picked
    // up at the next restart.
    if (handler && kinds.co && !handler.kinds.co) {
      handler.destroy()
      this.handlers.delete(key)
      handler = undefined
    }
    if (!handler) {
      this.setupAccessory(key, id, device, kinds, name, location)
      return
    }

    const wasStale = !handler.isFresh
    const context = handler.accessory.context
    let changed = false
    if (handler.displayName !== name) {
      handler.rename(name)
      changed = true
    }
    if (context.deviceId !== id) {
      logInfo(
        `"${name}" is listed by Kidde under a new id (${context.deviceId} -> ${id}); ` +
          'it stays the same accessory in HomeKit',
      )
      context.deviceId = id
      changed = true
    }
    if (context.locationId !== location.id) {
      context.locationId = location.id
      changed = true
    }
    if (changed) this.api.updatePlatformAccessories([handler.accessory])
    handler.update(device)
    if (wasStale && !this.authProblem) logInfo(`"${handler.displayName}" is reporting again`)
  }

  /** The HomeKit identity of an alarm, from its alarm key */
  private uuidFor(key: string): string {
    return hap.uuid.generate(`${PLUGIN_NAME}:${key}`)
  }

  private setupAccessory(
    key: string,
    id: string,
    device: KiddeDevice,
    kinds: DeviceKinds,
    name: string,
    location: LocationInfo,
  ): void {
    const uuid = this.uuidFor(key)
    let accessory = this.accessories.get(uuid)
    const restored = Boolean(accessory)

    // A document without a capability list keeps the CO sensor a previous
    // run created, rather than removing it
    const effective: DeviceKinds = {
      smoke: true,
      co: kinds.co || (!hasCapabilityList(device) && accessory?.context.hasCo === true),
    }

    // A restored accessory still carrying an older name is renamed by its
    // handler below, which renames its services with it
    if (!accessory) {
      logInfo(`Adding "${name}" (${describeModel(device, effective)}, id ${id}) at "${location.name}"`)
      accessory = new this.api.platformAccessory(name, uuid, hap.Categories.SENSOR)
    }
    if (restored && typeof accessory.context.deviceId === 'string' && accessory.context.deviceId !== id) {
      logInfo(
        `"${name}" is listed by Kidde under a new id (${accessory.context.deviceId} -> ${id}); ` +
          'it stays the same accessory in HomeKit',
      )
    }
    accessory.context.alarmKey = key
    accessory.context.deviceId = id
    accessory.context.locationId = location.id
    accessory.context.hasCo = effective.co
    const serial = serialOf(device)
    if (serial) accessory.context.serialNumber = serial

    const options: AccessoryOptions = {
      lowBatteryThreshold: this.options.lowBatteryThreshold,
      hushSwitch: this.options.hushSwitch,
      testSwitch: this.options.testSwitch,
      identifyLocate: this.options.identifyLocate,
      staleAfterMs: this.staleAfterMs,
    }
    const handler = new SmokeAlarmAccessory(accessory, name, device, effective, options, (command) =>
      this.sendCommand(key, command),
    )
    this.handlers.set(key, handler)
    this.missing.delete(key)

    if (restored) {
      this.api.updatePlatformAccessories([accessory])
    } else {
      this.accessories.set(uuid, accessory)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    }
  }

  /** Send a command to an alarm's current Kidde record */
  private async sendCommand(key: string, command: KiddeCommand): Promise<void> {
    const record = this.records.get(key)
    if (!this.client || !record || this.shuttingDown) {
      throw new Error('this alarm is not currently reported by Kidde')
    }
    await this.client.sendCommand(record.location.id, record.id, command)
    if (this.shuttingDown) return
    // Show the effect (hushed, test started) without waiting a full interval
    const timer = setTimeout(() => void this.pollNow(), POST_COMMAND_POLL_MS)
    timer.unref()
  }

  /**
   * Push any availability change caused by time passing. Runs on its own
   * timer and after every poll, so an alarm goes to No Response on time
   * even while polls are held up by a backoff.
   */
  private checkFreshness(): void {
    for (const handler of this.handlers.values()) {
      if (!handler.checkAvailability()) continue
      if (!handler.isFresh && !this.authProblem && this.consecutiveFailures === 0) {
        // Only worth a line of its own when Kidde itself is answering
        logWarn(
          `Kidde has not reported "${handler.displayName}" for ${Math.round(this.staleAfterMs / 1000)}s; ` +
            'it shows as No Response until it does',
        )
      }
    }
  }

  /**
   * Unregister accessories the user no longer wants, and alarms that have
   * been gone from Kidde long enough to be sure. Only complete polls count.
   */
  private reconcileRemovals(
    complete: boolean,
    seen: Set<string>,
    now: number,
    filterActive: boolean,
    knownLocationIds: Set<string>,
  ): void {
    if (!complete) return

    for (const accessory of [...this.accessories.values()]) {
      const key = typeof accessory.context.alarmKey === 'string' ? accessory.context.alarmKey : undefined
      if (!key) continue
      const id = typeof accessory.context.deviceId === 'string' ? accessory.context.deviceId : ''

      if (this.overrideFor(id, accessory.context.serialNumber)?.hidden) {
        this.removeAccessory(key, 'hidden in the plugin settings')
        continue
      }

      // Only when the filter matched something, and the alarm's location
      // still exists and is one the user left out
      const locationId =
        typeof accessory.context.locationId === 'string' ? accessory.context.locationId.toLowerCase() : undefined
      if (
        filterActive &&
        !seen.has(key) &&
        locationId &&
        knownLocationIds.has(locationId) &&
        !this.options.locationIds.has(locationId)
      ) {
        this.removeAccessory(key, 'its location is not in the configured Locations')
        continue
      }

      if (seen.has(key)) {
        this.missing.delete(key)
        continue
      }
      // A poll that found no alarms at all is never trusted to mean "every
      // alarm was removed": Kidde can transiently return an empty list.
      if (seen.size === 0) continue

      const entry = this.missing.get(key) ?? { since: now, polls: 0 }
      entry.polls++
      this.missing.set(key, entry)
      if (entry.polls >= REMOVAL_MIN_POLLS && now - entry.since >= REMOVAL_GRACE_MS) {
        this.removeAccessory(key, 'Kidde no longer reports it')
      }
    }
  }

  private removeAccessory(key: string, reason: string): void {
    const uuid = this.uuidFor(key)
    const accessory = this.accessories.get(uuid)
    this.handlers.get(key)?.destroy()
    this.handlers.delete(key)
    this.missing.delete(key)
    if (!accessory) return
    logInfo(`Removing "${accessory.displayName}" from HomeKit: ${reason}`)
    this.accessories.delete(uuid)
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
  }

  /**
   * Cached accessories with no live handler would keep serving the values
   * they had when Homebridge last stopped. Mark them not responding.
   */
  private markUnhandledAccessoriesUnavailable(): void {
    const handled = new Set([...this.handlers.values()].map((h) => h.accessory.UUID))
    for (const accessory of this.accessories.values()) {
      if (handled.has(accessory.UUID)) continue
      for (const service of accessory.services) {
        if (service.UUID === hap.Service.AccessoryInformation.UUID) continue
        for (const characteristic of service.characteristics) {
          if (characteristic.UUID === hap.Characteristic.Name.UUID) continue
          if (characteristic.UUID === hap.Characteristic.ConfiguredName.UUID) continue
          characteristic.updateValue(
            new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
          )
        }
      }
    }
  }

  // --- Settings page cache -----------------------------------------------------

  /** Publish the alarms and locations for the settings page, if they changed */
  private writeCache(): void {
    const now = monotonicNow()
    const devices: CachedDevice[] = []
    for (const record of this.records.values()) {
      if (now - record.lastSeenAt > REMOVAL_GRACE_MS) continue
      const entry = cachedDeviceFrom(record.device, record.location)
      if (entry) devices.push(entry)
    }
    const locations: CachedLocation[] = this.allLocations.map(({ id, name }) => ({ id, name }))
    const snapshot = JSON.stringify({ devices, locations })
    if (snapshot === this.cacheSnapshot) return
    this.cacheSnapshot = snapshot
    writeDeviceCache(this.storagePath, devices, locations).catch((error) =>
      logError(`Could not write the device list for the settings page: ${describeError(error)}`),
    )
  }
}
