/**
 * Queue and patrol rules: how many tasks may run, and when one counts as stuck.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeTaskCount, canStartTask } from '../host/tools.js'
import { isStuck } from '../host/team-mode.js'

/** Build a task map from plain entries. */
function taskMap(rows) {
  return new Map(rows.map((row, index) => [`t${index}`, row]))
}

test('finished tasks do not count as active', () => {
  const tasks = taskMap([
    { parentSession: 'S', startedAt: 1 },
    { parentSession: 'S', startedAt: 1, doneAt: 2 },
  ])
  assert.equal(activeTaskCount(tasks, 'S'), 1)
})

test('another session is not counted', () => {
  const tasks = taskMap([{ parentSession: 'other', startedAt: 1 }])
  assert.equal(activeTaskCount(tasks, 'S'), 0)
})

test('a session under the cap may start', () => {
  const tasks = taskMap([{ parentSession: 'S', startedAt: 1 }])
  assert.deepEqual(canStartTask(tasks, 'S', 2), { ok: true, active: 1 })
})

test('a session at the cap is refused with the active count', () => {
  const tasks = taskMap([
    { parentSession: 'S', startedAt: 1 },
    { parentSession: 'S', startedAt: 1 },
  ])
  assert.deepEqual(canStartTask(tasks, 'S', 2), { ok: false, active: 2 })
})

test('a long-running task is stuck, a finished one is not', () => {
  const now = 100 * 60_000
  assert.equal(isStuck({ startedAt: 1 }, now), true)
  assert.equal(isStuck({ startedAt: now - 60_000 }, now), false)
  assert.equal(isStuck({ startedAt: 1, doneAt: 2 }, now), false)
  assert.equal(isStuck(undefined, now), false)
})
