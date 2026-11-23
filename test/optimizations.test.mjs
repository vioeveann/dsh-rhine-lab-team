import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canStartTask, readTeamMemory } from '../host/tools.js'

test('团队知识按角色裁剪：采集/审计不带写作规范，写作带全套', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-memory-'))
  try {
    await mkdir(join(root, 'bots', '_team'), { recursive: true })
    await writeFile(join(root, 'bots', '_team', 'knowledge.md'), '共用事实', 'utf8')
    await writeFile(join(root, 'bots', '_team', 'user.md'), '用户偏好', 'utf8')
    await writeFile(join(root, 'bots', '_team', 'style.md'), '写作规范', 'utf8')
    const collector = await readTeamMemory(root, 'collector')
    assert.match(collector, /共用事实/)
    assert.doesNotMatch(collector, /用户偏好|写作规范/)
    const auditor = await readTeamMemory(root, 'auditor')
    assert.doesNotMatch(auditor, /用户偏好|写作规范/)
    const writer = await readTeamMemory(root, 'writer')
    assert.match(writer, /共用事实/)
    assert.match(writer, /用户偏好/)
    assert.match(writer, /写作规范/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('并发：普通任务占满上限后审计仍可单独启动', () => {
  const tasks = new Map()
  for (let i = 0; i < 4; i += 1) {
    tasks.set(`t${i}`, { taskId: `t${i}`, bot: 'writer', status: 'running', parentSession: 's' })
  }
  assert.equal(canStartTask(tasks, 's', 4).ok, false)
  assert.equal(canStartTask(tasks, 's', 4, { audit: true }).ok, true)
  tasks.set('a1', { taskId: 'a1', bot: 'auditor', status: 'running', parentSession: 's' })
  assert.equal(canStartTask(tasks, 's', 4, { audit: true }).ok, false)
})
