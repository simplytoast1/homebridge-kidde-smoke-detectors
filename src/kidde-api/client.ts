/**
 * Kidde HomeSafe API client.
 *
 * The API is the private one the Kidde app uses:
 *
 *   POST /auth/login                                   email + password
 *   GET  /location                                     locations (homes)
 *   GET  /location/{location}/device                   devices and their state
 *   POST /location/{location}/device/{device}/{cmd}    identify, test, hush
 *
 * AUTH is a cookie session. A login returns session cookies (and, on
 * current API versions, an access token as well, which is sent back in the
 * homeboy-auth header). Both are replayed on every request. Kidde ends
 * sessions on its own schedule, and then answers 401 or 403.
 *
 * TELLING REFUSALS APART: a 401 or 403 does not always mean the session
 * ended. Kidde may refuse one resource (a location the account cannot
 * read, a Hush the alarm will not accept) while the session is fine.
 * Signing in again for those would never help and would hammer the
 * account. So a refusal on anything except the account-level location
 * list is checked with one probe of that list: if the probe works, the
 * session is alive and only that request failed. Only a refused location
 * list (directly or as the probe) ends the session and leads to a new
 * sign-in.
 *
 * LOGIN SAFETY: every login is a sign-in on the owner's real account, and
 * Kidde may throttle or lock an account that keeps failing. So logins are
 * single-flight (concurrent callers share one attempt), and failures back
 * off exponentially (1 minute doubling to 1 hour). A failure is a rejected
 * password, or a new session that Kidde refuses before it ever worked. The
 * count only resets once a request actually succeeds, so a sign-in that
 * "works" but yields a useless session still backs off. A server error
 * during sign-in (HTTP 5xx) is Kidde having trouble, not the account being
 * refused, so it backs off only to 5 minutes and the plugin recovers soon
 * after Kidde does. A Retry-After from Kidde is honored (up to the hour).
 *
 * SESSIONS are tracked by generation (one per login), never by object
 * identity, because cookie refreshes replace the session object. Cookies
 * are only taken from successful responses: a server commonly clears its
 * cookie on the 401 itself, and applying that would hide the expiry.
 *
 * REDIRECTS are refused, never followed: a followed 307/308 would resend the
 * login body (the email and password) to whatever host the redirect names.
 *
 * TIME is measured on the monotonic clock (clock.ts), so a wall clock step
 * cannot shorten or extend a backoff.
 *
 * DEADLINES: every exchange, headers and body together, runs under one
 * timer on a controller that lives only as long as that request. The
 * shutdown signal is attached with a listener that is removed when the
 * request ends. AbortSignal.any() over the long-lived shutdown signal is
 * deliberately not used: on Node 24 every combined signal stays reachable
 * from the long-lived one after its request is over, which leaks memory on
 * every poll for as long as Homebridge runs.
 *
 * fetch is looked up from globalThis on every call (not captured at import)
 * so the test suite can stand in for Kidde.
 */

import { monotonicNow } from '../clock.js'
import { describeError } from '../util.js'
import { idOf, type KiddeCommand, type KiddeDevice, type KiddeLocation } from './types.js'

export const KIDDE_API_BASE = 'https://api.homesafe.kidde.com/api/v4'

const REQUEST_TIMEOUT_MS = 20_000
const LOGIN_BACKOFF_BASE_MS = 60_000
const LOGIN_BACKOFF_MAX_MS = 60 * 60_000
/** Cap while Kidde's own servers are failing (HTTP 5xx) during sign-in */
const LOGIN_OUTAGE_BACKOFF_MAX_MS = 5 * 60_000
/** Largest answer accepted. Real answers are a few kilobytes per alarm. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** Most attempts at one request (covers a re-login and a concurrent re-login) */
const MAX_ATTEMPTS = 3
const USER_AGENT = 'homebridge-kidde-smoke-detectors'
const LOCATIONS_PATH = '/location'

/**
 * Kidde will not accept the account right now: the credentials were
 * rejected, are missing, or sign-in is paused after a failure. Retrying
 * before retryAt does not help.
 */
export class KiddeAuthError extends Error {
  constructor(
    message: string,
    /** When sign-in may be tried again, on the monotonic clock (clock.ts) */
    readonly retryAt?: number,
  ) {
    super(message)
    this.name = 'KiddeAuthError'
  }
}

/** Kidde could not be reached or answered with an error. Usually transient. */
export class KiddeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'KiddeApiError'
  }
}

/** What a login produces, and what is persisted between restarts */
export interface KiddeSession {
  cookies: Record<string, string>
  accessToken?: string
  /** Wall clock time (epoch ms) of the login that created the session */
  createdAt: number
}

/** Why the session changed: a new sign-in, a cookie refresh, or it ended */
export type SessionChange = 'login' | 'refresh' | 'ended'

export interface KiddeClientOptions {
  email?: string
  password?: string
  /** A previously saved session, used before signing in again */
  session?: KiddeSession
  /** Called whenever the session is created, refreshed or dropped */
  onSessionChange?: (session: KiddeSession | undefined, change: SessionChange) => void
  baseUrl?: string
  timeoutMs?: number
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function isRefusal(status: number): boolean {
  return status === 401 || status === 403
}

/** One answer from Kidde, read to the end */
interface Answer {
  status: number
  ok: boolean
  headers: Headers
  text: string
  /** Set when the body could not be read to the end; text is then partial */
  bodyError?: unknown
}

/**
 * Read a body as text. Reading to the end also frees the connection for
 * reuse. An answer far larger than anything Kidde sends is cut off rather
 * than buffered, so a misbehaving server cannot exhaust a small machine.
 */
async function readBody(response: Response): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new KiddeApiError('the answer was too large')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/** Retry-After as milliseconds from now, when Kidde sends a usable one */
function retryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after')?.trim()
  if (!raw) return 0
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const when = Date.parse(raw)
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0
}

/**
 * Merge Set-Cookie headers into a cookie jar. Returns true if it changed.
 * Only name=value is kept; a cookie set to empty or expired is removed.
 */
export function applySetCookies(jar: Record<string, string>, headers: Headers): boolean {
  const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  let changed = false
  for (const line of lines) {
    const [pair, ...attributes] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue
    const expired = attributes.some((attr) => {
      const [key, val = ''] = attr.split('=')
      const k = key.trim().toLowerCase()
      if (k === 'max-age') return Number(val.trim()) <= 0
      if (k === 'expires') {
        const when = Date.parse(val.trim())
        return Number.isFinite(when) && when <= Date.now()
      }
      return false
    })
    if (!value || expired) {
      if (name in jar) {
        delete jar[name]
        changed = true
      }
    } else if (jar[name] !== value) {
      jar[name] = value
      changed = true
    }
  }
  return changed
}

/** Accept either a bare array or an object wrapping one under `key` */
function listFrom(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    const inner = (body as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner
  }
  throw new KiddeApiError(`Kidde returned an unexpected ${key} response.`)
}

function withId<T extends { id: unknown }>(items: unknown[]): T[] {
  return items.filter(
    (item): item is T =>
      typeof item === 'object' && item !== null && idOf((item as T).id) !== undefined,
  )
}

export class KiddeClient {
  private session: KiddeSession | undefined
  /** Increments on every login; a request remembers the generation it used */
  private generation = 0
  /** Set when this client signed in for the current generation */
  private signedInThisGeneration = false
  /** Whether any request has succeeded on the current generation */
  private generationWorked = false
  private loginInFlight: Promise<KiddeSession> | null = null
  private loginFailures = 0
  /** Monotonic time before which no login is attempted */
  private loginBlockedUntil = 0
  /** Why the last login failed, for the "paused" message */
  private lastLoginFailure = ''
  private readonly closer = new AbortController()
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly options: KiddeClientOptions) {
    this.session = options.session
    this.baseUrl = (options.baseUrl ?? KIDDE_API_BASE).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  get hasCredentials(): boolean {
    return Boolean(this.options.email && this.options.password)
  }

  /** The current session, for persistence. Treat as a secret. */
  get currentSession(): KiddeSession | undefined {
    return this.session
  }

  /** Abort every request in flight and refuse new ones (Homebridge shutdown) */
  close(): void {
    this.closer.abort()
  }

  /** Sign in now, replacing any current session. */
  async login(): Promise<void> {
    await this.ensureLogin(true)
  }

  async getLocations(): Promise<KiddeLocation[]> {
    const body = await this.request('GET', LOCATIONS_PATH, 'the location list')
    return withId<KiddeLocation>(listFrom(body, 'locations'))
  }

  async getDevices(locationId: string): Promise<KiddeDevice[]> {
    const body = await this.request(
      'GET',
      `/location/${encodeURIComponent(locationId)}/device`,
      'the device list',
    )
    return withId<KiddeDevice>(listFrom(body, 'devices'))
  }

  async sendCommand(locationId: string, deviceId: string, command: KiddeCommand): Promise<void> {
    await this.request(
      'POST',
      `/location/${encodeURIComponent(locationId)}/device/${encodeURIComponent(deviceId)}/${command}`,
      `the ${command} command`,
    )
  }

  // --- Session ---------------------------------------------------------------

  /**
   * Drop the session of the given generation, unless a newer one replaced
   * it. Returns whether this call was the one that ended it.
   */
  private endSession(generation: number): boolean {
    if (generation !== this.generation || !this.session) return false
    this.session = undefined
    this.options.onSessionChange?.(undefined, 'ended')
    return true
  }

  /** Record that a request succeeded on a generation */
  private markWorked(generation: number): void {
    if (generation !== this.generation) return
    this.generationWorked = true
    this.loginFailures = 0
  }

  /**
   * Return a usable session, signing in if there is none (or if forced).
   * Concurrent callers share a single login attempt.
   */
  private async ensureLogin(force = false): Promise<KiddeSession> {
    if (!force && this.session) return this.session
    if (!this.loginInFlight) {
      this.loginInFlight = this.performLogin().finally(() => {
        this.loginInFlight = null
      })
    }
    return this.loginInFlight
  }

  /**
   * Count a failed sign-in and pause further ones. The pause doubles with
   * every failure up to maxMs, and is never shorter than atLeastMs (a
   * Retry-After from Kidde), which itself is capped at the hour.
   */
  private recordLoginFailure(reason: string, maxMs = LOGIN_BACKOFF_MAX_MS, atLeastMs = 0): number {
    this.loginFailures++
    this.lastLoginFailure = reason
    const doubled = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (this.loginFailures - 1), maxMs)
    const backoff = Math.max(doubled, Math.min(atLeastMs, LOGIN_BACKOFF_MAX_MS))
    this.loginBlockedUntil = monotonicNow() + backoff
    return backoff
  }

  private shuttingDown(): KiddeApiError {
    return new KiddeApiError('The plugin is shutting down.')
  }

  /**
   * One HTTP exchange with Kidde, read to the end, under one deadline.
   * Rejects only if no answer arrived; a body that fails part way is
   * reported in bodyError, because the status and headers are still real.
   */
  private async exchange(
    path: string,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  ): Promise<Answer> {
    const closing = this.closer.signal
    if (closing.aborted) throw this.shuttingDown()
    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    closing.addEventListener('abort', onClose, { once: true })
    // unref: a request in flight must never hold a child bridge open on exit
    const deadline = setTimeout(
      () => controller.abort(new DOMException('The request timed out', 'TimeoutError')),
      this.timeoutMs,
    )
    deadline.unref()
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      })
      const answer: Answer = {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text: '',
      }
      try {
        answer.text = await readBody(response)
      } catch (error) {
        answer.bodyError = error
      }
      return answer
    } finally {
      clearTimeout(deadline)
      closing.removeEventListener('abort', onClose)
    }
  }

  private async performLogin(): Promise<KiddeSession> {
    const { email, password } = this.options
    if (!email || !password) {
      throw new KiddeAuthError('No Kidde email and password are configured.')
    }
    if (this.closer.signal.aborted) throw this.shuttingDown()
    const now = monotonicNow()
    if (now < this.loginBlockedUntil) {
      const seconds = Math.ceil((this.loginBlockedUntil - now) / 1000)
      const why = this.lastLoginFailure ? ` (${this.lastLoginFailure})` : ''
      throw new KiddeAuthError(
        `Signing in to Kidde is paused after a failed attempt${why}; trying again in ${seconds}s.`,
        this.loginBlockedUntil,
      )
    }

    let answer: Answer
    try {
      answer = await this.exchange('/auth/login', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ email, password }),
      })
    } catch (error) {
      if (this.closer.signal.aborted) throw this.shuttingDown()
      // Kidde was not reached, so this was not a failed sign-in on the account
      throw new KiddeApiError(`Could not reach Kidde to sign in: ${describeError(error)}`)
    }

    const { status } = answer
    if (isRefusal(status)) {
      const backoff = this.recordLoginFailure(`Kidde rejected the email or password, HTTP ${status}`)
      throw new KiddeAuthError(
        `Kidde rejected the email or password (HTTP ${status}). ` +
          `Check them in the plugin settings. Next attempt in ${Math.round(backoff / 1000)}s.`,
        this.loginBlockedUntil,
      )
    }
    if (!answer.ok || isRedirect(status)) {
      // A 5xx is Kidde's servers failing, not this account being refused
      const cap = status >= 500 ? LOGIN_OUTAGE_BACKOFF_MAX_MS : LOGIN_BACKOFF_MAX_MS
      this.recordLoginFailure(`Kidde answered HTTP ${status}`, cap, retryAfterMs(answer.headers))
      throw new KiddeApiError(`Kidde sign-in failed (HTTP ${status}).`, status)
    }

    const cookies: Record<string, string> = {}
    applySetCookies(cookies, answer.headers)
    let accessToken: string | undefined
    try {
      const body = JSON.parse(answer.text) as Record<string, unknown> | null
      const token = body?.access_token
      if (typeof token === 'string' && token) accessToken = token
    } catch {
      // A login answer without a JSON body is fine as long as it set cookies
    }
    if (Object.keys(cookies).length === 0 && !accessToken) {
      this.recordLoginFailure('Kidde returned no session')
      throw new KiddeApiError('Kidde accepted the sign-in but returned no session.')
    }

    // loginFailures is deliberately NOT reset here: only a request that
    // succeeds on this session proves the sign-in was worth anything.
    this.loginBlockedUntil = 0
    this.generation++
    this.signedInThisGeneration = true
    this.generationWorked = false
    const session: KiddeSession = { cookies, accessToken, createdAt: Date.now() }
    this.session = session
    this.options.onSessionChange?.(session, 'login')
    return session
  }

  // --- Requests --------------------------------------------------------------

  private async send(
    method: 'GET' | 'POST',
    path: string,
    session: KiddeSession,
    generation: number,
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
    }
    const cookie = Object.entries(session.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
    if (cookie) headers.cookie = cookie
    if (session.accessToken) headers['homeboy-auth'] = session.accessToken

    const answer = await this.exchange(path, { method, headers })

    // Kidde may refresh the session cookie. Only successful answers count,
    // and only for the generation the request was sent with.
    if (answer.ok && generation === this.generation && this.session) {
      const jar = { ...this.session.cookies }
      if (applySetCookies(jar, answer.headers)) {
        this.session = { ...this.session, cookies: jar }
        this.options.onSessionChange?.(this.session, 'refresh')
      }
    }
    return answer
  }

  /**
   * Whether the session still works, judged by one GET of the location list.
   * Network errors propagate: they say nothing about the session.
   */
  private async probe(session: KiddeSession, generation: number): Promise<boolean> {
    const answer = await this.send('GET', LOCATIONS_PATH, session, generation)
    if (answer.ok) {
      this.markWorked(generation)
      return true
    }
    return false
  }

  private async request(method: 'GET' | 'POST', path: string, what: string): Promise<unknown> {
    const unreachable = (error: unknown): KiddeApiError =>
      this.closer.signal.aborted
        ? this.shuttingDown()
        : new KiddeApiError(`Could not reach Kidde for ${what}: ${describeError(error)}`)

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const session = await this.ensureLogin()
      const generation = this.generation

      let answer: Answer
      try {
        answer = await this.send(method, path, session, generation)
      } catch (error) {
        throw unreachable(error)
      }
      const { status } = answer

      if (isRefusal(status)) {
        // Another request already signed in again; retry on the new session
        if (generation !== this.generation) continue

        // Refused something other than the location list: if the session
        // can still read the location list, only this request was refused.
        let alive = false
        if (path !== LOCATIONS_PATH) {
          try {
            alive = await this.probe(session, generation)
          } catch (error) {
            throw unreachable(error)
          }
        }
        if (alive) {
          throw new KiddeApiError(`Kidde refused ${what} (HTTP ${status}).`, status)
        }

        // The session itself is refused
        const brandNew = this.signedInThisGeneration && !this.generationWorked
        const ended = this.endSession(generation)
        if (brandNew) {
          // A session from a sign-in moments ago that never worked: signing
          // in again right away would only repeat it, so back off. Counted
          // once per session, however many requests were refused on it.
          if (ended) this.recordLoginFailure(`Kidde refused the new session, HTTP ${status}`)
          throw new KiddeApiError(`Kidde refused ${what} with a new session (HTTP ${status}).`, status)
        }
        if (!this.hasCredentials) {
          throw new KiddeAuthError('The Kidde session has ended. Sign in again in the plugin settings.')
        }
        continue
      }

      if (isRedirect(status)) {
        throw new KiddeApiError(`Kidde redirected ${what}; refusing to follow.`, status)
      }
      if (!answer.ok) {
        throw new KiddeApiError(`Kidde returned HTTP ${status} for ${what}.`, status)
      }

      this.markWorked(generation)
      if (answer.bodyError !== undefined) {
        if (this.closer.signal.aborted) throw this.shuttingDown()
        throw new KiddeApiError(
          `Could not read Kidde's answer for ${what}: ${describeError(answer.bodyError)}`,
        )
      }
      if (!answer.text.trim()) return undefined
      try {
        return JSON.parse(answer.text) as unknown
      } catch {
        throw new KiddeApiError(`Kidde returned an unreadable answer for ${what}.`)
      }
    }
    throw new KiddeApiError(`Kidde kept refusing ${what}.`)
  }
}
