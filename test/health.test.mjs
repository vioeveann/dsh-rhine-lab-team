/**
 * Health arithmetic: what is running, waiting, or stuck.
 *
 * The hourly character gate was removed (see `host/health.js`); what is left
 * is the summary the secretary reads before deciding whether to dispatch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STUCK_AFTER_MS, summarizeTasks } from '../host/health.js'

const NOW = 1_700_000_000_000
const SESSION = 'session-a'

/** Build a ledger with a few entries. */
function ledger(rows) {
  return new Map(rows.map((row, index) => [`t-${index}`, row]))
}

test('health separates running, awaiting review and stuck', () => {
  const tasks = ledger([
    { taskId: 'a', parentSession: SESSION, startedAt: NOW - 1000 },
    { taskId: 'b', parentSession: SESSION, startedAt: NOW - STUCK_AFTER_MS - 1000 },
    { taskId: 'c', parentSession: SESSION, startedAt: NOW - 5000, doneAt: NOW - 1000 },
    { taskId: 'd', parentSession: SESSION, startedAt: NOW - 5000, doneAt: NOW - 1000, reviewedAt: NOW },
    { taskId: 'e', parentSession: 'other', startedAt: NOW - 1000 },
  ])
  const summary = summarizeTasks(tasks, SESSION, NOW)
  assert.equal(summary.total, 4)
  assert.equal(summary.running, 2)
  assert.equal(summary.stuck, 1)
  assert.deepEqual(summary.stuckIds, ['b'])
  assert.equal(summary.ready, 1)
  assert.deepEqual(summary.awaitingReviewIds, ['c'])
})

test('an empty ledger summarises to zeros', () => {
  const summary = summarizeTasks(new Map(), SESSION, NOW)
  assert.deepEqual(
    { total: summary.total, running: summary.running, ready: summary.ready, stuck: summary.stuck },
    { total: 0, running: 0, ready: 0, stuck: 0 },
  )
})

test('rejected work is counted separately', () => {
  const tasks = ledger([
    { taskId: 'a', parentSession: SESSION, startedAt: NOW - 5000, doneAt: NOW - 1000, verdict: 'rejected' },
    { taskId: 'b', parentSession: SESSION, startedAt: NOW - 5000, doneAt: NOW - 1000, verdict: 'accepted' },
  ])
  assert.equal(summarizeTasks(tasks, SESSION, NOW).rejected, 1)
})

test('最慢的一件会单独报出来：跑着的按到现在算', () => {
  const tasks = ledger([
    { taskId: 'fast', bot: 'nova', parentSession: SESSION, startedAt: NOW - 2000, doneAt: NOW - 1000 },
    { taskId: 'slow', bot: 'writer', parentSession: SESSION, status: 'accepted', startedAt: NOW - 120000, doneAt: NOW - 1000 },
    { taskId: 'running', bot: 'auditor', parentSession: SESSION, startedAt: NOW - 30000 },
  ])
  const summary = summarizeTasks(tasks, SESSION, NOW)
  assert.equal(summary.slowest.taskId, 'slow')
  assert.equal(summary.slowest.bot, 'writer')
  assert.equal(summary.slowest.seconds, 119)
  assert.equal(summary.slowest.status, 'accepted')
})
