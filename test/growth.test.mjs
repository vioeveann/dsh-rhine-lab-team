/**
 * Growth state: settlement, rates, gates and promotion across three ranks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyGrowth,
  growthDetail,
  growthRates,
  growthSummary,
  improveReady,
  normalizeGrowth,
  promote,
  promoteReady,
  regrade,
  settleImprovement,
  settleRepeat,
  settleTask,
  settleTeaching,
  teachCount,
} from '../host/growth.js'
import { TEACH_WINDOW_MS, xpToReach } from '../host/progress.js'
import { SPEECH_MAX } from '../host/speech.js'

const lesson = (tag, text = '这类图要按外墙退线，不要按阳台算') => ({ tag, text })

test('a new bot starts as 普通, level 1', () => {
  assert.deepEqual(normalizeGrowth(null), emptyGrowth())
  assert.equal(emptyGrowth().rank, 0)
  assert.equal(growthSummary(emptyGrowth()).label, '普通')
})

test('older elite fields migrate onto ranks', () => {
  assert.equal(normalizeGrowth({ elite: 1 }).rank, 1)
  assert.equal(normalizeGrowth({ elite: 2 }).rank, 2)
  assert.equal(normalizeGrowth({ elite: 9 }).rank, 0)
})

test('lessons are trimmed and capped', () => {
  const growth = normalizeGrowth({ teaches: [{ tag: 'A', at: 1, text: 'x'.repeat(400) }] })
  assert.equal(growth.teaches[0].tag, 'A')
  assert.equal(growth.teaches[0].text.length, 200)
})

test('an accepted task moves experience and stats', () => {
  const { growth, gained } = settleTask(emptyGrowth(), { size: 'normal', grade: 'good', nthToday: 1 })
  assert.equal(gained, 175)
  assert.equal(growth.totalXp, 175)
  assert.equal(growth.stats.good, 1)
  assert.equal(growth.streak, 1)
})

test('a poor grade resets the streak', () => {
  const afterTwo = settleTask(settleTask(emptyGrowth(), { grade: 'good' }).growth, { grade: 'good' }).growth
  assert.equal(afterTwo.streak, 2)
  const { growth } = settleTask(afterTwo, { grade: 'poor' })
  assert.equal(growth.streak, 0)
  assert.equal(growth.stats.poor, 1)
})

test('teaching needs a tag and enough text', () => {
  assert.equal(settleTeaching(emptyGrowth(), { tag: '', text: '够长的一句话写着' }).ok, false)
  assert.equal(settleTeaching(emptyGrowth(), { tag: 'a', text: '太短' }).ok, false)
})

test('teaching pays once per week per tag', () => {
  const now = 1_700_000_000_000
  const first = settleTeaching(emptyGrowth(), { ...lesson('retro'), now })
  assert.equal(first.ok, true)
  assert.equal(first.gained, 240)
  const again = settleTeaching(first.growth, { ...lesson('retro'), now: now + 1000 })
  assert.equal(again.ok, false)
  const later = settleTeaching(first.growth, { ...lesson('retro'), now: now + TEACH_WINDOW_MS })
  assert.equal(later.ok, true)
})

test('different tags each count as a lesson', () => {
  const now = 1_700_000_000_000
  const one = settleTeaching(emptyGrowth(), { ...lesson('retro'), now })
  const two = settleTeaching(one.growth, { ...lesson('drawing'), now })
  assert.equal(two.ok, true)
  assert.equal(teachCount(two.growth), 2)
})

test('repeating an untaught mistake is not a penalty', () => {
  assert.equal(settleRepeat(emptyGrowth(), { tag: 'retro' }).ok, false)
})

test('repeating a taught mistake costs experience and resets the streak', () => {
  const now = 1_700_000_000_000
  const taught = settleTeaching(emptyGrowth(), { ...lesson('retro'), now }).growth
  const leveled = settleTask(taught, { grade: 'good' }).growth
  const { ok, growth, lost } = settleRepeat(leveled, { tag: 'retro' })
  assert.equal(ok, true)
  assert.equal(lost, 60)
  assert.equal(growth.totalXp, leveled.totalXp - 60)
  assert.equal(growth.streak, 0)
  assert.equal(growth.stats.repeats, 1)
})

test('rates are null until there is something to measure', () => {
  const summary = growthSummary(emptyGrowth())
  assert.equal(summary.goodRate, null)
  assert.equal(summary.repeatRate, null)
})

test('good rate is computed from real records', () => {
  let growth = emptyGrowth()
  growth = settleTask(growth, { grade: 'excellent' }).growth
  growth = settleTask(growth, { grade: 'good' }).growth
  growth = settleTask(growth, { grade: 'pass' }).growth
  growth = settleTask(growth, { grade: 'poor' }).growth
  assert.equal(growthSummary(growth).goodRate, 0.5)
})

test('普通 promotes to 精英化一阶 with no requirements once full', () => {
  const notFull = { ...emptyGrowth(), totalXp: 100 }
  assert.equal(promoteReady(notFull), false)
  const full = { ...emptyGrowth(), totalXp: xpToReach(20, 0) }
  assert.equal(promoteReady(full), true)
  const result = promote(full, 1)
  assert.equal(result.ok, true)
  assert.equal(result.growth.rank, 1)
  assert.equal(result.growth.totalXp, 0)
})

test('精英化一阶 needs three lessons, good rate and level 50', () => {
  let growth = { ...emptyGrowth(), rank: 1 }
  for (const tag of ['a', 'b', 'c']) growth = settleTeaching(growth, lesson(tag, '一条足够长的教学说明文字')).growth
  for (let i = 0; i < 4; i += 1) growth = settleTask(growth, { grade: 'excellent' }).growth
  assert.equal(promoteReady(growth), false, '等级还没满 50')
  const filled = { ...growth, totalXp: xpToReach(50, 1) }
  assert.equal(promoteReady(filled), true)
  const result = promote(filled, 1)
  assert.equal(result.growth.rank, 2)
  assert.equal(result.growth.totalXp, 0)
  assert.equal(result.growth.teaches.length, 3)
  assert.equal(result.growth.promotions.length, 1)
  // 好评率按段位重算：上一档的评分样本清零，复犯和教学保留。
  assert.equal(result.growth.stats.excellent, 0)
  assert.equal(result.growth.stats.good, 0)
  assert.equal(growthRates(result.growth).goodRate, null)
  assert.equal(result.growth.stats.repeats, growth.stats.repeats)
})

test('a bot that keeps repeating lessons cannot promote on rate alone', () => {
  let growth = { ...emptyGrowth(), rank: 1 }
  for (const tag of ['a', 'b', 'c']) growth = settleTeaching(growth, lesson(tag, '一条足够长的教学说明文字')).growth
  growth = settleRepeat(growth, { tag: 'a' }).growth
  growth = { ...growth, totalXp: xpToReach(50, 1) }
  assert.equal(promoteReady(growth), false, '复犯率 1/3 过高')
})

test('精英化二阶 is the end of the line', () => {
  const top = { ...emptyGrowth(), rank: 2, totalXp: 999999 }
  assert.equal(promote(top).ok, false)
  assert.equal(promoteReady(top), false)
  assert.equal(growthSummary(top).level, 90)
})

test('a new bot starts with no level timestamp, a level-up stamps it', () => {
  assert.equal(emptyGrowth().levelSince, 0)
  const { growth } = settleTask(emptyGrowth(), { grade: 'excellent', size: 'complex', nthToday: 1, now: 1_700_000_000_000 })
  assert.equal(growth.levelSince, 1_700_000_000_000)
})

test('promotion stamps the new rank start and clears experience', () => {
  const full = { ...emptyGrowth(), totalXp: xpToReach(20, 0) }
  const result = promote(full, 1_700_000_000_000)
  assert.equal(result.ok, true)
  assert.equal(result.growth.levelSince, 1_700_000_000_000)
  assert.equal(result.growth.totalXp, 0)
})

test('a promotion speech survives normalization, capped and never blank', () => {
  const kept = normalizeGrowth({ promotions: [{ at: 1, from: 0, to: 1, speech: '往下走一步。' }] })
  assert.equal(kept.promotions[0].speech, '往下走一步。')
  const capped = normalizeGrowth({ promotions: [{ at: 1, from: 0, to: 1, speech: '字'.repeat(900) }] })
  assert.equal(capped.promotions[0].speech.length, SPEECH_MAX)
  const blank = normalizeGrowth({ promotions: [{ at: 1, from: 0, to: 1, speech: '   ' }] })
  assert.equal('speech' in blank.promotions[0], false)
})

test('the growth archive carries samples, lessons and promotions', () => {  const detail = growthDetail({
    rank: 1,
    totalXp: 100,
    teaches: [{ tag: '口径', at: 1, text: '日期写 YYYY-MM-DD' }],
    stats: { excellent: 2, good: 1, pass: 0, poor: 0, repeats: 1, improvements: 0 },
    promotions: [
      { at: 10, from: 0, to: 1, speech: '往下走一步。' },
      { at: 20, from: 1, to: 2 },
    ],
  })
  assert.equal(detail.summary.rank, 1)
  assert.equal(detail.summary.label, '精英化一阶')
  assert.equal(detail.teaches[0].tag, '口径')
  assert.equal(detail.stats.repeats, 1)
  assert.equal(detail.promotions[0].speech, '往下走一步。')
  // 没写的感言不能凭空补一句
  assert.equal('speech' in detail.promotions[1], false)
})

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

/** 教下之后又干了 n 件活的时间轴。 */
const workedAfter = (lessonAt, count) => Array.from({ length: count }, (_value, index) => ({
  at: lessonAt + (index + 1) * 60_000,
  grade: 'good',
}))

test('a lesson can be confirmed once two jobs have been done clean', () => {
  const growth = {
    ...emptyGrowth(),
    teaches: [{ tag: '退线', at: NOW, text: '退线按外墙算' }],
    taskLog: workedAfter(NOW, 2),
  }
  const ready = improveReady(growth, '退线', NOW + DAY)
  assert.equal(ready.ok, true)
  assert.equal(ready.done, 2)
  const result = settleImprovement(growth, { tag: '退线', now: NOW + DAY })
  assert.equal(result.ok, true)
  assert.equal(result.gained, 120)
  assert.equal(result.growth.teaches[0].confirmedAt, NOW + DAY)
  assert.equal(result.growth.stats.improvements, 1)
  // 同一条教学只给一次
  assert.equal(settleImprovement(result.growth, { tag: '退线', now: NOW + DAY }).ok, false)
})

test('one job, a repeat, or an unknown tag cannot be confirmed', () => {
  const oneJob = {
    ...emptyGrowth(),
    teaches: [{ tag: '图号', at: NOW + 10 * 60_000, text: '图号写版本' }],
    taskLog: [
      { at: NOW + 60_000, grade: 'good' },
      // 教下之后只干了一件
      { at: NOW + 15 * 60_000, grade: 'good' },
    ],
  }
  // 只干了一件在教下之后
  assert.match(improveReady(oneJob, '图号', NOW + DAY).reason, /才做了 1 件活/)

  const repeated = {
    ...emptyGrowth(),
    teaches: [{ tag: '口径', at: NOW, text: '日期写满' }],
    taskLog: workedAfter(NOW, 2),
    repeatLog: [{ tag: '口径', at: NOW + 90_000 }],
  }
  assert.match(improveReady(repeated, '口径', NOW + DAY).reason, /又犯过/)

  assert.equal(improveReady(emptyGrowth(), '没教过', NOW).ok, false)
  assert.equal(settleImprovement(repeated, { tag: '口径', now: NOW + DAY }).ok, false)
})

test('a repeat is recorded with its tag so "kept clean" can be checked', () => {
  const growth = { ...emptyGrowth(), teaches: [{ tag: '退线', at: NOW - 2 * DAY, text: '退线按外墙算' }] }
  const result = settleRepeat(growth, { tag: '退线', now: NOW })
  assert.equal(result.ok, true)
  assert.deepEqual(result.growth.repeatLog, [{ tag: '退线', at: NOW }])
})

test('each settled task is logged so "two more jobs" can be counted', () => {
  const growth = settleTask(emptyGrowth(), { grade: 'good', now: NOW }).growth
  assert.deepEqual(growth.taskLog, [{ at: NOW, grade: 'good' }])
})

test('用户改判评分：旧样本扣掉、新样本记上，经验不动', () => {
  let growth = settleTask(emptyGrowth(), { grade: 'good', size: 'normal' }).growth
  const xpBefore = growth.totalXp
  const toPoor = regrade(growth, { from: 'good', to: 'poor' })
  assert.equal(toPoor.ok, true)
  assert.equal(toPoor.growth.stats.good, 0, '旧档样本要扣掉')
  assert.equal(toPoor.growth.stats.poor, 1, '用户说不行就记一档差')
  assert.equal(toPoor.growth.totalXp, xpBefore, '经验不追缴')
  assert.equal(growthRates(toPoor.growth).goodRate, 0)

  // 用户夸回来，差样本换成优秀
  const toPraise = regrade(toPoor.growth, { from: 'poor', to: 'excellent' })
  assert.equal(toPraise.growth.stats.poor, 0)
  assert.equal(toPraise.growth.stats.excellent, 1)
  // 旧档没样本时不乱扣别人的
  const noDouble = regrade(toPraise.growth, { from: 'poor', to: 'poor' })
  assert.equal(noDouble.growth.stats.excellent, 1)
})
