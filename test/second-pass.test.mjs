/**
 * Regression tests for the second stability and quality pass: request
 * deadlines that leave nothing behind, sign-in backoff during Kidde
 * outages, leniently read status flags, and renames that reach every
 * service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import v8 from 'node:v8'
import vm from 'node:vm'
import {
  createSim,
  comboAlarm,
  smokeAlarm,
  hap,
  fault,
  lowBattery,
  isResponding,
  mockClock,
  restoredFromDisk,
  MINUTE,
  EMAIL,
  PASSWORD,
} from './helpers/sim.mjs'
import { KiddeClient } from '../dist/kidde-api/client.js'
import { cachedDeviceFrom } from '../dist/kidde-api/device-cache.js'

const C = hap.Characteristic
const S = hap.Service

/** Listeners a client currently has on its long-lived shutdown signal */
const shutdownListeners = (client) => getEventListeners(client.closer.signal, 'abort').length

const nameOf = (service) => service.getCharacteristic(C.Name).value
const configuredNameOf = (service) => service.getCharacteristic(C.ConfiguredName).value

test('requests leave nothing attached to the shutdown signal, whether they succeed, fail or time out', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD, timeoutMs: 80 })

  for (let i = 0; i < 25; i++) await client.getDevices('1')
  assert.equal(shutdownListeners(client), 0, 'after successful requests')

  sim.kidde.failDevices.add('1')
  await assert.rejects(client.getDevices('1'), /HTTP 503/)
  sim.kidde.failDevices.clear()
  sim.kidde.networkDown = true
  await assert.rejects(client.getDevices('1'), /Could not reach Kidde/)
  sim.kidde.networkDown = false
  assert.equal(shutdownListeners(client), 0, 'after failed requests')

  // Kidde stops answering: the deadline ends the request
  sim.kidde.delayMs = 2000
  const started = performance.now()
  await assert.rejects(client.getDevices('1'), /the request timed out/)
  assert.ok(performance.now() - started < 1000, 'ended by the deadline, not by Kidde')
  assert.equal(sim.kidde.aborted, 1, 'the request itself was aborted')
  assert.equal(shutdownListeners(client), 0, 'after a timed out request')

  // And the client is still usable afterwards
  sim.kidde.delayMs = 0
  assert.equal((await client.getDevices('1')).length, 1)
  assert.equal(sim.kidde.logins, 1, 'none of this cost a second sign-in')
})

test('thousands of polls do not grow the heap', async (t) => {
  // A long-running bridge polls about 6,000 times a day. Whatever a request
  // leaves behind adds up, so the heap must be flat across many of them.
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  const heapMb = () => {
    gc()
    return process.memoryUsage().heapUsed / 1e6
  }
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD })
  const pollOnce = async () => {
    await client.getLocations()
    await client.getDevices('1')
    sim.kidde.requests.length = 0
  }

  for (let i = 0; i < 300; i++) await pollOnce()
  const before = heapMb()
  for (let i = 0; i < 5000; i++) await pollOnce()
  const grown = heapMb() - before
  assert.ok(grown < 4, `the heap grew ${grown.toFixed(1)} MB over 10,000 requests`)
})

test('closing the client ends a request in flight and refuses new ones', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD })
  await client.getLocations()

  sim.kidde.delayMs = 5000
  const pending = client.getDevices('1')
  await new Promise((resolve) => setImmediate(resolve))
  client.close()
  await assert.rejects(pending, /shutting down/)
  await assert.rejects(client.getLocations(), /shutting down/)
  assert.equal(sim.kidde.aborted, 1)
  assert.equal(shutdownListeners(client), 0)
})

test('an answer far larger than anything Kidde sends is refused, not buffered', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'x'.repeat(5 * 1024 * 1024))]
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD })
  await assert.rejects(client.getDevices('1'), /Could not read Kidde's answer for the device list: the answer was too large/)

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  assert.equal((await client.getDevices('1')).length, 1, 'the session survives it')
  assert.equal(sim.kidde.logins, 1)
})

test('a Kidde server error during sign-in backs off to 5 minutes, so recovery follows the outage closely', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD })

  // Kidde's sign-in endpoint is down for a long time
  sim.kidde.loginStatus = 503
  for (let attempt = 1; attempt <= 10; attempt++) {
    await assert.rejects(client.getLocations(), /Kidde sign-in failed \(HTTP 503\)/)
    assert.equal(sim.kidde.logins, attempt, 'each wait of 5 minutes allows one more attempt')
    // In between, sign-in is paused and says why, without contacting Kidde
    await assert.rejects(
      client.getLocations(),
      /paused after a failed attempt \(Kidde answered HTTP 503\)/,
    )
    assert.equal(sim.kidde.logins, attempt)
    clock.advance(5 * MINUTE + 1000)
  }

  // Kidde recovers: the very next attempt signs in
  sim.kidde.loginStatus = null
  assert.equal((await client.getLocations()).length, 1)
})

test('a rejected password still backs off all the way to an hour', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  const client = new KiddeClient({ email: EMAIL, password: 'wrong' })

  for (let attempt = 1; attempt <= 7; attempt++) {
    await assert.rejects(client.getLocations(), /Kidde rejected the email or password/)
    clock.advance(61 * MINUTE)
  }
  assert.equal(sim.kidde.logins, 7)
  // By now the pause is the full hour: 5 minutes is nowhere near enough
  await assert.rejects(client.getLocations(), /Kidde rejected the email or password/)
  clock.advance(5 * MINUTE + 1000)
  await assert.rejects(client.getLocations(), /paused after a failed attempt/)
  assert.equal(sim.kidde.logins, 8)
})

test('a Retry-After from Kidde on sign-in is honored', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD })

  sim.kidde.loginStatus = 429
  sim.kidde.loginHeaders = [['retry-after', '1800']]
  await assert.rejects(client.getLocations(), /Kidde sign-in failed \(HTTP 429\)/)

  // A first failure normally pauses one minute; Kidde asked for thirty
  clock.advance(10 * MINUTE)
  await assert.rejects(client.getLocations(), /paused after a failed attempt/)
  assert.equal(sim.kidde.logins, 1)

  sim.kidde.loginStatus = null
  clock.advance(20 * MINUTE + 1000)
  assert.equal((await client.getLocations()).length, 1)
  assert.equal(sim.kidde.logins, 2)
})

test('several requests refused on one new session count as one failed sign-in', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.uselessSessions = true
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD })

  const results = await Promise.allSettled([
    client.getDevices('1'),
    client.getDevices('1'),
    client.getDevices('1'),
  ])
  assert.ok(results.every((r) => r.status === 'rejected'))
  assert.equal(sim.kidde.logins, 1, 'the three requests shared one sign-in')

  // One failure pauses sign-in for one minute, not four
  clock.advance(MINUTE + 1000)
  sim.kidde.uselessSessions = false
  assert.equal((await client.getDevices('1')).length, 0)
  assert.equal(sim.kidde.logins, 2)
})

test('offline, fault and low-battery flags sent as 1 or "true" still count', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [
    comboAlarm(101, 'Kitchen', { lost: 1 }),
    smokeAlarm(102, 'Hall', { offline: 'true' }),
    smokeAlarm(103, 'Garage', { flt_pho: 1, flt_lwbat_mb: 'true' }),
    comboAlarm(104, 'Den', { low_battery_alarm: 1 }),
    smokeAlarm(105, 'Attic', { offline: 0, contact_lost: 'false', flt_pho: 0 }),
  ]
  const { accessory } = await sim.boot()

  assert.equal(await isResponding(accessory('Kitchen')), false, 'lost: 1 is offline')
  assert.equal(await isResponding(accessory('Hall')), false, 'offline: "true" is offline')
  assert.ok(sim.logged(/"Kitchen" is offline in Kidde \(lost\)/))

  assert.equal(fault(accessory('Garage')).value, C.StatusFault.GENERAL_FAULT)
  assert.equal(lowBattery(accessory('Garage')).value, C.StatusLowBattery.BATTERY_LEVEL_LOW)
  assert.equal(lowBattery(accessory('Den')).value, C.StatusLowBattery.BATTERY_LEVEL_LOW)

  // The same spellings of "not set" change nothing
  const attic = accessory('Attic')
  assert.equal(await isResponding(attic), true)
  assert.equal(fault(attic).value, C.StatusFault.NO_FAULT)
  assert.equal(lowBattery(attic).value, C.StatusLowBattery.BATTERY_LEVEL_NORMAL)
})

test('a name changed in the settings reaches every service after the restart, and a Home app name is kept', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const first = await sim.boot({ config: { hushSwitch: true } })
  const original = first.accessory('Kitchen')
  assert.equal(configuredNameOf(original.getService(S.CarbonMonoxideSensor)), 'Kitchen CO')

  // The user renames the CO sensor in the Home app, which writes ConfiguredName
  original.getService(S.CarbonMonoxideSensor).getCharacteristic(C.ConfiguredName).updateValue('Basement Air')
  first.api.handlers.shutdown()

  // Then sets a name in the plugin settings and restarts. Homebridge
  // restores the accessory from its cache file.
  const renamed = { hushSwitch: true, devices: [{ id: 101, name: 'Galley' }] }
  const kitchen = restoredFromDisk(original)
  const second = await sim.boot({ cached: [kitchen], config: renamed })
  assert.equal(second.api.registered.length, 0, 'the same accessory, not a new one')
  assert.equal(kitchen.displayName, 'Galley')
  assert.ok(sim.logged(/Renaming "Kitchen" to "Galley"/))

  const smoke = kitchen.getService(S.SmokeSensor)
  const co = kitchen.getService(S.CarbonMonoxideSensor)
  const battery = kitchen.getService(S.Battery)
  const hush = kitchen.getServiceById(S.Switch, 'hush')
  assert.equal(nameOf(kitchen.getService(S.AccessoryInformation)), 'Galley')
  assert.deepEqual(
    [nameOf(smoke), nameOf(co), nameOf(battery), nameOf(hush)],
    ['Galley', 'Galley CO', 'Galley Battery', 'Galley Hush'],
  )
  assert.deepEqual(
    [configuredNameOf(smoke), configuredNameOf(battery), configuredNameOf(hush)],
    ['Galley', 'Galley Battery', 'Galley Hush'],
    'names the plugin gave follow the rename',
  )
  assert.equal(configuredNameOf(co), 'Basement Air', 'a name chosen in the Home app is kept')

  // An ordinary restart, with nothing renamed, touches no names at all
  smoke.getCharacteristic(C.ConfiguredName).updateValue('Stove Smoke')
  second.api.handlers.shutdown()
  const renames = sim.countLogged(/Renaming/)
  const again = restoredFromDisk(kitchen)
  await sim.boot({ cached: [again], config: renamed })
  assert.equal(sim.countLogged(/Renaming/), renames)
  assert.equal(again.displayName, 'Galley')
  assert.equal(configuredNameOf(again.getService(S.SmokeSensor)), 'Stove Smoke')
  assert.equal(configuredNameOf(again.getService(S.CarbonMonoxideSensor)), 'Basement Air')
  assert.equal(nameOf(again.getService(S.Battery)), 'Galley Battery')
  assert.ok(await isResponding(again), 'and the restored alarm answers HomeKit')
})

test('a rename in the Kidde app while running reaches every service too', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll, api } = await sim.boot({ config: { testSwitch: true } })
  const kitchen = accessory('Kitchen')

  sim.kidde.devices[1] = [comboAlarm(101, 'Pantry')]
  await poll()
  assert.equal(kitchen.displayName, 'Pantry')
  assert.ok(api.updated > 0, 'Homebridge is told to save the new name')
  const test = kitchen.getServiceById(S.Switch, 'test')
  const co = kitchen.getService(S.CarbonMonoxideSensor)
  assert.deepEqual([nameOf(test), configuredNameOf(test)], ['Pantry Test', 'Pantry Test'])
  assert.deepEqual([nameOf(co), configuredNameOf(co)], ['Pantry CO', 'Pantry CO'])
})

test('an account with no locations is reported once, with one message', async (t) => {
  const sim = createSim(t)
  sim.kidde.locations = []
  const { poll } = await sim.boot()
  await poll()
  await poll()
  assert.equal(sim.countLogged(/\[warn\] Kidde reports no locations on this account/), 1)
  assert.equal(sim.countLogged(/\[warn\] No Kidde smoke alarms were found/), 0)
})

test('the settings page is given the HomeKit-safe default name for each alarm', () => {
  const location = { id: '1', name: 'Home' }
  const decorated = cachedDeviceFrom(comboAlarm(101, "Kid's Room (Upstairs) #2"), location)
  assert.equal(decorated.name, "Kid's Room (Upstairs) #2", 'the Kidde name is shown as it is')
  assert.equal(decorated.homeKitName, "Kid's Room Upstairs 2", 'the name box starts with what HomeKit will get')

  const unnamed = cachedDeviceFrom(comboAlarm(102, ''), location)
  assert.equal(unnamed.homeKitName, 'Smoke Alarm')
})
