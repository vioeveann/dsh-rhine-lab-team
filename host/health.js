/**
 * Team health: what is running, what is waiting, what is stuck.
 *
 * There used to be an hourly character budget here (a `charsPerHour` gate that
 * refused dispatches). It never fired once in real use, it could not see work
 * that was still running, and character count has almost nothing to do with
 * what a task costs — real token usage is tracked in `usage.js` and shown on
 * the cards. The gate is gone; only the health summary is left.
 */

/** A task running longer than this is worth flagging. */
export const STUCK_AFTER_MS = 10 * 60 * 1000

/**
 * Summarise the ledger for the secretary.
 * @param tasks - task ledger.
 * @param sessionId - parent session filter; empty means all.
 * @param now - current time in ms.
 */
export function summarizeTasks(tasks, sessionId, now = Date.now()) {
  const rows = [...tasks.values()].filter(
    (entry) => !sessionId || entry.parentSession === sessionId,
  )
  const running = rows.filter((entry) => !entry.doneAt)
  const ready = rows.filter((entry) => entry.doneAt && !entry.reviewedAt)
  const rejected = rows.filter((entry) => entry.verdict === 'rejected')
  const stuck = running.filter((entry) => now - (entry.startedAt ?? now) > STUCK_AFTER_MS)
  // 最慢的一件：卡住时先看它，别在别的任务上瞎猜。
  const elapsedOf = (entry) => (Number.isFinite(entry.startedAt)
    ? Math.max(0, (entry.doneAt ?? now) - entry.startedAt)
    : 0)
  const slowest = rows.reduce((hit, entry) => (hit === null || elapsedOf(entry) > elapsedOf(hit) ? entry : hit), null)
  return {
    total: rows.length,
    running: running.length,
    ready: ready.length,
    rejected: rejected.length,
    stuck: stuck.length,
    stuckIds: stuck.map((entry) => entry.taskId),
    awaitingReviewIds: ready.map((entry) => entry.taskId),
    slowest: slowest
      ? {
          taskId: slowest.taskId,
          bot: slowest.bot,
          seconds: Math.round(elapsedOf(slowest) / 1000),
          status: slowest.status ?? (slowest.doneAt ? 'done' : 'running'),
        }
      : null,
  }
}
