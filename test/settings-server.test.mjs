import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDeviceCache } from '../dist/kidde-api/device-cache.js'

const serverPath = fileURLToPath(new URL('../dist/homebridge-ui/server.js', import.meta.url))
const stubUrl = new URL('./helpers/ui-fetch-stub.mjs', import.meta.url).href
const PASSWORD = 'correct horse'

/**
 * Start the real settings server the way the Homebridge UI does: as a child
 * process that receives requests and answers over the process channel.
 */
async function startServer(t, storage) {
  const child = fork(serverPath, [], {
    silent: true,
    execArgv: ['--import', stubUrl],
    env: {
      ...process.env,
      HOMEBRIDGE_STORAGE_PATH: storage,
      HOMEBRIDGE_CONFIG_PATH: join(storage, 'config.json'),
    },
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  t.after(() => child.kill())

  const pending = new Map()
  let ready
  const isReady = new Promise((resolve) => (ready = resolve))
  child.on('message', (message) => {
    if (message.action === 'ready') ready()
    if (message.action === 'response') pending.get(message.payload.requestId)?.(message.payload)
  })
  await isReady

  let seq = 0
  const request = (path, body) =>
    new Promise((resolve) => {
      const requestId = `r${++seq}`
      pending.set(requestId, resolve)
      child.send({ action: 'request', requestId, path, body })
    })
  return { request, output: () => output }
}

function makeStorage(t) {
  const storage = mkdtempSync(join(tmpdir(), 'kidde-smoke-ui-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const config = JSON.stringify({ platforms: [{ platform: 'KiddeSmokeDetectors', email: 'owner@example.com', password: PASSWORD }] })
  writeFileSync(join(storage, 'config.json'), config)
  return { storage, config }
}

test('the alarm list comes from the plugin cache without contacting Kidde', async (t) => {
  const { storage } = makeStorage(t)
  const devices = [{ id: '101', name: 'Kitchen', description: 'Smart Smoke + CO Alarm', hasCo: true, locationId: '1', locationName: 'Home', online: true }]
  await writeDeviceCache(storage, devices, [{ id: '1', name: 'Home' }])
  const { request } = await startServer(t, storage)

  const response = await request('/devices')
  assert.equal(response.success, true)
  assert.deepEqual(response.data.devices, devices)
  assert.deepEqual(response.data.locations, [{ id: '1', name: 'Home' }])
  assert.ok(response.data.updatedAt > 0)
})

test('Sign In & Find Alarms lists smoke alarms, saves the session, and never edits config.json', async (t) => {
  const { storage, config } = makeStorage(t)
  const { request, output } = await startServer(t, storage)

  const response = await request('/scan', { email: 'owner@example.com', password: PASSWORD })
  assert.equal(response.success, true, JSON.stringify(response.data))
  const { devices, locations, failedLocations, otherDevices } = response.data
  assert.deepEqual(devices.map((d) => [d.id, d.name, d.hasCo, d.online]), [
    ['101', 'Kitchen', true, true],
    ['201', 'Loft', false, false],
  ])
  assert.deepEqual(locations, [{ id: '1', name: 'Home' }, { id: '2', name: 'Cabin' }])
  assert.deepEqual(failedLocations, [])
  assert.equal(otherDevices, 1, 'the water sensor is counted, not listed')

  const sessionFile = join(storage, 'kidde-smoke-detectors.session.json')
  assert.ok(existsSync(sessionFile))
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600)
  assert.ok(existsSync(join(storage, 'kidde-smoke-detectors.devices.json')))

  assert.equal(readFileSync(join(storage, 'config.json'), 'utf8'), config, 'config.json is untouched')
  assert.ok(!output().includes(PASSWORD), 'the password never reaches the UI log')
})

test('sign-in input is validated and a rejected password is not retried immediately', async (t) => {
  const { storage } = makeStorage(t)
  const { request } = await startServer(t, storage)

  const empty = await request('/scan', { email: '', password: '' })
  assert.equal(empty.success, false)
  assert.match(empty.data.message, /Enter your Kidde email and password/)

  const tooLong = await request('/scan', { email: 'a'.repeat(300), password: 'x' })
  assert.equal(tooLong.success, false)

  const wrong = await request('/scan', { email: 'owner@example.com', password: 'nope' })
  assert.equal(wrong.success, false)
  assert.match(wrong.data.message, /Kidde rejected that email or password/)

  const again = await request('/scan', { email: 'owner@example.com', password: PASSWORD })
  assert.equal(again.success, false)
  assert.match(again.data.message, /wait a few seconds/)
})
