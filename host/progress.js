/**
 * Bot growth: three ranks, levels, experience sources and the elite gate.
 *
 * Ranks:
 *   0 「普通」      Lv1–20, any bot can promote for free once full.
 *   1 「精英化一阶」 Lv1–50, promotion needs 3 lessons + rates + level 50.
 *   2 「精英化二阶」 Lv1–90, the end of the line.
 *
 * Everything here is pure so the numbers can be tested without a runtime.
 */

/** Rank labels, in order. */
export const RANK_LABELS = ['普通', '精英化一阶', '精英化二阶']

/** Experience needed to go from `level` to `level + 1` in rank 0. */
export function normalCost(level) {
  return 15 + 2 * (level - 1)
}

/** Experience needed to go from `level` to `level + 1` in rank 1. */
export function eliteOneCost(level) {
  if (level <= 9) return 60 + 8 * (level - 1)
  return 120 + 14 * (level - 10)
}

/** Experience needed to go from `level` to `level + 1` in rank 2. */
export function eliteTwoCost(level) {
  return 150 + 20 * (level - 1)
}

/** Per-rank cost function and level cap. */
export function rankConfig(rank = 0) {
  if (rank >= 2) return { cost: eliteTwoCost, max: 90 }
  if (rank === 1) return { cost: eliteOneCost, max: 50 }
  return { cost: normalCost, max: 20 }
}

/** Cumulative experience to reach `level` from level 1. */
export function xpToReach(level, rank = 0) {
  const { cost } = rankConfig(rank)
  let total = 0
  for (let l = 1; l < level; l += 1) total += cost(l)
  return total
}

/**
 * Highest reachable level, including the rank-1 teaching gate.
 * @param rank - 0, 1 or 2.
 * @param teachCount - effective lessons.
 */
export function maxLevel(rank = 0, teachCount = 0) {
  if (rank >= 2) return 90
  // 一阶上限是 50，但 49 → 50 要凑满 3 条教学记录。
  if (rank === 1) return teachCount >= TEACH_GATE_COUNT ? 50 : 49
  return 20
}

/** Level implied by total experience, before the gate is applied. */
function rawLevel(totalXp, rank = 0) {
  const { cost, max } = rankConfig(rank)
  let level = 1
  let left = Math.max(0, Math.floor(totalXp))
  while (level < max && left >= cost(level)) {
    left -= cost(level)
    level += 1
  }
  return level
}

/**
 * Resolve the displayed level.
 * @param totalXp - everything earned in this rank.
 * @param rank - 0, 1 or 2.
 * @param teachCount - how many effective lessons it has.
 */
export function levelOf(totalXp, rank = 0, teachCount = 0) {
  const raw = rawLevel(totalXp, rank)
  const cap = maxLevel(rank, teachCount)
  const level = Math.min(raw, cap)
  const { cost } = rankConfig(rank)
  return {
    level,
    capped: raw > level,
    into: Math.max(0, Math.floor(totalXp) - xpToReach(level, rank)),
    need: level >= cap ? 0 : cost(level),
  }
}

/* ------------------------------------------------------------------ */
/* 获得                                                                */
/* ------------------------------------------------------------------ */

/** Base experience by task size. */
export const TASK_BASE = { quick: 40, normal: 140, complex: 190 }

/** Grade multipliers (additive with streak, capped). */
export const GRADE_MULT = { excellent: 1.5, good: 1.25, pass: 1.0, poor: 0.5 }

/** One effective lesson. */
export const TEACH_XP = 240
/** Lessons required to unlock level 50 in rank 1. */
export const TEACH_GATE_COUNT = 3
/** Same tag taught again inside this window earns nothing. */
export const TEACH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Repeat of a mistake the bot was already taught. */
export const REPEAT_PENALTY = 60
/** Bonus when a taught lesson stops a mistake from coming back (later phase). */
export const IMPROVEMENT_BONUS = 120
/** 「教后不再犯」要守住的观察期：教下之后干满这么多件活（期间没复犯）才许确认 +120。 */
export const IMPROVE_CLEAN_TASKS = 2

/** Streak bonus: +25% per 5 consecutive good reviews, capped at +200%. */
export function streakBonus(streak = 0) {
  const steps = Math.floor(Math.max(0, streak) / 5)
  return Math.min(2, steps * 0.25)
}

/** Same-day decay for the n-th finished task. */
export function sameDayDecay(nth = 1) {
  return 1 / (1 + 0.15 * Math.max(0, nth - 1))
}

/**
 * Experience for one accepted task.
 * Grade and streak add up (never multiply); the total multiplier is capped.
 * @param options - { size, grade, streak, nthToday }.
 */
export function taskGain(options = {}) {
  const base = TASK_BASE[options.size] ?? TASK_BASE.normal
  const grade = GRADE_MULT[options.grade] ?? 1
  const mult = Math.min(3, grade + streakBonus(options.streak))
  const decay = sameDayDecay(options.nthToday ?? 1)
  return Math.round(base * mult * decay)
}

/** Whether teaching this tag counts as a lesson now. */
export function teachingCounts(lastTaughtAt, now = Date.now()) {
  if (!Number.isFinite(lastTaughtAt)) return true
  return now - lastTaughtAt >= TEACH_WINDOW_MS
}
