/**
 * Growth integrity: a per-install HMAC over a bot's growth record.
 *
 * The roster is plain JSON on disk, so a user (or an agent told to "make me a
 * level 90 bot") can edit `growth.totalXp` directly. A signature stored next
 * to the record makes casual edits visible: `loadBots` resets a record whose
 * signature no longer matches.
 *
 * This is a local deterrent, not a security boundary: anyone who can read
 * `.state/integrity.key` can sign their own edits. It stops the "just ask the
 * agent to change my level" case, not a determined local attacker.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SECRET_FILE = 'integrity.key'
const STATE_FILE = 'integrity.json'
const cache = new Map()

/**
 * A stable JSON representation: object keys sorted at every level, so
 * reordering keys in the file does not look like tampering.
 * @param value - JSON value.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Load (or create once) the per-install signing key.
 * @param root - package directory.
 * @returns hex key.
 */
async function loadSecret(root) {
  const key = String(root)
  if (cache.has(key)) return cache.get(key)
  const task = (async () => {
    const dir = join(root, '.state')
    const file = join(dir, SECRET_FILE)
    try {
      const existing = (await readFile(file, 'utf8')).trim()
      if (existing.length >= 32) return existing
    } catch {
      // create below
    }
    await mkdir(dir, { recursive: true })
    const secret = randomBytes(32).toString('hex')
    await writeFile(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600 })
    return secret
  })()
  cache.set(key, task)
  return task
}

/**
 * Sign one growth record.
 * @param root - package directory.
 * @param botId - bot id.
 * @param growth - normalized growth record.
 */
export async function signGrowth(root, botId, growth) {
  const secret = await loadSecret(root)
  const sig = createHmac('sha256', secret).update(`${botId}\n${canonical(growth)}`).digest('hex')
  return { v: 1, sig }
}

/**
 * Does the stored signature match this growth record?
 * @param root - package directory.
 * @param botId - bot id.
 * @param growth - growth record read from disk.
 * @param integrity - `{ v, sig }` stored beside it.
 */
export async function verifyGrowth(root, botId, growth, integrity) {
  if (!integrity || integrity.v !== 1 || typeof integrity.sig !== 'string') return false
  const expected = await signGrowth(root, botId, growth)
  const left = Buffer.from(expected.sig, 'hex')
  const right = Buffer.from(integrity.sig, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Read the one-time migration marker.
 * @param root - package directory.
 */
async function readState(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, '.state', STATE_FILE), 'utf8'))
    return {
      version: 1,
      migrated: Array.isArray(parsed?.migrated) ? parsed.migrated.map(String) : [],
    }
  } catch {
    return { version: 1, migrated: [] }
  }
}

/**
 * Was this bot's record already signed at least once?
 * @param root - package directory.
 * @param botId - bot id.
 */
export async function isMigrated(root, botId) {
  const state = await readState(root)
  return state.migrated.includes(String(botId))
}

/**
 * Mark a bot as signed, so a later missing signature is treated as tampering
 * rather than as a legacy record.
 * @param root - package directory.
 * @param botId - bot id.
 */
export async function markMigrated(root, botId) {
  const state = await readState(root)
  const id = String(botId)
  if (state.migrated.includes(id)) return
  state.migrated.push(id)
  await mkdir(join(root, '.state'), { recursive: true })
  await writeFile(join(root, '.state', STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
