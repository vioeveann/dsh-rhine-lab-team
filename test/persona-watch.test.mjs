import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonaWatcher } from '../host/persona-watch.js'

/** 造一个可以手动改 mtime 的 statFn。 */
function fakeStat(initial = 0) {
  let mtime = initial
  const calls = []
  return {
    statFn: async (file) => {
      calls.push(file)
      if (mtime === 0) throw new Error('ENOENT')
      return { mtimeMs: mtime }
    },
    set(next) {
      mtime = next
    },
    calls,
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('人设窗口：开窗时先读基线，之后 mtime 变了才回调', async () => {
  const fake = fakeStat(1000)
  const seen = []
  const watcher = createPersonaWatcher({
    statFn: fake.statFn,
    intervalMs: 5,
    windowMs: 10_000,
    onChanged: (botId, info) => seen.push([botId, info.mtime]),
  })
  assert.equal(watcher.arm('viviana', 'soul.txt'), true)
  await tick(30)
  assert.deepEqual(seen, [], '基线没变不该回调')
  fake.set(2000)
  await tick(40)
  assert.deepEqual(seen, [['viviana', 2000]])
  // 回调过一次就摘窗，不重复触发
  await tick(30)
  assert.deepEqual(seen, [['viviana', 2000]])
  assert.deepEqual(watcher.armed, [])
  watcher.dispose()
})

test('人设窗口：文件还不存在时，出现的那一刻算改动', async () => {
  const fake = fakeStat(0)
  const seen = []
  const watcher = createPersonaWatcher({
    statFn: fake.statFn,
    intervalMs: 5,
    windowMs: 10_000,
    onChanged: (botId) => seen.push(botId),
  })
  watcher.arm('nova', 'soul.txt')
  await tick(20)
  assert.deepEqual(seen, [])
  fake.set(500)
  await tick(40)
  assert.deepEqual(seen, ['nova'])
  watcher.dispose()
})

test('人设窗口：重复点编辑人设，窗口往后推而不是叠加两个定时器', async () => {
  const fake = fakeStat(1000)
  const seen = []
  const watcher = createPersonaWatcher({
    statFn: fake.statFn,
    intervalMs: 5,
    windowMs: 10_000,
    onChanged: (botId) => seen.push(botId),
  })
  watcher.arm('viviana', 'soul.txt')
  watcher.arm('viviana', 'soul.txt')
  assert.deepEqual(watcher.armed, ['viviana'])
  fake.set(2000)
  await tick(40)
  assert.deepEqual(seen, ['viviana'])
  watcher.dispose()
})

test('人设窗口：过了窗口就自己停，不再回调', async () => {
  const fake = fakeStat(1000)
  const seen = []
  let clock = 0
  const watcher = createPersonaWatcher({
    statFn: fake.statFn,
    intervalMs: 5,
    windowMs: 50,
    now: () => clock,
    onChanged: (botId) => seen.push(botId),
  })
  watcher.arm('viviana', 'soul.txt')
  await tick(15)
  clock = 100
  fake.set(2000)
  await tick(40)
  assert.deepEqual(seen, [])
  assert.deepEqual(watcher.armed, [])
  watcher.dispose()
})

test('人设窗口：回调抛错不会把轮询打崩', async () => {
  const fake = fakeStat(1000)
  const debug = []
  const watcher = createPersonaWatcher({
    statFn: fake.statFn,
    intervalMs: 5,
    windowMs: 10_000,
    debug: async (event) => debug.push(event),
    onChanged: () => {
      throw new Error('boom')
    },
  })
  watcher.arm('viviana', 'soul.txt')
  fake.set(2000)
  await tick(40)
  assert.equal(watcher.armed.length, 0)
  assert.ok(debug.some((event) => event.event === 'persona-changed-failed'))
  watcher.dispose()
})
