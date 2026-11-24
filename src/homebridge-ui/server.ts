/**
 * Homebridge settings page server.
 *
 * Every option is edited in the standard Homebridge settings form generated
 * from config.schema.json. This server only backs the small helper panel
 * shown above that form:
 *
 *   /devices  The alarms and locations the running plugin last found, read
 *             from its cache. Never contacts Kidde.
 *   /scan     Sign in with the email and password from the form, and list
 *             the account's locations and smoke alarms. Proves the
 *             credentials work and refreshes the cache.
 *
 * Neither endpoint changes config.json; the form remains the one editor.
 * The password is used for the one sign-in and is never logged or written
 * anywhere by this server. The session the sign-in creates is saved (owner
 * only) so the plugin can start with it instead of signing in again.
 */

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'
import { KiddeApiError, KiddeAuthError, KiddeClient } from '../kidde-api/client.js'
import { readDeviceCache, writeDeviceCache } from '../kidde-api/device-cache.js'
import { saveSession } from '../kidde-api/session-store.js'
import { describeError } from '../util.js'
import { scanAccount } from './scan.js'

const MAX_EMAIL_LENGTH = 254
const MAX_PASSWORD_LENGTH = 1024
/** After a rejected sign-in, wait this long before trying Kidde again */
const REJECTED_LOGIN_COOLDOWN_MS = 5000

interface ScanRequest {
  email?: unknown
  password?: unknown
}

class KiddeSettingsServer extends HomebridgePluginUiServer {
  private scanInFlight = false
  private lastRejectionAt = 0

  constructor() {
    super()
    this.onRequest('/devices', () => this.cachedDevices())
    this.onRequest('/scan', (payload: ScanRequest) => this.scan(payload))
    this.ready()
  }

  private async cachedDevices() {
    const storagePath = this.homebridgeStoragePath
    if (!storagePath) return { devices: [], locations: [], updatedAt: 0 }
    return readDeviceCache(storagePath)
  }

  private async scan(payload: ScanRequest) {
    const email = typeof payload?.email === 'string' ? payload.email.trim() : ''
    const password = typeof payload?.password === 'string' ? payload.password : ''
    if (!email || !password) {
      throw new RequestError('Enter your Kidde email and password first.', { status: 400 })
    }
    if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new RequestError('That email or password is too long.', { status: 400 })
    }
    if (this.scanInFlight) {
      throw new RequestError('A sign-in is already in progress.', { status: 409 })
    }
    if (Date.now() - this.lastRejectionAt < REJECTED_LOGIN_COOLDOWN_MS) {
      throw new RequestError('Please wait a few seconds before trying again.', { status: 429 })
    }

    this.scanInFlight = true
    try {
      const client = new KiddeClient({ email, password })
      await client.login()
      const result = await scanAccount(client)

      const storagePath = this.homebridgeStoragePath
      if (storagePath) {
        await saveSession(storagePath, email, client.currentSession).catch(() => {})
        await writeDeviceCache(storagePath, result.devices, result.locations).catch(() => {})
      }
      return result
    } catch (error) {
      if (error instanceof KiddeAuthError) {
        this.lastRejectionAt = Date.now()
        throw new RequestError('Kidde rejected that email or password.', { status: 401 })
      }
      if (error instanceof KiddeApiError) {
        throw new RequestError(error.message, { status: 502 })
      }
      throw new RequestError(`Something went wrong: ${describeError(error)}`, { status: 500 })
    } finally {
      this.scanInFlight = false
    }
  }
}

new KiddeSettingsServer()
