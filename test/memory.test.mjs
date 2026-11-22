/**
 * Offline checks for the memory search: tag hits must outrank plain substring
 * hits, and a miss must return nothing (so a bot can say "没记过").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallLines } from '../host/tools.js'

const memory = [
  '# 标题不算',
  '',
  '[沙箱] 子会话运行在 workspace-write 下，工作区外写不出去。',
  '[插件] 派活走 subagents.startActivation，delivery: caller 才能同步拿结果。',
  '[文档] runtime-notes.md 记录了五个坑。',
].join('\n')

test('a tag hit is returned', () => {
  const hits = recallLines(memory, '沙箱')
  assert.equal(hits.length, 1)
  assert.match(hits[0], /workspace-write/)
})

test('a substring hit is returned too', () => {
  const hits = recallLines(memory, 'runtime-notes')
  assert.equal(hits.length, 1)
  assert.match(hits[0], /\[文档\]/)
})

test('a tag hit outranks a substring hit', () => {
  const hits = recallLines(memory, '插件', 2)
  assert.match(hits[0], /\[插件\]/)
})

test('headings and blank lines never come back', () => {
  const hits = recallLines(memory, '标题')
  assert.deepEqual(hits, [])
})

test('a miss returns an empty list', () => {
  assert.deepEqual(recallLines(memory, '完全不存在的词'), [])
})

test('limit caps the number of lines', () => {
  const many = Array.from({ length: 20 }, (_, index) => `[标签${index}] 关于图纸的一条`).join('\n')
  assert.equal(recallLines(many, '图纸', 3).length, 3)
})
