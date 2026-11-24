/**
 * 子会话「现在是不是在干活」的实时登记。
 *
 * 为什么单独一张表：账本（tasks）里的状态是派活那次工具调用写下来的，
 * 一旦派活调用被中止（秘书正等结果时用户插话），账本会被提前收成 ready，
 * 但子会话其实还在后台跑——面板于是显示「待命」，看门狗也跟着关了。
 * 这里只认子会话自己发出来的 `agent/status`，与账本无关，面板以它为准。
 */

/** sessionId -> { state, botId, at } */
const states = new Map()

/**
 * 超过这个时间没再报过状态的登记，一律当成失效。
 *
 * 子会话正常会发 `idle`；真崩了可能一个字都不发，那就得靠时间兜底，
 * 否则一个死会话能把 Bot 永久钉在「繁忙」上——跟原来那个「待命」是同一类错。
 * 四小时与后台接力的放弃期限对齐。
 */
const STALE_MS = 4 * 60 * 60 * 1000

/** 这条登记还作不作数。 */
function fresh(row) {
  return Date.now() - (row?.at ?? 0) <= STALE_MS
}

/**
 * 记一次子会话状态。
 * @param sessionId - 子会话 id。
 * @param state - `agent/status` 给的值（idle / running / …）。
 * @param botId - 这个子会话属于哪个 Bot。
 */
export function noteChildState(sessionId, state, botId) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return
  states.set(id, {
    state: String(state ?? '').trim(),
    botId: botId ? String(botId) : null,
    at: Date.now(),
  })
}

/**
 * 忘掉一个子会话（会话被删 / 任务收了）。
 * @param sessionId - 子会话 id。
 */
export function forgetChild(sessionId) {
  states.delete(String(sessionId ?? ''))
}

/**
 * 现在正在干活的 Bot。
 * @returns Bot id 的集合；`idle` 之外的任何状态都算在干活。
 */
export function runningBots() {
  const out = new Set()
  for (const row of states.values()) {
    if (!fresh(row)) continue
    if (row.botId && row.state !== '' && row.state !== 'idle') out.add(row.botId)
  }
  return out
}

/**
 * 一个子会话当前的状态。
 * @param sessionId - 子会话 id。
 * @returns 状态字符串；没登记过就是空串。
 */
export function childStateOf(sessionId) {
  const row = states.get(String(sessionId ?? ''))
  return row && fresh(row) ? row.state : ''
}

/**
 * 某个 Bot 名下正在跑的会话。
 * @param botId - Bot id。
 * @returns 会话 id 数组。
 */
export function runningSessions(botId) {
  const out = []
  for (const [id, row] of states) {
    if (!fresh(row)) continue
    if (row.botId === botId && row.state !== '' && row.state !== 'idle') out.push(id)
  }
  return out
}

/**
 * 清空登记。只给测试用——撑起现场再演练，别让上一次的残留把这次判成繁忙。
 */
export function resetChildStates() {
  states.clear()
}
