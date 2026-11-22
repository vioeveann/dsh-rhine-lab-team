/**
 * Growth curve and experience sources across the three ranks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  eliteOneCost,
  eliteTwoCost,
  GRADE_MULT,
  IMPROVEMENT_BONUS,
  levelOf,
  maxLevel,
  normalCost,
  RANK_LABELS,
  REPEAT_PENALTY,
  sameDayDecay,
  streakBonus,
  TASK_BASE,
  taskGain,
  TEACH_GATE_COUNT,
  TEACH_WINDOW_MS,
  TEACH_XP,
  teachingCounts,
  xpToReach,
} from '../host/progress.js'

test('the three ranks are labelled', () => {
  assert.deepEqual(RANK_LABELS, ['普通', '精英化一阶', '精英化二阶'])
})

test('the normal rank is short and cheap', () => {
  assert.equal(normalCost(1), 15)
  assert.equal(normalCost(19), 51)
  const total = xpToReach(20, 0)
  assert.ok(total > 400 && total < 900, `unexpected total ${total}`)
  assert.equal(levelOf(total, 0, 0).level, 20)
})

test('a normal bot reaches 20 after a few decent tasks', () => {
  const total = xpToReach(20, 0)
  let xp = 0
  let n = 0
  while (xp < total && n < 10) {
    n += 1
    xp += taskGain({ size: 'normal', grade: 'good', streak: n, nthToday: n })
  }
  assert.ok(n <= 6, `需要 ${n} 件任务，太多了`)
})

test('elite one keeps the old curve', () => {
  assert.equal(eliteOneCost(1), 60)
  assert.equal(eliteOneCost(49), 666)
  const total = xpToReach(50, 1)
  assert.ok(total > 15000 && total < 17500, `unexpected total ${total}`)
})

test('elite two costs more per level', () => {
  assert.equal(eliteTwoCost(1), 150)
  assert.ok(eliteTwoCost(20) > eliteOneCost(20))
})

test('experience accumulates level by level', () => {
  assert.equal(xpToReach(1, 1), 0)
  assert.equal(xpToReach(2, 1), eliteOneCost(1))
  assert.equal(xpToReach(3, 1), eliteOneCost(1) + eliteOneCost(2))
})

test('一阶 49 起，凑满 3 条教学才到 50', () => {
  const rich = 999999
  assert.equal(levelOf(rich, 1, 0).level, 49)
  assert.equal(levelOf(rich, 1, 0).capped, true, '经验够了但教学不够，标 capped')
  assert.equal(levelOf(rich, 1, TEACH_GATE_COUNT).level, 50)
})

test('the normal rank stops at 20', () => {
  assert.equal(levelOf(999999, 0, 0).level, 20)
  assert.equal(maxLevel(0, 0), 20)
  assert.equal(maxLevel(1, 0), 49)
  assert.equal(maxLevel(1, 3), 50)
  assert.equal(maxLevel(0), 20)
  assert.equal(maxLevel(2), 90)
  assert.equal(maxLevel(2, 0), 90)
})

test('levelOf reports progress inside the current level', () => {
  const xp = xpToReach(5, 1) + 30
  const info = levelOf(xp, 1, 0)
  assert.equal(info.level, 5)
  assert.equal(info.into, 30)
  assert.equal(info.need, eliteOneCost(5))
})

test('streak bonus is +25% per five good reviews, capped at +200%', () => {
  assert.equal(streakBonus(0), 0)
  assert.equal(streakBonus(4), 0)
  assert.equal(streakBonus(5), 0.25)
  assert.equal(streakBonus(100), 2)
})

test('same-day decay lowers later tasks but never below zero', () => {
  assert.equal(sameDayDecay(1), 1)
  assert.ok(sameDayDecay(3) < sameDayDecay(2))
  assert.ok(sameDayDecay(50) > 0)
})

test('grade and streak add up, total multiplier capped at 3x', () => {
  const base = TASK_BASE.normal
  assert.equal(taskGain({ size: 'normal', grade: 'pass', streak: 0, nthToday: 1 }), base)
  assert.equal(taskGain({ size: 'normal', grade: 'good', streak: 0, nthToday: 1 }), Math.round(base * GRADE_MULT.good))
  const capped = taskGain({ size: 'normal', grade: 'excellent', streak: 40, nthToday: 1 })
  assert.equal(capped, base * 3)
})

test('task sizes are priced differently', () => {
  assert.ok(TASK_BASE.quick < TASK_BASE.normal)
  assert.ok(TASK_BASE.normal < TASK_BASE.complex)
})

test('constants match the agreed spec', () => {
  assert.equal(TEACH_XP, 240)
  assert.equal(TEACH_GATE_COUNT, 3)
  assert.equal(REPEAT_PENALTY, 60)
  assert.equal(IMPROVEMENT_BONUS, 120)
  assert.equal(TEACH_WINDOW_MS, 7 * 24 * 60 * 60 * 1000)
})

test('the same tag taught again inside a week earns nothing', () => {
  const now = 1_000_000_000_000
  assert.equal(teachingCounts(undefined, now), true)
  assert.equal(teachingCounts(now - 1000, now), false)
  assert.equal(teachingCounts(now - TEACH_WINDOW_MS, now), true)
})
