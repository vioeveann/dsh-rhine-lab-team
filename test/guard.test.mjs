import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { createWorkspaceGuard } from '../host/guard.js'

const cwd = join(process.cwd(), 'task')
const other = join(process.cwd(), 'other')
const guard = createWorkspaceGuard({
  tasks: new Map([
    ['t1', { taskId: 't1', bot: 'writer', sessionId: 's1', cwd }],
    ['t2', { taskId: 't2', bot: 'auditor', sessionId: 's2', cwd }],
  ]),
  deliverableRoot: join(process.cwd(), 'deliverables'),
})
const call = (name, path, sessionId = 's1') => guard({ name, arguments: { path }, agent: { session: { id: sessionId } } })

test('workspace guard: writes inside the task directory pass', () => {
  assert.equal(call('write', join(cwd, 'report.md')), undefined)
  assert.equal(call('edit', 'notes.md'), undefined)
})

test('workspace guard: absolute and relative escapes are denied', () => {
  assert.match(call('write', join(other, 'x.md')), /只能写自己的工作目录/)
  assert.match(call('write', '../other/x.md'), /只能写自己的工作目录/)
})

test('workspace guard: direct deliverable writes are denied', () => {
  assert.match(call('write', join(process.cwd(), 'deliverables', 'x.md')), /team_collect/)
})

test('workspace guard: auditor is read-only', () => {
  assert.match(call('write', join(cwd, 'x.md'), 's2'), /只读/)
  assert.match(call('team_collect', '', 's2'), /只读/)
})

test('workspace guard: non-team session is untouched', () => {
  assert.equal(guard({ name: 'write', arguments: { path: 'C:/anywhere/x' }, agent: { session: { id: 'other' } } }), undefined)
})
