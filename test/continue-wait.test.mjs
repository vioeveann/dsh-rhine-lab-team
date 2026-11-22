/**
 * 续聊等待：状态不转 idle 时也要能认出「新回复已经落盘」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { pickContinueAgent, readSessionTurnReply, waitForContinuedReply, waitForSessionTurnReply } from '../host/tools.js'

function sessionWith(text) {
  return {
    snapshotEvents: () => [
      { type: 'assistant/message', message: { content: [{ type: 'text', text }] } },
    ],
  }
}

test('续聊：idle + 新文字立即返回', async () => {
  const agent = { status: 'idle', session: sessionWith('第二版回复') }
  const result = await waitForContinuedReply(() => agent, '第一版回复', 3_000)
  assert.equal(result.why, 'ok')
  assert.equal(result.text, '第二版回复')
})

test('续聊：状态一直是 running，但新文字稳定两次也返回', async () => {
  let text = '第一版回复'
  const agent = {
    status: 'running',
    get session() {
      return sessionWith(text)
    },
  }
  setTimeout(() => {
    text = '第二版回复'
  }, 50)
  const startedAt = Date.now()
  const result = await waitForContinuedReply(() => agent, '第一版回复', 5_000)
  assert.equal(result.why, 'ok')
  assert.equal(result.text, '第二版回复')
  assert.ok(Date.now() - startedAt < 4_000, '不该拖到超时')
})

test('续聊：liveChildren 里的新 agent 优先于 agents.get 的旧对象', () => {
  const fresh = { status: 'idle', tag: 'fresh' }
  const stale = { status: 'idle', tag: 'stale' }
  const live = new Map([['session-x', fresh]])
  const registry = { get: () => stale }
  assert.equal(pickContinueAgent('session-x', live, registry), fresh)
  assert.equal(pickContinueAgent('session-y', live, registry), stale)
})

test('续聊：文字没变就不算回来', async () => {
  const agent = { status: 'idle', session: sessionWith('第一版回复') }
  const result = await waitForContinuedReply(() => agent, '第一版回复', 800)
  assert.equal(result.why, 'timeout')
})

test('续聊：agent 的 session 是空的，靠落盘文件也能认出回复', async () => {
  const emptySession = { snapshotEvents: () => [] }
  const agent = { status: 'idle', session: emptySession }
  let disk = ''
  setTimeout(() => {
    disk = '落盘的第二版回复'
  }, 50)
  const startedAt = Date.now()
  const result = await waitForContinuedReply(() => agent, '第一版回复', 5_000, {
    readDiskText: async () => disk,
  })
  assert.equal(result.why, 'ok')
  assert.equal(result.text, '落盘的第二版回复')
  assert.ok(Date.now() - startedAt < 3_000, '不该拖到超时')
})

async function writeSession(root, sessionId, events) {
  const dir = join(root, 'some-cwd', sessionId)
  await mkdir(dir, { recursive: true })
  const body = events
    .map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
    .reduce((all, frame) => Buffer.concat([all, frame]), Buffer.alloc(0))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), body)
}

async function appendSession(root, sessionId, events) {
  const file = join(root, 'some-cwd', sessionId, 'session.v4.jsonl.zstd')
  const body = events
    .map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
    .reduce((all, frame) => Buffer.concat([all, frame]), Buffer.alloc(0))
  await appendFile(file, body)
}

test('落盘读取：只取 afterTime 之后那一轮的最后一句', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-'))
  const sessionId = 'session-test-1'
  const first = 1_000
  const second = 2_000
  await writeSession(root, sessionId, [
    { type: 'turn/start', time: first },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } } },
    { type: 'turn/end', time: first + 1 },
    { type: 'turn/start', time: second },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新回复' }] } } },
    { type: 'turn/end', time: second + 1 },
  ])
  assert.equal(await readSessionTurnReply(sessionId, second, root), '新回复')
  assert.equal(await readSessionTurnReply(sessionId, second + 2, root), '')
  assert.equal(await readSessionTurnReply('session-missing', 0, root), '')
})

test('落盘等待：新回复和上一轮一字不差，也算回来了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-'))
  const sessionId = 'session-test-3'
  await writeSession(root, sessionId, [
    { type: 'turn/start', time: 1_000 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OK' }] } } },
    { type: 'turn/end', time: 1_001 },
    { type: 'turn/start', time: 3_000 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OK' }] } } },
    { type: 'turn/end', time: 3_001 },
  ])
  const result = await waitForSessionTurnReply(sessionId, 2_000, 3_000, {
    root,
    baselineText: 'OK',
  })
  assert.equal(result.why, 'ok')
  assert.equal(result.text, 'OK')
})

test('落盘等待：子会话一落盘就返回，不空等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-'))
  const sessionId = 'session-test-2'
  await writeSession(root, sessionId, [
    { type: 'turn/start', time: 1_000 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } } },
    { type: 'turn/end', time: 1_001 },
  ])
  const startedAt = Date.now()
  const waiting = waitForSessionTurnReply(sessionId, 2_000, 10_000, {
    root,
    baselineText: '旧回复',
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  await appendSession(root, sessionId, [
    { type: 'turn/start', time: 3_000 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新回复' }] } } },
    { type: 'turn/end', time: 3_001 },
  ])
  const result = await waiting
  assert.equal(result.why, 'ok')
  assert.equal(result.text, '新回复')
  assert.ok(Date.now() - startedAt < 2_000, '应在文件变化后立即返回，不拖到兜底轮询')
})
