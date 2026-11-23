/**
 * 数据目录必须在包目录之外：升级会整个替换包目录，数据放里面就是一次升级丢一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDataRoot, resolveDataRoot } from '../host/paths.js'

/** 临时改环境变量跑一段，跑完还原。 */
async function withEnv(vars, run) {
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('resolveDataRoot：DSH_TEAM_HOME 优先于 DSH_HOME', async () => {
  await withEnv({ DSH_TEAM_HOME: join(tmpdir(), 'team-home-a'), DSH_HOME: join(tmpdir(), 'dsh-home-a') }, () => {
    assert.equal(resolveDataRoot(), join(tmpdir(), 'team-home-a'))
  })
})

test('resolveDataRoot：没设 DSH_TEAM_HOME 时落在 DSH_HOME/rhine-lab-team', async () => {
  await withEnv({ DSH_TEAM_HOME: undefined, DSH_HOME: join(tmpdir(), 'dsh-home-b') }, () => {
    assert.equal(resolveDataRoot(), join(tmpdir(), 'dsh-home-b', 'rhine-lab-team'))
  })
})

test('migrateDataRoot：包目录里的旧 Bot 搬到数据目录，不覆盖已有数据', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-team-paths-'))
  const pkg = join(base, 'package')
  const data = join(base, 'data')
  await mkdir(join(pkg, 'bots', 'nova', 'memory'), { recursive: true })
  await mkdir(join(pkg, 'bots', '_team'), { recursive: true })
  await mkdir(join(pkg, '.state'), { recursive: true })
  await mkdir(join(pkg, '.team-work', 'nova', 'chat-1'), { recursive: true })
  await writeFile(join(pkg, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员' }), 'utf8')
  await writeFile(join(pkg, 'bots', '_team', 'knowledge.md'), '团队知识', 'utf8')
  await writeFile(join(pkg, '.state', 'config.json'), '{"address":"博士"}', 'utf8')
  await writeFile(join(pkg, '.state', 'groups.json'), '{"groups":[{"name":"我的组"}]}', 'utf8')
  await writeFile(join(pkg, '.team-work', 'nova', 'chat-1', 'note.txt'), '工作目录', 'utf8')

  const moved = await migrateDataRoot(pkg, data)
  assert.deepEqual(moved.sort(), ['.state', '.team-work', 'bots'])
  assert.match(await readFile(join(data, 'bots', 'nova.json'), 'utf8'), /Nova/)
  assert.match(await readFile(join(data, 'bots', '_team', 'knowledge.md'), 'utf8'), /团队知识/)
  assert.match(await readFile(join(data, '.state', 'config.json'), 'utf8'), /博士/)
  assert.match(await readFile(join(data, '.state', 'groups.json'), 'utf8'), /我的组/)
  assert.match(await readFile(join(data, '.team-work', 'nova', 'chat-1', 'note.txt'), 'utf8'), /工作目录/)
  // 旧目录留着：不替用户删数据。
  assert.match(await readFile(join(pkg, 'bots', 'nova.json'), 'utf8'), /Nova/)

  // 已经有数据目录时不搬、不覆盖。
  await writeFile(join(data, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', name: '新名字' }), 'utf8')
  const again = await migrateDataRoot(pkg, data)
  assert.deepEqual(again, [])
  assert.match(await readFile(join(data, 'bots', 'nova.json'), 'utf8'), /新名字/)
})

test('migrateDataRoot：包目录就是数据目录时什么都不做', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-paths-same-'))
  assert.deepEqual(await migrateDataRoot(root, root), [])
})
