/**
 * Memory history: git init, commit on append, list, restore.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitMemory, ensureRepo, listSnapshots, restoreSnapshot } from '../host/memory.js'

// 子会话沙箱不允许 spawn，git 命令会 EPERM。此时跳过 git 用例；本机/CI 照常跑。
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const gitTest = (name, fn) => test(name, { skip: gitAvailable ? false : '子会话沙箱不允许启动 git 子进程' }, fn)

/** A temp directory holding one memory file. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-team-memory-'))
  await writeFile(join(dir, 'project.md'), '# 记忆\n\n[初始] 第一行\n', 'utf8')
  return dir
}

gitTest('ensureRepo makes the directory a repository', async () => {
  const dir = await fixture()
  try {
    assert.equal(await ensureRepo(dir), true)
    assert.equal(await ensureRepo(dir), true, 'calling twice must be harmless')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

gitTest('记忆目录在别的仓库里面时，自己另起一个仓库，不去提交父仓库', async () => {
  // 插件目录本身是 git 仓库，记忆目录只是它的子目录——不能认父仓库当自己。
  const parent = await mkdtemp(join(tmpdir(), 'dsh-team-parent-'))
  const child = join(parent, 'bots', 'nova', 'memory')
  try {
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'plugin.txt'), '插件文件\n', 'utf8')
    await writeFile(join(child, 'project.md'), '# 记忆\n', 'utf8')
    const init = await promisify(execFile)('git', ['-C', parent, 'init', '--quiet'], { windowsHide: true })
    assert.equal(init.stdout.trim(), '')

    assert.equal(await ensureRepo(child), true)
    const top = await promisify(execFile)('git', ['-C', child, 'rev-parse', '--show-toplevel'], { windowsHide: true })
    assert.match(top.stdout.trim().replace(/\\/g, '/').toLowerCase(), /\/bots\/nova\/memory$|^[a-z]:\/.*bots\/nova\/memory$/)

    // 提交记忆之后，父仓库不该多出任何提交（父仓库本来没有提交，HEAD 仍然不存在）。
    await commitMemory(child, '记忆提交')
    const parentLog = await promisify(execFile)('git', ['-C', parent, 'log', '--oneline'], { windowsHide: true }).catch(() => ({ stdout: '' }))
    assert.equal(parentLog.stdout.trim(), '')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

gitTest('a commit records a snapshot and nothing changed yields null', async () => {
  const dir = await fixture()
  try {
    const first = await commitMemory(dir, 'memory: [初始] 第一行')
    assert.ok(first, 'first commit should return a hash')
    assert.equal(await commitMemory(dir, 'again'), null, 'no change must not create an empty commit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

gitTest('snapshots list newest first', async () => {
  const dir = await fixture()
  try {
    await commitMemory(dir, 'first')
    await writeFile(join(dir, 'project.md'), '# 记忆\n\n[初始] 第一行\n[沙箱] 第二行\n', 'utf8')
    await commitMemory(dir, 'second')
    const snapshots = await listSnapshots(dir)
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[0].subject, 'second')
    assert.equal(snapshots[1].subject, 'first')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

gitTest('restore puts project.md back to a commit', async () => {
  const dir = await fixture()
  try {
    const firstHash = await commitMemory(dir, 'first')
    await writeFile(join(dir, 'project.md'), '# 记忆\n\n[初始] 第一行\n[新增] 第二行\n', 'utf8')
    await commitMemory(dir, 'second')
    const result = await restoreSnapshot(dir, firstHash, 'project.md')
    assert.equal(result.ok, true)
    const content = await readFile(join(dir, 'project.md'), 'utf8')
    assert.ok(!content.includes('新增'), 'restore should drop the later line')
    assert.ok(content.includes('第一行'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

gitTest('an unknown hash is reported, not thrown', async () => {
  const dir = await fixture()
  try {
    await commitMemory(dir, 'first')
    const result = await restoreSnapshot(dir, 'deadbeefdeadbeef', 'project.md')
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
