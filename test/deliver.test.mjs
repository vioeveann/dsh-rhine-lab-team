/**
 * Deliverables: collect a task directory into the shelf the user opens.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTask } from '../host/deliver.js'

test('collect refuses a directory outside the deliverable root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-deliver-'))
  const taskDir = join(root, 'task')
  await mkdir(taskDir, { recursive: true })
  await writeFile(join(taskDir, 'report.md'), 'x', 'utf8')
  const deliverableRoot = join(root, 'deliverables')
  try {
    const result = await collectTask({ taskDir, deliverableRoot, into: '../outside' })
    assert.equal(result.ok, false)
    assert.match(result.error, /交付根目录/)
    await assert.rejects(() => readFile(join(root, 'outside', 'report.md'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Build a throwaway task directory with a few files. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-deliver-'))
  const taskDir = join(root, 'task')
  await mkdir(join(taskDir, 'parts'), { recursive: true })
  await writeFile(join(taskDir, 'report.md'), '# 报告\n', 'utf8')
  await writeFile(join(taskDir, 'parts', 'sec1.md'), '第一节\n', 'utf8')
  await mkdir(join(taskDir, '.debug'), { recursive: true })
  await writeFile(join(taskDir, '.debug', 'host.log'), 'scratch\n', 'utf8')
  // 工作目录：交接副本和原始响应不该进交付目录
  await mkdir(join(taskDir, 'from-previous'), { recursive: true })
  await writeFile(join(taskDir, 'from-previous', 'report.md'), '上一版\n', 'utf8')
  await mkdir(join(taskDir, 'raw'), { recursive: true })
  await writeFile(join(taskDir, 'raw', 'last-week.json'), '{}\n', 'utf8')
  return { root, taskDir, deliverableRoot: join(root, 'deliverables') }
}

test('collect copies nested files and skips scratch', async () => {
  const { root, taskDir, deliverableRoot } = await fixture()
  try {
    const result = await collectTask({ taskDir, deliverableRoot, into: 'case-a' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.files.sort(), ['parts/sec1.md', 'report.md'])
    const copied = await readFile(join(deliverableRoot, 'case-a', 'parts', 'sec1.md'), 'utf8')
    assert.equal(copied, '第一节\n')
    await assert.rejects(readFile(join(deliverableRoot, 'case-a', '.debug', 'host.log')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing task directory is reported, not thrown', async () => {
  const { root, deliverableRoot } = await fixture()
  try {
    const result = await collectTask({
      taskDir: join(root, 'nope'),
      deliverableRoot,
      into: 'x',
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /任务目录不存在/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty task directory is reported with a hint', async () => {
  const { root, deliverableRoot } = await fixture()
  try {
    const empty = join(root, 'empty')
    await mkdir(empty, { recursive: true })
    const result = await collectTask({ taskDir: empty, deliverableRoot, into: 'x' })
    assert.equal(result.ok, false)
    assert.match(result.error, /没有产物/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collecting twice never overwrites: the second delivery gets a -2 directory', async () => {
  const { root, taskDir, deliverableRoot } = await fixture()
  try {
    await collectTask({ taskDir, deliverableRoot, into: 'case-a' })
    await writeFile(join(taskDir, 'report.md'), '# 报告 v2\n', 'utf8')
    const second = await collectTask({ taskDir, deliverableRoot, into: 'case-a' })
    assert.equal(second.ok, true)
    assert.equal(second.renamed, true)
    assert.equal(second.dir, join(deliverableRoot, 'case-a-2'))
    const v1 = await readFile(join(deliverableRoot, 'case-a', 'report.md'), 'utf8')
    const copied = await readFile(join(deliverableRoot, 'case-a-2', 'report.md'), 'utf8')
    assert.match(v1, /# 报告/)
    assert.equal(copied, '# 报告 v2\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
