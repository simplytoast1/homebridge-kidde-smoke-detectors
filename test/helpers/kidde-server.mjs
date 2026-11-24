/**
 * A fake Kidde HomeSafe API, as a drop-in replacement for global fetch.
 *
 * Behaves like the real service in the ways the plugin depends on: a login
 * sets a session cookie (and returns an access token), every other request
 * needs a live session, an ended session answers 401, and bad credentials
 * answer 403. Tests change the state on the returned object to simulate
 * alarms, outages, expired sessions and unusual server behavior.
 */

export function createKiddeServer({ email, password }) {
  const server = {
    email,
    password,
    /** [{ id, name }] */
    locations: [{ id: 1, name: 'Home' }],
    /** location id (string) -> device documents */
    devices: { 1: [] },
    /** Session cookie values Kidde currently accepts */
    sessions: new Set(),
    seq: 0,
    logins: 0,
    requests: [],
    commands: [],
    /** When true, every request fails as if the network were down */
    networkDown: false,
    /** When set, POST /auth/login answers this status instead of signing in */
    loginStatus: null,
    /** Extra headers on that failed login answer, e.g. [['retry-after', '1800']] */
    loginHeaders: [],
    /** When true, a login succeeds but the session it returns is never accepted */
    uselessSessions: false,
    /** When true, GET /location answers 500 */
    failLocations: false,
    /** Location ids whose device list answers 503 */
    failDevices: new Set(),
    /** Location ids whose device list answers 404, as real Kidde does for a location the account cannot read */
    missingDevices: new Set(),
    /** Location ids whose device list answers 403 although the session is fine */
    forbiddenDevices: new Set(),
    /** Commands answered 403 although the session is fine */
    forbiddenCommands: new Set(),
    /** 'clear': a 401 also clears the session cookie, as many servers do */
    cookieOn401: null,
    /** When true, every response sets a new load-balancer cookie */
    rotatingCookie: false,
    rotation: 0,
    /** Delay before answering device-list requests (aborts are honored) */
    delayMs: 0,
    /** Delay before answering commands (aborts are honored) */
    commandDelayMs: 0,
    /** Requests that were aborted by the plugin */
    aborted: 0,

    /** End every session, as Kidde does on its own schedule */
    expireSessions() {
      server.sessions.clear()
    },

    respond(body, status = 200, headers = []) {
      const all = [['content-type', 'application/json'], ...headers]
      if (server.rotatingCookie) all.push(['set-cookie', `AWSALB=r${++server.rotation}; Path=/`])
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: all })
    },

    async wait(ms, signal) {
      if (!ms) return
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          server.aborted++
          reject(signal.reason ?? new Error('aborted'))
        })
      })
    },

    async fetch(url, init = {}) {
      const u = new URL(String(url))
      const path = u.pathname.replace(/^\/api\/v4/, '')
      const method = init.method ?? 'GET'
      const headers = init.headers ?? {}
      server.requests.push({ method, path, headers, redirect: init.redirect })
      if (server.networkDown) {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
      }

      if (path === '/auth/login' && method === 'POST') {
        server.logins++
        if (server.loginStatus) {
          return server.respond({ message: 'error' }, server.loginStatus, server.loginHeaders)
        }
        const body = JSON.parse(init.body)
        if (body.email !== server.email || body.password !== server.password) {
          return server.respond({ message: 'Invalid credentials' }, 403)
        }
        const token = `s${++server.seq}`
        if (!server.uselessSessions) server.sessions.add(token)
        return server.respond({ access_token: `at-${token}` }, 200, [
          ['set-cookie', `session=${token}; Path=/; HttpOnly; Secure`],
        ])
      }

      const cookie = headers.cookie ?? ''
      const match = /(?:^|;\s*)session=([^;]+)/.exec(cookie)
      if (!match || !server.sessions.has(match[1])) {
        const extra = server.cookieOn401 === 'clear' ? [['set-cookie', 'session=; Max-Age=0; Path=/']] : []
        return server.respond({ message: 'Unauthorized' }, 401, extra)
      }

      if (path === '/location' && method === 'GET') {
        if (server.failLocations) return server.respond({ message: 'error' }, 500)
        return server.respond(server.locations)
      }
      let m = /^\/location\/([^/]+)\/device$/.exec(path)
      if (m && method === 'GET') {
        await server.wait(server.delayMs, init.signal)
        if (server.missingDevices.has(m[1])) return server.respond({ message: 'Not found' }, 404)
        if (server.forbiddenDevices.has(m[1])) return server.respond({ message: 'Forbidden' }, 403)
        if (server.failDevices.has(m[1])) return server.respond({ message: 'unavailable' }, 503)
        return server.respond(server.devices[m[1]] ?? [])
      }
      m = /^\/location\/([^/]+)\/device\/([^/]+)\/([a-z]+)$/.exec(path)
      if (m && method === 'POST') {
        await server.wait(server.commandDelayMs, init.signal)
        if (server.forbiddenCommands.has(m[3])) return server.respond({ message: 'Forbidden' }, 403)
        server.commands.push({ location: m[1], device: m[2], command: m[3] })
        return server.respond(null, 204)
      }
      return server.respond({ message: 'Not found' }, 404)
    },
  }
  return server
}
