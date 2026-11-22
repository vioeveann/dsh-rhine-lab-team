/**
 * Growth state for one bot: rank, experience, lessons, streaks and the
 * statistics that decide whether the numbers are telling the truth.
 *
 * The state lives on the bot definition (`growth`), so exporting the roster
 * carries the growth with it.
 */
import {
  GRADE_MULT,
  IMPROVEMENT_BONUS,
  IMPROVE_CLEAN_TASKS,
  levelOf,
  maxLevel,
  RANK_LABELS,
  REPEAT_PENALTY,
  taskGain,
  TEACH_GATE_COUNT,
  TEACH_WINDOW_MS,
  TEACH_XP,
  teachingCounts,
} from './progress.js'
import { SPEECH_MAX } from './speech.js'

const MAX_LESSONS = 200
const MAX_TAG = 24
const MAX_LESSON_TEXT = 200

/** A brand new bot's growth: 普通 rank, level 1. */
export function emptyGrowth() {
  return {
    rank: 0,
    totalXp: 0,
    streak: 0,
    teaches: [],
    stats: { excellent: 0, good: 0, pass: 0, poor: 0, repeats: 0, improvements: 0 },
    promotions: [],
    // 复犯按 tag 记，用来判断「教后有没有再犯」；老的 stats.repeats 只有次数。
    repeatLog: [],
    // 每件被验收的活记一条时间，用来数「教下之后又干了几件」。
    taskLog: [],
    // 到达当前等级的时间：同星同级时据此排队。
    levelSince: 0,
  }
}

/**
 * Older files used `elite: 1 | 2`; map them onto ranks.
 * @param raw - parsed JSON.
 */
function rankOf(raw) {
  if (raw.rank === 0 || raw.rank === 1 || raw.rank === 2) return raw.rank
  if (raw.elite === 2) return 2
  if (raw.elite === 1) return 1
  return 0
}

/**
 * Coerce whatever is on disk into a valid growth object.
 * @param raw - parsed JSON or anything.
 */
export function normalizeGrowth(raw) {
  const base = emptyGrowth()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const rank = rankOf(raw)
  const totalXp = Number.isFinite(raw.totalXp) ? Math.max(0, Math.floor(raw.totalXp)) : 0
  const streak = Number.isFinite(raw.streak) ? Math.max(0, Math.floor(raw.streak)) : 0
  const teaches = Array.isArray(raw.teaches)
    ? raw.teaches
      .filter((entry) => entry && typeof entry.tag === 'string' && entry.tag !== '')
      .map((entry) => ({
        tag: entry.tag.slice(0, MAX_TAG),
        at: Number.isFinite(entry.at) ? entry.at : 0,
        text: typeof entry.text === 'string' ? entry.text.slice(0, MAX_LESSON_TEXT) : '',
        // 确认守住的时间；没确认过就不写这个字段。
        ...(Number.isFinite(entry.confirmedAt) ? { confirmedAt: entry.confirmedAt } : {}),
      }))
      .slice(-MAX_LESSONS)
    : []
  const statsRaw = raw.stats && typeof raw.stats === 'object' ? raw.stats : {}
  const count = (key) => (Number.isFinite(statsRaw[key]) ? Math.max(0, Math.floor(statsRaw[key])) : 0)
  const stats = {
    excellent: count('excellent'),
    good: count('good'),
    pass: count('pass'),
    poor: count('poor'),
    repeats: count('repeats'),
    improvements: count('improvements'),
  }
  const promotions = Array.isArray(raw.promotions)
    ? raw.promotions
      .filter((entry) => entry && Number.isFinite(entry.at))
      .map((entry) => ({
        at: entry.at,
        from: Number.isInteger(entry.from) ? entry.from : 0,
        to: Number.isInteger(entry.to) ? entry.to : 1,
        // 感言缺失就是没写（或者写失败），不要补空串。
        ...(typeof entry.speech === 'string' && entry.speech.trim() !== ''
          ? { speech: entry.speech.trim().slice(0, SPEECH_MAX) }
          : {}),
      }))
      .slice(-50)
    : []
  const repeatLog = Array.isArray(raw.repeatLog)
    ? raw.repeatLog
      .filter((entry) => entry && typeof entry.tag === 'string' && entry.tag !== '' && Number.isFinite(entry.at))
      .map((entry) => ({ tag: entry.tag.slice(0, MAX_TAG), at: entry.at }))
      .slice(-50)
    : []
  const taskLog = Array.isArray(raw.taskLog)
    ? raw.taskLog
      .filter((entry) => entry && Number.isFinite(entry.at))
      .map((entry) => ({ at: entry.at, grade: typeof entry.grade === 'string' ? entry.grade.slice(0, 12) : '' }))
      .slice(-100)
    : []
  const levelSince = Number.isFinite(raw.levelSince) ? Math.max(0, Math.floor(raw.levelSince)) : 0
  return { rank, totalXp, streak, teaches, stats, promotions, repeatLog, taskLog, levelSince }
}

/** Lessons that count toward the gate. */
export function teachCount(growth) {
  return normalizeGrowth(growth).teaches.length
}

/**
 * Rates that describe how well the bot actually works.
 * @param growth - growth object.
 */
export function growthRates(growth) {
  const { stats, teaches } = normalizeGrowth(growth)
  const graded = stats.excellent + stats.good + stats.pass + stats.poor
  const good = stats.excellent + stats.good
  const goodRate = graded === 0 ? null : good / graded
  const repeatRate = teaches.length === 0 ? null : stats.repeats / teaches.length
  return { graded, good, goodRate, repeatRate, teaches: teaches.length }
}

/** Whether the rank-1 gate is satisfied. */
function gateOpen(state) {
  if (state.rank !== 1) return true
  if (state.teaches.length < TEACH_GATE_COUNT) return false
  const { goodRate, repeatRate } = growthRates(state)
  if (goodRate !== null && goodRate < 0.7) return false
  if (repeatRate !== null && repeatRate > 0.2) return false
  return true
}

/** Promotion needs the gate plus the level playing set. */
export function promoteReady(growth) {
  const state = normalizeGrowth(growth)
  if (state.rank >= 2) return false
  if (!gateOpen(state)) return false
  const level = levelOf(state.totalXp, state.rank, state.teaches.length).level
  return level >= maxLevel(state.rank, state.teaches.length)
}

/** Everything the panel needs, already resolved against the curve. */
export function growthSummary(growth) {
  const state = normalizeGrowth(growth)
  const rates = growthRates(state)
  const level = levelOf(state.totalXp, state.rank, state.teaches.length)
  return {
    rank: state.rank,
    label: RANK_LABELS[state.rank] ?? RANK_LABELS[0],
    totalXp: state.totalXp,
    level: level.level,
    into: level.into,
    need: level.need,
    capped: level.capped,
    streak: state.streak,
    teaches: rates.teaches,
    // 写晋升感言时要能点名一条真教过的规矩，只给数量它会瞎编。
    teachTags: state.teaches.map((entry) => entry.tag),
    goodRate: rates.goodRate,
    repeatRate: rates.repeatRate,
    graded: rates.graded,
    levelSince: state.levelSince,
    canPromote: promoteReady(state),
  }
}

/**
 * Everything the growth archive shows about one bot.
 *
 * 档案页只读：评分样本、教学记录、晋升历史（带感言）都从 `growth` 里取，
 * 不读别的文件，所以它和面板上的卡片不会打架。
 * @param growth - growth object.
 */
export function growthDetail(growth) {
  const state = normalizeGrowth(growth)
  return {
    summary: growthSummary(state),
    stats: { ...state.stats },
    teaches: state.teaches.map((entry) => {
      const confirmed = Number.isFinite(entry.confirmedAt)
      // 已确认的就不用再算一次，直接把结论摆出来。
      const ready = confirmed ? { ok: false, reason: '已确认守住' } : improveReady(state, entry.tag)
      return {
        tag: entry.tag,
        at: entry.at,
        text: entry.text,
        ...(confirmed ? { confirmedAt: entry.confirmedAt } : {}),
        canConfirm: ready.ok,
        ...(ready.ok ? {} : { reason: ready.reason }),
      }
    }),
    // 复犯记录：确认守住时拿它对照，档案里也能看到犯过什么。
    repeatLog: state.repeatLog.map((entry) => ({ tag: entry.tag, at: entry.at })),
    promotions: state.promotions.map((entry) => ({
      at: entry.at,
      from: entry.from,
      to: entry.to,
      ...(entry.speech ? { speech: entry.speech } : {}),
    })),
  }
}

/**
 * Settle one accepted task.
 * @param growth - current growth.
 * @param options - { size, grade, nthToday }.
 */
export function settleTask(growth, options = {}) {
  const state = normalizeGrowth(growth)
  const grade = GRADE_MULT[options.grade] === undefined ? 'pass' : options.grade
  const before = levelOf(state.totalXp, state.rank, state.teaches.length).level
  const gained = taskGain({ size: options.size, grade, streak: state.streak, nthToday: options.nthToday })
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const next = {
    ...state,
    totalXp: state.totalXp + gained,
    // 差评清零连击；其余继续累积。
    streak: grade === 'poor' ? 0 : state.streak + 1,
    stats: { ...state.stats, [grade]: state.stats[grade] + 1 },
    // 记下这件活什么时候被验收：确认「守住」要数教下之后又干了几件。
    taskLog: [...state.taskLog, { at: now, grade }].slice(-100),
  }
  const after = levelOf(next.totalXp, next.rank, next.teaches.length).level
  if (after > before) next.levelSince = now
  return { growth: next, gained, levelBefore: before, levelAfter: after }
}

/**
 * Settle one lesson. Same tag inside a week earns nothing.
 * @param growth - current growth.
 * @param options - { tag, text, now }.
 */
export function settleTeaching(growth, options = {}) {
  const state = normalizeGrowth(growth)
  const tag = String(options.tag ?? '').trim().slice(0, MAX_TAG).toLowerCase()
  const text = String(options.text ?? '').trim().slice(0, MAX_LESSON_TEXT)
  if (tag === '') return { ok: false, error: '缺少标签', growth: state }
  if (text.length < 10) return { ok: false, error: '教学内容太短（至少 10 字）', growth: state }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const last = [...state.teaches].reverse().find((entry) => entry.tag === tag)
  if (!teachingCounts(last?.at, now) || (last && now - last.at < TEACH_WINDOW_MS)) {
    return { ok: false, error: '这个标签一周内教过了，换个角度或换标签', growth: state }
  }
  const before = levelOf(state.totalXp, state.rank, state.teaches.length).level
  const next = {
    ...state,
    totalXp: state.totalXp + TEACH_XP,
    teaches: [...state.teaches, { tag, text, at: now }].slice(-MAX_LESSONS),
  }
  const after = levelOf(next.totalXp, next.rank, next.teaches.length).level
  if (after > before) next.levelSince = now
  return { ok: true, growth: next, gained: TEACH_XP, teaches: next.teaches.length }
}

/**
 * The bot repeated a mistake it was already taught.
 * @param growth - current growth.
 * @param options - { tag }.
 */
/**
 * 用户反馈改判这次活的评分：不加经验，只把评分样本从旧档换到新档。
 *
 * 依据是这个项目一直认的口径——用户就是审计。秘书打完分，用户后来挑错、说漏了、
 * 说老毛病又犯，这件活就该按「差」算；用户说不错，就按「优秀」算。
 * 经验不回退（已经发出去的成长不追缴），只让好评率反映真实评价。
 * @param growth - current growth.
 * @param options - { from, to }：from 是秘书原来打的评分，to 是用户口径换算出来的评分。
 * @returns `{ ok, growth, changed }`.
 */
export function regrade(growth, options = {}) {
  const state = normalizeGrowth(growth)
  const grades = ['excellent', 'good', 'pass', 'poor']
  const from = grades.includes(options.from) ? options.from : null
  const to = grades.includes(options.to) ? options.to : 'poor'
  const stats = { ...state.stats }
  // 旧档有这个样本才扣，防止把别的活的评分扣掉。
  const dropped = from !== null && from !== to && stats[from] > 0
  if (dropped) stats[from] -= 1
  stats[to] += 1
  const next = {
    ...state,
    stats,
    streak: to === 'poor' ? 0 : state.streak,
  }
  return { ok: true, growth: next, changed: dropped || from !== to }
}

export function settleRepeat(growth, options = {}) {
  const state = normalizeGrowth(growth)
  const tag = String(options.tag ?? '').trim().toLowerCase().slice(0, MAX_TAG)
  if (tag === '') return { ok: false, error: '需要指定教过的标签', growth: state }
  if (!state.teaches.some((entry) => entry.tag === tag)) {
    return { ok: false, error: '这个标签没教过，不算重复犯错', growth: state }
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const next = {
    ...state,
    totalXp: Math.max(0, state.totalXp - REPEAT_PENALTY),
    streak: 0,
    stats: { ...state.stats, repeats: state.stats.repeats + 1 },
    // 记下是哪条规矩什么时候犯的：确认「守住」时要拿它对照。
    repeatLog: [...state.repeatLog, { tag, at: now }].slice(-50),
  }
  return { ok: true, growth: next, lost: REPEAT_PENALTY }
}

/**
 * Whether a lesson may be confirmed as learned (+120).
 *
 * 三条都要满足：这条规矩教过、教下之后又干满 `IMPROVE_CLEAN_TASKS` 件活、
 * 期间没有复犯记录。一次教学只能确认一次（确认时间记在教学记录上）。
 * 老存档没有逐件记录，所以「干了几件」从有 taskLog 之后才开始数，宁可少给分。
 * @param growth - current growth.
 * @param tag - lesson tag.
 * @param now - timestamp.
 * @returns `{ ok, reason?, lessonAt?, done? }`.
 */
export function improveReady(growth, tag, now = Date.now()) {
  const state = normalizeGrowth(growth)
  const key = String(tag ?? '').trim().toLowerCase().slice(0, MAX_TAG)
  if (key === '') return { ok: false, reason: '缺少标签' }
  // 取最近一条还没确认过的同 tag 教学。
  const lesson = [...state.teaches].reverse().find((entry) => entry.tag === key && !entry.confirmedAt)
  if (!lesson) {
    const taught = state.teaches.some((entry) => entry.tag === key)
    return { ok: false, reason: taught ? '这条规矩已经确认过了' : '这条规矩没教过' }
  }
  const done = state.taskLog.filter((entry) => entry.at > lesson.at).length
  if (done < IMPROVE_CLEAN_TASKS) {
    return {
      ok: false,
      reason: `教下之后才做了 ${done} 件活，还差 ${IMPROVE_CLEAN_TASKS - done} 件`,
    }
  }
  if (state.repeatLog.some((entry) => entry.tag === key && entry.at > lesson.at)) {
    return { ok: false, reason: '教下之后又犯过' }
  }
  return { ok: true, lessonAt: lesson.at, done }
}

/**
 * Confirm a lesson as learned: one +120 per lesson, once it has been kept clean.
 * @param growth - current growth.
 * @param options - { tag, now }.
 */
export function settleImprovement(growth, options = {}) {
  const state = normalizeGrowth(growth)
  const key = String(options.tag ?? '').trim().toLowerCase().slice(0, MAX_TAG)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const ready = improveReady(state, key, now)
  if (!ready.ok) return { ok: false, error: ready.reason, growth: state }
  const teaches = state.teaches.slice()
  for (let index = teaches.length - 1; index >= 0; index -= 1) {
    if (teaches[index].tag === key && !teaches[index].confirmedAt) {
      teaches[index] = { ...teaches[index], confirmedAt: now }
      break
    }
  }
  const next = {
    ...state,
    totalXp: state.totalXp + IMPROVEMENT_BONUS,
    stats: { ...state.stats, improvements: state.stats.improvements + 1 },
    teaches,
  }
  return { ok: true, growth: next, gained: IMPROVEMENT_BONUS, tag: key }
}

/**
 * Promote one rank up. Experience restarts, history is kept.
 * 普通 → 精英化一阶 needs nothing but a full bar.
 * 精英化一阶 → 精英化二阶 needs the teaching gate and the rates.
 * @param growth - current growth.
 * @param now - timestamp.
 */
export function promote(growth, now = Date.now()) {
  const state = normalizeGrowth(growth)
  if (state.rank >= 2) return { ok: false, error: '已经是精英化二阶', growth: state }
  if (!promoteReady(state)) {
    return {
      ok: false,
      error: state.rank === 0 ? '还没满 20 级' : '还不满足晋升条件',
      growth: state,
    }
  }
  const next = {
    ...state,
    rank: state.rank + 1,
    totalXp: 0,
    streak: 0,
    // 好评率按段位重算：晋升那一档的评分样本清零，复犯记录和教学留着。
    stats: { ...state.stats, excellent: 0, good: 0, pass: 0, poor: 0 },
    promotions: [...state.promotions, { at: now, from: state.rank, to: state.rank + 1 }].slice(-50),
    levelSince: now,
  }
  return { ok: true, growth: next }
}
