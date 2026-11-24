/**
 * Regression tests built from a real Kidde account, captured with
 * `npm run probe` on a real EssWFAC smoke + CO alarm (30CUAR-W). The
 * document below has the same fields and values as the real one, with the
 * identifying ones (serial, ids, network, position) replaced. The self-test
 * sequence is the one Kidde reported while the test button was pressed and
 * a remote test was run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSim, hap, smoke, co, fault, lowBattery, batteryLevel, isResponding } from './helpers/sim.mjs'

const C = hap.Characteristic
const S = hap.Service

/** A location as real Kidde sends it: named by `label`, with no `name` */
const lakeHouse = {
  id: 4242,
  label: 'Lake House',
  country: 'United States of America',
  emergency: '911',
  emergency_desc: 'Call 911',
  viewers_enabled: true,
  viewers_delay: 0,
}

/** The real EssWFAC 30CUAR-W document, before its first self-test (no last_test_time) */
function realEssWfac(overrides = {}) {
  return {
    id: 5550001,
    serial_number: 'TEST00000000001',
    model: 'EssWFAC',
    notify: true,
    location_id: 4242,
    label: 'Test',
    last_seen: '2026-11-24T21:39:00.075504969Z',
    lost: false,
    end_of_life_status: 1,
    battery_state: 'Good',
    life: 3749,
    mb_model: 48,
    capabilities: ['Smoke', 'CO'],
    co_alarm: false,
    smoke_alarm: false,
    too_much_smoke: false,
    ptt_state: false,
    smoke_hushed: false,
    low_battery_hushed: false,
    eol_hushed: false,
    flt_fat_eol: false,
    flt_fat_lwbat: false,
    hardwire_smoke: false,
    hardwire_co: false,
    co_conserve: false,
    identifying: false,
    flt_pho: false,
    flt_co: false,
    flt_eol: false,
    flt_lwbat_mb: false,
    flt_lwbat_wb: false,
    smk_alg_irf: 0,
    smk_alg_irb: 0,
    smk_alg_temp: 0,
    co_acc: 0,
    gflt_pttbtn: false,
    gflt_enbtn: false,
    flt_fat_bm: 0,
    flt_pho_bm: 0,
    flt_co_bm: 0,
    smoke_level: 0,
    temp_mb_f: 0,
    ptt_cnt: 2,
    notify_contact: true,
    announcement: 'hallway',
    notify_eol: true,
    instance_id: '0000000000',
    ap_rssi: -40,
    reset_flag: false,
    fwrev: { wm: '01.00.11', net: '', alarm: '01.00.79' },
    diag_params: { ap_rssi: -40 },
    smoke_comp: false,
    co_ppm: 3,
    flt_i2c: false,
    ver_mb: '01.00.79',
    ver_wb: '01.00.11',
    errors: [],
    offline: false,
    contact_lost: false,
    cap_sensor: ['Smoke', 'CO'],
    no_chirp_enabled: false,
    no_chirp_on_time: 1320,
    no_chirp_off_time: 360,
    time_zone_end: 0,
    gmt_offset: 0,
    mobile_smoke_hushed: false,
    mobile_lb_hushed: false,
    mobile_eol_hushed: false,
    ...overrides,
  }
}

function realAccount(t) {
  const sim = createSim(t)
  sim.kidde.locations = [lakeHouse]
  sim.kidde.devices[4242] = [realEssWfac()]
  return sim
}

test('a real EssWFAC smoke + CO alarm shows correctly in HomeKit', async (t) => {
  const sim = realAccount(t)
  const { accessory } = await sim.boot()
  const alarm = accessory('Test')

  assert.ok(await isResponding(alarm))
  assert.equal(smoke(alarm).value, C.SmokeDetected.SMOKE_NOT_DETECTED)
  assert.equal(co(alarm).value, C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
  assert.equal(alarm.getService(S.CarbonMonoxideSensor).getCharacteristic(C.CarbonMonoxideLevel).value, 3)
  assert.equal(batteryLevel(alarm).value, 100)
  assert.equal(lowBattery(alarm).value, C.StatusLowBattery.BATTERY_LEVEL_NORMAL)
  assert.equal(fault(alarm).value, C.StatusFault.NO_FAULT)

  const info = alarm.getService(S.AccessoryInformation)
  assert.equal(info.getCharacteristic(C.Model).value, 'Smart Smoke + CO Alarm (EssWFAC)')
  assert.equal(info.getCharacteristic(C.FirmwareRevision).value, '1.0.79')
  assert.equal(info.getCharacteristic(C.SerialNumber).value, 'TEST00000000001')

  assert.ok(sim.logged(/Adding "Test" \(Smart Smoke \+ CO Alarm \(EssWFAC\), id 5550001\) at "Lake House"/), 'the location is named by its label')
  assert.ok(!sim.logged(/^\[(warn|error)\]/), 'a healthy real alarm logs no warnings')
})

test('the test button and a remote test each log a self-test, and never raise a HomeKit alarm', async (t) => {
  const sim = realAccount(t)
  const { accessory, poll } = await sim.boot()
  const alarm = accessory('Test')
  const alerts = []
  smoke(alarm).on('change', (e) => alerts.push(['smoke', e.newValue]))
  co(alarm).on('change', (e) => alerts.push(['co', e.newValue]))

  // What Kidde reported, poll by poll, during the real tests
  const polls = [
    { ptt_state: true, last_test_time: '2026-11-24T21:55:45Z' },
    { ptt_state: true, last_test_time: '2026-11-24T21:55:45Z', ptt_cnt: 3 },
    { ptt_state: true, last_test_time: '2026-11-24T21:56:03Z', ptt_cnt: 3, no_chirp_enabled: true, gmt_offset: -21600 },
    { ptt_state: false, last_test_time: '2026-11-24T21:56:03Z', ptt_cnt: 3, gmt_offset: -21600 },
    { ptt_state: false, last_test_time: '2026-11-24T21:56:03Z', ptt_cnt: 3, gmt_offset: -21600 },
    { ptt_state: true, last_test_time: '2026-11-24T21:57:43Z', ptt_cnt: 3, gmt_offset: -21600 },
    { ptt_state: false, last_test_time: '2026-11-24T21:57:43Z', ptt_cnt: 3, gmt_offset: -21600 },
    { ptt_state: true, identifying: true, last_test_time: '2026-11-24T21:58:02Z', ptt_cnt: 3, gmt_offset: -21600 },
  ]
  for (const fields of polls) {
    sim.kidde.devices[4242] = [realEssWfac(fields)]
    await poll()
  }

  assert.equal(sim.countLogged(/^\[info\] "Test" ran a self-test$/), 4, 'one line per test, the first one included')
  assert.deepEqual(alerts, [], 'HomeKit saw no smoke or CO at any point')
  assert.ok(!sim.logged(/SMOKE ALARM|CARBON MONOXIDE ALARM/))
  assert.ok(await isResponding(alarm))

  // A document that leaves the field out, and then the same time again, is not another test
  sim.kidde.devices[4242] = [realEssWfac({ ptt_cnt: 3 })]
  await poll()
  sim.kidde.devices[4242] = [realEssWfac({ ptt_cnt: 3, last_test_time: '2026-11-24T21:58:02Z' })]
  await poll()
  assert.equal(sim.countLogged(/ran a self-test/), 4)
})

test('fault detail numbers do not raise a HomeKit fault on their own; the fault flags do', async (t) => {
  const sim = realAccount(t)
  sim.kidde.devices[4242] = [realEssWfac({ flt_pho_bm: 4, flt_co_bm: 1, flt_fat_bm: 2 })]
  const { accessory, poll } = await sim.boot()
  const alarm = accessory('Test')
  assert.equal(fault(alarm).value, C.StatusFault.NO_FAULT)

  sim.kidde.devices[4242] = [realEssWfac({ flt_pho: true, flt_pho_bm: 4 })]
  await poll()
  assert.equal(fault(alarm).value, C.StatusFault.GENERAL_FAULT)
  assert.ok(sim.logged(/"Test" reports a fault: smoke sensor fault$/))
})

test('a location Kidde answers 404 for affects only that location, and costs no sign-in', async (t) => {
  const sim = realAccount(t)
  sim.kidde.locations = [lakeHouse, { id: 7, label: 'Old House' }]
  sim.kidde.missingDevices.add('7')
  const { accessory, poll } = await sim.boot()
  await poll()
  await poll()

  assert.ok(await isResponding(accessory('Test')), 'the other location is unaffected')
  assert.equal(sim.kidde.logins, 1)
  assert.equal(sim.countLogged(/^\[warn\] Could not read the alarms at "Old House": Kidde returned HTTP 404/), 1, 'warned once')
  assert.ok(!sim.logged(/Could not update from Kidde/), 'the poll as a whole still succeeds')
})

test('an alarm powered back up with no battery shows a low battery, not a fault', async (t) => {
  const sim = realAccount(t)
  // Power cut with no battery fitted: Kidde has lost the alarm
  sim.kidde.devices[4242] = [realEssWfac({ lost: true, offline: true })]
  const { accessory, poll } = await sim.boot()
  const alarm = accessory('Test')
  assert.equal(await isResponding(alarm), false, 'No Response while Kidde has lost it')

  // Power back, still no battery: what the real alarm reported
  sim.kidde.devices[4242] = [realEssWfac({ battery_state: 'Critical', flt_fat_lwbat: true, co_ppm: 0, ptt_cnt: 6 })]
  await poll()
  assert.ok(await isResponding(alarm))
  assert.ok(sim.logged(/"Test" is back online in Kidde/))
  assert.equal(smoke(alarm).value, C.SmokeDetected.SMOKE_NOT_DETECTED)
  assert.equal(lowBattery(alarm).value, C.StatusLowBattery.BATTERY_LEVEL_LOW)
  assert.equal(batteryLevel(alarm).value, 10)
  assert.equal(fault(alarm).value, C.StatusFault.NO_FAULT, 'a missing battery is a battery warning, not a sensor fault')
  assert.ok(sim.logged(/^\[warn\] Battery for "Test" changed: Good -> Critical$/))

  // The CO sensor warming up reads 0, then ambient again
  sim.kidde.devices[4242] = [realEssWfac({ battery_state: 'Critical', flt_fat_lwbat: true, co_ppm: 6, ptt_cnt: 6 })]
  await poll()
  assert.equal(alarm.getService(S.CarbonMonoxideSensor).getCharacteristic(C.CarbonMonoxideLevel).value, 6)
  assert.equal(co(alarm).value, C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
})

// --- Removing an alarm in the Kidde app and adding it again -----------------------

test('an alarm removed in the Kidde app and added again under a new id stays the same HomeKit accessory', async (t) => {
  const sim = realAccount(t)
  const { accessory, poll, api } = await sim.boot({
    config: { hushSwitch: true, devices: [{ id: 'TEST00000000001', name: 'Hallway' }] },
  })
  const alarm = accessory('Hallway')
  const uuid = alarm.UUID

  // Removed from the account: the accessory stays, it is the only alarm
  sim.kidde.devices[4242] = []
  await poll()
  assert.equal(api.unregistered.length, 0)

  // Added again: Kidde gives it a new id, the serial number is the same
  sim.kidde.devices[4242] = [realEssWfac({ id: 5550002 })]
  await poll()
  assert.equal(api.registered.length, 1, 'no second accessory')
  assert.equal(api.unregistered.length, 0, 'nothing removed')
  assert.equal(alarm.UUID, uuid)
  assert.equal(alarm.displayName, 'Hallway', 'the name set by serial number still applies')
  assert.equal(alarm.context.deviceId, '5550002')
  assert.ok(sim.logged(/"Hallway" is listed by Kidde under a new id \(5550001 -> 5550002\); it stays the same accessory in HomeKit/))
  assert.ok(await isResponding(alarm))

  // Commands go to the new record
  await alarm.getServiceById(S.Switch, 'hush').getCharacteristic(C.On).handleSetRequest(true)
  assert.deepEqual(sim.kidde.commands.at(-1), { location: '4242', device: '5550002', command: 'hush' })
})

test('when Kidde lists the old and the new record of one alarm, the live one is used, in either order', async (t) => {
  const old = realEssWfac({ id: 5550001, lost: true, offline: true, last_seen: '2026-11-24T22:07:08Z' })
  const fresh = realEssWfac({ id: 5550002, last_seen: '2026-11-24T22:09:00Z' })
  for (const devices of [[old, fresh], [fresh, old]]) {
    const sim = realAccount(t)
    sim.kidde.devices[4242] = devices
    const { accessory, api } = await sim.boot()
    assert.equal(api.registered.length, 1, 'one accessory for one alarm')
    const alarm = accessory('Test')
    assert.ok(await isResponding(alarm), 'the online record is the one shown')
    assert.equal(alarm.context.deviceId, '5550002')
    assert.ok(!sim.logged(/is offline in Kidde/), 'the stale record is not reported')
    api.handlers.shutdown()
  }
})

test('an alarm Kidde lists without a serial number is known by its id', async (t) => {
  const sim = realAccount(t)
  sim.kidde.devices[4242] = [realEssWfac({ serial_number: undefined })]
  const { accessory, poll, api } = await sim.boot({ config: { hushSwitch: true } })
  const alarm = accessory('Test')
  assert.equal(alarm.context.alarmKey, 'id:5550001')
  assert.equal(alarm.getService(S.AccessoryInformation).getCharacteristic(C.SerialNumber).value, '5550001')
  await poll()
  assert.equal(api.registered.length, 1)
  await alarm.getServiceById(S.Switch, 'hush').getCharacteristic(C.On).handleSetRequest(true)
  assert.deepEqual(sim.kidde.commands.at(-1), { location: '4242', device: '5550001', command: 'hush' })
})

test('a restart keeps the accessory found by serial number, whatever the id is now', async (t) => {
  const sim = realAccount(t)
  const first = await sim.boot()
  const cached = first.api.registered
  first.api.handlers.shutdown()

  sim.kidde.devices[4242] = [realEssWfac({ id: 5550003 })]
  const second = await sim.boot({ cached })
  assert.equal(second.api.registered.length, 0, 'the cached accessory is reused')
  assert.equal(second.api.unregistered.length, 0)
  assert.equal(cached[0].context.deviceId, '5550003')
  assert.ok(sim.logged(/"Test" is listed by Kidde under a new id \(5550001 -> 5550003\)/))
  assert.ok(await isResponding(cached[0]))
})
