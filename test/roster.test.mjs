/**
 * Roster merge: disk defines who exists, the live task map decides who is busy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRoster } from '../host/team-mode.js'

/** Build a throwaway package root with one bot. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-roster-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(
    join(root, 'bots', 'nova.json'),
    JSON.stringify({ id: 'nova', role: '研究员' }),
    'utf8',
  )
  return root
}

test('an idle bot reports idle with zero tasks', async () => {
  const root = await fixture()
  try {
    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    assert.equal(members.length, 1)
    assert.equal(members[0].id, 'nova')
    assert.equal(members[0].status, 'idle')
    assert.equal(members[0].tasks, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a running task makes the bot busy', async () => {
  const root = await fixture()
  try {
    const tasks = new Map([['t1', { bot: 'nova', parentSession: 'S', startedAt: 1 }]])
    const members = await readRoster({ root, tasks, sessionId: 'S' })
    assert.equal(members[0].status, 'busy')
    assert.equal(members[0].tasks, 1)
    assert.equal(members[0].since, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a finished task no longer counts', async () => {
  const root = await fixture()
  try {
    const tasks = new Map([['t1', { bot: 'nova', parentSession: 'S', startedAt: 1, doneAt: 2 }]])
    const members = await readRoster({ root, tasks, sessionId: 'S' })
    assert.equal(members[0].status, 'idle')
    assert.equal(members[0].tasks, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('another session\'s task does not make this one look busy', async () => {
  const root = await fixture()
  try {
    const tasks = new Map([['t1', { bot: 'nova', parentSession: 'other', startedAt: 1 }]])
    const members = await readRoster({ root, tasks, sessionId: 'S' })
    assert.equal(members[0].status, 'idle')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing bots directory yields an empty roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-empty-'))
  try {
    assert.deepEqual(await readRoster({ root, tasks: new Map(), sessionId: 'S' }), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the roster carries growth numbers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-roster-growth-'))
  try {
    await mkdir(join(root, 'bots'), { recursive: true })
    await writeFile(
      join(root, 'bots', 'nova.json'),
      JSON.stringify({
        id: 'nova',
        role: '研究员',
        growth: {
          elite: 1,
          totalXp: 175,
          teaches: [{ tag: 'retro', at: 1, text: '按外墙退线' }],
          stats: { excellent: 2, good: 1, pass: 0, poor: 0, repeats: 0 },
        },
      }),
      'utf8',
    )
    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    const m = members[0]
    assert.equal(m.rank, 1)
    assert.equal(typeof m.lv, 'number')
    assert.equal(m.teaches, 1)
    assert.equal(m.goodRate, 1)
    assert.equal(m.repeatRate, 0)
    assert.equal(m.canPromote, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('自带的 Bot 在名册里带 builtin 标记，普通 Bot 没有', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'bots', 'auditor.json'), JSON.stringify({ id: 'auditor', role: '成果审计' }), 'utf8')
    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    const auditor = members.find((m) => m.id === 'auditor')
    const nova = members.find((m) => m.id === 'nova')
    assert.equal(auditor.builtin, true)
    assert.equal(nova.builtin, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
