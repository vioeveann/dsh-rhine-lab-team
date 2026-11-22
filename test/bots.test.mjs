/**
 * Roster files: validation, creation with a memory skeleton, archiving.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteBot, loadBots, normalizeBot, saveBot } from '../host/bots.js'
import { ensureBuiltinBots, listRemovedBuiltins, rememberRemovedBuiltin, restoreBuiltinBot } from '../host/builtin-bots.js'

test('upper case is normalized rather than rejected', () => {
  assert.equal(normalizeBot({ id: 'Nova', role: '研究员' }).ok, true)
})

test('a legal id normalizes to lower case', () => {
  const result = normalizeBot({ id: 'Nova-2', name: 'Nova', role: '研究员', persona: '只做核对' })
  assert.equal(result.ok, true)
  assert.equal(result.bot.id, 'nova-2')
})

test('agentTeam 只在显式传的时候才写：不传保持原值，传 false 才关', () => {
  assert.equal('agentTeam' in normalizeBot({ id: 'nova', role: '研究员' }).bot, false)
  assert.equal(normalizeBot({ id: 'nova', role: '研究员', agentTeam: true }).bot.agentTeam, true)
  assert.equal(normalizeBot({ id: 'nova', role: '研究员', agentTeam: false }).bot.agentTeam, false)
})

test('an illegal id is rejected with a reason', () => {  for (const id of ['', '1abc', 'a_b', 'x'.repeat(30), '-a', '中文']) {
    const result = normalizeBot({ id, role: '研究员' })
    assert.equal(result.ok, false, `expected ${JSON.stringify(id)} to be rejected`)
    assert.equal(typeof result.error, 'string')
  }
})

test('an empty role is rejected', () => {
  assert.equal(normalizeBot({ id: 'nova', role: '   ' }).ok, false)
})

test('an overlong persona is rejected', () => {
  assert.equal(normalizeBot({ id: 'nova', role: '研究员', persona: 'x'.repeat(4001) }).ok, false)
})

test('an empty name falls back to the id', () => {
  const result = normalizeBot({ id: 'nova', name: '  ', role: '研究员' })
  assert.equal(result.bot.name, 'nova')
})

test('saving creates the json plus a memory skeleton, and keeps memory on re-save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-bots-'))
  try {
    const bot = { id: 'nova', name: 'Nova', role: '研究员', persona: '只做核对' }
    await saveBot(root, bot)
    const raw = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
    assert.equal(raw.role, '研究员')
    assert.ok(await stat(join(root, 'bots', 'nova', 'memory', 'soul.txt')))
    assert.ok(await stat(join(root, 'bots', 'nova', 'memory', 'project.md')))

    const soulPath = join(root, 'bots', 'nova', 'memory', 'soul.txt')
    const before = await readFile(soulPath, 'utf8')
    await saveBot(root, { ...bot, role: '资深研究员' })
    const after = await readFile(soulPath, 'utf8')
    assert.equal(after, before, 'saving must not overwrite an existing soul')
    const updated = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
    assert.equal(updated.role, '资深研究员')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadBots lists saved bots and skips broken files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-load-'))
  try {
    await saveBot(root, { id: 'nova', name: 'Nova', role: '研究员', persona: '' })
    await saveBot(root, { id: 'forge', name: 'Forge', role: '审图', persona: '' })
    await (await import('node:fs/promises')).writeFile(join(root, 'bots', 'broken.json'), '{not json', 'utf8')
    const bots = await loadBots(root)
    assert.deepEqual(bots.map((bot) => bot.id).sort(), ['forge', 'nova'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('彻底删除：JSON 和整个目录（记忆、头像）一起删掉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-archive-'))
  try {
    await saveBot(root, { id: 'nova', name: 'Nova', role: '研究员', persona: '' })
    assert.ok(await stat(join(root, 'bots', 'nova', 'memory', 'soul.txt')))
    const result = await deleteBot(root, 'nova')
    assert.equal(result.ok, true)
    assert.deepEqual(await loadBots(root), [])
    await assert.rejects(stat(join(root, 'bots', 'nova')), '整个目录都要没')
    await assert.rejects(stat(join(root, 'bots', 'nova.json')), '定义文件也要没')
    // 再删一次是幂等成功，不炸
    assert.equal((await deleteBot(root, 'nova')).ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自带 Bot 只种一次：新装就有，删掉之后不会再冒出来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-builtin-'))
  try {
    const added = await ensureBuiltinBots(root)
    assert.deepEqual(added, ['auditor', 'writer', 'collector'])
    const list = await loadBots(root)
    assert.equal(list.length, 3)
    const auditor = list.find((bot) => bot.id === 'auditor')
    assert.equal(auditor.role, '成果审计')
    assert.equal(auditor.stars, 4, '默认四星')
    assert.equal(auditor.growth.rank, 1, '默认精英化一阶')
    assert.equal(auditor.growth.totalXp, 0, '默认 LV.1')
    assert.equal(auditor.growth.promotions.length, 1, '记一笔出生晋级')
    const writer = list.find((bot) => bot.id === 'writer')
    assert.equal(writer.name, '写作')
    assert.equal(writer.role, '写稿与成稿')
    assert.equal(writer.growth?.rank ?? 0, 0, '写作默认普通')
    assert.equal(writer.growth?.totalXp ?? 0, 0, '写作默认 LV.1')
    const collector = list.find((bot) => bot.id === 'collector')
    assert.equal(collector.name, '资料整理')
    assert.equal(collector.role, '资料处理')
    assert.equal(collector.growth?.rank ?? 0, 0, '资料整理默认普通')
    assert.equal(collector.growth?.totalXp ?? 0, 0, '资料整理默认 LV.1')

    // 博士定的：自带 Bot 不留备注
    assert.equal('note' in writer, false)
    assert.equal('note' in collector, false)
    const soul = await readFile(join(root, 'bots', 'auditor', 'memory', 'soul.txt'), 'utf8')
    assert.match(soul, /不打分/)
    assert.match(soul, /必须改｜建议改/)
    const writerSoul = await readFile(join(root, 'bots', 'writer', 'memory', 'soul.txt'), 'utf8')
    assert.match(writerSoul, /不瞎编/, '写作人设必须写不许瞎编')
    assert.match(writerSoul, /去掉 AI 味/, '写作人设必须写去除 AI 味')
    assert.match(writerSoul, /在当今……的背景下/, '要有具体禁用清单')
    assert.match(writerSoul, /交稿前自检/)

    // 第二次加载：不重复种
    assert.deepEqual(await ensureBuiltinBots(root), [])

    // 用户删掉之后也不再回来
    await deleteBot(root, 'auditor')
    await deleteBot(root, 'writer')
    await deleteBot(root, 'collector')
    assert.deepEqual(await ensureBuiltinBots(root), [])
    assert.deepEqual(await loadBots(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自带 Bot 不覆盖用户自己建的同一个 id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-builtin2-'))
  try {
    await saveBot(root, { id: 'auditor', name: '我自己建的', role: '别的活' })
    const added = await ensureBuiltinBots(root)
    assert.deepEqual(added, ['writer', 'collector'], '同 id 的那个不覆盖，只补其它的')
    const list = await loadBots(root)
    const mine = list.find((bot) => bot.id === 'auditor')
    assert.equal(mine.name, '我自己建的')
    assert.equal(mine.role, '别的活')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('删掉自带 Bot 之后可以手动恢复回来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-builtin3-'))
  try {
    await ensureBuiltinBots(root)
    await deleteBot(root, 'auditor')
    assert.equal((await loadBots(root)).some((bot) => bot.id === 'auditor'), false)
    // 自动加载不会复活它
    assert.deepEqual(await ensureBuiltinBots(root), [])
    // 但手动恢复可以
    const restored = await restoreBuiltinBot(root, 'auditor')
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, true)
    const list = await loadBots(root)
    const back = list.find((bot) => bot.id === 'auditor')
    assert.equal(back.stars, 4)
    // 不存在的自带 id 直接报错
    assert.equal((await restoreBuiltinBot(root, 'nobody')).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('审计员被挪到自建组再删掉：恢复后回到那个组', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-builtin4-'))
  try {
    await ensureBuiltinBots(root)
    // 挪到 A 组
    const file = join(root, 'bots', 'auditor.json')
    const bot = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...bot, group: 'g-group-a' }), 'utf8')
    // 删之前记下它在哪
    await rememberRemovedBuiltin(root, 'auditor', 'g-group-a')
    await deleteBot(root, 'auditor')
    assert.deepEqual(await listRemovedBuiltins(root), [{ id: 'auditor', group: 'g-group-a' }])
    // 自动加载不复活
    assert.deepEqual(await ensureBuiltinBots(root), [])
    // 手动恢复：回到 A 组，记录清空
    const restored = await restoreBuiltinBot(root, 'auditor')
    assert.equal(restored.restored, true)
    assert.equal(restored.group, 'g-group-a')
    const back = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(back.group, 'g-group-a')
    assert.deepEqual(await listRemovedBuiltins(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('普通内置 Bot（写作/研读）删掉就没了：不给恢复，也不留记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-builtin5-'))
  try {
    await ensureBuiltinBots(root)
    // 普通内置：删除时不留「可从哪恢复」的记录
    assert.equal(await rememberRemovedBuiltin(root, 'writer', 'g-x'), false)
    await deleteBot(root, 'writer')
    const restored = await restoreBuiltinBot(root, 'writer')
    assert.equal(restored.ok, false)
    assert.match(restored.error, /删掉就没了/)
    assert.deepEqual(await ensureBuiltinBots(root), [])
    assert.equal((await loadBots(root)).some((bot) => bot.id === 'writer'), false)
    // 限定那个照旧可恢复
    await rememberRemovedBuiltin(root, 'auditor', '')
    await deleteBot(root, 'auditor')
    assert.deepEqual(await listRemovedBuiltins(root), [{ id: 'auditor', group: '' }])
    assert.equal((await restoreBuiltinBot(root, 'auditor')).restored, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只有限定的审计员出生即精英化一阶；用户自建和普通内置都是普通 LV.1', async () => {
  const { levelOf, RANK_LABELS } = await import('../host/progress.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-builtin6-'))
  try {
    await saveBot(root, { id: 'mine', name: '我自己建的', role: '随便' })
    await ensureBuiltinBots(root)
    const bots = await loadBots(root)
    const pick = (id) => bots.find((bot) => bot.id === id)
    const rankOf = (bot) => Number(bot?.growth?.rank) || 0
    const levelOfBot = (bot) => levelOf(Number(bot?.growth?.totalXp) || 0, rankOf(bot), 0).level

    assert.equal(RANK_LABELS[rankOf(pick('auditor'))], '精英化一阶')
    assert.equal(levelOfBot(pick('auditor')), 1)
    for (const id of ['mine', 'writer', 'collector']) {
      assert.equal(RANK_LABELS[rankOf(pick(id))], '普通', `${id} 应该是普通`)
      assert.equal(levelOfBot(pick(id)), 1, `${id} 应该是 LV.1`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('星级上限按段位：普通 4、一阶 5、二阶 6', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-starcap-'))
  try {
    const save = async (id, rank, stars) => {
      await saveBot(root, { id, name: id, role: '测试', stars, growth: { rank, totalXp: 0 } })
      const bot = JSON.parse(await readFile(join(root, 'bots', `${id}.json`), 'utf8'))
      return bot.stars
    }
    assert.equal(await save('r0', 0, 6), 4)
    assert.equal(await save('r1', 1, 6), 5)
    assert.equal(await save('r2', 2, 6), 6)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
