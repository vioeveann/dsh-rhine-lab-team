/**
 * 人设热更新的「窗口」：点了编辑人设之后的 30 分钟里盯着 soul.txt。
 *
 * 为什么是窗口而不是常驻轮询：插件拿不到编辑器保存事件（人设是交给系统
 * 编辑器打开的），要发现改动只能看文件时间。常驻轮询为一个几乎不发生的事件
 * 每 2 秒一次 stat，不值；用户点「编辑人设」的那一刻，才是他真要改的信号。
 *
 * 换来换去都是同一个文件，所以窗口按 Bot 记，重复点编辑只是把窗口往后推。
 */
import { stat } from 'node:fs/promises'

/** 窗口时长：30 分钟。 */
export const PERSONA_WATCH_WINDOW_MS = 30 * 60_000

/** 轮询间隔：2 秒。 */
export const PERSONA_WATCH_INTERVAL_MS = 2000

/**
 * 建一个窗口轮询器。
 * @param options - `{ statFn, onChanged, debug, windowMs, intervalMs, now }`。
 *   `statFn` / `now` 只在测试里替换，默认用 fs 和 Date.now。
 * @returns `{ arm, disarm, dispose, armed }`。
 */
export function createPersonaWatcher(options = {}) {
  const statFn = typeof options.statFn === 'function' ? options.statFn : stat
  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : null
  const debug = typeof options.debug === 'function' ? options.debug : null
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : PERSONA_WATCH_WINDOW_MS
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : PERSONA_WATCH_INTERVAL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** @type {Map<string, {file: string, mtime: number, timer: any, deadline: number, polls: number}>} */
  const arms = new Map()

  const disarm = (botId) => {
    const id = String(botId ?? '')
    const record = arms.get(id)
    if (!record) return false
    if (record.timer) clearInterval(record.timer)
    arms.delete(id)
    return true
  }

  const check = async (id, record) => {
    if (arms.get(id) !== record) return
    if (now() > record.deadline) {
      disarm(id)
      await debug?.({ event: 'persona-watch-expired', bot: id })
      return
    }
    record.polls += 1
    let info
    try {
      info = await statFn(record.file)
    } catch {
      // 还没建出来：记下「本来就不在」，等它出现时算一次改动。
      record.missing = true
      return
    }
    if (arms.get(id) !== record) return
    const mtime = Number(info?.mtimeMs) || 0
    if (mtime === 0) return
    if (record.mtime === 0) {
      if (!record.missing) {
        // 一直在的文件：第一次读到的是基线，不是改动。
        record.mtime = mtime
        return
      }
      // 从「不存在」变成「存在」：这就是新建人设，算改动。
    } else if (mtime === record.mtime) {
      return
    }
    record.mtime = mtime
    // 变了：先摘掉窗口，回调里再出错也不会每 2 秒重放一次。
    disarm(id)
    await debug?.({ event: 'persona-changed', bot: id, mtime, polls: record.polls })
    try {
      await onChanged?.(id, { file: record.file, mtime })
    } catch (error) {
      await debug?.({ event: 'persona-changed-failed', bot: id, error: String(error?.message ?? error) })
    }
  }

  const arm = (botId, file) => {
    const id = String(botId ?? '').trim()
    if (id === '' || !file) return false
    disarm(id)
    const record = {
      file,
      mtime: 0,
      timer: null,
      deadline: now() + windowMs,
      polls: 0,
    }
    // 先同步读一次基线：文件已经存在时，基线必须是现在的内容，
    // 否则窗口一开就会把「上次保存」当成新改动。
    record.timer = setInterval(() => void check(id, record), intervalMs)
    record.timer?.unref?.()
    arms.set(id, record)
    void check(id, record)
    return true
  }

  return {
    arm,
    disarm,
    dispose: () => {
      for (const id of [...arms.keys()]) disarm(id)
    },
    get armed() {
      return [...arms.keys()]
    },
  }
}
