/**
 * Per-session teams: one session may run the writing crew, another the research
 * crew. Absent an assignment a session sees the whole roster, so existing
 * setups keep working after upgrading.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Coerce saved data into `{ [sessionId]: string[] }`.
 * @param raw - parsed JSON or anything.
 * @returns a clean map.
 */
export function normalizeTeams(raw) {
  const map = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return map
  for (const [sessionId, bots] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || !Array.isArray(bots)) continue
    const list = bots.filter((id) => typeof id === 'string' && id !== '')
    if (list.length > 0) map[sessionId] = [...new Set(list)]
  }
  return map
}

/**
 * Load the assignment file.
 * @param root - package directory.
 */
export async function loadTeams(root) {
  const file = join(root, '.state', 'teams.json')
  try {
    return normalizeTeams(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Persist the assignment file.
 * @param root - package directory.
 * @param teams - map to save.
 */
export async function saveTeams(root, teams) {
  const normalized = normalizeTeams(teams)
  const file = join(root, '.state', 'teams.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

/**
 * Which bots a session may use. No assignment means the whole roster.
 * @param teams - current map.
 * @param sessionId - session id.
 * @param allIds - every roster id.
 */
export function botsForSession(teams, sessionId, allIds) {
  const assigned = teams?.[String(sessionId ?? '')]
  if (!Array.isArray(assigned) || assigned.length === 0) return [...allIds]
  return allIds.filter((id) => assigned.includes(id))
}

/**
 * Update one session's assignment.
 * @param teams - current map.
 * @param sessionId - session id.
 * @param bots - bot ids, or an empty list to fall back to the whole roster.
 */
export function setSessionTeam(teams, sessionId, bots) {
  const next = { ...teams }
  const id = String(sessionId ?? '').trim()
  if (id === '') return next
  const list = Array.isArray(bots) ? bots.filter((entry) => typeof entry === 'string' && entry !== '') : []
  if (list.length === 0) delete next[id]
  else next[id] = [...new Set(list)]
  return next
}

/**
 * Who the session's team **explicitly** lists. An unset team means nobody is
 * listed yet — that is different from "everyone is usable", which is what
 * dispatch gating cares about.
 * @param teams - current map.
 * @param sessionId - session id.
 */
export function explicitTeamBots(teams, sessionId) {
  const assigned = teams?.[String(sessionId ?? '')]
  return new Set(Array.isArray(assigned) ? assigned : [])
}

/**
 * Put a bot into the session's action group (idempotent).
 * @param teams - current map.
 * @param sessionId - session id.
 * @param botId - bot id.
 */
export function addActionBot(teams, sessionId, botId) {
  const id = String(sessionId ?? '').trim()
  const bot = String(botId ?? '').trim()
  if (id === '' || bot === '') return { ...(teams ?? {}) }
  const next = { ...(teams ?? {}) }
  const current = Array.isArray(next[id]) ? next[id] : []
  if (current.includes(bot)) return next
  next[id] = [...current, bot]
  return next
}
