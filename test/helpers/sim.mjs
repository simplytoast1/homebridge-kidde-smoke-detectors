/**
 * Simulated Kidde backend for the regression tests.
 *
 * The tests run the REAL compiled plugin (dist/) end to end. Only the edge
 * that touches Kidde is replaced: global fetch. Everything in between, the
 * client, session handling, platform and HomeKit accessories, is production
 * code running against real HAP classes.
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHap } from '../../dist/hap.js'
import { advanceMonotonicClock } from '../../dist/clock.js'
import { KiddeSmokeDetectorsPlatform } from '../../dist/platform.js'
import { createKiddeServer } from './kidde-server.mjs'

const require = createRequire(import.meta.url)
const hbRequire = createRequire(require.resolve('homebridge'))

/** hap-nodejs exactly as Homebridge itself resolves it, so the classes match */
function loadHap() {
  for (const name of ['@homebridge/hap-nodejs', 'hap-nodejs']) {
    try {
      return hbRequire(name)
    } catch {
      // try the next name
    }
  }
  throw new Error('hap-nodejs not found next to homebridge')
}

export const hap = loadHap()
setHap(hap)

export const MINUTE = 60_000
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Control time for a test. The plugin measures durations on its monotonic
 * clock, so advance() moves that; the wall clock (Date) is frozen and moved
 * along with it, and jumpWallClock() moves only the wall clock, the way NTP
 * steps it on a device without a real-time clock. Timers stay real.
 */
export function mockClock(t) {
  let now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  return {
    advance(ms) {
      now += ms
      t.mock.timers.setTime(now)
      advanceMonotonicClock(ms)
    },
    jumpWallClock(ms) {
      now += ms
      t.mock.timers.setTime(now)
    },
  }
}

/** Poll until a condition holds, failing loudly if it never does. */
export async function until(condition, { timeout = 3000, what = 'condition' } = {}) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(5)
  }
}

/** Stand-in for Homebridge's PlatformAccessory, backed by a real HAP Accessory. */
export class FakePlatformAccessory extends EventEmitter {
  constructor(displayName, UUID, category) {
    super()
    this.displayName = displayName
    this.UUID = UUID
    this.category = category
    this.context = {}
    this.hapAccessory = new hap.Accessory(displayName, UUID)
  }
  get services() {
    return this.hapAccessory.services
  }
  getService(service) {
    return this.hapAccessory.getService(service)
  }
  getServiceById(service, subtype) {
    return this.hapAccessory.getServiceById(service, subtype)
  }
  addService(service, ...args) {
    return this.hapAccessory.addService(service, ...args)
  }
  removeService(service) {
    this.hapAccessory.removeService(service)
  }
}

/**
 * An accessory as Homebridge restores it after a restart: written to the
 * accessory cache as JSON and rebuilt from it, not the same objects.
 */
export function restoredFromDisk(accessory) {
  const copy = new FakePlatformAccessory(accessory.displayName, accessory.UUID, accessory.category)
  const saved = JSON.parse(JSON.stringify(hap.Accessory.serialize(accessory.hapAccessory)))
  copy.hapAccessory = hap.Accessory.deserialize(saved)
  copy.context = JSON.parse(JSON.stringify(accessory.context))
  return copy
}

/** A smoke + CO alarm document, shaped like a real wifidetector */
export function comboAlarm(id, label, overrides = {}) {
  return {
    id,
    serial_number: `SN${id}`,
    model: 'wifidetector',
    location_id: 1,
    label,
    hwrev: 'WD-ESP32',
    capabilities: ['smoke', 'co'],
    errors: [],
    smoke_alarm: false,
    co_alarm: false,
    smoke_level: 0,
    too_much_smoke: false,
    smoke_hushed: false,
    co_level: 0,
    fwrev: { wm: '2.5', net: '4.4.1', alarm: '1.10' },
    life: 535,
    batt_volt: 0,
    battery_state: 'ok',
    lost: false,
    end_of_life_status: 1,
    last_seen: '2026-11-10T18:59:02.932375951Z',
    last_test_time: '2026-11-10T18:56:02Z',
    ...overrides,
  }
}

/** A smoke-only alarm document, shaped like a real EssWFAC (20SAR-W) */
export function smokeAlarm(id, label, overrides = {}) {
  return {
    id,
    serial_number: `SN${id}`,
    model: 'EssWFAC',
    location_id: 1,
    label,
    lost: false,
    end_of_life_status: 1,
    battery_state: 'Good',
    life: 3748,
    capabilities: ['Smoke'],
    cap_sensor: ['Smoke'],
    co_alarm: false,
    smoke_alarm: false,
    too_much_smoke: false,
    smoke_hushed: false,
    hardwire_smoke: false,
    hardwire_co: false,
    flt_pho: false,
    flt_co: false,
    flt_eol: false,
    flt_lwbat_mb: false,
    flt_lwbat_wb: false,
    co_ppm: 0,
    fwrev: { wm: '01.00.11', net: '', alarm: '01.00.79' },
    errors: [],
    offline: false,
    contact_lost: false,
    last_test_time: '2026-05-25T16:05:50Z',
    ...overrides,
  }
}

/** A Kidde device that is not a smoke alarm */
export function waterLeakSensor(id, label) {
  return {
    id,
    label,
    model: 'waterleakdetector',
    capabilities: ['temperature'],
    water_alarm: false,
    battery_state: 'ok',
    offline: true,
  }
}

export function coOnlyAlarm(id, label) {
  return {
    id,
    label,
    model: 'cowifidetector',
    capabilities: ['co'],
    cap_sensor: ['CO', 'IAQ'],
    co_alarm: false,
    battery_state: 'ok',
  }
}

export const EMAIL = 'owner@example.com'
export const PASSWORD = 'correct horse'

export function createSim(t) {
  const storage = mkdtempSync(join(tmpdir(), 'kidde-smoke-test-'))
  const kidde = createKiddeServer({ email: EMAIL, password: PASSWORD })
  const realFetch = globalThis.fetch
  globalThis.fetch = kidde.fetch
  const apis = []

  const sim = {
    storage,
    kidde,
    logs: [],
    logged: (pattern) => sim.logs.some((line) => pattern.test(line)),
    countLogged: (pattern) => sim.logs.filter((line) => pattern.test(line)).length,

    /** Start a platform instance, optionally with accessories from a previous run */
    async boot({ config = {}, cached = [] } = {}) {
      const handlers = {}
      const api = {
        hap,
        handlers,
        registered: [],
        unregistered: [],
        updated: 0,
        user: { storagePath: () => storage },
        on: (event, fn) => {
          handlers[event] = fn
        },
        platformAccessory: FakePlatformAccessory,
        registerPlatformAccessories: (_plugin, _platform, accessories) => api.registered.push(...accessories),
        unregisterPlatformAccessories: (_plugin, _platform, accessories) => api.unregistered.push(...accessories),
        updatePlatformAccessories: () => {
          api.updated++
        },
      }
      apis.push(api)
      const log = Object.fromEntries(
        ['info', 'warn', 'error', 'debug', 'success'].map((level) => [
          level,
          (message) => sim.logs.push(`[${level}] ${message}`),
        ]),
      )
      const platform = new KiddeSmokeDetectorsPlatform(
        log,
        { platform: 'KiddeSmokeDetectors', email: EMAIL, password: PASSWORD, ...config },
        api,
      )
      for (const accessory of cached) platform.configureAccessory(accessory)
      handlers.didFinishLaunching?.()
      if (handlers.shutdown) {
        await until(
          () =>
            platform.client &&
            platform.pollInFlight === null &&
            (platform.firstPollDone || platform.consecutiveFailures > 0),
          { what: 'the first poll' },
        )
      }
      const accessory = (name) => {
        const found = [...cached, ...api.registered].find((a) => a.displayName === name)
        if (!found) throw new Error(`No accessory named ${name}`)
        return found
      }
      return { api, platform, accessory, poll: () => platform.pollNow() }
    },
  }

  t.after(() => {
    for (const api of apis) api.handlers.shutdown?.()
    globalThis.fetch = realFetch
    rmSync(storage, { recursive: true, force: true })
  })
  return sim
}

// --- Reading HomeKit state ---------------------------------------------------

const C = hap.Characteristic
const S = hap.Service

export const smoke = (a) => a.getService(S.SmokeSensor).getCharacteristic(C.SmokeDetected)
export const co = (a) => a.getService(S.CarbonMonoxideSensor).getCharacteristic(C.CarbonMonoxideDetected)
export const fault = (a) => a.getService(S.SmokeSensor).getCharacteristic(C.StatusFault)
export const lowBattery = (a) => a.getService(S.Battery).getCharacteristic(C.StatusLowBattery)
export const batteryLevel = (a) => a.getService(S.Battery).getCharacteristic(C.BatteryLevel)

/** Read a characteristic the way HomeKit does; resolves to the value or the HAP status error code */
export async function read(characteristic) {
  try {
    return await characteristic.handleGetRequest()
  } catch (error) {
    return typeof error === 'number' ? { status: error } : { status: error?.hapStatus ?? 'error' }
  }
}

/** Whether HomeKit gets a live answer from this accessory's smoke sensor */
export async function isResponding(accessory) {
  const value = await read(smoke(accessory))
  return typeof value === 'number'
}
