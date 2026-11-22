/**
 * Real token usage: normalisation, frame extraction, per-session book and the
 * ledger sums the panel reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHARS_PER_TOKEN,
  createUsageBook,
  estimateTokensFromChars,
  mergeUsage,
  normalizeUsage,
  sumTaskTokens,
  usageOfFrame,
} from '../host/usage.js'

test('a provider payload keeps its breakdown and reported total', () => {
  const usage = normalizeUsage({
    inputTokens: 28586,
    outputTokens: 897,
    cacheReadTokens: 2944,
    cacheWriteTokens: 0,
    totalTokens: 32427,
  })
  assert.deepEqual(usage, {
    input: 28586,
    output: 897,
    cacheRead: 2944,
    cacheWrite: 0,
    total: 32427,
    steps: 1,
  })
})

test('a payload without a total adds its parts up', () => {
  const usage = normalizeUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
  assert.equal(usage.total, 125)
})

test('prompt/completion aliases are understood', () => {
  const usage = normalizeUsage({ promptTokens: 10, completionTokens: 4 })
  assert.equal(usage.input, 10)
  assert.equal(usage.output, 4)
  assert.equal(usage.total, 14)
})

test('all-zero and garbage payloads produce nothing', () => {
  assert.equal(normalizeUsage({ inputTokens: 0, outputTokens: 0 }), null)
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage('nope'), null)
})

test('negative and non-numeric fields clamp to zero', () => {
  const usage = normalizeUsage({ inputTokens: -5, outputTokens: 'abc', totalTokens: 7 })
  assert.equal(usage.input, 0)
  assert.equal(usage.output, 0)
  assert.equal(usage.total, 7)
})

test('usage is read only from a chunk frame of type usage', () => {
  const frame = {
    type: 'chunk',
    chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  }
  assert.equal(usageOfFrame({ agent: {}, frame }).total, 5)
  // 有些调用方直接给帧
  assert.equal(usageOfFrame(frame).total, 5)
})

test('other frames carry no usage', () => {
  assert.equal(usageOfFrame({ type: 'start' }), null)
  assert.equal(usageOfFrame({ type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } }), null)
  assert.equal(usageOfFrame({ type: 'end' }), null)
  assert.equal(usageOfFrame(undefined), null)
})

test('merge adds both sides without mutating them', () => {
  const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, steps: 1 }
  const b = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100, steps: 1 }
  const merged = mergeUsage(a, b)
  assert.equal(merged.total, 110)
  assert.equal(merged.steps, 2)
  assert.equal(a.total, 10)
  assert.equal(mergeUsage(null, b).total, 100)
  assert.equal(mergeUsage(a, null).total, 10)
  assert.equal(mergeUsage(null, null), null)
})

test('the book accumulates per session and take() forgets', () => {
  const book = createUsageBook()
  book.add('session-a', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, steps: 1 })
  book.add('session-a', { input: 3, output: 4, cacheRead: 5, cacheWrite: 0, total: 12, steps: 1 })
  book.add('session-b', { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, steps: 1 })
  assert.equal(book.get('session-a').total, 14)
  assert.equal(book.get('session-b').total, 1)

  const taken = book.take('session-a')
  assert.equal(taken.total, 14)
  assert.equal(book.get('session-a'), null)
  assert.equal(book.take('session-a'), null)
  // 领走 $a 不影响 $b
  assert.equal(book.get('session-b').total, 1)
})

test('the book ignores empty ids and empty usages', () => {
  const book = createUsageBook()
  book.add('', { total: 5, input: 5, output: 0, cacheRead: 0, cacheWrite: 0, steps: 1 })
  book.add('session-a', null)
  assert.equal(book.get(''), null)
  assert.equal(book.get('session-a'), null)
})

test('legacy rows fall back to the character estimate and are flagged', () => {
  assert.equal(estimateTokensFromChars(130), Math.round(130 / CHARS_PER_TOKEN))
  assert.equal(estimateTokensFromChars(-1), 0)
  assert.equal(estimateTokensFromChars('x'), 0)

  const sum = sumTaskTokens([
    { tokens: { total: 1000, input: 800, output: 200, cacheRead: 0 }, chars: 10 },
    { chars: 130 },
  ])
  assert.equal(sum.real, 1000)
  assert.equal(sum.estimated, 100)
  assert.equal(sum.partial, true)
  assert.deepEqual({ input: sum.input, output: sum.output }, { input: 800, output: 200 })
})

test('rows with real usage are never marked partial', () => {
  const sum = sumTaskTokens([
    { tokens: { total: 10, input: 8, output: 2, cacheRead: 0 }, chars: 500 },
    { tokens: { total: 5, input: 4, output: 1, cacheRead: 0 } },
  ])
  assert.equal(sum.real, 15)
  assert.equal(sum.estimated, 0)
  assert.equal(sum.partial, false)
})

test('an empty ledger sums to zero', () => {
  assert.deepEqual(sumTaskTokens([]), {
    real: 0,
    estimated: 0,
    partial: false,
    input: 0,
    output: 0,
    cacheRead: 0,
  })
  assert.deepEqual(sumTaskTokens(undefined).real, 0)
})

test('累计簿可以 dump 再 restore，重载不丢正在跑的用量', () => {
  const book = createUsageBook()
  book.add('session-a', { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, total: 125, steps: 1 })
  const dumped = book.dump()
  const restored = createUsageBook()
  restored.restore(JSON.parse(JSON.stringify(dumped)))
  assert.equal(restored.get('session-a').total, 125)
  // 坏数据不炸
  restored.restore({ 'session-b': null, '': { total: 1 } })
  assert.equal(restored.get(''), null)
})
