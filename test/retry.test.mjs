/**
 * 自动重试：判定函数的用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTechnicalFailure } from '../host/tools.js'

test('网络/网关类错误算技术性失败，值得重试', () => {
  assert.equal(isTechnicalFailure(new Error('connect ETIMEDOUT 1.2.3.4:443')), true)
  assert.equal(isTechnicalFailure(new Error('socket hang up')), true)
  assert.equal(isTechnicalFailure(new Error('fetch failed')), true)
  assert.equal(isTechnicalFailure(new Error('503 Service Unavailable')), true)
  assert.equal(isTechnicalFailure(new Error('rate limit exceeded')), true)
})

test('用户取消（aborted）不重试：重试会覆盖掉取消', () => {
  assert.equal(isTechnicalFailure(new Error('The operation was aborted')), false)
})

test('内容类问题不重试', () => {
  assert.equal(isTechnicalFailure(new Error('报告里引用了不存在的页码')), false)
  assert.equal(isTechnicalFailure(new Error('任务单是空的')), false)
  assert.equal(isTechnicalFailure(''), false)
  assert.equal(isTechnicalFailure(undefined), false)
})
