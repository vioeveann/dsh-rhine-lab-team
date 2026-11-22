/**
 * Renaming a bot: the definition and its memory directory move together.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBots, renameBot, saveBot } from '../host/bots.js'

/** Root with one saved bot and a memory line. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-rename-'))
  await saveBot(root, { id: 'nova', name: 'Nova', role: '研究员', persona: '只做核对' })
  await writeFile(join(root, 'bots', 'nova', 'memory', 'project.md'), '# 记忆\n[沙箱] 一条\n', 'utf8')
  return root
}

test('rename moves the json and the memory directory', async () => {
  const root = await fixture()
  try {
    const result = await renameBot(root, 'nova', 'nova2')
    assert.equal(result.ok, true)
    assert.equal(result.id, 'nova2')
    const bots = await loadBots(root)
    assert.deepEqual(bots.map((bot) => bot.id), ['nova2'])
    assert.equal(bots[0].name, 'Nova', 'display name must survive the rename')
    const memory = await readFile(join(root, 'bots', 'nova2', 'memory', 'project.md'), 'utf8')
    assert.match(memory, /一条/)
    await assert.rejects(stat(join(root, 'bots', 'nova.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renaming onto an existing id is refused', async () => {
  const root = await fixture()
  try {
    await saveBot(root, { id: 'forge', name: 'Forge', role: '审图', persona: '' })
    const result = await renameBot(root, 'nova', 'forge')
    assert.equal(result.ok, false)
    assert.match(result.error, /已经有/)
    assert.deepEqual((await loadBots(root)).map((bot) => bot.id).sort(), ['forge', 'nova'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invalid or missing source is refused', async () => {
  const root = await fixture()
  try {
    assert.equal((await renameBot(root, 'nova', 'Bad Id')).ok, false)
    assert.equal((await renameBot(root, 'ghost', 'ghost2')).ok, false)
    assert.deepEqual((await loadBots(root)).map((bot) => bot.id), ['nova'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renaming to the same id is a no-op', async () => {
  const root = await fixture()
  try {
    const result = await renameBot(root, 'nova', 'nova')
    assert.equal(result.ok, true)
    assert.equal(result.unchanged, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
