/**
 * Task brief composition.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIEF_SECTIONS, buildTaskPrompt } from '../host/brief.js'

test('a lone task still produces a usable prompt', () => {
  const prompt = buildTaskPrompt({ task: '核对这份材料的退线' })
  assert.match(prompt, /核对这份材料的退线/)
  assert.match(prompt, /做完直接回结论/)
})

test('structured fields appear in the documented order', () => {
  const prompt = buildTaskPrompt({
    task: '核对指标',
    goal: '确认容积率没错',
    deliverable: '一张对照表',
    accept: '每个数字都有出处',
    redlines: '不许改原文件',
    materials: 'D:/工作区/方案.pdf',
  })
  const order = ['核对指标', '目标：', '交付物：', '验收标准：', '红线：', '材料：']
  const positions = order.map((needle) => prompt.indexOf(needle))
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1], `${order[index]} should follow ${order[index - 1]}`)
  }
})

test('empty optional fields are skipped, not printed as blanks', () => {
  const prompt = buildTaskPrompt({ task: '做一件事', goal: '  ', redlines: '别删东西' })
  assert.ok(!prompt.includes('目标：'))
  assert.match(prompt, /红线：别删东西/)
})

test('no content yields an empty string', () => {
  assert.equal(buildTaskPrompt({}), '')
  assert.equal(buildTaskPrompt({ task: '   ' }), '')
})

test('the section list is the source of truth', () => {
  assert.deepEqual(BRIEF_SECTIONS.map(([key]) => key), ['goal', 'deliverable', 'accept', 'redlines', 'materials'])
})
