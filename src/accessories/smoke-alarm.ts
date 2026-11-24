/**
 * Smoke Alarm Accessory
 *
 * One HomeKit accessory per Kidde smoke alarm, with:
 * - Smoke Sensor (primary): smoke detected, fault, low battery
 * - Carbon Monoxide Sensor, on smoke + CO models: CO detected, CO level,
 *   fault, low battery
 * - Battery: level, low battery, not chargeable
 * - optional momentary Hush and Test switches
 *
 * Each accessory owns its own copy of its alarm's state. Kidde reports all
 * alarms in one response per location, and the platform hands each alarm
 * only its own document, so an update for one alarm can never touch
 * another alarm's state.
 *
 * AVAILABILITY: every characteristic except the static accessory
 * information is gated on whether this alarm is currently being heard
 * from. That needs both: a successful poll included the alarm within the
 * stale window (measured live, on the monotonic clock, at every read), and
 * Kidde does not flag it as offline. While either is false, reads fail with
 * SERVICE_COMMUNICATION_FAILURE and HomeKit shows "No Response" instead of
 * the last known reading. For a life-safety sensor, a stale "no smoke" from
 * an alarm nobody can hear from is the worst possible failure mode; an
 * obvious "No Response" is the honest one.
 *
 * UPDATES are pushed, not just served: every bound characteristic is
 * recomputed after each poll (and when the alarm goes stale) and pushed to
 * HomeKit only when its value changes, so alarm notifications fire without
 * HomeKit having to ask.
 *
 * NAMES: each service is named after the alarm ("Kitchen", "Kitchen CO",
 * "Kitchen Battery"). When the alarm is renamed (in the Kidde app or in the
 * plugin settings), the accessory and every service follow, whether the
 * rename is seen while running or after a restart. ConfiguredName, the
 * name the Home app shows and lets the user edit, follows only while it
 * still holds the name this plugin gave it, so a name chosen in the Home
 * app is never overwritten.
 *
 * SERVICES are decided once, when the handler is built, from the alarm's
 * capabilities. The Battery service and the CO level are always present
 * (rather than depending on fields being in a given document), so one
 * unusual document cannot remove a service and with it the user's
 * automations and notification settings.
 */

import type {
  Characteristic,
  CharacteristicValue,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge'
import { hap } from '../hap.js'
import { monotonicNow } from '../clock.js'
import { describeError, logDebug, logError, logInfo, logWarn } from '../util.js'
import {
  batteryCategory,
  batteryPercent,
  coPpm,
  CO_FIELDS,
  describeModel,
  faultReasons,
  firmwareRevision,
  idOf,
  isCoDetected,
  isFlagSet,
  isLowBattery,
  isOffline,
  isSmokeDetected,
  OFFLINE_FLAGS,
  readAlarmField,
  SMOKE_FIELDS,
  unreadableAlarmFields,
  type DeviceKinds,
  type KiddeCommand,
  type KiddeDevice,
} from '../kidde-api/types.js'

/** Per-accessory settings taken from the plugin options */
export interface AccessoryOptions {
  lowBatteryThreshold: number
  hushSwitch: boolean
  testSwitch: boolean
  identifyLocate: boolean
  /** How long after the last poll that included this alarm its data is trusted */
  staleAfterMs: number
}

/** Sends a command to this accessory's alarm through the Kidde cloud */
export type CommandSender = (command: KiddeCommand) => Promise<void>

/** How long a momentary switch stays on before it turns itself off */
const MOMENTARY_RESET_MS = 1000
/**
 * Longest a switch press waits for Kidde before answering HomeKit.
 * HAP-NodeJS warns about handlers slower than 3 seconds.
 */
const COMMAND_RESPONSE_DEADLINE_MS = 2500
/** How long a Locate runs before it is cancelled */
const LOCATE_DURATION_MS = 20_000

/**
 * Fields kept from the previous document if a new one omits them: the
 * alarm fields, and the time of the last self-test (so a field that comes
 * and goes can never log the same test twice).
 */
const STICKY_FIELDS: readonly string[] = [...SMOKE_FIELDS, ...CO_FIELDS, 'last_test_time']

const UNSET = Symbol('unset')
const UNAVAILABLE = Symbol('unavailable')

interface Binding {
  characteristic: Characteristic
  getValue: (device: KiddeDevice) => CharacteristicValue | undefined
  gated: boolean
  last: CharacteristicValue | typeof UNSET | typeof UNAVAILABLE
}

/**
 * A HapStatusError, not a plain Error: HAP-NodeJS treats a plain Error from
 * a read handler as a plugin bug and logs a stack trace for every read,
 * which would flood the log for the whole length of an outage.
 */
function unavailableError(): Error {
  return new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
}

/** Values already warned about, so each is logged once */
const warnedValues = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedValues.has(key)) return
  warnedValues.add(key)
  logWarn(message)
}

export class SmokeAlarmAccessory {
  readonly deviceId: string
  private device: KiddeDevice
  /** Monotonic time of the last poll that included this alarm */
  private lastSeenAt = monotonicNow()
  /** Availability as last pushed to HomeKit */
  private lastAvailable: boolean | undefined
  private destroyed = false
  private readonly bindings: Binding[] = []
  /** Services named after the alarm, with the suffix each adds to its name */
  private readonly named: Array<{ service: Service; suffix: string }> = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private locateTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Last battery percentage that could be determined. HomeKit's BatteryLevel
   * has no "unknown", so an unrecognized battery state holds this value; the
   * low-battery warning, which never guesses, is the signal that counts.
   */
  private lastBatteryPercent = 100
  private readonly onIdentify = () => {
    void this.identify()
  }

  /**
   * @param name The alarm's name. A restored accessory still carrying an
   *   older name is renamed to it, services included.
   */
  constructor(
    readonly accessory: PlatformAccessory,
    name: string,
    device: KiddeDevice,
    readonly kinds: DeviceKinds,
    private readonly options: AccessoryOptions,
    private readonly sendCommand: CommandSender,
  ) {
    this.deviceId = idOf(device.id) ?? accessory.UUID
    this.device = device

    const used: Service[] = []
    const previousName = accessory.displayName

    // Static information. Not gated: an offline alarm should still show
    // its model and serial number.
    const info = accessory.getService(hap.Service.AccessoryInformation)!
    this.bind(info, hap.Characteristic.Manufacturer, () => 'Kidde', false)
    this.bind(info, hap.Characteristic.Model, (d) => describeModel(d, this.kinds), false)
    this.bind(
      info,
      hap.Characteristic.SerialNumber,
      (d) =>
        (typeof d.serial_number === 'string' && d.serial_number.trim()) || this.deviceId,
      false,
    )
    this.bind(
      info,
      hap.Characteristic.FirmwareRevision,
      (d) => firmwareRevision(d) ?? '1.0.0',
      false,
    )
    used.push(info)

    // Smoke Sensor, the primary service. Triggers HomeKit's smoke alert.
    // An unreadable alarm value is No Response, never a guessed "no smoke".
    const smoke = this.service(hap.Service.SmokeSensor, name, '')
    smoke.setPrimaryService(true)
    this.bind(smoke, hap.Characteristic.SmokeDetected, (d) => {
      const detected = isSmokeDetected(d)
      if (detected === undefined) return undefined
      return detected
        ? hap.Characteristic.SmokeDetected.SMOKE_DETECTED
        : hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
    })
    this.bindHealth(smoke)
    used.push(smoke)

    // Carbon Monoxide Sensor, on smoke + CO models. Triggers HomeKit's CO alert.
    if (kinds.co) {
      const co = this.service(hap.Service.CarbonMonoxideSensor, name, ' CO')
      this.bind(co, hap.Characteristic.CarbonMonoxideDetected, (d) => {
        const detected = isCoDetected(d)
        if (detected === undefined) return undefined
        return detected
          ? hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL
      })
      // The level is informational; the alert is CarbonMonoxideDetected.
      // A missing reading is 0 ppm, the normal state, and readings are
      // clamped to the characteristic's 0 to 100 range so HAP never rejects
      // them.
      this.bind(co, hap.Characteristic.CarbonMonoxideLevel, (d) =>
        Math.max(0, Math.min(100, coPpm(d) ?? 0)),
      )
      this.bindHealth(co)
      used.push(co)
    }

    // Every supported alarm has a battery (sealed, or backup on hardwired
    // models). Without battery data the level holds its placeholder and the
    // warning stays off.
    const battery = this.service(hap.Service.Battery, name, ' Battery')
    this.bind(battery, hap.Characteristic.BatteryLevel, (d) => {
      const percent = batteryPercent(d, this.options.lowBatteryThreshold)
      if (percent !== undefined) this.lastBatteryPercent = percent
      return percent ?? this.lastBatteryPercent
    })
    this.bindLowBattery(battery)
    this.bind(
      battery,
      hap.Characteristic.ChargingState,
      () => hap.Characteristic.ChargingState.NOT_CHARGEABLE,
    )
    used.push(battery)

    if (options.hushSwitch) {
      used.push(this.momentarySwitch('hush', name, 'hush', 'Hush'))
    }
    if (options.testSwitch) {
      used.push(this.momentarySwitch('test', name, 'test', 'Test'))
    }

    this.pruneServices(used)
    if (previousName !== name) this.applyName(previousName, name)
    accessory.on('identify', this.onIdentify)

    this.logInitialState()
    this.refresh()
  }

  get displayName(): string {
    return this.accessory.displayName
  }

  /** Whether a poll included this alarm within the stale window */
  get isFresh(): boolean {
    return monotonicNow() - this.lastSeenAt <= this.options.staleAfterMs
  }

  /** Whether HomeKit is currently being given live values for this alarm */
  get available(): boolean {
    return !this.destroyed && this.isFresh && !isOffline(this.device)
  }

  // --- State -----------------------------------------------------------------

  /**
   * Apply a fresh device document from a poll.
   *
   * Kidde returns the full document every time, so it replaces the previous
   * one (a fault flag that Kidde drops must stop showing). The one exception
   * is the alarm fields: if a document arrives without them at all, the
   * previous values are kept, because a malformed answer must never be able
   * to read as "smoke cleared".
   */
  update(next: KiddeDevice): void {
    if (this.destroyed) return
    this.lastSeenAt = monotonicNow()
    const previous = this.device
    const merged: KiddeDevice = { ...next }
    for (const field of STICKY_FIELDS) {
      if (!(field in next) && field in previous) merged[field] = previous[field]
    }
    this.device = merged
    try {
      this.logTransitions(previous, merged)
    } catch (error) {
      logDebug(`Could not log state changes for "${this.displayName}": ${describeError(error)}`)
    }
    this.refresh()
  }

  /**
   * Re-check availability against the clock and push the change to HomeKit
   * if it flipped. The platform calls this on a timer, so an alarm goes to
   * No Response on time even when polling is held up. Returns true if
   * availability changed.
   */
  checkAvailability(): boolean {
    if (this.destroyed) return false
    const before = this.lastAvailable
    this.refresh()
    return before !== this.lastAvailable
  }

  /** Apply a new display name (Kidde app rename, or the name in the settings) */
  rename(name: string): void {
    if (this.accessory.displayName === name) return
    this.applyName(this.accessory.displayName, name)
  }

  private applyName(previous: string, next: string): void {
    logInfo(`Renaming "${previous}" to "${next}"`)
    this.accessory.displayName = next
    this.accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.Name, next)
    for (const { service, suffix } of this.named) {
      const was = `${previous}${suffix}`
      const now = `${next}${suffix}`
      service.displayName = now
      service.updateCharacteristic(hap.Characteristic.Name, now)
      // Follow the rename only where the Home app still shows the name this
      // plugin gave the service; a name the user chose there is theirs
      if (!service.testCharacteristic(hap.Characteristic.ConfiguredName)) continue
      const configured = service.getCharacteristic(hap.Characteristic.ConfiguredName)
      if (configured.value === was || !configured.value) configured.updateValue(now)
    }
  }

  /** Stop pushing updates and release timers and listeners */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.locateTimer) clearTimeout(this.locateTimer)
    this.locateTimer = null
    this.accessory.removeListener('identify', this.onIdentify)
  }

  /** Recompute every bound characteristic and push the ones that changed */
  private refresh(): void {
    const available = this.available
    this.lastAvailable = available
    for (const binding of this.bindings) {
      let next: CharacteristicValue | typeof UNAVAILABLE
      if (binding.gated && !available) {
        next = UNAVAILABLE
      } else {
        next = this.safeValue(binding) ?? UNAVAILABLE
      }
      if (next === binding.last) continue
      binding.last = next
      if (next === UNAVAILABLE) {
        binding.characteristic.updateValue(unavailableError())
      } else {
        binding.characteristic.updateValue(next)
      }
    }
  }

  /**
   * A characteristic's value, or undefined if it cannot be computed. The
   * device document is untrusted input from the cloud; an exception here
   * must not escape into HAP or the poll loop.
   */
  private safeValue(binding: Binding): CharacteristicValue | undefined {
    try {
      return binding.getValue(this.device)
    } catch {
      return undefined
    }
  }

  // --- Services --------------------------------------------------------------

  /**
   * Reuse a cached service (preserving the HomeKit pairing) or add it,
   * named after the alarm plus the service's suffix.
   */
  private service(
    type: WithUUID<typeof Service>,
    base: string,
    suffix: string,
    subtype?: string,
  ): Service {
    const existing = subtype
      ? this.accessory.getServiceById(type, subtype)
      : this.accessory.getService(type)
    if (existing) {
      this.named.push({ service: existing, suffix })
      return existing
    }
    const name = `${base}${suffix}`
    // Every predefined HAP service constructor takes (displayName, subtype)
    const ServiceType = type as unknown as new (displayName: string, subtype?: string) => Service
    const service = this.accessory.addService(new ServiceType(name, subtype))
    // ConfiguredName is what current Home apps show for a service. It is
    // written at creation and on a rename (see applyName), never on an
    // ordinary start, so a name the user gives it in the Home app is kept.
    if (!service.testCharacteristic(hap.Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName)
    }
    service.setCharacteristic(hap.Characteristic.ConfiguredName, name)
    this.named.push({ service, suffix })
    return service
  }

  /**
   * Bind a characteristic to the alarm state, for both HomeKit reads (onGet)
   * and pushed updates (refresh). getValue returning undefined means "not
   * known", which HomeKit sees as No Response rather than a made-up value.
   * Reads check availability live, so a stale alarm answers No Response even
   * between availability checks.
   */
  private bind(
    service: Service,
    type: WithUUID<new () => Characteristic>,
    getValue: (device: KiddeDevice) => CharacteristicValue | undefined,
    gated = true,
  ): Characteristic {
    const characteristic = service.getCharacteristic(type)
    const binding: Binding = { characteristic, getValue, gated, last: UNSET }
    characteristic.onGet(() => {
      if (gated && !this.available) throw unavailableError()
      const value = this.safeValue(binding)
      if (value === undefined) throw unavailableError()
      return value
    })
    this.bindings.push(binding)
    return characteristic
  }

  /** Active, fault and low battery on a sensor service */
  private bindHealth(service: Service): void {
    this.bind(service, hap.Characteristic.StatusActive, () => true)
    this.bind(service, hap.Characteristic.StatusFault, (d) =>
      faultReasons(d).length > 0
        ? hap.Characteristic.StatusFault.GENERAL_FAULT
        : hap.Characteristic.StatusFault.NO_FAULT,
    )
    // On the sensor itself so the warning shows on its tile, not only in
    // the battery details
    this.bindLowBattery(service)
  }

  private bindLowBattery(service: Service): void {
    this.bind(service, hap.Characteristic.StatusLowBattery, (d) =>
      isLowBattery(d, this.options.lowBatteryThreshold)
        ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    )
  }

  /**
   * A switch that sends one command when turned on, then turns itself off.
   *
   * The set handler waits for Kidde only briefly: HAP-NodeJS warns about
   * handlers slower than 3 seconds. A command still in flight at the
   * deadline is left to finish, and its outcome is logged.
   */
  private momentarySwitch(subtype: string, base: string, command: KiddeCommand, label: string): Service {
    const service = this.service(hap.Service.Switch, base, ` ${label}`, subtype)
    const on = service.getCharacteristic(hap.Characteristic.On)
    on.onGet(() => {
      if (!this.available) throw unavailableError()
      return false
    })
    on.onSet(async (value) => {
      if (value !== true) return
      this.later(() => on.updateValue(false), MOMENTARY_RESET_MS)
      if (!this.available) throw unavailableError()

      const sent = this.sendCommand(command).then(
        () => {
          logInfo(`${label} sent to "${this.displayName}"`)
          return true
        },
        (error) => {
          logError(`${label} for "${this.displayName}" failed: ${describeError(error)}`)
          return false
        },
      )
      const outcome = await Promise.race([
        sent,
        new Promise<'pending'>((resolve) => this.later(() => resolve('pending'), COMMAND_RESPONSE_DEADLINE_MS)),
      ])
      if (outcome === false) throw unavailableError()
    })
    return service
  }

  /**
   * HomeKit's Identify Accessory. With the option on, the alarm locates
   * itself (beeps and flashes, like Locate in the Kidde app) and the locate
   * is cancelled after a short while so it cannot run on indefinitely.
   */
  private async identify(): Promise<void> {
    if (!this.options.identifyLocate) {
      logInfo(`Identify requested for "${this.displayName}" (Locate on Identify is off)`)
      return
    }
    try {
      await this.sendCommand('identify')
      logInfo(`Locating "${this.displayName}"`)
    } catch (error) {
      logError(`Could not locate "${this.displayName}": ${describeError(error)}`)
      return
    }
    if (this.destroyed) return
    if (this.locateTimer) clearTimeout(this.locateTimer)
    this.locateTimer = setTimeout(() => {
      this.locateTimer = null
      if (this.destroyed) return
      this.sendCommand('identifycancel').catch((error) =>
        logDebug(`Could not end Locate on "${this.displayName}": ${describeError(error)}`),
      )
    }, LOCATE_DURATION_MS)
    this.locateTimer.unref()
  }

  /** setTimeout that never holds the process open and is cleared on destroy */
  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.destroyed) fn()
    }, ms)
    timer.unref()
    this.timers.add(timer)
  }

  /**
   * Remove services this accessory no longer uses, for example a Hush
   * switch after the option is turned off, or services left by an older
   * version of the plugin.
   */
  private pruneServices(used: Service[]): void {
    const keep = new Set(used)
    // Iterate a copy: removeService mutates the live array
    for (const service of [...this.accessory.services]) {
      if (keep.has(service)) continue
      if (service.UUID === hap.Service.AccessoryInformation.UUID) continue
      this.accessory.removeService(service)
    }
  }

  // --- Logging ---------------------------------------------------------------

  private logInitialState(): void {
    const d = this.device
    const name = this.displayName
    if (isSmokeDetected(d) === true) logWarn(`SMOKE ALARM: "${name}" is reporting smoke`)
    if (this.kinds.co && isCoDetected(d) === true) logWarn(`CARBON MONOXIDE ALARM: "${name}" is reporting CO`)
    if (isOffline(d)) {
      logWarn(`"${name}" is offline in Kidde (${this.offlineFlags(d)}); it shows as No Response`)
    }
    const faults = faultReasons(d)
    if (faults.length > 0) logWarn(`"${name}" reports a fault: ${faults.join(', ')}`)
    if (isLowBattery(d, this.options.lowBatteryThreshold)) {
      logWarn(`"${name}" reports a low battery (${this.describeBattery(d)})`)
    }
    this.warnUnreadable(d)
  }

  /** Log every change worth knowing about between two documents */
  private logTransitions(prev: KiddeDevice, cur: KiddeDevice): void {
    const name = this.displayName

    const smokeBefore = isSmokeDetected(prev) === true
    const smokeNow = isSmokeDetected(cur) === true
    if (!smokeBefore && smokeNow) {
      const via =
        readAlarmField(cur.smoke_alarm) !== true && readAlarmField(cur.hardwire_smoke) === true
          ? ' (sounding with an interconnected alarm)'
          : ''
      logWarn(`SMOKE ALARM: "${name}" is reporting smoke${via}`)
    } else if (smokeBefore && !smokeNow) {
      logInfo(`Smoke alarm cleared on "${name}"`)
    }

    const coBefore = isCoDetected(prev) === true
    const coNow = isCoDetected(cur) === true
    if (this.kinds.co) {
      if (!coBefore && coNow) {
        const ppm = coPpm(cur)
        logWarn(`CARBON MONOXIDE ALARM: "${name}" is reporting CO${ppm ? ` (${ppm} ppm)` : ''}`)
      } else if (coBefore && !coNow) {
        logInfo(`Carbon monoxide alarm cleared on "${name}"`)
      }
    } else if (!coBefore && coNow) {
      // The capability list said no CO sensor, yet Kidde reports a CO alarm
      logError(
        `"${name}" is reporting a CO alarm, but Kidde lists no CO sensor for it, so it has no ` +
          'Carbon Monoxide Sensor in HomeKit. Please report this on the issue tracker.',
      )
    }

    if (!isFlagSet(prev.smoke_hushed) && isFlagSet(cur.smoke_hushed)) logInfo(`"${name}" was hushed`)

    const offlineBefore = isOffline(prev)
    const offlineNow = isOffline(cur)
    if (!offlineBefore && offlineNow) {
      logWarn(
        `"${name}" is offline in Kidde (${this.offlineFlags(cur)}); it shows as No Response ` +
          'until Kidde hears from it again',
      )
    } else if (offlineBefore && !offlineNow) {
      logInfo(`"${name}" is back online in Kidde`)
    }

    const faultsBefore = faultReasons(prev).join(', ')
    const faultsNow = faultReasons(cur).join(', ')
    if (faultsNow !== faultsBefore) {
      if (faultsNow) logWarn(`"${name}" reports a fault: ${faultsNow}`)
      else logInfo(`Fault cleared on "${name}"`)
    }

    const threshold = this.options.lowBatteryThreshold
    const batteryBefore = this.describeBattery(prev)
    const batteryNow = this.describeBattery(cur)
    if (batteryBefore !== batteryNow) {
      const low = isLowBattery(cur, threshold)
      const message = `Battery for "${name}" changed: ${batteryBefore} -> ${batteryNow}`
      if (low && !isLowBattery(prev, threshold)) logWarn(message)
      else logInfo(message)
    }

    // Kidde sets last_test_time when a self-test starts, from the test button
    // or remotely. Alarms that have not been tested lately leave it out
    // entirely (seen on a real EssWFAC), so its first appearance is a test
    // too. A test never sets the alarm fields, so HomeKit stays quiet.
    if (typeof cur.last_test_time === 'string' && cur.last_test_time !== prev.last_test_time) {
      logInfo(`"${name}" ran a self-test`)
    }

    this.warnUnreadable(cur)
  }

  private describeBattery(d: KiddeDevice): string {
    const parts: string[] = []
    if (typeof d.battery_state === 'string') parts.push(d.battery_state)
    if (typeof d.battery_level === 'number') parts.push(`${d.battery_level}%`)
    if (isFlagSet(d.low_battery_alarm)) parts.push('low battery alarm')
    return parts.join(', ') || 'no battery information'
  }

  private offlineFlags(d: KiddeDevice): string {
    return OFFLINE_FLAGS.filter((flag) => isFlagSet(d[flag])).join(', ')
  }

  /** Log values the plugin cannot interpret, once each */
  private warnUnreadable(d: KiddeDevice): void {
    for (const field of unreadableAlarmFields(d)) {
      const value = JSON.stringify(d[field])
      warnOnce(
        `alarm:${this.deviceId}:${field}:${value}`,
        `"${this.displayName}" reports ${field} as ${value}, which the plugin cannot read; ` +
          'it shows as No Response rather than guessing. Please report this on the issue tracker.',
      )
    }
    if (batteryCategory(d) === 'unrecognized') {
      const key = String(d.battery_state)
      warnOnce(
        `battery:${key}`,
        `Unrecognized battery state "${key}" on "${this.displayName}"; not treating it as low. ` +
          'Please report this value on the issue tracker so it can be mapped.',
      )
    }
  }
}
