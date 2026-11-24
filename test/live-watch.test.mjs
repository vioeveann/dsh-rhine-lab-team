/**
 * 实时登记：成员卡「在不在干活」看的是子会话自己报的状态，不是账本。
 *
 * 这一层就是为了修「派活调用被打断后，子会话还在跑、面板却显示待命」，
 * 所以它自己的语义也得钉住：running 算忙、idle 算闲、死会话不能永久算忙。
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRoster } from '../host/team-mode.js'
import {
  childStateOf,
  forgetChild,
  noteChildState,
  resetChildStates,
  runningBots,
  runningSessions,
} from '../host/live-watch.js'

beforeEach(() => resetChildStates())

/** 一个只有一个 Bot 的临时包目录。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-live-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(
    join(root, 'bots', 'nova.json'),
    JSON.stringify({ id: 'nova', role: '研究员' }),
    'utf8',
  )
  return root
}

test('a running child session marks the bot busy', async () => {
  const root = await fixture()
  try {
    noteChildState('S-child', 'running', 'nova')
    assert.deepEqual([...runningBots()], ['nova'])
    assert.deepEqual(runningSessions('nova'), ['S-child'])
    assert.equal(childStateOf('S-child'), 'running')

    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    assert.equal(members[0].status, 'busy')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an idle child session releases the bot', async () => {
  const root = await fixture()
  try {
    noteChildState('S-child', 'running', 'nova')
    noteChildState('S-child', 'idle', 'nova')
    assert.deepEqual([...runningBots()], [])
    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    assert.equal(members[0].status, 'idle')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a session that never reported idle goes stale instead of busy forever', async () => {
  const root = await fixture()
  const realNow = Date.now
  try {
    noteChildState('S-crashed', 'running', 'nova')
    Date.now = () => realNow() + 5 * 60 * 60 * 1000
    assert.deepEqual([...runningBots()], [])
    assert.equal(childStateOf('S-crashed'), '')
    const members = await readRoster({ root, tasks: new Map(), sessionId: 'S' })
    assert.equal(members[0].status, 'idle')
  } finally {
    Date.now = realNow
    await rm(root, { recursive: true, force: true })
  }
})

test('forget and reset clear the registry', async () => {
  noteChildState('S-a', 'running', 'nova')
  noteChildState('S-b', 'running', 'shop')
  resetChildStates()
  assert.deepEqual([...runningBots()], [])
  noteChildState('S-c', 'running', 'nova')
  forgetChild('S-c')
  assert.deepEqual(runningSessions('nova'), [])
})
