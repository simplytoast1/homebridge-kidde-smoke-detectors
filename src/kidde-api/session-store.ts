/**
 * Kidde session persistence.
 *
 * Signing in to Kidde is not free: each login is a sign-in on the owner's
 * account (the Kidde app may even announce it), and Kidde may throttle an
 * account that signs in too often. So the session from the last login is
 * kept in the Homebridge storage directory and reused after a restart, and
 * the plugin only signs in again when Kidde ends that session.
 *
 * The file holds a live credential, so it is written owner-only (0600) and
 * atomically (temp file, then rename). It is bound to the account it was
 * created for through a hash of the email address, so changing the email
 * in the settings never reuses another account's session. The email itself
 * is not stored here.
 */

import { createHash } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KiddeSession } from './client.js'

export const SESSION_FILE = 'kidde-smoke-detectors.session.json'

function accountKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function sessionPath(storagePath: string): string {
  return join(storagePath, SESSION_FILE)
}

function isSession(value: unknown): value is KiddeSession {
  if (!value || typeof value !== 'object') return false
  const s = value as KiddeSession
  if (!s.cookies || typeof s.cookies !== 'object' || Array.isArray(s.cookies)) return false
  if (!Object.values(s.cookies).every((v) => typeof v === 'string')) return false
  if (s.accessToken !== undefined && typeof s.accessToken !== 'string') return false
  return typeof s.createdAt === 'number' && Number.isFinite(s.createdAt)
}

/** The saved session for this account, or undefined if there is none or it is unusable. */
export async function loadSession(
  storagePath: string,
  email: string,
): Promise<KiddeSession | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(storagePath), 'utf-8'))
    if (parsed?.account !== accountKey(email) || !isSession(parsed.session)) return undefined
    const { cookies, accessToken, createdAt } = parsed.session as KiddeSession
    return { cookies: { ...cookies }, accessToken, createdAt }
  } catch {
    return undefined
  }
}

let writeSeq = 0

/** Save (or with undefined, delete) the session for this account. */
export async function saveSession(
  storagePath: string,
  email: string,
  session: KiddeSession | undefined,
): Promise<void> {
  const finalPath = sessionPath(storagePath)
  if (!session) {
    await unlink(finalPath).catch(() => {})
    return
  }
  const tmpPath = `${finalPath}.${process.pid}.${writeSeq++}.tmp`
  const body = JSON.stringify({ version: 1, account: accountKey(email), session })
  await writeFile(tmpPath, body, { encoding: 'utf-8', mode: 0o600 })
  try {
    await rename(tmpPath, finalPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}
