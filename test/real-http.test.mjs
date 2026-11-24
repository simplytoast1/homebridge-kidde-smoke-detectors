/**
 * The Kidde client against a real HTTP server on the loopback interface.
 *
 * Every other test replaces global fetch with a fake Kidde. These use the
 * real fetch, so they cover what a fake cannot: real cookies and headers on
 * the wire, a real connection that stops answering, a body that stalls part
 * way, real redirects, and a real oversized download.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { KiddeClient } from '../dist/kidde-api/client.js'

const EMAIL = 'owner@example.com'
const PASSWORD = 'correct horse'

/** A small stand-in for Kidde, speaking real HTTP. `state.mode` picks how the device list behaves. */
async function startKidde(t) {
  const state = { mode: 'ok', loginMode: 'ok', logins: 0, elsewhere: 0, seen: [], commands: [] }
  const server = createServer(async (req, res) => {
    const path = req.url.replace(/^\/api\/v4/, '')
    state.seen.push({ method: req.method, path, cookie: req.headers.cookie, token: req.headers['homeboy-auth'] })
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    const base = `http://127.0.0.1:${server.address().port}/api/v4`

    if (path === '/elsewhere') {
      state.elsewhere++
      return json(200, [])
    }
    if (path === '/auth/login' && req.method === 'POST') {
      state.logins++
      let raw = ''
      for await (const chunk of req) raw += chunk
      if (state.loginMode === 'redirect') return json(307, undefined, { location: `${base}/elsewhere` })
      const { email, password } = JSON.parse(raw)
      if (email !== EMAIL || password !== PASSWORD) return json(403, { message: 'Invalid credentials' })
      return json(200, { access_token: 'tok-1' }, { 'set-cookie': ['session=abc; Path=/; HttpOnly', 'lb=1; Path=/'] })
    }
    if (!/(?:^|;\s*)session=abc(?:;|$)/.test(req.headers.cookie ?? '') || req.headers['homeboy-auth'] !== 'tok-1') {
      return json(401, { message: 'Unauthorized' })
    }
    if (path === '/location') return json(200, [{ id: 1, name: 'Home' }])
    if (path === '/location/1/device') {
      switch (state.mode) {
        case 'silent':
          return // never answers
        case 'stalled-body':
          res.writeHead(200, { 'content-type': 'application/json' })
          res.write('[{"id": 101, "label": "Kit')
          return // headers and half a body, then nothing
        case 'redirect':
          return json(307, undefined, { location: `${base}/elsewhere` })
        case 'huge': {
          res.writeHead(200, { 'content-type': 'application/json' })
          const chunk = Buffer.alloc(256 * 1024, 0x20)
          for (let i = 0; i < 32 && !res.destroyed; i++) {
            if (!res.write(chunk)) await once(res, 'drain').catch(() => {})
          }
          return res.end('[]')
        }
        default:
          return json(200, [{ id: 101, label: 'Kitchen', capabilities: ['smoke', 'co'] }])
      }
    }
    const command = /^\/location\/1\/device\/101\/([a-z]+)$/.exec(path)
    if (command && req.method === 'POST') {
      state.commands.push(command[1])
      res.writeHead(204)
      return res.end()
    }
    return json(404, { message: 'Not found' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  state.baseUrl = `http://127.0.0.1:${server.address().port}/api/v4`
  return state
}

test('over real HTTP: sign in once, replay the cookies and token, list alarms, send a command', async (t) => {
  const kidde = await startKidde(t)
  const sessions = []
  const client = new KiddeClient({
    email: EMAIL,
    password: PASSWORD,
    baseUrl: kidde.baseUrl,
    onSessionChange: (session, change) => sessions.push(change),
  })

  assert.deepEqual((await client.getLocations()).map((l) => l.name), ['Home'])
  assert.deepEqual((await client.getDevices('1')).map((d) => d.label), ['Kitchen'])
  await client.sendCommand('1', '101', 'hush')

  assert.equal(kidde.logins, 1)
  assert.deepEqual(kidde.commands, ['hush'])
  assert.deepEqual(sessions, ['login'])
  const afterLogin = kidde.seen.filter((r) => r.path !== '/auth/login')
  assert.ok(afterLogin.length === 3 && afterLogin.every((r) => r.cookie === 'session=abc; lb=1' && r.token === 'tok-1'))
})

test('over real HTTP: a rejected password is an auth error, and nothing else is requested', async (t) => {
  const kidde = await startKidde(t)
  const client = new KiddeClient({ email: EMAIL, password: 'wrong', baseUrl: kidde.baseUrl })
  await assert.rejects(client.getLocations(), { name: 'KiddeAuthError', message: /rejected the email or password \(HTTP 403\)/ })
  assert.deepEqual(kidde.seen.map((r) => r.path), ['/auth/login'])
})

test('over real HTTP: a server that stops answering is cut off at the deadline, and the client carries on', async (t) => {
  const kidde = await startKidde(t)
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD, baseUrl: kidde.baseUrl, timeoutMs: 150 })
  await client.getLocations()

  kidde.mode = 'silent'
  let started = performance.now()
  await assert.rejects(client.getDevices('1'), /Could not reach Kidde for the device list: the request timed out/)
  assert.ok(performance.now() - started < 1500)

  // Headers arrive, then the body stalls: still one deadline for the whole exchange
  kidde.mode = 'stalled-body'
  started = performance.now()
  await assert.rejects(client.getDevices('1'), /Could not read Kidde's answer for the device list: the request timed out/)
  assert.ok(performance.now() - started < 1500)

  kidde.mode = 'ok'
  assert.equal((await client.getDevices('1')).length, 1)
  assert.equal(kidde.logins, 1, 'a slow answer is not a reason to sign in again')
})

test('over real HTTP: redirects are never followed, for requests or for the sign-in', async (t) => {
  const kidde = await startKidde(t)
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD, baseUrl: kidde.baseUrl })
  await client.getLocations()
  kidde.mode = 'redirect'
  await assert.rejects(client.getDevices('1'), /Kidde redirected the device list; refusing to follow/)

  kidde.loginMode = 'redirect'
  const fresh = new KiddeClient({ email: EMAIL, password: PASSWORD, baseUrl: kidde.baseUrl })
  await assert.rejects(fresh.getLocations(), /Kidde sign-in failed \(HTTP 307\)/)
  assert.equal(kidde.elsewhere, 0, 'neither the request nor the password went to the redirect target')
})

test('over real HTTP: an oversized answer is cut off', async (t) => {
  const kidde = await startKidde(t)
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD, baseUrl: kidde.baseUrl })
  await client.getLocations()
  kidde.mode = 'huge'
  await assert.rejects(client.getDevices('1'), /the answer was too large/)
  kidde.mode = 'ok'
  assert.equal((await client.getDevices('1')).length, 1)
})

test('over real HTTP: closing the client ends a request that is waiting on Kidde', async (t) => {
  const kidde = await startKidde(t)
  const client = new KiddeClient({ email: EMAIL, password: PASSWORD, baseUrl: kidde.baseUrl })
  await client.getLocations()
  kidde.mode = 'silent'
  const pending = client.getDevices('1')
  const settled = assert.rejects(pending, /shutting down/)
  setTimeout(() => client.close(), 50)
  const started = performance.now()
  await settled
  assert.ok(performance.now() - started < 1500, 'ended by close, not by the 20 second deadline')
})
