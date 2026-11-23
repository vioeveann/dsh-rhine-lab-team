import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMailbox, formatMailPrompt } from '../host/mailbox.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mailbox-'))
  return { root, box: createMailbox({ root }) }
}

test('mailbox：发件进收件箱，未读计数正确，标记已读后清零', async () => {
  const { root, box } = await fixture()
  try {
    const sent = await box.send({ from: 'auditor', to: 'writer', subject: '口径', body: '第三段请用 UTC 日期。' })
    assert.equal(sent.ok, true)
    assert.equal(sent.message.from, 'auditor')
    assert.equal((await box.unreadCounts()).writer, 1)
    const rows = await box.inbox('writer')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].subject, '口径')
    assert.equal(await box.markRead('writer', [rows[0].id]), 1)
    assert.equal((await box.unreadCounts()).writer, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox：同一线程按时间正序，回复沿用 threadId', async () => {
  const { root, box } = await fixture()
  try {
    const first = await box.send({ from: 'auditor', to: 'writer', subject: '问题', body: '这句出处是哪一页？' })
    await box.send({ from: 'writer', to: 'auditor', subject: '回复', body: '第 12 页，表 3。', threadId: first.message.threadId })
    const rows = await box.thread(first.message.threadId)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].from, 'auditor')
    assert.equal(rows[1].from, 'writer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox：不能发给自己，正文不能为空', async () => {
  const { root, box } = await fixture()
  try {
    await assert.rejects(() => box.send({ from: 'writer', to: 'writer', body: 'x' }), /不能给自己/)
    await assert.rejects(() => box.send({ from: 'writer', to: 'auditor', body: '   ' }), /正文不能为空/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox：每小时限额 20 条', async () => {
  const { root, box } = await fixture()
  try {
    for (let i = 0; i < 20; i += 1) {
      await box.send({ from: 'auditor', to: 'writer', body: `第 ${i} 条` })
    }
    await assert.rejects(() => box.send({ from: 'auditor', to: 'writer', body: '第 21 条' }), /每小时最多 20 条/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox：peekForPrompt 不标读，markRead 才清未读', async () => {
  const { root, box } = await fixture()
  try {
    await box.send({ from: 'auditor', to: 'writer', subject: '待核', body: '先别标读。' })
    const first = await box.peekForPrompt('writer')
    const second = await box.peekForPrompt('writer')
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal((await box.unreadCounts()).writer, 1)
    assert.equal(await box.markRead('writer', first.map((row) => row.id)), 1)
    assert.equal((await box.unreadCounts()).writer, undefined)
    assert.deepEqual(await box.peekForPrompt('writer'), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mailbox：takeForPrompt 取出未读并标读，formatMailPrompt 带线程提示', async () => {
  const { root, box } = await fixture()
  try {
    await box.send({ from: 'auditor', to: 'writer', subject: '核对', body: '第 3 节数字不对。' })
    const taken = await box.takeForPrompt('writer')
    assert.equal(taken.length, 1)
    assert.match(formatMailPrompt(taken), /来自 auditor/)
    assert.match(formatMailPrompt(taken), /team_reply/)
    assert.deepEqual(await box.takeForPrompt('writer'), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
