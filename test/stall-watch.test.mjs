/**
 * 监考：停滞 / 打转。
 *
 * 只测确定性部分：文件多久没长、同一工具同一组参数重复几次。不测模型语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { classifyCheckinReply, readSessionDigest, startStallWatch, waitForSessionTurnReply } from '../host/tools.js'

function frame(event) {
  return zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8'))
}

async function writeSession(root, sessionId, events) {
  const dir = join(root, 'some-cwd', sessionId)
  await mkdir(dir, { recursive: true })
  const body = events.map(frame).reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), body)
}

function call(name, args, seq) {
  return { type: 'tool/call', seq, time: Date.now(), data: { name, arguments: args } }
}

async function appendEvent(root, sessionId, event) {
  const dir = join(root, 'some-cwd', sessionId)
  await appendFile(join(dir, 'session.v4.jsonl.zstd'), frame(event))
}

test('停滞：到点先问「是不是卡住了」，没有回答也没有新动作才判 stalled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stall-'))
  const sessionId = 'session-stall-1'
  await writeSession(root, sessionId, [{ type: 'turn/start', time: Date.now() }])
  const nudges = []
  const watch = startStallWatch(sessionId, {
    root,
    warnMs: 30,
    graceMs: 80,
    nudge: (text) => nudges.push(text),
  })
  let timer
  const why = await Promise.race([
    watch.promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('test-timeout'), 8000)
    }),
  ])
  clearTimeout(timer)
  assert.equal(why, 'stalled')
  assert.ok(nudges.length >= 1)
  assert.match(nudges[0], /是不是卡住了/)
})

test('停滞：两次询问没回答、日志也不动，就停掉当前 turn 再问一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cancel-'))
  const sessionId = 'session-cancel-1'
  await writeSession(root, sessionId, [{ type: 'turn/start', time: Date.now() }])
  const nudges = []
  let cancelled = 0
  const watch = startStallWatch(sessionId, {
    root,
    warnMs: 30,
    graceMs: 80,
    nudge: async (text) => {
      nudges.push(text)
      // 模拟真实插件：提醒消息会写进子会话，不能把它当成 BOT 的进展。
      await appendEvent(root, sessionId, { type: 'user/message', time: Date.now(), data: { text } })
    },
    cancel: async () => {
      cancelled += 1
    },
  })
  let timer
  const why = await Promise.race([
    watch.promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('test-timeout'), 8000)
    }),
  ])
  clearTimeout(timer)
  assert.equal(why, 'stalled')
  assert.equal(cancelled, 1)
  assert.ok(watch.cancelledAt > 0)
  assert.ok(nudges.length >= 3)
  assert.ok(nudges.some((text) => /刚才停掉了/.test(text)))
})

test('打转：同一工具同一组参数重复 8 次就判 loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-'))
  const sessionId = 'session-loop-1'
  const events = [{ type: 'turn/start', time: Date.now() }]
  for (let i = 0; i < 8; i += 1) events.push(call('ops_bash', { command: 'ls' }, i + 1))
  await writeSession(root, sessionId, events)
  const nudges = []
  const watch = startStallWatch(sessionId, {
    root,
    warnMs: 60_000,
    nudge: (text) => nudges.push(text),
  })
  const why = await watch.promise
  assert.equal(why, 'loop')
  assert.ok(nudges.some((text) => /同一个工具/.test(text)))
})

test('readSessionDigest 只数最后一轮，不把上一轮算进打转', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-digest-'))
  const sessionId = 'session-digest-1'
  const events = [
    { type: 'turn/start', time: 1 },
    call('ops_bash', { command: 'old' }, 1),
    call('ops_bash', { command: 'old' }, 2),
    call('ops_bash', { command: 'old' }, 3),
    { type: 'turn/end', time: 2 },
    { type: 'turn/start', time: 3 },
    call('ops_bash', { command: 'new' }, 4),
  ]
  await writeSession(root, sessionId, events)
  const digest = await readSessionDigest(sessionId, root)
  assert.equal(digest.maxRepeat, 1)
})

test('续聊等待：没回复且没动作时返回 stalled，不空等满超时', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wait-stall-'))
  const sessionId = 'session-wait-1'
  await writeSession(root, sessionId, [{ type: 'turn/start', time: Date.now() - 1000 }])
  const nudges = []
  const { why } = await waitForSessionTurnReply(sessionId, Date.now() - 5000, 10_000, {
    root,
    stallWarnMs: 40,
    stallGraceMs: 100,
    nudge: (text) => nudges.push(text),
  })
  assert.equal(why, 'stalled')
  assert.ok(nudges.length >= 1)
})

test('答复分流：正常/卡住分开认', () => {
  assert.equal(classifyCheckinReply('没卡住，在等 npm 命令'), 'normal')
  assert.equal(classifyCheckinReply('正常，还在跑测试'), 'normal')
  assert.equal(classifyCheckinReply('卡住了，工具一直超时'), 'stuck')
  assert.equal(classifyCheckinReply('刚才卡死，已经调整好了'), 'stuck')
})

test('监考：BOT 回答「正常，在等」就把下一次询问推后，不判卡', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checkin-'))
  const sessionId = 'session-checkin-1'
  await writeSession(root, sessionId, [{ type: 'turn/start', time: Date.now() }])
  const watch = startStallWatch(sessionId, {
    root,
    warnMs: 30,
    askMs: 60_000,
    graceMs: 1500,
    maxNormal: 10,
    nudge: () => {},
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await appendEvent(root, sessionId, {
    type: 'assistant/message',
    time: Date.now(),
    data: { message: { content: [{ type: 'text', text: '正常，在等编译' }] } },
  })
  await new Promise((resolve) => setTimeout(resolve, 800))
  let settled = null
  void watch.promise.then((why) => {
    settled = why
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(settled, null, '回答正常后不应立刻判卡')
  watch.stop()
})
