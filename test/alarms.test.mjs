import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSim,
  comboAlarm,
  smokeAlarm,
  waterLeakSensor,
  coOnlyAlarm,
  hap,
  smoke,
  co,
  fault,
  lowBattery,
  batteryLevel,
  read,
  isResponding,
} from './helpers/sim.mjs'

const C = hap.Characteristic
const S = hap.Service

test('only smoke alarms become accessories, with the services their model supports', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [
    comboAlarm(101, 'Kitchen'),
    smokeAlarm(102, 'Hallway'),
    coOnlyAlarm(103, 'Basement CO'),
    waterLeakSensor(104, 'Water Heater'),
  ]
  const { api, accessory } = await sim.boot()

  assert.deepEqual(
    api.registered.map((a) => a.displayName).sort(),
    ['Hallway', 'Kitchen'],
    'CO-only alarms and water sensors are skipped',
  )

  const kitchen = accessory('Kitchen')
  assert.ok(kitchen.getService(S.SmokeSensor))
  assert.ok(kitchen.getService(S.CarbonMonoxideSensor), 'smoke + CO model gets a CO sensor')
  assert.ok(kitchen.getService(S.Battery))

  const hallway = accessory('Hallway')
  assert.ok(hallway.getService(S.SmokeSensor))
  assert.equal(hallway.getService(S.CarbonMonoxideSensor), undefined, 'EssWFAC listing only "Smoke" has no CO sensor')

  const info = kitchen.getService(S.AccessoryInformation)
  assert.equal(info.getCharacteristic(C.Manufacturer).value, 'Kidde')
  assert.equal(info.getCharacteristic(C.SerialNumber).value, 'SN101')
  assert.equal(info.getCharacteristic(C.FirmwareRevision).value, '1.10.0', 'firmware normalized to x.y.z')
  assert.match(info.getCharacteristic(C.Model).value, /Smoke \+ CO Alarm \(wifidetector\)/)
  assert.equal(
    hallway.getService(S.AccessoryInformation).getCharacteristic(C.FirmwareRevision).value,
    '1.0.79',
  )
  assert.ok(sim.logged(/Found 2 smoke alarms at 1 location \(2 in HomeKit\)/))
})

test('smoke and CO alarms reach HomeKit and clear again', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  const { accessory, poll } = await sim.boot()
  const kitchen = accessory('Kitchen')
  assert.equal(smoke(kitchen).value, C.SmokeDetected.SMOKE_NOT_DETECTED)

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen', { smoke_alarm: true })]
  await poll()
  assert.equal(smoke(kitchen).value, C.SmokeDetected.SMOKE_DETECTED, 'pushed without HomeKit asking')
  assert.equal(await read(smoke(kitchen)), C.SmokeDetected.SMOKE_DETECTED)
  assert.ok(sim.logged(/\[warn\] SMOKE ALARM: "Kitchen" is reporting smoke/))

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen', { co_alarm: true, co_level: 250 })]
  await poll()
  assert.equal(smoke(kitchen).value, C.SmokeDetected.SMOKE_NOT_DETECTED)
  assert.equal(co(kitchen).value, C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)
  const level = kitchen.getService(S.CarbonMonoxideSensor).getCharacteristic(C.CarbonMonoxideLevel)
  assert.equal(level.value, 100, 'CO level clamped to the characteristic range')
  assert.ok(sim.logged(/CARBON MONOXIDE ALARM: "Kitchen" is reporting CO \(250 ppm\)/))
  assert.ok(sim.logged(/Smoke alarm cleared on "Kitchen"/))

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  await poll()
  assert.equal(co(kitchen).value, C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
})

test('an interconnected alarm sounding through a detector counts as smoke', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [smokeAlarm(102, 'Hallway', { hardwire_smoke: true })]
  const { accessory } = await sim.boot()
  assert.equal(smoke(accessory('Hallway')).value, C.SmokeDetected.SMOKE_DETECTED)
  assert.ok(sim.logged(/SMOKE ALARM: "Hallway"/))
})

test("one alarm's update never changes another alarm's state", async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(201, 'Bedroom')]
  const { accessory, poll } = await sim.boot()
  const kitchen = accessory('Kitchen')
  const bedroom = accessory('Bedroom')
  const bedroomChanges = []
  smoke(bedroom).on('change', ({ newValue }) => bedroomChanges.push(newValue))

  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen', { smoke_alarm: true }), comboAlarm(201, 'Bedroom')]
  await poll()
  await poll()
  assert.equal(smoke(kitchen).value, 1)
  assert.equal(smoke(bedroom).value, 0)
  assert.deepEqual(bedroomChanges, [], 'the bedroom never flickered')
})

test('a document missing its alarm fields never reads as "smoke cleared"', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen', { smoke_alarm: true })]
  const { accessory, poll } = await sim.boot()
  const partial = comboAlarm(101, 'Kitchen')
  delete partial.smoke_alarm
  sim.kidde.devices[1] = [partial]
  await poll()
  assert.equal(smoke(accessory('Kitchen')).value, 1)
})

test('battery states in every observed spelling', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [
    comboAlarm(1, 'A', { battery_state: 'ok' }),
    smokeAlarm(2, 'B', { battery_state: 'Good' }),
    smokeAlarm(3, 'C', { battery_state: 'Normal' }),
    smokeAlarm(4, 'D', { battery_state: 'Low' }),
    comboAlarm(5, 'E', { battery_state: 'warning' }),
    smokeAlarm(6, 'F', { battery_state: 'Good', flt_lwbat_mb: true }),
    comboAlarm(7, 'G', { battery_state: 'ok', battery_level: 15 }),
  ]
  const { accessory } = await sim.boot({ config: { lowBatteryThreshold: 20 } })
  const NORMAL = C.StatusLowBattery.BATTERY_LEVEL_NORMAL
  const LOW = C.StatusLowBattery.BATTERY_LEVEL_LOW

  for (const name of ['A', 'B', 'C']) {
    assert.equal(lowBattery(accessory(name)).value, NORMAL, `${name} is healthy`)
    assert.equal(batteryLevel(accessory(name)).value, 100)
  }
  for (const name of ['D', 'E', 'F', 'G']) {
    assert.equal(lowBattery(accessory(name)).value, LOW, `${name} is low`)
  }
  assert.equal(batteryLevel(accessory('G')).value, 15, 'a numeric level is used as is')
  // The warning is on the sensor tile too, not only in the battery details
  const smokeLow = accessory('D').getService(S.SmokeSensor).getCharacteristic(C.StatusLowBattery)
  assert.equal(smokeLow.value, LOW)
  assert.equal(
    accessory('A').getService(S.Battery).getCharacteristic(C.ChargingState).value,
    C.ChargingState.NOT_CHARGEABLE,
  )
})

test('an unrecognized battery state is logged once and never treated as low', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [smokeAlarm(2, 'B', { battery_state: 'Sparkly' })]
  const { accessory, poll } = await sim.boot()
  await poll()
  const b = accessory('B')
  assert.equal(lowBattery(b).value, C.StatusLowBattery.BATTERY_LEVEL_NORMAL)
  assert.equal(batteryLevel(b).value, 100, 'holds the placeholder level')
  assert.ok(await isResponding(b), 'an unmapped battery string must not make the alarm No Response')
  assert.equal(sim.countLogged(/Unrecognized battery state "Sparkly"/), 1)
})

test('end of life and sensor faults show as a fault', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [
    smokeAlarm(1, 'Healthy'),
    smokeAlarm(2, 'Old', { end_of_life_status: 2 }),
    smokeAlarm(3, 'Broken', { flt_pho: true }),
    smokeAlarm(4, 'Errors', { errors: ['E12'] }),
    smokeAlarm(5, 'Expired', { life: 0 }),
  ]
  const { accessory, poll } = await sim.boot()
  const OK = C.StatusFault.NO_FAULT
  const FAULT = C.StatusFault.GENERAL_FAULT
  assert.equal(fault(accessory('Healthy')).value, OK)
  for (const name of ['Old', 'Broken', 'Errors', 'Expired']) {
    assert.equal(fault(accessory(name)).value, FAULT, `${name} shows a fault`)
  }
  assert.ok(sim.logged(/"Old" reports a fault: end of life warning/))
  assert.ok(sim.logged(/"Broken" reports a fault: smoke sensor fault/))

  // A low-battery fault flag is a battery problem, not a sensor fault
  sim.kidde.devices[1] = [smokeAlarm(1, 'Healthy', { flt_lwbat_wb: true })]
  await poll()
  assert.equal(fault(accessory('Healthy')).value, OK)
})

test('hidden alarms stay out of HomeKit and renamed ones use the new name', async (t) => {
  const sim = createSim(t)
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen'), comboAlarm(102, 'Hall 2'), comboAlarm(103, 'Garage')]
  const { api, accessory } = await sim.boot({
    config: {
      devices: [
        { id: '101', hidden: true },
        { id: 'sn102', name: 'Upstairs Hall' },
      ],
    },
  })
  assert.deepEqual(api.registered.map((a) => a.displayName).sort(), ['Garage', 'Upstairs Hall'])
  assert.ok(accessory('Upstairs Hall'), 'matched by serial number, case-insensitively')
  assert.ok(sim.logged(/"Kitchen" \(id 101\) is hidden from HomeKit/))
})

test('a location filter limits which alarms are added', async (t) => {
  const sim = createSim(t)
  sim.kidde.locations = [{ id: 1, name: 'Home' }, { id: 2, name: 'Cabin' }]
  sim.kidde.devices[1] = [comboAlarm(101, 'Kitchen')]
  sim.kidde.devices[2] = [comboAlarm(201, 'Cabin Loft')]
  const { api } = await sim.boot({ config: { locationIds: ['2'] } })
  assert.deepEqual(api.registered.map((a) => a.displayName), ['Cabin Loft'])
  assert.ok(!sim.kidde.requests.some((r) => r.path === '/location/1/device'), 'excluded location is not even read')
})
