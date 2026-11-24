import test from 'node:test'
import assert from 'node:assert/strict'
import { chatRootAlive, chatRootId } from '../host/chat-session.js'

test('单聊根会话：优先 rootSession，老记录退回 parentSession', () => {
  assert.equal(chatRootId({ rootSession: 'root-a', parentSession: 'parent-b' }), 'root-a')
  assert.equal(chatRootId({ parentSession: 'parent-b' }), 'parent-b')
  assert.equal(chatRootId({}), '')
})

test('单聊根会话：当前会话一定活着', () => {
  assert.equal(chatRootAlive({ rootSession: 'root-a' }, { currentSession: 'root-a' }), true)
  assert.equal(chatRootAlive({ rootSession: 'root-a' }, { currentSession: 'other' }), false)
})

test('单聊根会话：只有 agents.get 还能拿到才算活', () => {
  const seen = []
  const alive = chatRootAlive(
    { rootSession: 'root-a' },
    { currentSession: 'other', getAgent: (id) => { seen.push(id); return { id } } },
  )
  assert.equal(alive, true)
  assert.deepEqual(seen, ['root-a'])
  assert.equal(chatRootAlive({ rootSession: 'root-a' }, { getAgent: () => undefined }), false)
})

test('单聊根会话：getAgent 抛错按失效处理，不把面板卡死', () => {
  assert.equal(
    chatRootAlive({ rootSession: 'root-a' }, { getAgent: () => { throw new Error('gone') } }),
    false,
  )
})
