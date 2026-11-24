#!/usr/bin/env node
/**
 * Kidde account probe
 *
 * Signs in to a real Kidde HomeSafe account ONCE and records what the API
 * actually sends, so the plugin's assumptions can be checked against real
 * hardware. Then runs the plugin's own code on the same session and shows
 * what HomeKit would get.
 *
 *   npm run probe                         read-only check of the account
 *   npm run probe -- --watch 10           then poll for 10 minutes and print every change
 *   npm run probe -- --locate <id>        also make one alarm beep and flash for 5 seconds
 *   npm run probe -- --self-test <id>     also start one alarm's self-test (asks first)
 *
 * SAFETY
 * - One sign-in. If Kidde rejects the password, nothing else is tried, so
 *   the probe cannot lock the account.
 * - Read-only unless --locate or --self-test is given.
 * - Only Kidde is contacted. Nothing is written to Homebridge: the dry run
 *   of the plugin uses a temporary folder that is deleted afterwards.
 * - The password is typed at a hidden prompt (never an argument or an
 *   environment variable, which would end up in shell history).
 * - The report (probe-reports/) holds no password, cookie, token or email
 *   address. Serial numbers are shortened, location names and anything
 *   that looks like an address, network name, MAC or IP address are
 *   removed. Alarm names are kept. Read it before sharing it.
 *
 * This script is for the repository only; it is not part of the npm
 * package.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(ROOT, 'dist', 'platform.js'))) {
  console.error('Build the plugin first with "npm run build" ("npm run probe" does this for you).')
  process.exit(1)
}

const { KIDDE_API_BASE, KiddeClient } = await import(new URL('../dist/kidde-api/client.js', import.meta.url))
const types = await import(new URL('../dist/kidde-api/types.js', import.meta.url))
const { saveSession } = await import(new URL('../dist/kidde-api/session-store.js', import.meta.url))
const { scanAccount } = await import(new URL('../dist/homebridge-ui/scan.js', import.meta.url))
const { KiddeSmokeDetectorsPlatform } = await import(new URL('../dist/platform.js', import.meta.url))
const { describeError } = await import(new URL('../dist/util.js', import.meta.url))

const USER_AGENT = 'homebridge-kidde-smoke-detectors'
const REQUEST_TIMEOUT_MS = 20_000
const LOW_BATTERY_THRESHOLD = 20
const LOCATE_SECONDS = 5
/** Self-test watch: poll this often at first, to catch a short-lived alarm state */
const FAST_POLL_MS = 5000
const FAST_POLL_WINDOW_MS = 90_000
const SELF_TEST_DEFAULT_MINUTES = 3
/** Fields that change on their own all the time; recorded, but not printed while watching */
const QUIET_KEYS = /^last_seen$|rssi|^diag_params$|signal|uptime|heartbeat|timestamp|updated/i

const USAGE = `Probe a Kidde HomeSafe account with this plugin's code.

  npm run probe                          read-only check of the account
  npm run probe -- --watch 10            then poll for 10 minutes, printing every change
  npm run probe -- --locate <id>         also make one alarm beep and flash for ${LOCATE_SECONDS} seconds
  npm run probe -- --self-test <id>      also start one alarm's self-test (asks first)

Options:
  --email <address>     skip the email prompt (the password is always asked for)
  --watch <minutes>     keep polling this long after the check (up to 120)
  --interval <seconds>  seconds between polls while watching (5 to 300, default 15)
  --locate <id>         device id, as listed by a plain run
  --self-test <id>      device id, as listed by a plain run; watches ${SELF_TEST_DEFAULT_MINUTES} minutes unless --watch is given
  -h, --help

Signs in once. Writes a report to probe-reports/ with no password, cookie,
token or email address in it.`

// --- Options -------------------------------------------------------------------

function fail(message) {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

let args
try {
  args = parseArgs({
    options: {
      email: { type: 'string' },
      watch: { type: 'string' },
      interval: { type: 'string' },
      locate: { type: 'string' },
      'self-test': { type: 'string' },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  }).values
} catch (error) {
  fail(error.message)
}
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

function numberOption(name, fallback, min, max) {
  if (args[name] === undefined) return fallback
  const value = Number(args[name])
  if (!Number.isFinite(value) || value < min || value > max) fail(`--${name} must be a number from ${min} to ${max}.`)
  return value
}
const watchGiven = args.watch !== undefined
const watchMinutes = numberOption('watch', 0, 0, 120)
const intervalMs = numberOption('interval', 15, 5, 300) * 1000

/**
 * --base-url exists only to test this script against a local fake Kidde.
 * It accepts nothing but this computer, so the password can never be sent
 * anywhere else.
 */
function resolveBase(value) {
  if (value === undefined) return KIDDE_API_BASE
  let url
  try {
    url = new URL(value)
  } catch {
    fail('--base-url is not a URL.')
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    fail('--base-url only accepts a test server on this computer.')
  }
  return url.href.replace(/\/+$/, '')
}
const base = resolveBase(args['base-url'])

// --- Contacting Kidde -------------------------------------------------------------

/**
 * Every request goes through here, the plugin's included: it counts
 * sign-ins, refuses any host but Kidde, and in a local test sends the
 * plugin's requests to the test server.
 */
const realFetch = globalThis.fetch
const counts = { requests: 0, signIns: 0 }
globalThis.fetch = (input, init) => {
  let target = String(input)
  if (base !== KIDDE_API_BASE && target.startsWith(KIDDE_API_BASE)) {
    target = base + target.slice(KIDDE_API_BASE.length)
  }
  if (!target.startsWith(`${base}/`)) {
    return Promise.reject(new Error(`the probe refused to contact ${new URL(target).origin}`))
  }
  counts.requests++
  if (new URL(target).pathname.endsWith('/auth/login')) counts.signIns++
  return realFetch(target, init)
}

class ProbeStop extends Error {}

function parseSetCookie(line) {
  const [pair, ...attributes] = line.split(';')
  const eq = pair.indexOf('=')
  const name = (eq > 0 ? pair.slice(0, eq) : pair).trim()
  const value = eq > 0 ? pair.slice(eq + 1).trim() : ''
  const info = { name, valueLength: value.length }
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=')
    const key = rawKey.trim().toLowerCase()
    const v = rest.join('=').trim()
    if (key === 'max-age') info.maxAgeSeconds = Number(v)
    else if (key === 'expires') {
      const when = Date.parse(v)
      if (Number.isFinite(when)) info.expiresInSeconds = Math.round((when - Date.now()) / 1000)
    } else if (key === 'domain') info.domain = v
    else if (key === 'path') info.path = v
    else if (key === 'samesite') info.sameSite = v
    else if (key === 'httponly') info.httpOnly = true
    else if (key === 'secure') info.secure = true
  }
  return { info, name, value }
}

/** Header values that are safe and useful to record; every other header is recorded by name only */
function notableHeaders(headers) {
  const names = []
  const values = {}
  headers.forEach((value, name) => {
    names.push(name)
    if (/^(content-type|server|retry-after|cache-control)$|rate|limit|retry/i.test(name)) values[name] = value
  })
  return { names: [...new Set(names)].sort(), values }
}

async function rawCall(method, path, { session, cookies, token, body } = {}) {
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT }
  const jar = cookies ?? session?.cookies
  const bearer = token ?? session?.accessToken
  if (jar && Object.keys(jar).length > 0) {
    headers.cookie = Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
  if (bearer) headers['homeboy-auth'] = bearer
  if (body !== undefined) headers['content-type'] = 'application/json'

  const started = performance.now()
  let response
  try {
    response = await globalThis.fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ProbeStop(`Could not reach Kidde: ${describeError(error)}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const text = buffer.toString('utf8')
  let json
  let unreadable = false
  if (text.trim()) {
    try {
      json = JSON.parse(text)
    } catch {
      unreadable = true
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    isRedirect: response.status >= 300 && response.status < 400,
    ms: Math.round(performance.now() - started),
    bytes: buffer.length,
    json,
    unreadable,
    setCookies: (response.headers.getSetCookie?.() ?? []).map(parseSetCookie),
    headers: notableHeaders(response.headers),
  }
}

/** Accept a bare list or one wrapped under a key, as the plugin does */
function listFrom(body, key) {
  if (Array.isArray(body)) return { list: body, shape: 'array' }
  if (body && typeof body === 'object' && Array.isArray(body[key])) {
    return { list: body[key], shape: `object with "${key}" list (keys: ${Object.keys(body).join(', ')})` }
  }
  return { list: [], shape: body === undefined ? 'empty' : `unexpected (${typeof body})` }
}

// --- Keeping secrets out of the report -------------------------------------------

const SENSITIVE_PARTS = new Set([
  'password', 'passwd', 'pass', 'token', 'secret', 'cookie', 'cookies', 'session', 'auth',
  'authorization', 'email', 'mail', 'phone', 'mobile', 'mac', 'bssid', 'ssid', 'ip', 'ipv4',
  'ipv6', 'address', 'addr', 'street', 'city', 'zip', 'zipcode', 'postal', 'postcode', 'lat',
  'latitude', 'lon', 'lng', 'longitude', 'altitude', 'accuracy', 'geo', 'gps', 'owner', 'user',
  'username', 'account', 'timezone', 'zone',
])
const PERSON_NAME_KEY = /^(first|last|full|display|user|owner|contact)_?name$/i

function keyParts(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isSensitiveKey(key) {
  return PERSON_NAME_KEY.test(key) || keyParts(key).some((part) => SENSITIVE_PARTS.has(part))
}

function shortenSerial(value) {
  const s = String(value)
  return s.length <= 4 ? `<${s.length} chars>` : `...${s.slice(-4)} (${s.length} chars)`
}

function redactString(value) {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) return '<email address>'
  if (/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i.test(value)) return '<MAC address>'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return '<IP address>'
  if (/^eyJ[\w-]*\.[\w-]*\./.test(value)) return '<token>'
  if (value.length >= 32 && /^[A-Za-z0-9+/=_.:-]+$/.test(value) && Number.isNaN(Date.parse(value))) {
    return `<opaque string, ${value.length} chars>`
  }
  return value
}

/** A copy of a Kidde document that is safe to share */
function redact(value, key = '') {
  if (value === null || value === undefined || typeof value === 'boolean') return value
  if (key && /serial/i.test(key) && (typeof value === 'string' || typeof value === 'number')) {
    return shortenSerial(value)
  }
  if (key && isSensitiveKey(key)) {
    if (typeof value === 'string') return `<redacted, ${value.length} chars>`
    if (typeof value === 'number') return '<redacted number>'
    return Array.isArray(value) ? '<redacted list>' : '<redacted>'
  }
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  }
  return value
}

/** Locations are named by their owners, often after the street address */
function redactLocation(location) {
  const copy = redact(location)
  for (const key of ['name', 'label', 'title', 'description', 'nickname']) {
    if (typeof location[key] === 'string') copy[key] = `<location name, ${location[key].length} chars>`
  }
  return copy
}

function keyTypes(items) {
  const seen = {}
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    for (const [key, value] of Object.entries(item)) {
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      ;(seen[key] ??= new Set()).add(type)
    }
  }
  return Object.fromEntries(Object.entries(seen).sort().map(([k, v]) => [k, [...v].join(' | ')]))
}

function describeToken(token) {
  const out = { length: token.length, jwt: false }
  const parts = token.split('.')
  if (parts.length !== 3) return out
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    out.jwt = true
    out.claims = Object.keys(payload)
    if (typeof payload.exp === 'number') {
      out.expiresInSeconds = payload.exp - Math.floor(Date.now() / 1000)
      if (typeof payload.iat === 'number') out.lifetimeSeconds = payload.exp - payload.iat
    }
  } catch {
    // not a JWT after all
  }
  return out
}

// --- What the plugin makes of a document ------------------------------------------

/** The fields the plugin knows (types.ts); flt_ and gflt_ flags are read generically */
const KNOWN_KEYS = new Set([
  'id', 'location_id', 'label', 'model', 'serial_number', 'hwrev', 'fwrev', 'ver_mb',
  'capabilities', 'cap_sensor', 'smoke_alarm', 'hardwire_smoke', 'too_much_smoke',
  'smoke_hushed', 'smoke_level', 'co_alarm', 'hardwire_co', 'co_level', 'co_ppm',
  'battery_state', 'battery_level', 'low_battery_alarm', 'offline', 'lost', 'contact_lost',
  'life', 'end_of_life_status', 'errors', 'last_seen', 'last_test_time',
])
const WORTH_A_LOOK = /alarm|smoke|(^|_)co(_|$)|hush|batt|fault|err|offline|online|lost|connect|life|eol|test|status|state|alert|silence|mute/i

function tri(value) {
  if (value === true) return 'DETECTED'
  if (value === false) return 'clear'
  return 'unreadable (No Response)'
}

function interpret(doc) {
  const kinds = types.detectKinds(doc)
  const decidedBy = types.hasCapabilityList(doc) ? 'capability list' : 'model name and fields (no capability list)'
  if (!kinds.smoke) return { smokeAlarm: false, decidedBy }
  const battery = types.batteryCategory(doc)
  return {
    smokeAlarm: true,
    decidedBy,
    hasCo: kinds.co,
    homeKitName: types.sanitizeName(typeof doc.label === 'string' ? doc.label : ''),
    model: types.describeModel(doc, kinds),
    firmware: types.firmwareRevision(doc) ?? '(none found, shown as 1.0.0)',
    smoke: tri(types.isSmokeDetected(doc)),
    co: kinds.co ? tri(types.isCoDetected(doc)) : 'no CO sensor',
    coPpm: types.coPpm(doc) ?? null,
    battery: {
      category: battery,
      reported: typeof doc.battery_state === 'string' ? doc.battery_state : doc.battery_state === undefined ? null : typeof doc.battery_state,
      percentShown: types.batteryPercent(doc, LOW_BATTERY_THRESHOLD) ?? 'held at last value',
      low: types.isLowBattery(doc, LOW_BATTERY_THRESHOLD),
    },
    offline: types.isOffline(doc),
    faults: types.faultReasons(doc),
    unreadableAlarmFields: types.unreadableAlarmFields(doc),
  }
}

/** One line for the HomeKit-relevant state, to spot changes while watching */
function homeKitSummary(doc) {
  const p = interpret(doc)
  if (!p.smokeAlarm) return 'not a smoke alarm'
  if (p.offline) return 'No Response (offline in Kidde)'
  const parts = [`smoke ${p.smoke}`]
  if (p.hasCo) parts.push(`CO ${p.co}`)
  parts.push(`battery ${p.battery.low ? 'LOW' : 'normal'}`)
  parts.push(p.faults.length ? `fault: ${p.faults.join(', ')}` : 'no fault')
  return parts.join(', ')
}

function display(value) {
  if (value === undefined) return '(absent)'
  const shown = JSON.stringify(value)
  return shown.length > 80 ? `${shown.slice(0, 77)}...` : shown
}

// --- Prompts and stopping -----------------------------------------------------------

let stopRequested = false
let wake = null
let watching = false
let activeReport = null
const tempDirs = new Set()

function cleanUpTemp() {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
}

function onInterrupt() {
  if (watching && !stopRequested) {
    stopRequested = true
    console.log('\nStopping after this poll...')
    wake?.()
    return
  }
  console.log('\nStopped.')
  cleanUpTemp()
  if (activeReport) finishReport(activeReport, 130)
  process.exit(130)
}

function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      wake = null
      resolve()
    }
    wake = done
  })
}

let pipedLines = null
async function promptLine(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) {
    // Piped input (used by the self-check): one answer per line
    pipedLines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]()
    process.stdout.write(question)
    const { value, done } = await pipedLines.next()
    process.stdout.write(hidden ? '\n' : `${done ? '' : value}\n`)
    return done ? '' : value
  }
  if (!hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => {
      rl.close()
      onInterrupt()
    })
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close()
        resolve(answer)
      })
    })
  }
  // Hidden: read keys in raw mode and echo nothing
  process.stdout.write(question)
  const stdin = process.stdin
  return new Promise((resolve) => {
    let value = ''
    const finish = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish()
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          finish()
          onInterrupt()
          return
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}

// --- Output ------------------------------------------------------------------------

const clockTime = () => new Date().toLocaleTimeString()
const heading = (text) => console.log(`\n${text}`)
const line = (text = '') => console.log(`  ${text}`)
const pad = (text, width) => String(text).padEnd(width)
const attention = []
function flag(text) {
  attention.push(text)
}

function finishReport(report, exitCode) {
  report.finished = new Date().toISOString()
  report.exitCode = exitCode
  report.requests = { ...counts }
  report.attention = attention
  const dir = join(ROOT, 'probe-reports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = join(dir, `kidde-probe-${stamp}.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return path
}

// --- The probe ----------------------------------------------------------------------

async function signIn(report, email, password) {
  process.stdout.write('\nSigning in to Kidde ... ')
  const login = await rawCall('POST', '/auth/login', { body: { email, password } })
  const body = login.json && typeof login.json === 'object' && !Array.isArray(login.json) ? login.json : {}
  const token = typeof body.access_token === 'string' && body.access_token ? body.access_token : undefined
  report.login = {
    status: login.status,
    ms: login.ms,
    bodyKeys: keyTypes([body]),
    cookies: login.setCookies.map((c) => c.info),
    accessToken: token ? describeToken(token) : null,
    headers: login.headers,
  }

  if (login.status === 401 || login.status === 403) {
    console.log(`rejected (HTTP ${login.status})`)
    throw new ProbeStop(
      'Kidde rejected the email or password. Nothing else was tried, so this cannot lock the account. ' +
        'Check them in the Kidde app and run the probe again.',
    )
  }
  if (!login.ok) {
    console.log(`failed (HTTP ${login.status})`)
    throw new ProbeStop(
      login.isRedirect
        ? `Kidde answered the sign-in with a redirect (HTTP ${login.status}), which the plugin never follows.`
        : `Kidde's sign-in answered HTTP ${login.status}. Try again later.`,
    )
  }
  const cookies = Object.fromEntries(login.setCookies.filter((c) => c.value).map((c) => [c.name, c.value]))
  if (Object.keys(cookies).length === 0 && !token) {
    console.log('no session')
    throw new ProbeStop('Kidde accepted the sign-in but returned no cookie or access token.')
  }
  console.log(`ok, ${login.ms} ms`)

  const lifetime = (seconds) =>
    seconds === undefined ? '' : `, valid ${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  const cookieText = login.setCookies
    .map((c) => {
      const age = c.info.maxAgeSeconds ?? c.info.expiresInSeconds
      return `${c.name}${age === undefined ? ' (session cookie)' : lifetime(age)}`
    })
    .join('; ')
  line(`Cookies: ${cookieText || 'none'}`)
  const t = report.login.accessToken
  line(`Access token: ${t ? `${t.jwt ? 'JWT' : 'opaque'}, ${t.length} chars${lifetime(t.lifetimeSeconds ?? t.expiresInSeconds)}` : 'none'}`)
  return { cookies, accessToken: token, createdAt: Date.now() }
}

async function readAccount(report, session) {
  process.stdout.write('Reading locations ... ')
  const res = await rawCall('GET', '/location', { session })
  if (!res.ok) {
    console.log(`failed (HTTP ${res.status})`)
    throw new ProbeStop(`Kidde answered HTTP ${res.status} for the location list right after signing in.`)
  }
  const { list, shape } = listFrom(res.json, 'locations')
  const locations = list.map((raw) => types.locationInfo(raw ?? {})).filter(Boolean)
  console.log(`${locations.length} found, ${res.ms} ms`)
  for (const location of locations) line(`${location.name} (location id ${location.id})`)
  report.locations = {
    status: res.status,
    ms: res.ms,
    bytes: res.bytes,
    shape,
    count: locations.length,
    keys: keyTypes(list),
    items: list.map((raw) => (raw && typeof raw === 'object' ? redactLocation(raw) : raw)),
    setCookieNames: res.setCookies.map((c) => c.name),
    headers: res.headers,
  }

  const devices = []
  report.deviceLists = []
  for (const location of locations) {
    process.stdout.write(`Reading devices at ${location.name} ... `)
    const r = await rawCall('GET', `/location/${encodeURIComponent(location.id)}/device`, { session })
    const entry = {
      location: `Location ${location.id}`,
      status: r.status,
      ms: r.ms,
      bytes: r.bytes,
      setCookieNames: r.setCookies.map((c) => c.name),
    }
    report.deviceLists.push(entry)
    if (!r.ok) {
      console.log(`failed (HTTP ${r.status})`)
      flag(`The device list for location ${location.id} answered HTTP ${r.status}.`)
      continue
    }
    const { list: docs, shape: deviceShape } = listFrom(r.json, 'devices')
    entry.shape = deviceShape
    entry.devices = []
    console.log(`${docs.length} found, ${r.ms} ms`)
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue
      const id = types.idOf(doc.id)
      const plugin = interpret(doc)
      entry.devices.push({ raw: redact(doc), plugin })
      if (!id) {
        flag('A device without a usable id was skipped.')
        continue
      }
      devices.push({ id, doc, location, name: typeof doc.label === 'string' ? doc.label : `Device ${id}` })
      const model = typeof doc.model === 'string' ? doc.model : '?'
      if (!plugin.smokeAlarm) {
        line(`${pad(doc.label ?? id, 22)} id ${pad(id, 10)} ${pad(model, 18)} not a smoke alarm, skipped`)
        continue
      }
      const state = [
        plugin.hasCo ? 'smoke + CO' : 'smoke only',
        `battery ${plugin.battery.reported === null ? 'not reported' : JSON.stringify(plugin.battery.reported)}`,
        plugin.offline ? 'OFFLINE' : 'online',
      ]
      if (plugin.faults.length) state.push(`fault: ${plugin.faults.join(', ')}`)
      line(`${pad(doc.label ?? id, 22)} id ${pad(id, 10)} ${pad(model, 18)} ${state.join(', ')}`)
      if (plugin.battery.category === 'unrecognized') {
        flag(`"${doc.label}" reports battery_state ${JSON.stringify(doc.battery_state)}, which the plugin does not recognize.`)
      }
      if (plugin.unreadableAlarmFields.length) {
        flag(`"${doc.label}" has alarm fields the plugin cannot read: ${plugin.unreadableAlarmFields.join(', ')}.`)
      }
    }
  }

  // Fields the plugin does not read, so anything new from Kidde is noticed
  const smokeDocs = devices.filter((d) => types.detectKinds(d.doc).smoke).map((d) => d.doc)
  const unread = {}
  for (const doc of smokeDocs) {
    for (const [key, value] of Object.entries(doc)) {
      if (KNOWN_KEYS.has(key) || /^g?flt_/.test(key) || key in unread) continue
      unread[key] = { example: redact(value, key), worthALook: WORTH_A_LOOK.test(key) }
    }
  }
  report.fieldReview = { keysSeen: keyTypes(smokeDocs), notReadByPlugin: unread }
  const interesting = Object.keys(unread).filter((k) => unread[k].worthALook)
  if (interesting.length) flag(`Alarm-related fields the plugin does not read yet: ${interesting.join(', ')}.`)
  // Fault detail fields (flt_pho_bm and the like) are numbers; worth knowing when one is not 0
  for (const doc of smokeDocs) {
    for (const [key, value] of Object.entries(doc)) {
      if (/^g?flt_.*_bm$/.test(key) && typeof value === 'number' && value !== 0) {
        flag(`"${doc.label}" reports ${key} = ${value}.`)
      }
    }
  }
  return { locations, devices }
}

async function authChecks(report, session) {
  process.stdout.write('Checking how Kidde treats sessions ... ')
  const status = async (path, auth) => {
    const r = await rawCall('GET', path, auth)
    return { status: r.status, setCookieNames: r.setCookies.map((c) => c.name) }
  }
  const invalid = Object.fromEntries(Object.keys(session.cookies).map((name) => [name, 'invalid']))
  const checks = {
    cookieOnly: Object.keys(session.cookies).length ? await status('/location', { cookies: session.cookies }) : 'no cookie',
    tokenOnly: session.accessToken ? await status('/location', { token: session.accessToken }) : 'no token',
    noCredentials: await status('/location', {}),
    invalidCookie: Object.keys(invalid).length ? await status('/location', { cookies: invalid }) : 'no cookie',
    // A location id that cannot exist on any account; only the status is kept
    unknownLocation: await status('/location/0/device', { session }),
    stillSignedIn: await status('/location', { session }),
  }
  report.authChecks = checks
  console.log('done')
  const s = (c) => (typeof c === 'string' ? c : `HTTP ${c.status}`)
  line(`Cookie alone: ${s(checks.cookieOnly)}. Token alone: ${s(checks.tokenOnly)}. Neither: ${s(checks.noCredentials)}. Invalid cookie: ${s(checks.invalidCookie)}.`)
  line(`A location the account cannot read: ${s(checks.unknownLocation)}. Session afterwards: ${s(checks.stillSignedIn)}.`)
  if (checks.stillSignedIn.status !== 200) flag('The session stopped working during the session checks.')
  if (![401, 403].includes(checks.noCredentials.status)) {
    flag(`A request without credentials answered HTTP ${checks.noCredentials.status}, not 401 or 403.`)
  }
}

async function pluginClientCheck(report, email, password, session, expectedSmokeAlarms) {
  process.stdout.write("Running the plugin's Kidde client on this session ... ")
  const events = []
  const client = new KiddeClient({
    email,
    password,
    session,
    onSessionChange: (_next, change) => events.push({ at: new Date().toISOString(), change }),
  })
  const before = counts.signIns
  const scan = await scanAccount(client)
  const signIns = counts.signIns - before
  report.pluginClient = {
    smokeAlarms: scan.devices.length,
    otherDevices: scan.otherDevices,
    failedLocations: scan.failedLocations.length,
    newSignIns: signIns,
    sessionEvents: events,
  }
  console.log(`${scan.devices.length} smoke alarm(s), ${signIns} extra sign-in(s)`)
  if (signIns > 0) flag("The plugin's client signed in again instead of reusing the session.")
  if (scan.devices.length !== expectedSmokeAlarms) {
    flag(`The plugin found ${scan.devices.length} smoke alarm(s) but the raw read found ${expectedSmokeAlarms}.`)
  }
  return { client, events }
}

const ENUM_TEXT = new Map()
function enumText(C) {
  if (ENUM_TEXT.size) return ENUM_TEXT
  ENUM_TEXT.set(C.SmokeDetected.UUID, ['not detected', 'SMOKE DETECTED'])
  ENUM_TEXT.set(C.CarbonMonoxideDetected.UUID, ['normal', 'CO ABNORMAL'])
  ENUM_TEXT.set(C.StatusFault.UUID, ['no fault', 'FAULT'])
  ENUM_TEXT.set(C.StatusLowBattery.UUID, ['normal', 'LOW'])
  ENUM_TEXT.set(C.ChargingState.UUID, ['not charging', 'charging', 'not chargeable'])
  return ENUM_TEXT
}

/**
 * Boot the real plugin platform against this session, with a stand-in for
 * Homebridge, and read every characteristic the way HomeKit does.
 */
async function homeKitPreview(report, email, password, session, locations) {
  process.stdout.write('Running the plugin itself (HomeKit preview) ... ')
  const { hap, FakePlatformAccessory } = await import(new URL('../test/helpers/sim.mjs', import.meta.url))
  const C = hap.Characteristic
  const storage = await mkdtemp(join(tmpdir(), 'kidde-probe-'))
  tempDirs.add(storage)
  const logs = []
  const hapWarnings = []
  const consoleLines = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  const before = counts.signIns
  let platformHandlers = {}
  try {
    await saveSession(storage, email, session)
    class ProbeAccessory extends FakePlatformAccessory {
      constructor(...a) {
        super(...a)
        this.hapAccessory.on('characteristic-warning', (w) =>
          hapWarnings.push(`[${(w.originatorChain ?? []).join(' > ')}] ${w.message}`),
        )
      }
    }
    const registered = []
    const api = {
      hap,
      on: (event, fn) => {
        platformHandlers[event] = fn
      },
      user: { storagePath: () => storage },
      platformAccessory: ProbeAccessory,
      registerPlatformAccessories: (_p, _n, list) => registered.push(...list),
      unregisterPlatformAccessories: () => {},
      updatePlatformAccessories: () => {},
    }
    const log = Object.fromEntries(
      ['info', 'warn', 'error', 'debug', 'success'].map((level) => [level, (m) => logs.push(`[${level}] ${m}`)]),
    )
    // HAP prints some warnings straight to the console; keep them for the report
    for (const k of Object.keys(original)) console[k] = (...a) => consoleLines.push(a.join(' '))

    const platform = new KiddeSmokeDetectorsPlatform(
      log,
      { platform: 'KiddeSmokeDetectors', email, password, hushSwitch: true, testSwitch: true },
      api,
    )
    platformHandlers.didFinishLaunching?.()
    const deadline = performance.now() + 60_000
    while (!(platform.client && platform.pollInFlight === null && (platform.firstPollDone || platform.consecutiveFailures > 0))) {
      if (performance.now() > deadline) throw new ProbeStop('The plugin did not finish its first poll within a minute.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const texts = enumText(C)
    const accessories = []
    for (const accessory of registered) {
      accessory.hapAccessory.validateAccessory?.(false)
      const services = []
      for (const service of accessory.services) {
        const values = {}
        for (const characteristic of service.characteristics) {
          // Identify and the like can only be written; HomeKit never reads them
          if (!characteristic.props.perms.includes(hap.Perms.PAIRED_READ)) continue
          let shown
          try {
            const value = await characteristic.handleGetRequest()
            shown = texts.get(characteristic.UUID)?.[value] ?? value
            if (characteristic.UUID === C.SerialNumber.UUID) shown = shortenSerial(value)
          } catch (error) {
            const code = typeof error === 'number' ? error : error?.hapStatus
            shown = code === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE ? 'No Response' : `error ${code ?? describeError(error)}`
          }
          values[characteristic.displayName] = shown
        }
        services.push({ service: service.constructor?.name ?? service.UUID, subtype: service.subtype ?? null, values })
      }
      accessories.push({ name: accessory.displayName, category: accessory.category, services })
    }
    platformHandlers.shutdown?.()
    platformHandlers = {}

    // Location names are the owner's; keep them out of the report
    const scrub = (text) =>
      locations.reduce((t, l) => t.split(`"${l.name}"`).join(`"Location ${l.id}"`), String(text))
    report.homeKit = {
      accessories,
      pluginLog: logs.map(scrub),
      hapWarnings: hapWarnings.map(scrub),
      consoleOutput: consoleLines.map(scrub),
      newSignIns: counts.signIns - before,
    }
    Object.assign(console, original)
    console.log(`${accessories.length} accessor${accessories.length === 1 ? 'y' : 'ies'}`)

    for (const a of accessories) {
      const find = (name) => a.services.find((s) => s.service === name)?.values ?? {}
      const smoke = find('SmokeSensor')
      const co = find('CarbonMonoxideSensor')
      const battery = find('Battery')
      if (smoke['Smoke Detected'] === 'No Response') {
        line(`${pad(a.name, 22)} No Response`)
        continue
      }
      const parts = [`smoke ${smoke['Smoke Detected']}`]
      if (Object.keys(co).length) parts.push(`CO ${co['Carbon Monoxide Detected']}, ${co['Carbon Monoxide Level']} ppm`)
      parts.push(`battery ${battery['Battery Level']}% ${battery['Status Low Battery']}`)
      parts.push(smoke['Status Fault'])
      line(`${pad(a.name, 22)} ${parts.join(' | ')}`)
    }
    const services = accessories.flatMap((a) => a.services.map((s) => `${a.name}: ${s.service}`))
    if (services.length) line(`${services.length} services in all; every characteristic is listed in the report.`)
    if (hapWarnings.length || consoleLines.some((l) => /warn|error/i.test(l))) {
      flag(`HomeKit (HAP) raised ${hapWarnings.length + consoleLines.length} warning(s); see homeKit in the report.`)
    }
    if (report.homeKit.newSignIns > 0) flag('The plugin signed in again instead of using the saved session.')
    for (const entry of logs) {
      if (entry.startsWith('[error]')) flag(`Plugin error: ${scrub(entry.slice(8))}`)
    }
  } finally {
    Object.assign(console, original)
    platformHandlers.shutdown?.()
    rmSync(storage, { recursive: true, force: true })
    tempDirs.delete(storage)
  }
}

async function locate(report, client, target) {
  heading(`Locating "${target.name}": it should beep and flash for about ${LOCATE_SECONDS} seconds.`)
  const result = {}
  report.locate = { device: target.id, result }
  for (const [command, waitAfter] of [['identify', LOCATE_SECONDS * 1000], ['identifycancel', 0]]) {
    const started = performance.now()
    try {
      await client.sendCommand(target.location.id, target.id, command)
      result[command] = { ok: true, ms: Math.round(performance.now() - started) }
      line(`${command}: accepted by Kidde`)
    } catch (error) {
      result[command] = { ok: false, error: describeError(error) }
      line(`${command}: FAILED, ${describeError(error)}`)
      flag(`The ${command} command failed: ${describeError(error)}`)
      if (command === 'identify') break
    }
    if (waitAfter) await pause(waitAfter)
  }
}

async function confirmSelfTest(report, client, target) {
  heading(`Self-test for "${target.name}"`)
  line('It sounds the siren for several seconds, and alarms interconnected with it may sound too.')
  line('Warn anyone nearby before you continue.')
  const answer = await promptLine('  Type TEST to start it, or press Enter to skip: ')
  if (answer.trim() !== 'TEST') {
    line('Skipped.')
    report.selfTest = { device: target.id, skipped: true }
    return false
  }
  const started = performance.now()
  try {
    await client.sendCommand(target.location.id, target.id, 'test')
    report.selfTest = { device: target.id, sent: true, ms: Math.round(performance.now() - started) }
    line('Kidde accepted the test command. Watching for what changes...')
    return true
  } catch (error) {
    report.selfTest = { device: target.id, sent: false, error: describeError(error) }
    line(`FAILED: ${describeError(error)}`)
    flag(`The test command failed: ${describeError(error)}`)
    return false
  }
}

async function watch(report, client, sessionEvents, account, { minutes, focusId }) {
  const devicesById = new Map(account.devices.map((d) => [d.id, d]))
  const previous = new Map(account.devices.map((d) => [d.id, d.doc]))
  /** Devices Kidde stopped listing while watching */
  const gone = new Set()
  const events = []
  const sessionEventsBefore = sessionEvents.length
  let polls = 0
  let failures = 0
  const started = performance.now()
  const end = started + minutes * 60_000
  const fast = focusId !== undefined
  heading(
    `Watching for ${minutes} minute(s), polling every ${intervalMs / 1000}s` +
      `${fast ? ` (every ${FAST_POLL_MS / 1000}s for the first ${FAST_POLL_WINDOW_MS / 1000}s)` : ''}. Ctrl+C stops early.`,
  )
  watching = true
  try {
    while (!stopRequested) {
      const elapsed = performance.now() - started
      const wait = fast && elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : intervalMs
      if (elapsed + wait > end - started) break
      await pause(wait)
      if (stopRequested) break
      polls++
      for (const location of account.locations) {
        let docs
        try {
          docs = await client.getDevices(location.id)
        } catch (error) {
          failures++
          events.push({ at: new Date().toISOString(), location: `Location ${location.id}`, error: describeError(error) })
          line(`[${clockTime()}] Could not read ${location.name}: ${describeError(error)}`)
          continue
        }
        const idsNow = new Set(docs.map((doc) => types.idOf(doc?.id)).filter(Boolean))
        for (const [id, known] of devicesById) {
          if (known.location.id !== location.id || idsNow.has(id) || gone.has(id)) continue
          gone.add(id)
          events.push({ at: new Date().toISOString(), device: id, disappeared: true })
          line(`[${clockTime()}] ${known.name} (id ${id}) is no longer listed by Kidde`)
        }
        for (const doc of docs) {
          const id = types.idOf(doc?.id)
          if (!id) continue
          const before = previous.get(id)
          previous.set(id, doc)
          const name = devicesById.get(id)?.name ?? (typeof doc.label === 'string' ? doc.label : `Device ${id}`)
          if (!devicesById.has(id)) devicesById.set(id, { id, doc, location, name })
          if (gone.delete(id)) {
            events.push({ at: new Date().toISOString(), device: id, reappeared: true })
            line(`[${clockTime()}] ${name} (id ${id}) is listed by Kidde again`)
          }
          if (!before) {
            const serial = typeof doc.serial_number === 'string' ? `, serial ${shortenSerial(doc.serial_number)}` : ''
            events.push({ at: new Date().toISOString(), device: id, appeared: true, serial: serial ? shortenSerial(doc.serial_number) : null })
            line(`[${clockTime()}] New device: ${name} (id ${id}${serial})`)
            continue
          }
          const changes = []
          for (const key of new Set([...Object.keys(before), ...Object.keys(doc)])) {
            if (JSON.stringify(before[key]) !== JSON.stringify(doc[key])) {
              changes.push({ key, from: before[key], to: doc[key] })
            }
          }
          if (!changes.length) continue
          const homeKitBefore = homeKitSummary(before)
          const homeKitNow = homeKitSummary(doc)
          events.push({
            at: new Date().toISOString(),
            device: id,
            changes: changes.map((c) => ({ key: c.key, from: redact(c.from, c.key), to: redact(c.to, c.key) })),
            homeKit: homeKitBefore === homeKitNow ? undefined : { from: homeKitBefore, to: homeKitNow },
          })
          for (const c of changes) {
            if (QUIET_KEYS.test(c.key)) continue
            line(`[${clockTime()}] ${name}: ${c.key} ${display(redact(c.from, c.key))} -> ${display(redact(c.to, c.key))}`)
          }
          if (homeKitBefore !== homeKitNow) line(`[${clockTime()}] ${name} in HomeKit: ${homeKitNow}`)
        }
      }
    }
  } finally {
    watching = false
  }
  const newSessionEvents = sessionEvents.slice(sessionEventsBefore)
  report.watch = {
    minutesPlanned: minutes,
    secondsWatched: Math.round((performance.now() - started) / 1000),
    polls,
    failures,
    events,
    sessionEvents: newSessionEvents,
  }
  line(`${polls} poll(s), ${failures} failure(s), ${events.length} change(s).`)
  for (const e of newSessionEvents) {
    if (e.change === 'login') line(`Kidde ended the session at ${e.at}; the plugin's client signed in again on its own.`)
  }
  if (newSessionEvents.some((e) => e.change === 'refresh')) {
    line('Kidde refreshed the session cookie while watching.')
  }

  if (focusId !== undefined) {
    const mine = events.filter((e) => e.device === focusId && e.changes)
    const alarmKeys = new Set([...types.SMOKE_FIELDS, ...types.CO_FIELDS])
    const wentTrue = mine.flatMap((e) =>
      e.changes.filter((c) => alarmKeys.has(c.key) && types.readAlarmField(c.to) === true).map((c) => c.key),
    )
    const tested = mine.some((e) => e.changes.some((c) => c.key === 'last_test_time'))
    const changedKeys = [...new Set(mine.flatMap((e) => e.changes.map((c) => c.key)))]
    report.selfTest = { ...report.selfTest, observed: { alarmFieldsTrue: [...new Set(wentTrue)], lastTestTimeChanged: tested, changedKeys } }
    heading('Self-test result')
    if (wentTrue.length) {
      line(`Kidde reported ${[...new Set(wentTrue)].join(', ')} during the test, so HomeKit would show an alarm for every self-test.`)
      flag(`A self-test set ${[...new Set(wentTrue)].join(', ')}: HomeKit raises an alarm during tests.`)
    } else {
      line('No alarm field went true, so HomeKit stays quiet during a self-test.')
    }
    line(tested ? 'last_test_time changed, so the plugin logs that a self-test completed.' : 'last_test_time did not change while watching.')
    line(`Fields that changed: ${changedKeys.length ? changedKeys.join(', ') : 'none'}`)
  }
}

async function main() {
  console.log('Kidde account probe')
  console.log('')
  console.log("This signs in to Kidde once, reads your locations and alarms, and runs the plugin's own code on them.")
  console.log(
    args.locate || args['self-test']
      ? 'It also sends the commands you asked for (asking first for a self-test).'
      : 'It changes nothing on your account or your alarms.',
  )
  console.log('The Kidde app may show that a new device signed in.\n')

  const email = (args.email ?? (await promptLine('Kidde email: '))).trim()
  const password = await promptLine('Kidde password (hidden): ', { hidden: true })
  if (!email || !password) {
    console.error('An email and a password are needed.')
    process.exit(2)
  }
  process.on('SIGINT', onInterrupt)

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const report = {
    probe: {
      plugin: `${pkg.name} ${pkg.version}`,
      node: process.version,
      platform: process.platform,
      started: new Date().toISOString(),
      api: base === KIDDE_API_BASE ? 'Kidde' : 'local test server',
      options: { watchMinutes, intervalSeconds: intervalMs / 1000, locate: Boolean(args.locate), selfTest: Boolean(args['self-test']) },
    },
  }
  activeReport = report

  let exitCode = 0
  try {
    const session = await signIn(report, email, password)
    const account = await readAccount(report, session)
    const smokeAlarms = account.devices.filter((d) => types.detectKinds(d.doc).smoke)

    const pick = (option) => {
      const id = args[option]
      if (id === undefined) return undefined
      const target = account.devices.find((d) => d.id === String(id).trim())
      if (!target) {
        flag(`--${option} ${id} matches no device on this account; nothing was sent.`)
        return null
      }
      if (!types.detectKinds(target.doc).smoke) {
        flag(`--${option} ${id} is not a smoke alarm; nothing was sent.`)
        return null
      }
      return target
    }
    const locateTarget = pick('locate')
    const testTarget = pick('self-test')

    await authChecks(report, session)
    const { client, events } = await pluginClientCheck(report, email, password, session, smokeAlarms.length)
    await homeKitPreview(report, email, password, client.currentSession ?? session, account.locations)

    if (locateTarget) await locate(report, client, locateTarget)
    let focusId
    if (testTarget && (await confirmSelfTest(report, client, testTarget))) focusId = testTarget.id
    const minutes = focusId !== undefined && !watchGiven ? SELF_TEST_DEFAULT_MINUTES : watchMinutes
    if (minutes > 0 && !stopRequested) await watch(report, client, events, account, { minutes, focusId })
    client.close()
  } catch (error) {
    exitCode = 1
    report.stopped = describeError(error)
    console.error(`\n${error instanceof ProbeStop ? error.message : `The probe hit an unexpected error: ${error?.stack ?? describeError(error)}`}`)
  } finally {
    cleanUpTemp()
  }

  if (attention.length) heading('Worth a look:')
  else if (exitCode === 0) heading('Nothing unexpected.')
  for (const item of attention) line(`- ${item}`)
  const path = finishReport(report, exitCode)
  const shown = path.startsWith(`${process.cwd()}/`) ? relative(process.cwd(), path) : path
  heading(`Report: ${shown}`)
  line('It holds no password, cookie, token or email address; serial numbers are shortened and')
  line('location names removed. Alarm names are kept. Read it before sharing it.')
  process.exit(exitCode)
}

await main()
