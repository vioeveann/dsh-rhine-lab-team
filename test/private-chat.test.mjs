import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPrivateUnread,
  blankPrivateState,
  clearPrivateUnread,
  normalizePrivateState,
  privateBotOfSession,
  privateEntryOf,
  privateStatePath,
  readPrivateState,
  setPrivateEntry,
  writePrivateState,
} from '../host/private-chat.js'

test('私聊状态：没有文件时是空状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-private-'))
  try {
    const state = await readPrivateState(dir)
    assert.deepEqual(state.bots, {})
    assert.equal(privateEntryOf(state, 'viviana'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('私聊状态：写进去再读回来，数字字段都规整过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-private-'))
  try {
    const state = blankPrivateState()
    setPrivateEntry(state, 'viviana', {
      sessionId: 'session-a',
      parentSession: 'session-root',
      dir: 'D:/tmp/x',
      createdAt: 100,
      soulMtime: 200,
      unread: 3,
    })
    await writePrivateState(dir, state)
    const raw = JSON.parse(await readFile(privateStatePath(dir), 'utf8'))
    assert.equal(raw.version, 1)
    const back = await readPrivateState(dir)
    const entry = privateEntryOf(back, 'viviana')
    assert.equal(entry.sessionId, 'session-a')
    assert.equal(entry.soulMtime, 200)
    assert.equal(entry.unread, 3)
    assert.equal(entry.parentSession, 'session-root')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('私聊状态：坏数据不该让面板起不来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-private-'))
  try {
    await mkdir(join(dir, '.state'), { recursive: true })
    await writeFile(privateStatePath(dir), '{ not json', 'utf8')
    const state = await readPrivateState(dir)
    assert.deepEqual(state.bots, {})
    // 数组、null、没有 sessionId 的条目统统丢掉
    const normalized = normalizePrivateState({ bots: { a: null, b: [], c: { sessionId: '' }, d: { sessionId: 's-d' } } })
    assert.deepEqual(Object.keys(normalized.bots), ['d'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('私聊未读：加、清、不因加错 Bot 而崩', () => {
  const state = blankPrivateState()
  setPrivateEntry(state, 'viviana', { sessionId: 'session-a', unread: 0 })
  assert.equal(addPrivateUnread(state, 'viviana'), 1)
  assert.equal(addPrivateUnread(state, 'viviana', 2), 3)
  assert.equal(addPrivateUnread(state, 'nobody'), 0)
  assert.equal(clearPrivateUnread(state, 'viviana'), 0)
  assert.equal(privateEntryOf(state, 'viviana').unread, 0)
  assert.ok(privateEntryOf(state, 'viviana').lastSeenAt > 0)
})

test('私聊状态：按会话 id 反查是哪个 Bot 的', () => {
  const state = blankPrivateState()
  setPrivateEntry(state, 'viviana', { sessionId: 'session-a' })
  setPrivateEntry(state, 'nova', { sessionId: 'session-b' })
  assert.equal(privateBotOfSession(state, 'session-a'), 'viviana')
  assert.equal(privateBotOfSession(state, 'session-b'), 'nova')
  assert.equal(privateBotOfSession(state, 'session-c'), null)
  assert.equal(privateBotOfSession(state, ''), null)
})

test('私聊状态：覆盖同一条不会丢别的 Bot', () => {
  const state = blankPrivateState()
  setPrivateEntry(state, 'viviana', { sessionId: 'session-a', unread: 1 })
  setPrivateEntry(state, 'nova', { sessionId: 'session-b' })
  setPrivateEntry(state, 'viviana', { unread: 5 })
  assert.equal(privateEntryOf(state, 'viviana').unread, 5)
  assert.equal(privateEntryOf(state, 'viviana').sessionId, 'session-a')
  assert.equal(privateEntryOf(state, 'nova').sessionId, 'session-b')
})
