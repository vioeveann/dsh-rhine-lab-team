/**
 * Deliverables: a bot writes drafts inside its task directory, and the
 * secretary collects them into the one folder the user will open.
 *
 * The copy is deliberate: the task directory is scratch space that may be
 * rebuilt, while `deliverables` is the user-facing shelf.
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Files we never collect: scratch, editor junk, our own debug output. */
const SKIP = /(^|[\\/])(\.debug|node_modules|\.git)([\\/]|$)/

/**
 * Top-level directories that are working material, not deliverables.
 * `from-previous/` is the handoff copy of an earlier task and `raw/` is the
 * archived API response set — both are duplicates or noise on the shelf.
 */
const SKIP_TOP = new Set(['from-previous', 'raw'])

/**
 * Resolve the user-facing subdirectory, refusing anything that escapes the
 * deliverable root. `into` comes from a tool argument, so it must not be
 * allowed to climb out with `..` or an absolute path.
 * @param root - deliverable root.
 * @param into - relative folder name, may be empty.
 * @returns absolute target dir.
 */
function resolveInto(root, into) {
  const base = resolve(String(root ?? '.'))
  const raw = String(into ?? '').trim()
  const target = raw === '' ? base : resolve(base, raw)
  const rel = relative(base, target)
  if (rel === '') return target
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('交付目录必须是交付根目录下的相对路径')
  }
  return target
}

/**
 * List every regular file under a directory.
 * @param dir - root to walk.
 * @param base - prefix used for relative paths.
 */
async function walk(dir, base = dir) {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (SKIP.test(full)) continue
    // 只在顶层跳过工作目录：产物里的同名子目录照收。
    if (dir === base && entry.isDirectory() && SKIP_TOP.has(entry.name)) continue
    if (entry.isDirectory()) {
      found.push(...(await walk(full, base)))
      continue
    }
    if (!entry.isFile()) continue
    found.push(relative(base, full))
  }
  return found
}

/**
 * True when `dir` exists and already contains at least one file.
 * An empty existing directory is safe to reuse.
 * @param dir - candidate directory.
 */
async function hasFiles(dir) {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return true
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/**
 * Pick a directory that will not overwrite an earlier delivery.
 * `报告` → `报告-2` → `报告-3` …; the caller gets the actual path back.
 * @param target - preferred directory.
 */
async function pickFreeDir(target) {
  if (!(await hasFiles(target))) return target
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${target}-${index}`
    if (!(await hasFiles(candidate))) return candidate
  }
  throw new Error(`同名交付目录太多，无法为 ${target} 找到空位`)
}

/**
 * Copy every file of one task directory into the deliverable folder.
 * Never overwrites a previous delivery: picks `into-2`, `into-3` … instead.
 * @param options - `{ taskDir, deliverableRoot, into }`.
 * @returns `{ ok, dir, files, renamed?, error? }`.
 */
export async function collectTask({ taskDir, deliverableRoot, into }) {
  let wanted
  try {
    wanted = resolveInto(deliverableRoot, into)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), dir: String(deliverableRoot ?? ''), files: [] }
  }
  try {
    const info = await stat(taskDir)
    if (!info.isDirectory()) return { ok: false, error: `任务目录不存在：${taskDir}` }
  } catch {
    return { ok: false, error: `任务目录不存在：${taskDir}` }
  }

  const files = await walk(taskDir)
  if (files.length === 0) {
    return { ok: false, error: '这个任务目录里没有产物——它可能只回了文字，没落文件', dir: wanted, files: [] }
  }

  let target
  try {
    target = await pickFreeDir(wanted)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), dir: wanted, files: [] }
  }
  await mkdir(target, { recursive: true })
  const copied = []
  for (const file of files) {
    const from = join(taskDir, file)
    const to = join(target, file)
    await mkdir(join(to, '..'), { recursive: true })
    await cp(from, to)
    copied.push(file.split(sep).join('/'))
  }
  return {
    ok: true,
    dir: target,
    files: copied,
    ...(target === wanted ? {} : { renamed: true }),
  }
}
