/**
 * Regression tests for the findings of the independent security and
 * stability review. Each test reproduces the scenario the review described
 * and checks the fixed behavior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSim,
  comboAlarm,
  smokeAlarm,
  hap,
  smoke,
  read,
  isResponding,
  until,
  mockClock,
  MINUTE,
} from './helpers/sim.mjs'

const C = hap.Characteristic
const S = hap.Service
const SESSION_FILE = 'kidde-smoke-detectors.session.json'

test('1: a 401 that also clears the cookie still leads to a transparent re-login', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.cookieOn401 = 'clear'
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll } = await sim.boot()

  sim.kidde.expireSessions()
  clock.advance(5 * MINUTE)
  await poll()
  assert.equal(sim.kidde.logins, 2, 'signed in again')
  assert.ok(await isResponding(accessory('Kitchen')))
  assert.ok(!sim.logged(/with a new session/), 'no false "new session refused" error')
  assert.ok(!sim.logged(/Could not update from Kidde/))
})

test('1, 8: a cookie that rotates on every response neither blocks re-login nor rewrites the session file each poll', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.rotatingCookie = true
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll } = await sim.boot()
  const file = join(sim.storage, SESSION_FILE)
  await until(() => existsSync(file), { what: 'the session file' })
  const savedAtLogin = readFileSync(file, 'utf8')

  for (let i = 0; i < 5; i++) await poll()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(readFileSync(file, 'utf8'), savedAtLogin, 'cookie refreshes are not written on every poll')

  sim.kidde.expireSessions()
  clock.advance(5 * MINUTE)
  await poll()
  assert.equal(sim.kidde.logins, 2, 'the expired session is replaced')
  assert.ok(await isResponding(accessory('Kitchen')))
})

test('2: a location the account may not read causes no sign-ins and does not take other alarms offline', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.locations = [{ id: 1, name: 'Shared Cabin' }, { id: 2, name: 'Home' }]
  sim.kidde.devices[1] = [comboAlarm(101, 'Cabin')]
  sim.kidde.devices[2] = [comboAlarm(201, 'Kitchen')]
  sim.kidde.forbiddenDevices.add('1')
  const { accessory, poll } = await sim.boot()

  for (let i = 0; i < 20; i++) {
    clock.advance(15_000)
    await poll()
  }
  assert.equal(sim.kidde.logins, 1, 'no login per poll (the review measured one a minute)')
  assert.ok(await isResponding(accessory('Kitchen')), 'the readable location keeps working')
  assert.equal(sim.countLogged(/\[warn\] Could not read the alarms at "Shared Cabin".*HTTP 403/), 1, 'warned once, not every poll')
})

test('2: a refused Hush fails that command only; the session is kept and nothing signs in', async (t) => {
  const sim = createSim(t)
  sim.kidde.forbiddenCommands.add('hush')
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen', { smoke_alarm: true })]
  const { accessory, poll } = await sim.boot({ config: { hushSwitch: true } })
  const hush = accessory('Kitchen').getServiceById(S.Switch, 'hush').getCharacteristic(C.On)

  await assert.rejects(hush.handleSetRequest(true), 'HomeKit is told the command failed')
  assert.ok(sim.logged(/Hush for "Kitchen" failed: Kidde refused the hush command \(HTTP 403\)/))
  await poll()
  assert.equal(sim.kidde.logins, 1)
  assert.equal(smoke(accessory('Kitchen')).value, 1, 'the alarm is still reported')
})

test('2: if Kidde refuses every new session, sign-ins back off instead of repeating every minute', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const realFetch = sim.kidde.fetch
  globalThis.fetch = async (url, init) => {
    const response = await realFetch(url, init)
    if (String(url).endsWith('/auth/login')) sim.kidde.expireSessions()
    return response
  }
  const { poll } = await sim.boot()
  // An hour of polling, a minute at a time
  for (let i = 0; i < 60; i++) {
    clock.advance(MINUTE)
    await poll()
  }
  assert.ok(sim.kidde.logins <= 7, `signed in ${sim.kidde.logins} times in an hour; the backoff must grow`)
})

test('3: an auth failure cannot keep a stale "no smoke" alive past the stale window', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll, platform } = await sim.boot()
  const kitchen = accessory('Kitchen')

  // The password is changed in the Kidde app and the session ends
  sim.kidde.password = 'changed'
  sim.kidde.expireSessions()
  clock.advance(20_000)
  await poll()
  assert.ok(sim.logged(/Kidde sign-in failed/))
  assert.ok(await isResponding(kitchen), 'still inside the stale window')

  // No further poll happens (the login is backing off), but time passes
  clock.advance(75_000)
  assert.equal((await read(smoke(kitchen))).status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE, 'reads check freshness live')
  platform.checkFreshness()
  assert.equal(smoke(kitchen).statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE, 'and the timer pushes No Response')
})

test('4: a Locations filter that matches nothing is ignored instead of removing every alarm', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(102, 'Hall')]
  const first = await sim.boot()
  const cached = first.api.registered
  first.api.handlers.shutdown()

  const second = await sim.boot({ cached, config: { locationIds: ['Home'] } })
  await second.poll()
  assert.equal(second.api.unregistered.length, 0, 'nothing removed')
  assert.ok(await isResponding(second.accessory('Kitchen')))
  assert.equal(sim.countLogged(/\[warn\] None of the configured Locations exist/), 1)
})

test('4: an alarm moved to another location is not removed and re-added', async (t) => {
  const sim = createSim(t)
  sim.kidde.locations = [{ id: 1, name: 'Home' }, { id: 2, name: 'Cabin' }]
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  sim.kidde.devices[2] = [comboAlarm(201, 'Loft')]
  const { api, poll, accessory } = await sim.boot({ config: { locationIds: ['2'] } })
  assert.deepEqual(api.registered.map((a) => a.displayName), ['Loft'])

  // The Loft alarm is moved to... still location 2; Kitchen moves into it too
  sim.kidde.devices[1] = []
  sim.kidde.devices[2] = [comboAlarm(201, 'Loft'), comboAlarm(101, 'Kitchen')]
  await poll()
  await poll()
  assert.equal(api.unregistered.length, 0)
  assert.equal(accessory('Kitchen').context.locationId, '2')
})

test('5: a wall clock step does not make the removal grace pass early', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(102, 'Hall')]
  const { api, poll, accessory } = await sim.boot()

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  await poll()
  clock.jumpWallClock(6 * 60 * MINUTE)
  await poll()
  await poll()
  assert.equal(api.unregistered.length, 0, 'a 6 hour NTP step is not 6 hours of absence')
  assert.ok(await isResponding(accessory('Kitchen')), 'nor does it make live data stale')
})

test('6: alarm values in unexpected types are read as alarms, or as No Response, never as "no smoke"', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [
    comboAlarm(101, 'Numeric', { smoke_alarm: 1 }),
    comboAlarm(102, 'Text', { co_alarm: 'true' }),
    comboAlarm(103, 'Garbled', { smoke_alarm: { state: 'x' } }),
  ]
  const { accessory } = await sim.boot()
  assert.equal(smoke(accessory('Numeric')).value, C.SmokeDetected.SMOKE_DETECTED)
  const co = accessory('Text').getService(S.CarbonMonoxideSensor).getCharacteristic(C.CarbonMonoxideDetected)
  assert.equal(co.value, C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)
  assert.equal((await read(smoke(accessory('Garbled')))).status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  assert.ok(sim.logged(/"Garbled" reports smoke_alarm as \{"state":"x"\}, which the plugin cannot read/))
})

test('7: one document without capability lists does not remove the CO sensor', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll, api } = await sim.boot()
  const before = accessory('Kitchen').getService(S.CarbonMonoxideSensor)

  const bare = comboAlarm(101, 'Kitchen')
  delete bare.capabilities
  delete bare.co_alarm
  sim.kidde.devices[1] = [bare]
  await poll()
  assert.equal(accessory('Kitchen').getService(S.CarbonMonoxideSensor), before, 'same service, automations intact')

  // Even across a restart
  api.handlers.shutdown()
  const second = await sim.boot({ cached: api.registered })
  assert.equal(second.accessory('Kitchen').getService(S.CarbonMonoxideSensor), before)
})

test('9: long or decorated names become names HomeKit accepts', async (t) => {
  const sim = createSim(t)
  const long = 'Upstairs Hallway Outside The Kids Bedroom Near The Laundry Room Door'
  sim.kidde.devices[1] = [comboAlarm(101, long), comboAlarm(102, 'Kitchen (Main) - #1 ')]
  const { api } = await sim.boot({ config: { hushSwitch: true, testSwitch: true } })
  const names = api.registered.map((a) => a.displayName)
  assert.ok(names.includes('Kitchen Main 1'))
  const longName = names.find((n) => n.startsWith('Upstairs'))
  assert.ok(longName.length <= 55 && /[\p{L}\p{N}]$/u.test(longName), longName)
  for (const accessory of api.registered) {
    for (const service of accessory.services) {
      const configured = service.getCharacteristic(C.ConfiguredName).value
      if (typeof configured === 'string') assert.ok(configured.length <= 64, configured)
    }
  }
})

test('11: a slow Kidde command answers HomeKit before HAP warns about a slow handler', async (t) => {
  const sim = createSim(t)
  sim.kidde.commandDelayMs = 4000
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory } = await sim.boot({ config: { hushSwitch: true } })
  const hush = accessory('Kitchen').getServiceById(S.Switch, 'hush').getCharacteristic(C.On)
  const started = performance.now()
  await hush.handleSetRequest(true)
  const took = performance.now() - started
  assert.ok(took < 3000, `answered in ${Math.round(took)}ms`)
  await until(() => sim.kidde.commands.length === 1, { timeout: 3000, what: 'the slow command to land' })
})

test('12: shutdown aborts the poll in flight and nothing is created afterwards', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { api, platform } = await sim.boot()
  const registeredBefore = api.registered.length
  const updatesBefore = api.updated

  sim.kidde.delayMs = 5000
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), smokeAlarm(102, 'New Alarm')]
  const sentBefore = sim.kidde.requests.length
  const inFlight = platform.pollNow()
  await until(
    () => sim.kidde.requests.slice(sentBefore).some((r) => r.path === '/location/1/device'),
    { what: 'the slow request to be sent' },
  )
  api.handlers.shutdown()
  await inFlight
  assert.equal(sim.kidde.aborted, 1, 'the request was aborted')
  assert.equal(api.registered.length, registeredBefore, 'no accessory added after shutdown')
  assert.equal(api.updated, updatesBefore)
  assert.equal(platform.handlers.size, 0)
})
