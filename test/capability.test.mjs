/**
 * Capability cards: which tools a bot may never use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DENY, capabilityDenyList } from '../host/tools.js'

test('a bot without a card gets the default deny list', () => {
  assert.deepEqual(capabilityDenyList({ id: 'x' }), DEFAULT_DENY)
  assert.deepEqual(capabilityDenyList({ id: 'x', capability: {} }), DEFAULT_DENY)
  assert.deepEqual(capabilityDenyList({ id: 'x', capability: { tools: {} } }), DEFAULT_DENY)
})

test('an explicit deny list wins', () => {
  const bot = { id: 'x', capability: { tools: { deny: ['workflow'] } } }
  assert.deepEqual(capabilityDenyList(bot), ['workflow'])
})

test('an empty deny list falls back to the defaults', () => {
  const bot = { id: 'x', capability: { tools: { deny: [] } } }
  assert.deepEqual(capabilityDenyList(bot), DEFAULT_DENY)
})

test('the defaults cover the runaway tools', () => {
  for (const name of ['workflow', 'create_goal', 'schedule_create', 'ask_user_question']) {
    assert.ok(DEFAULT_DENY.includes(name), `default deny should include ${name}`)
  }
})

test('entries are stringified', () => {
  const bot = { id: 'x', capability: { tools: { deny: [1, 'workflow'] } } }
  assert.deepEqual(capabilityDenyList(bot), ['1', 'workflow'])
})

test('a non-empty allow list wins over the deny list', async () => {
  const { capabilityPlan } = await import('../host/tools.js')
  const plan = capabilityPlan({ id: 'x', capability: { tools: { allow: ['read', 'bash'] } } })
  assert.deepEqual(plan, { allow: ['read', 'bash'] })
})

test('without an allow list the deny plan applies', async () => {
  const { capabilityPlan } = await import('../host/tools.js')
  const plan = capabilityPlan({ id: 'x', capability: { tools: { deny: ['workflow'] } } })
  assert.deepEqual(plan, { deny: ['workflow'] })
  const fallback = capabilityPlan({ id: 'y' })
  assert.deepEqual(fallback, { deny: DEFAULT_DENY })
})
