/**
 * Growth persistence: serialized read-modify-write per bot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmImprovement, promoteBot, savePromotionSpeech, updateGrowth } from '../host/growth-store.js'
import { normalizeBot } from '../host/bots.js'
import { emptyGrowth } from '../host/growth.js'
import { xpToReach } from '../host/progress.js'

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-growth-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(
    join(root, 'bots', 't.json'),
    JSON.stringify({ id: 't', name: 't', role: '测试', persona: '', growth: emptyGrowth() }),
    'utf8',
  )
  return root
}

test('parallel updates do not lose writes', async () => {
  const root = await makeRoot()
  try {
    await Promise.all(Array.from({ length: 20 }, () => updateGrowth(root, 't', (_bot, growth) => ({
      ok: true,
      growth: { ...growth, totalXp: growth.totalXp + 1 },
    }))))
    const saved = JSON.parse(await readFile(join(root, 'bots', 't.json'), 'utf8'))
    assert.equal(saved.growth.totalXp, 20)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing mutation does not block the queue', async () => {
  const root = await makeRoot()
  try {
    await updateGrowth(root, 't', () => ({ ok: false, error: 'nope' }))
    const result = await updateGrowth(root, 't', (_bot, growth) => ({
      ok: true,
      growth: { ...growth, totalXp: 7 },
    }))
    assert.equal(result.ok, true)
    const saved = JSON.parse(await readFile(join(root, 'bots', 't.json'), 'utf8'))
    assert.equal(saved.growth.totalXp, 7)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updates on a missing bot report an error', async () => {
  const root = await makeRoot()
  try {
    const result = await updateGrowth(root, 'ghost', () => ({ ok: true }))
    assert.equal(result.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizing a bot drops growth from request bodies', () => {
  const { ok, bot } = normalizeBot({
    id: 't',
    name: 'T',
    role: '测试',
    growth: { elite: 2, totalXp: 123 },
  })
  assert.equal(ok, true)
  assert.equal('growth' in bot, false)
})

test('a bot saved without growth keeps whatever is on disk', () => {
  const { bot } = normalizeBot({ id: 't', name: 'T', role: '测试' })
  // 不带 growth 就不写这个字段，saveBot 合并时会保留旧值
  assert.equal('growth' in bot, false)
})

test('the promotion speech lands on the latest promotion record', async () => {
  const root = await makeRoot()
  try {
    await writeFile(
      join(root, 'bots', 't.json'),
      JSON.stringify({ id: 't', name: 't', role: '测试', growth: { rank: 0, totalXp: xpToReach(20, 0) } }),
      'utf8',
    )
    const promoted = await promoteBot(root, 't')
    assert.equal(promoted.ok, true)
    assert.equal(promoted.growth.promotions.length, 1)
    assert.equal('speech' in promoted.growth.promotions[0], false)

    const saved = await savePromotionSpeech(root, 't', '我把每一份都核到页码。')
    assert.equal(saved.ok, true)
    const onDisk = JSON.parse(await readFile(join(root, 'bots', 't.json'), 'utf8'))
    assert.equal(onDisk.growth.promotions[0].speech, '我把每一份都核到页码。')
    // 晋升本身的账不能因为它被改写
    assert.equal(onDisk.growth.rank, 1)
    assert.equal(onDisk.growth.totalXp, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty or speechless speech is refused', async () => {
  const root = await makeRoot()
  try {
    assert.equal((await savePromotionSpeech(root, 't', '  ')).ok, false)
    // 一次都没晋升过：没有记录可挂
    assert.equal((await savePromotionSpeech(root, 't', '往下走一步。')).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('confirming a lesson pays once and lands on disk', async () => {
  const root = await makeRoot()
  try {
    const now = Date.now()
    await writeFile(
      join(root, 'bots', 't.json'),
      JSON.stringify({
        id: 't',
        name: 't',
        role: '测试',
        growth: {
          teaches: [{ tag: '口径', at: now - 5 * 24 * 60 * 60 * 1000, text: '日期写满' }],
          // 教下之后干过两件活：满足「2 件活内没复犯」
          taskLog: [
            { at: now - 2 * 60 * 60 * 1000, grade: 'good' },
            { at: now - 60 * 60 * 1000, grade: 'good' },
          ],
        },
      }),
      'utf8',
    )
    const result = await confirmImprovement(root, 't', '口径', now)
    assert.equal(result.ok, true)
    assert.equal(result.gained, 120)
    const onDisk = JSON.parse(await readFile(join(root, 'bots', 't.json'), 'utf8'))
    assert.equal(onDisk.growth.teaches[0].confirmedAt, now)
    assert.equal(onDisk.growth.totalXp, 120)
    // 第二次确认被拒（已经确认过）
    assert.equal((await confirmImprovement(root, 't', '口径', now)).ok, false)
    // 没教过的标签也拒绝
    assert.equal((await confirmImprovement(root, 't', '没教过', now)).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('晋升后星级自动顶到该段位上限：一阶 5 星、二阶 6 星', async () => {
  const { mkdtemp, mkdir, readFile: read, rm, writeFile: write } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { promoteBot } = await import('../host/growth-store.js')
  const { loadBots } = await import('../host/bots.js')

  const root = await mkdtemp(join(tmpdir(), 'dsh-team-promote-stars-'))
  try {
    await mkdir(join(root, 'bots'), { recursive: true })
    // 普通满级，可以升一阶
    await write(join(root, 'bots', 'nova.json'), JSON.stringify({
      id: 'nova',
      role: '研究员',
      stars: 4,
      growth: { rank: 0, totalXp: 627, streak: 0, teaches: [], promotions: [], levelSince: 1 },
    }), 'utf8')

    const first = await promoteBot(root, 'nova')
    assert.equal(first.ok, true)
    let bot = (await loadBots(root)).find((entry) => entry.id === 'nova')
    assert.equal(bot.growth.rank, 1)
    assert.equal(bot.stars, 5, '升一阶自动 5 星')

    // 一阶满级后再升二阶：需要 3 条教学 + 等级 50
    const { xpToReach } = await import('../host/progress.js')
    bot.growth.totalXp = xpToReach(50, 1)
    bot.growth.teaches = ['a', 'b', 'c'].map((tag) => ({ tag, at: 1, text: '一条足够长的教学说明文字' }))
    await write(join(root, 'bots', 'nova.json'), JSON.stringify(bot), 'utf8')
    const second = await promoteBot(root, 'nova')
    assert.equal(second.ok, true)
    bot = (await loadBots(root)).find((entry) => entry.id === 'nova')
    assert.equal(bot.growth.rank, 2)
    assert.equal(bot.stars, 6, '升二阶自动 6 星')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
