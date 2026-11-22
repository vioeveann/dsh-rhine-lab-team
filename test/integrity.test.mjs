/**
 * Growth integrity: legitimate saves verify, hand edits reset.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBots, normalizeBot, saveBot } from '../host/bots.js'

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-team-integrity-'))
}

test('a saved growth record verifies on load', async () => {
  const root = await makeRoot()
  try {
    await saveBot(root, {
      id: 'nova',
      name: 'Nova',
      role: '研究员',
      growth: { rank: 0, totalXp: 120 },
    })
    const raw = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
    assert.equal(raw.integrity.v, 1)
    assert.equal(typeof raw.integrity.sig, 'string')
    const [bot] = await loadBots(root)
    assert.equal(bot.growth.totalXp, 120)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('editing growth without a new signature resets it to Lv.1', async () => {
  const root = await makeRoot()
  try {
    await saveBot(root, {
      id: 'nova',
      name: 'Nova',
      role: '研究员',
      growth: { rank: 0, totalXp: 120 },
    })
    const file = join(root, 'bots', 'nova.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    raw.growth.totalXp = 999999
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    const [bot] = await loadBots(root)
    assert.equal(bot.growth.totalXp, 0)
    assert.equal(bot.growth.rank, 0)
    assert.equal(bot.growthReset, true)

    const after = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(after.growth.totalXp, 0)
    assert.equal(after.integrity.v, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy growth without a signature is migrated once, then guarded', async () => {
  const root = await makeRoot()
  try {
    const file = join(root, 'bots', 'nova.json')
    await mkdir(join(root, 'bots'), { recursive: true })
    await writeFile(
      file,
      `${JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员', growth: { rank: 0, totalXp: 88 } }, null, 2)}\n`,
      'utf8',
    )

    const [first] = await loadBots(root)
    assert.equal(first.growth.totalXp, 88)
    const signed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(signed.integrity.v, 1)

    signed.growth.totalXp = 777
    await writeFile(file, `${JSON.stringify(signed, null, 2)}\n`, 'utf8')
    const [second] = await loadBots(root)
    assert.equal(second.growth.totalXp, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('request bodies cannot carry growth into a saved bot', () => {
  const result = normalizeBot({
    id: 'nova',
    role: '研究员',
    growth: { rank: 2, totalXp: 999999 },
  })
  assert.equal(result.ok, true)
  assert.equal('growth' in result.bot, false)
})

test('adding growth by hand to a bot that never had it is reset', async () => {
  const root = await makeRoot()
  try {
    await saveBot(root, { id: 'nova', name: 'Nova', role: '研究员' })
    const file = join(root, 'bots', 'nova.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    raw.growth = { rank: 2, totalXp: 999999 }
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

    const [bot] = await loadBots(root)
    assert.equal(bot.growth.totalXp, 0)
    assert.equal(bot.growth.rank, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit roster import may carry growth (backup restore)', () => {
  const result = normalizeBot(
    { id: 'nova', role: '研究员', growth: { rank: 1, totalXp: 300 } },
    { allowGrowth: true },
  )
  assert.equal(result.ok, true)
  assert.equal(result.bot.growth.rank, 1)
  assert.equal(result.bot.growth.totalXp, 300)
})
