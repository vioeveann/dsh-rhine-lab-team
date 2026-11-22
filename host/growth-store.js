/**
 * Read-modify-write growth for one bot, serialized per bot id.
 *
 * Two sessions can finish tasks for the same bot at the same moment; without a
 * queue the second write would overwrite the first.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { saveBot } from './bots.js'
import { normalizeGrowth, promote, settleImprovement } from './growth.js'
import { SPEECH_MAX } from './speech.js'

/** bot id -> tail of its update chain. */
const queues = new Map()

/**
 * Apply one growth mutation.
 * @param root - package directory.
 * @param botId - bot id.
 * @param mutate - (bot, growth) => { ok, growth, patch? } | { ok: false, error }
 */
export function updateGrowth(root, botId, mutate) {
  const id = String(botId ?? '').trim()
  if (id === '') return Promise.resolve({ ok: false, error: '缺少 bot id' })
  const previous = queues.get(id) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      let bot
      try {
        bot = JSON.parse(await readFile(join(root, 'bots', `${id}.json`), 'utf8'))
      } catch {
        return { ok: false, error: `找不到 ${id}` }
      }
      const growth = normalizeGrowth(bot.growth)
      const result = await mutate(bot, growth)
      if (!result || result.ok === false) return result ?? { ok: false, error: '没有变化' }
      await saveBot(root, { ...bot, ...(result.patch ?? {}), growth: result.growth })
      return result
    })
  queues.set(id, run)
  // 队列尾部失败也要能把后面的更新放行。
  run.catch(() => undefined)
  return run
}

/**
 * 晋升：成长按规则进位，星级同时顶到这一阶的上限（之后用户可自己改）。
 * @param root - 包目录。
 * @param botId - bot id。
 * @param now - 时间戳。
 */
export function promoteBot(root, botId, now = Date.now()) {
  return updateGrowth(root, botId, (bot, growth) => {
    const result = promote(growth, now)
    if (!result.ok) return result
    return {
      ok: true,
      growth: result.growth,
      // 一阶自动 5 星，二阶自动 6 星（之后用户可以自己往下调）。
      patch: { stars: result.growth.rank >= 2 ? 6 : 5 },
    }
  })
}

/**
 * 确认一条教过的规矩守住了：+120，一次教学只能确认一次。
 * 条件（教下之后干满 2 件活、期间没复犯）在 `settleImprovement` 里判，这里只负责串行落盘。
 * @param root - 包目录。
 * @param botId - bot id。
 * @param tag - 规矩标签。
 * @param now - 时间戳。
 */
export function confirmImprovement(root, botId, tag, now = Date.now()) {
  const key = String(tag ?? '').trim().toLowerCase()
  if (key === '') return Promise.resolve({ ok: false, error: '缺少标签' })
  return updateGrowth(root, botId, (_bot, growth) => {
    const result = settleImprovement(growth, { tag: key, now })
    return result.ok
      ? { ok: true, growth: result.growth, gained: result.gained, tag: result.tag }
      : result
  })
}

/**
 * 把一段感言挂到最近一次晋升记录上。
 * 先晋升、后写感言：写失败不该把晋升回滚，所以单独一次更新。
 * @param root - 包目录。
 * @param botId - bot id。
 * @param speech - 感言正文。
 */
export function savePromotionSpeech(root, botId, speech) {
  const text = String(speech ?? '').trim()
  if (text === '') return Promise.resolve({ ok: false, error: '感言是空的' })
  return updateGrowth(root, botId, (_bot, growth) => {
    const last = growth.promotions.length - 1
    if (last < 0) return { ok: false, error: '没有晋升记录' }
    const promotions = growth.promotions.slice()
    promotions[last] = { ...promotions[last], speech: text.slice(0, SPEECH_MAX) }
    return { ok: true, growth: { ...growth, promotions } }
  })
}
