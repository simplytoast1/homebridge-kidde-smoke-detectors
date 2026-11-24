import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSim,
  comboAlarm,
  smokeAlarm,
  hap,
  smoke,
  read,
  isResponding,
  sleep,
  until,
  MINUTE,
  FakePlatformAccessory,
  PASSWORD,
  mockClock,
} from './helpers/sim.mjs'

const C = hap.Characteristic
const S = hap.Service
const SESSION_FILE = 'kidde-smoke-detectors.session.json'


test('a Kidde outage shows as No Response after the stale window, then recovers', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll } = await sim.boot()
  const kitchen = accessory('Kitchen')
  assert.ok(await isResponding(kitchen))

  sim.kidde.networkDown = true
  clock.advance(30_000)
  await poll()
  assert.ok(await isResponding(kitchen), 'one missed poll is not an outage yet')
  assert.ok(sim.logged(/\[warn\] Could not update from Kidde: .*ECONNREFUSED/))

  clock.advance(70_000)
  await poll()
  assert.ok(!(await isResponding(kitchen)), 'stale data is not presented as live')
  assert.equal((await read(smoke(kitchen))).status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)

  sim.kidde.networkDown = false
  await poll()
  assert.ok(await isResponding(kitchen))
  assert.ok(sim.logged(/Connection to Kidde restored/))
})

test('an alarm Kidde flags as offline is No Response while the others stay up', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(102, 'Hall')]
  const { accessory, poll } = await sim.boot()

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen', { contact_lost: true }), comboAlarm(102, 'Hall')]
  await poll()
  assert.ok(!(await isResponding(accessory('Kitchen'))))
  assert.ok(await isResponding(accessory('Hall')))
  assert.ok(sim.logged(/"Kitchen" is offline in Kidde \(contact_lost\)/))

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(102, 'Hall')]
  await poll()
  assert.ok(await isResponding(accessory('Kitchen')))
  assert.ok(sim.logged(/"Kitchen" is back online/))
})

test('an expired session signs in again once and carries on', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll } = await sim.boot()
  assert.equal(sim.kidde.logins, 1)

  sim.kidde.expireSessions()
  clock.advance(5 * MINUTE)
  await poll()
  assert.equal(sim.kidde.logins, 2, 'exactly one new sign-in')
  assert.ok(await isResponding(accessory('Kitchen')))

  const login = sim.kidde.requests.find((r) => r.path === '/auth/login')
  assert.equal(login.redirect, 'manual', 'redirects are never followed with credentials')
  const later = sim.kidde.requests.at(-1)
  assert.match(later.headers.cookie, /^session=s2$/)
  assert.equal(later.headers['homeboy-auth'], 'at-s2')
})

test('a rejected password backs off instead of signing in on every poll', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.password = 'changed in the Kidde app'
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { api, poll } = await sim.boot()
  assert.equal(sim.kidde.logins, 1)
  assert.equal(api.registered.length, 0)
  assert.ok(sim.logged(/\[error\] Kidde sign-in failed: Kidde rejected the email or password \(HTTP 403\)/))

  await poll()
  await poll()
  assert.equal(sim.kidde.logins, 1, 'no second attempt inside the backoff window')
  assert.equal(sim.countLogged(/\[error\] Kidde sign-in failed/), 1, 'logged once, not every poll')

  clock.advance(61_000)
  await poll()
  assert.equal(sim.kidde.logins, 2, 'tries again after the first backoff')
  await poll()
  assert.equal(sim.kidde.logins, 2, 'and the next wait is longer')
})

test('the session is saved owner-only, without the password, and reused after a restart', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const first = await sim.boot()
  await until(() => existsSync(join(sim.storage, SESSION_FILE)), { what: 'the session file' })

  const file = join(sim.storage, SESSION_FILE)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const saved = readFileSync(file, 'utf8')
  assert.ok(!saved.includes(PASSWORD), 'the password is never written')
  assert.ok(!saved.includes('owner@example.com'), 'nor the email')

  first.api.handlers.shutdown()
  await sim.boot()
  assert.equal(sim.kidde.logins, 1, 'the restart reused the saved session')
})

test('a saved session Kidde ended while Homebridge was down earns one sign-in, even right after a restart', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const first = await sim.boot()
  await until(() => existsSync(join(sim.storage, SESSION_FILE)), { what: 'the session file' })
  first.api.handlers.shutdown()

  sim.kidde.expireSessions()
  const second = await sim.boot({ cached: first.api.registered })
  assert.equal(sim.kidde.logins, 2)
  assert.ok(await isResponding(second.accessory('Kitchen')), 'the first poll after the restart succeeds')
  assert.ok(!sim.logged(/Could not update from Kidde/))
})

test('a new session that Kidde refuses straight away does not cause a sign-in loop', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  // Kidde accepts the sign-in but then refuses every session it issued
  const realFetch = sim.kidde.fetch
  globalThis.fetch = async (url, init) => {
    const response = await realFetch(url, init)
    if (String(url).endsWith('/auth/login')) sim.kidde.expireSessions()
    return response
  }
  const { poll } = await sim.boot()
  await poll()
  await poll()
  assert.ok(sim.kidde.logins <= 3, `signed in ${sim.kidde.logins} times; must not sign in on every request`)
  assert.ok(sim.logged(/refused the location list with a new session/))
})

test('a saved session for a different account is never used', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const first = await sim.boot()
  await until(() => existsSync(join(sim.storage, SESSION_FILE)), { what: 'the session file' })
  first.api.handlers.shutdown()

  sim.kidde.email = 'someone-else@example.com'
  await sim.boot({ config: { email: 'someone-else@example.com' } })
  assert.equal(sim.kidde.logins, 2)
})

test('accessories restored from cache start No Response until Kidde confirms them', async (t) => {
  const sim = createSim(t)
  sim.kidde.failLocations = true
  // As a previous run left it: identified by its serial number (comboAlarm uses SN101)
  const cached = new FakePlatformAccessory('Kitchen', hap.uuid.generate('homebridge-kidde-smoke-detectors:sn:SN101'))
  cached.context.alarmKey = 'sn:SN101'
  cached.context.deviceId = '101'
  cached.addService(S.SmokeSensor, 'Kitchen').getCharacteristic(C.SmokeDetected).updateValue(0)

  const { api } = await sim.boot({ cached: [cached] })
  const status = smoke(cached).statusCode
  assert.equal(status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE, 'last session\'s "no smoke" is not served')
  assert.equal(api.unregistered.length, 0, 'an outage never removes accessories')
})

test('removal is slow and never triggered by an empty answer', async (t) => {
  const clock = mockClock(t)
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(102, 'Hall')]
  const { api, poll } = await sim.boot()

  // Kidde transiently returns nothing at all
  sim.kidde.devices[1] = []
  for (let i = 0; i < 5; i++) {
    clock.advance(10 * MINUTE)
    await poll()
  }
  assert.equal(api.unregistered.length, 0, 'an empty account is not trusted')

  // The hall alarm is really gone
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  await poll()
  await poll()
  await poll()
  assert.equal(api.unregistered.length, 0, 'not after a few quick polls')
  clock.advance(31 * MINUTE)
  await poll()
  assert.deepEqual(api.unregistered.map((a) => a.displayName), ['Hall'])
  assert.ok(sim.logged(/Removing "Hall" from HomeKit: Kidde no longer reports it/))
})

test('hiding an alarm removes its existing accessory right away', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const first = await sim.boot()
  const cached = first.api.registered
  first.api.handlers.shutdown()

  const second = await sim.boot({ cached, config: { devices: [{ id: 101, hidden: true }] } })
  assert.deepEqual(second.api.unregistered.map((a) => a.displayName), ['Kitchen'])
})

test('not configured: the plugin does not start', async (t) => {
  const sim = createSim(t)
  await sim.boot({ config: { email: '', password: '' } })
  assert.equal(sim.kidde.requests.length, 0, 'Kidde is never contacted')
  assert.ok(sim.logged(/Not set up yet/))
})

test('the Hush switch sends the command once and turns itself off', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory } = await sim.boot({ config: { hushSwitch: true } })
  const kitchen = accessory('Kitchen')
  const hush = kitchen.getServiceById(S.Switch, 'hush')
  assert.ok(hush, 'Hush switch added')
  assert.equal(kitchen.getServiceById(S.Switch, 'test'), undefined, 'Test switch is opt-in')

  await hush.getCharacteristic(C.On).handleSetRequest(true)
  assert.deepEqual(sim.kidde.commands, [{ location: '1', device: '101', command: 'hush' }])
  assert.ok(sim.logged(/Hush sent to "Kitchen"/))
  await until(() => hush.getCharacteristic(C.On).value === false, { what: 'the switch to reset' })
})

test('turning the Hush option off removes the switch on the next start', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const first = await sim.boot({ config: { hushSwitch: true } })
  const cached = first.api.registered
  first.api.handlers.shutdown()
  await sim.boot({ cached })
  assert.equal(cached[0].getServiceById(S.Switch, 'hush'), undefined)
})

test('Identify locates the alarm and cancels the locate afterwards', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory } = await sim.boot()
  // setTimeout is mocked so the 20s locate can be fast-forwarded; waits
  // therefore spin on setImmediate, which stays real
  const settle = async (condition, what) => {
    for (let i = 0; i < 1000 && !condition(); i++) await new Promise((r) => setImmediate(r))
    assert.ok(condition(), `timed out waiting for ${what}`)
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  accessory('Kitchen').emit('identify')
  await settle(() => sim.kidde.commands.length === 1, 'the identify command')
  assert.equal(sim.kidde.commands[0].command, 'identify')
  assert.ok(sim.logged(/Locating "Kitchen"/))

  t.mock.timers.tick(19_000)
  await settle(() => true, 'nothing')
  assert.equal(sim.kidde.commands.length, 1, 'still locating')
  t.mock.timers.tick(1_000)
  await settle(() => sim.kidde.commands.length === 2, 'the cancel')
  assert.equal(sim.kidde.commands[1].command, 'identifycancel')
})

test('a malformed device document is skipped without stopping the poll', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [
    { id: 999, label: 'Weird', capabilities: ['smoke'], fwrev: 42, errors: 'not a list', battery_state: 7 },
    smokeAlarm(102, 'Hallway'),
  ]
  const { accessory } = await sim.boot()
  assert.ok(await isResponding(accessory('Hallway')))
  assert.ok(await isResponding(accessory('Weird')), 'odd field types are tolerated')
  await sleep(5)
})
