/**
 * Memory history: every bot memory directory is a Git repository.
 *
 * The point is not version control for its own sake — it is the "回到某个快照"
 * promise: something the bot learned can be inspected and undone.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Run one git command inside a directory.
 * @param dir - repository directory.
 * @param args - git arguments.
 */
async function git(dir, args) {
  const { stdout } = await run('git', ['-C', dir, ...args], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

/**
 * Initialise the repository if it is not one yet.
 * @param dir - memory directory.
 * @returns true when a repository is ready.
 */
export async function ensureRepo(dir) {
  try {
    // 必须确认「这个目录本身」就是仓库根：插件目录本身是个 git 仓库，
    // 记忆目录只是它的子目录，`rev-parse --is-inside-work-tree` 也会返回 true，
    // 于是 `git -C <子目录> add -A` 会把整个插件仓库的改动一起提交。
    const top = await git(dir, ['rev-parse', '--show-toplevel'])
    if (samePath(top, dir)) return true
  } catch {
    // 不是仓库，往下走 init。
  }
  try {
    await git(dir, ['init', '--quiet'])
    await git(dir, ['config', 'user.name', 'dsh-team'])
    await git(dir, ['config', 'user.email', 'dsh-team@localhost'])
    return true
  } catch {
    return false
  }
}

/**
 * Compare two paths loosely (separators, drive-letter case on Windows).
 * @param a - one path.
 * @param b - another path.
 */
function samePath(a, b) {
  const norm = (value) => {
    const text = String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? text.toLowerCase() : text
  }
  return norm(a) === norm(b)
}

/**
 * Commit the current memory state.
 * @param dir - memory directory.
 * @param message - commit subject.
 * @returns the commit hash, or null when nothing changed.
 */
export async function commitMemory(dir, message) {
  if (!(await ensureRepo(dir))) return null
  try {
    await git(dir, ['add', '-A'])
    const status = await git(dir, ['status', '--porcelain'])
    if (status === '') return null
    await git(dir, ['commit', '--quiet', '-m', message])
    return await git(dir, ['rev-parse', '--short', 'HEAD'])
  } catch {
    return null
  }
}

/**
 * List the most recent commits.
 * @param dir - memory directory.
 * @param limit - how many to return.
 * @returns `[{ hash, when, subject }]`.
 */
export async function listSnapshots(dir, limit = 20) {
  try {
    const raw = await git(dir, ['log', `-${limit}`, '--pretty=format:%h%x09%ad%x09%s', '--date=short'])
    if (raw === '') return []
    return raw.split('\n').map((line) => {
      const [hash, when, ...rest] = line.split('\t')
      return { hash, when, subject: rest.join('\t') }
    })
  } catch {
    return []
  }
}

/**
 * Put one file back to the state of a commit.
 * @param dir - memory directory.
 * @param hash - commit hash.
 * @param file - relative file name.
 */
export async function restoreSnapshot(dir, hash, file = 'project.md') {
  try {
    await git(dir, ['checkout', hash, '--', file])
    return { ok: true, hash, file }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
