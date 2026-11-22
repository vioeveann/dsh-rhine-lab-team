/**
 * User-created member groups.
 *
 * Built-in groups are not stored: 行动组 is whoever the session's team contains,
 * 行动预备组 is everyone without a custom group. Only the custom names live here.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,23}$/
const MAX_NAME = 20

/**
 * Coerce saved data into `[{ id, name }]`.
 * @param raw - parsed JSON or anything.
 * @returns a clean list.
 */
export function normalizeGroups(raw) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.groups) ? raw.groups : []
  const seen = new Set()
  const groups = []
  for (const entry of source) {
    const id = String(entry?.id ?? '').trim()
    const name = String(entry?.name ?? '').trim()
    if (!GROUP_ID.test(id) || name === '' || seen.has(id)) continue
    seen.add(id)
    groups.push({ id, name: name.slice(0, MAX_NAME) })
  }
  return groups
}

/**
 * Load the group list.
 * @param root - package directory.
 */
export async function loadGroups(root) {
  try {
    return normalizeGroups(JSON.parse(await readFile(join(root, '.state', 'groups.json'), 'utf8')))
  } catch {
    return []
  }
}

/**
 * Persist the group list.
 * @param root - package directory.
 * @param groups - list to save.
 */
export async function saveGroups(root, groups) {
  const clean = normalizeGroups(groups)
  const file = join(root, '.state', 'groups.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ groups: clean }, null, 2)}\n`, 'utf8')
  return clean
}

/**
 * Make an id from a name, falling back to a timestamp suffix.
 * @param name - display name.
 * @param taken - existing ids.
 */
function idFor(name, taken) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
  let id = base !== '' && GROUP_ID.test(base) ? base : `g-${Date.now().toString(36)}`
  let n = 2
  while (taken.has(id)) {
    id = `${base === '' ? 'g' : base}-${n}`
    n += 1
  }
  return id
}

/**
 * Create a group.
 * @param groups - current list.
 * @param name - display name.
 * @returns `{ ok, groups, group }` or `{ ok: false, error }`.
 */
export function createGroup(groups, name) {
  const label = String(name ?? '').trim()
  if (label === '') return { ok: false, error: '组名不能为空' }
  if (label.length > MAX_NAME) return { ok: false, error: `组名最多 ${MAX_NAME} 个字` }
  const list = normalizeGroups(groups)
  if (list.some((group) => group.name === label)) return { ok: false, error: '已经有同名的组了' }
  const group = { id: idFor(label, new Set(list.map((entry) => entry.id))), name: label }
  return { ok: true, groups: [...list, group], group }
}

/**
 * Rename a group.
 * @param groups - current list.
 * @param id - group id.
 * @param name - new display name.
 */
export function renameGroup(groups, id, name) {
  const label = String(name ?? '').trim()
  if (label === '') return { ok: false, error: '组名不能为空' }
  if (label.length > MAX_NAME) return { ok: false, error: `组名最多 ${MAX_NAME} 个字` }
  const list = normalizeGroups(groups)
  if (!list.some((group) => group.id === id)) return { ok: false, error: '没有这个组' }
  if (list.some((group) => group.id !== id && group.name === label)) return { ok: false, error: '已经有同名的组了' }
  return { ok: true, groups: list.map((group) => (group.id === id ? { ...group, name: label } : group)) }
}

/**
 * Drop a group; bots keep their `group` field but fall back to 行动预备组 when
 * the id no longer resolves.
 * @param groups - current list.
 * @param id - group id.
 */
export function removeGroup(groups, id) {
  const list = normalizeGroups(groups)
  if (!list.some((group) => group.id === id)) return { ok: false, error: '没有这个组' }
  return { ok: true, groups: list.filter((group) => group.id !== id) }
}

/**
 * Which custom group a bot belongs to, if any.
 * @param groups - current list.
 * @param bot - bot definition.
 */
export function groupOf(groups, bot) {
  const id = String(bot?.group ?? '').trim()
  return normalizeGroups(groups).some((group) => group.id === id) ? id : ''
}
