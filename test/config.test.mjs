import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolveOptions,
  PLATFORM_NAME,
  DEFAULT_POLLING_INTERVAL_SECONDS,
  MIN_POLLING_INTERVAL_SECONDS,
  MAX_POLLING_INTERVAL_SECONDS,
  DEFAULT_LOW_BATTERY_THRESHOLD,
} from '../dist/settings.js'

const schemaFile = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'))
const props = schemaFile.schema.properties

/** Every key a layout places, including array items, without the [] suffix */
function layoutKeys(items, out = []) {
  for (const item of items ?? []) {
    if (typeof item === 'string') out.push(item.replace(/\[\]$/, ''))
    else if (item?.key) {
      out.push(item.key)
      if (item.items) layoutKeys(item.items, [])
    } else if (item?.items) layoutKeys(item.items, out)
  }
  return out
}

test('the settings schema is the standard platform form the plugin expects', () => {
  assert.equal(schemaFile.pluginAlias, PLATFORM_NAME)
  assert.equal(schemaFile.pluginType, 'platform')
  assert.equal(schemaFile.singular, true, 'one block per Homebridge, needed for the schema form under the custom panel')
  assert.deepEqual(schemaFile.schema.required, ['email', 'password'])

  // Every option appears in the layout exactly once, so none is unreachable in the form
  const placed = layoutKeys(schemaFile.layout)
  assert.deepEqual([...placed].sort(), Object.keys(props).sort())
  assert.equal(new Set(placed).size, placed.length)

  // The password is masked
  const passwordItem = schemaFile.layout[0].items.find((i) => i.key === 'password')
  assert.equal(passwordItem.type, 'password')

  // Every option has a title, and every non-credential option a description
  for (const [key, prop] of Object.entries(props)) {
    assert.ok(prop.title, `${key} has a title`)
    if (!['email', 'password', 'devices'].includes(key)) assert.ok(prop.description, `${key} has a description`)
  }
})

test('schema defaults and ranges match what the plugin applies', () => {
  assert.equal(props.pollingInterval.default, DEFAULT_POLLING_INTERVAL_SECONDS)
  assert.equal(props.pollingInterval.minimum, MIN_POLLING_INTERVAL_SECONDS)
  assert.equal(props.pollingInterval.maximum, MAX_POLLING_INTERVAL_SECONDS)
  assert.equal(props.lowBatteryThreshold.default, DEFAULT_LOW_BATTERY_THRESHOLD)

  const defaults = resolveOptions({ platform: PLATFORM_NAME })
  assert.equal(defaults.pollingIntervalMs, props.pollingInterval.default * 1000)
  assert.equal(defaults.lowBatteryThreshold, props.lowBatteryThreshold.default)
  assert.equal(defaults.hushSwitch, props.hushSwitch.default)
  assert.equal(defaults.testSwitch, props.testSwitch.default)
  assert.equal(defaults.identifyLocate, props.identifyLocate.default)
  assert.equal(defaults.debug, props.debug.default)
})

test('hand-edited config values are normalized instead of crashing the plugin', () => {
  const options = resolveOptions({
    platform: PLATFORM_NAME,
    email: '  owner@example.com ',
    password: 'pw',
    pollingInterval: 2,
    lowBatteryThreshold: '150',
    locationIds: [12345, ' 678 ', '', null],
    devices: [
      { id: 101, name: ' Kitchen ', hidden: true },
      { id: 'SN-ABC', name: '' },
      { name: 'no id' },
      'garbage',
    ],
    hushSwitch: 'yes',
  })
  assert.equal(options.email, 'owner@example.com')
  assert.equal(options.pollingIntervalMs, MIN_POLLING_INTERVAL_SECONDS * 1000, 'clamped up')
  assert.equal(options.lowBatteryThreshold, 100, 'clamped down')
  assert.deepEqual([...options.locationIds], ['12345', '678'])
  assert.deepEqual([...options.devices.entries()], [
    ['101', { name: 'Kitchen', hidden: true }],
    ['sn-abc', { name: undefined, hidden: false }],
  ])
  assert.equal(options.hushSwitch, false, 'only a real true turns an option on')

  assert.equal(resolveOptions({ platform: PLATFORM_NAME, pollingInterval: 9999 }).pollingIntervalMs, MAX_POLLING_INTERVAL_SECONDS * 1000)
  assert.equal(resolveOptions({ platform: PLATFORM_NAME, pollingInterval: 'abc' }).pollingIntervalMs, DEFAULT_POLLING_INTERVAL_SECONDS * 1000)
})
