/**
 * Roster merge: disk defines who exists, the live task map decides who is busy.
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRoster } from '../host/team-mode.js'
import { resetChildStates } from '../host/live-watch.js'

// 实时登记是进程级的；同一个进程里别的用例可能留下「在跑」的会话，先把现场清干净。
beforeEach(() => resetChildStates())

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

test('别的会话里的单聊不冒充本会话的工作聊天', async () => {
  const root = await fixture()
  try {
    const tasks = new Map([
      ['c-old', { bot: 'nova', parentSession: 'OTHER', sessionId: 'sess-old', startedAt: 5, chatKind: 'work', status: 'chat' }],
    ])
    const members = await readRoster({ root, tasks, sessionId: 'S' })
    assert.equal(members[0].sessionId, null, '别的会话的聊天不应被当成这个会话的')
    assert.equal(members[0].worked, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('本会话的工作聊天会被记住，私聊不算活儿', async () => {
  const root = await fixture()
  try {
    const tasks = new Map([
      ['t1', { bot: 'nova', parentSession: 'S', startedAt: 1, doneAt: 2 }],
      ['c-work', { bot: 'nova', parentSession: 'S', sessionId: 'sess-work', startedAt: 3, chatKind: 'work', status: 'chat' }],
      ['c-priv', { bot: 'nova', parentSession: 'S', sessionId: 'sess-priv', startedAt: 9, chatKind: 'private', status: 'chat' }],
    ])
    const members = await readRoster({ root, tasks, sessionId: 'S' })
    const m = members[0]
    assert.equal(m.sessionId, 'sess-work', '私聊插队也不能顶掉工作聊天')
    assert.equal(m.worked, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('私聊未读数与固定会话号来自 .state/private.json', async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, '.state'), { recursive: true })
    await writeFile(
      join(root, '.state', 'private.json'),
      JSON.stringify({
        version: 1,
        bots: {
          nova: {
            sessionId: 'sess-priv',
            parentSession: 'S',
            dir: '',
            createdAt: 1,
            soulMtime: 1,
            unread: 3,
            lastSeenAt: null,
            greetingAt: 1,
            archivedCount: 0,
          },
        },
      }),
      'utf8',
    )
    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    assert.equal(members[0].privateUnread, 3)
    assert.equal(members[0].privateSessionId, 'sess-priv')
    assert.equal(members[0].worked, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('老账本里没带 chatKind 的私聊轮次，不能被当成本会话的工作聊天', async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, '.state'), { recursive: true })
    await writeFile(
      join(root, '.state', 'private.json'),
      JSON.stringify({
        version: 1,
        bots: {
          nova: {
            sessionId: 'sess-priv',
            parentSession: 'S',
            dir: '',
            createdAt: 1,
            soulMtime: 1,
            unread: 0,
            lastSeenAt: null,
            greetingAt: 1,
            archivedCount: 1,
          },
        },
      }),
      'utf8',
    )
    // 0.6.0 早期版本的私聊轮次只记了 note，没记 chatKind。
    const tasks = new Map([
      ['c-old', {
        taskId: 'c-old',
        bot: 'nova',
        parentSession: 'S',
        sessionId: 'sess-priv',
        startedAt: 5,
        status: 'chat',
        note: '单聊第 1 轮',
      }],
    ])
    const members = await readRoster({ root, tasks, sessionId: 'S' })
    assert.equal(members[0].worked, false)
    assert.equal(members[0].sessionId, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
