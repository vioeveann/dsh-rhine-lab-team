/**
 * 任务依赖图：直接派活等上游、批量内 key 别名、上游失败阻塞下游、成环拒绝。
 *
 * 子会话是桩：只记录启动顺序，按需成功/失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTeamTools } from '../host/tools.js'

function fakeTools() {
  const registered = []
  return {
    registered,
    register(definition, options) {
      registered.push({ definition, options })
      return () => {}
    },
  }
}

const leadAgent = { session: { header: { id: 'session-test', parentSession: undefined } } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-deps-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(join(root, 'bots', 'a.json'), JSON.stringify({ id: 'a', name: '甲', role: '采集' }), 'utf8')
  await writeFile(join(root, 'bots', 'b.json'), JSON.stringify({ id: 'b', name: '乙', role: '写作' }), 'utf8')
  await writeFile(join(root, 'bots', 'auditor.json'), JSON.stringify({ id: 'auditor', name: '审计员', role: '成果审计' }), 'utf8')
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * 记录启动顺序的桩；`failBots` 里的 Bot 启动后直接失败。
 * @param options - `{ delayMs, failBots }`。
 */
function stubSubagents(options = {}) {
  const calls = []
  let active = 0
  const maxActive = { value: 0 }
  return {
    calls,
    maxActive,
    async startActivation(activation) {
      const bot = String(activation?.name ?? '').split('-')[0]
      calls.push(bot)
      active += 1
      maxActive.value = Math.max(maxActive.value, active)
      const delay = options.delayMs ?? 10
      const fail = options.failBots?.includes(bot) === true
      return {
        childId: `child-${calls.length}`,
        name: activation?.name ?? `child-${calls.length}`,
        dispose: async () => {},
        result: new Promise((resolve, reject) => {
          setTimeout(() => {
            active -= 1
            if (fail) reject(new Error(`${bot} boom`))
            else resolve({ output: [{ type: 'text', text: `${bot} 完成` }] })
          }, delay)
        }),
      }
    },
  }
}

function options(tools, root, subagents) {
  return {
    root,
    tools,
    agents: {},
    subagents,
    debug: async () => {},
    pending: new Map(),
    tasks: new Map(),
    deliverableRoot: join(root, 'deliverables'),
    getDeliverableRoot: () => join(root, 'deliverables'),
    getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 5 }),
    persistTasks: async () => {},
    api: {},
    isTeamSession: () => true,
  }
}

function definitionOf(tools, name) {
  const hit = tools.registered.find((row) => row.definition.name === name)
  assert.ok(hit, `没有注册 ${name}`)
  return hit.definition
}

const run = (def, args) => def.execute(args, { agent: leadAgent, signal: undefined })

test('team_dispatch：上游还在排队时等待，不直接 blocked', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-q', {
      taskId: 't-q',
      bot: 'a',
      status: 'queued',
      parentSession: 'session-test',
      brief: { task: '采集' },
    })
    setTimeout(() => {
      const row = opts.tasks.get('t-q')
      if (row) row.status = 'ready'
    }, 50)
    const def = definitionOf(tools, 'team_dispatch')
    const started = Date.now()
    const result = JSON.parse(await run(def, {
      bot: 'b',
      task: '写简报',
      dependsOn: ['t-q'],
    }))
    assert.equal(result.status, 'ready')
    assert.ok(Date.now() - started >= 400, '应该等过一轮轮询')
    assert.equal(subagents.calls.length, 1)
  } finally {
    await cleanup()
  }
})

test('team_dispatch：依赖已就绪才 spawn，账本留下 dependsOn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-up', {
      taskId: 't-up',
      bot: 'a',
      status: 'ready',
      parentSession: 'session-test',
      brief: { task: '采集' },
      output: '上游完成',
    })
    const def = definitionOf(tools, 'team_dispatch')
    const result = JSON.parse(await run(def, {
      bot: 'b',
      task: '写简报',
      dependsOn: ['t-up'],
    }))
    assert.equal(result.status, 'ready')
    assert.equal(subagents.calls.length, 1)
    const row = opts.tasks.get(result.taskId)
    assert.deepEqual(row.dependsOn, ['t-up'])
    assert.equal(row.status, 'ready')
  } finally {
    await cleanup()
  }
})

test('team_dispatch：上游打回则下游直接 blocked，不 spawn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-up', {
      taskId: 't-up',
      bot: 'a',
      status: 'rejected',
      parentSession: 'session-test',
      brief: { task: '采集' },
    })
    const def = definitionOf(tools, 'team_dispatch')
    const result = JSON.parse(await run(def, {
      bot: 'b',
      task: '写简报',
      dependsOn: ['t-up'],
    }))
    assert.equal(result.status, 'blocked')
    assert.match(result.message, /上游 t-up 被打回/)
    assert.equal(subagents.calls.length, 0)
    const row = opts.tasks.get(result.taskId)
    assert.equal(row.status, 'blocked')
    assert.equal(row.doneAt > 0, true)
    assert.match(row.blockedBy, /上游 t-up 被打回/)
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：批内 key 依赖按顺序跑，结果顺序不变', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents({ delayMs: 15 })
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const result = JSON.parse(await run(def, {
      tasks: JSON.stringify([
        { key: 'collect', bot: 'a', task: '采集' },
        { key: 'write', bot: 'b', task: '写简报', dependsOn: ['collect'] },
        { key: 'audit', bot: 'auditor', task: '只读复核', dependsOn: ['write'] },
      ]),
    }))
    assert.equal(result.status, 'done')
    assert.equal(result.count, 3)
    assert.deepEqual(subagents.calls, ['a', 'b', 'auditor'])
    assert.equal(result.results[0].status, 'ready')
    assert.equal(result.results[1].status, 'ready')
    assert.equal(result.results[2].status, 'ready')
    // 下游账本里存的是真实任务号，不是 key
    assert.deepEqual(result.results[1].dependsOn, [result.results[0].taskId])
    assert.deepEqual(result.results[2].dependsOn, [result.results[1].taskId])
    assert.equal(opts.tasks.get(result.results[2].taskId).dependsOn[0], result.results[1].taskId)
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：上游失败，下游标 blocked 且不再 spawn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents({ failBots: ['a'] })
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const result = JSON.parse(await run(def, {
      tasks: JSON.stringify([
        { key: 'collect', bot: 'a', task: '采集' },
        { key: 'write', bot: 'b', task: '写简报', dependsOn: ['collect'] },
        { key: 'audit', bot: 'auditor', task: '复核', dependsOn: ['write'] },
      ]),
    }))
    assert.equal(result.status, 'done')
    assert.equal(result.results[0].status, 'failed')
    assert.equal(result.results[1].status, 'blocked')
    assert.equal(result.results[2].status, 'blocked')
    assert.equal(subagents.calls.length, 1)
    assert.match(result.results[1].message, /上游 .* 状态是 failed/)
    assert.equal(opts.tasks.get(result.results[1].taskId).status, 'blocked')
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：依赖成环直接拒绝，不 spawn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const result = JSON.parse(await run(def, {
      tasks: JSON.stringify([
        { key: 'a', bot: 'a', task: '甲', dependsOn: ['b'] },
        { key: 'b', bot: 'b', task: '乙', dependsOn: ['a'] },
      ]),
    }))
    assert.equal(result.status, 'failed')
    assert.match(result.error, /成环/)
    assert.equal(subagents.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：找不到依赖直接拒绝，不 spawn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const result = JSON.parse(await run(def, {
      tasks: JSON.stringify([
        { key: 'write', bot: 'b', task: '写简报', dependsOn: ['ghost'] },
      ]),
    }))
    assert.equal(result.status, 'failed')
    assert.match(result.error, /依赖找不到：ghost/)
    assert.equal(subagents.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('team_dispatch：accepted 模式不阻塞，上游验收后后台自动派', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-up', {
      taskId: 't-up',
      bot: 'a',
      status: 'ready',
      parentSession: 'session-test',
      brief: { task: '采集' },
      output: '上游完成',
    })
    const def = definitionOf(tools, 'team_dispatch')
    const started = Date.now()
    const result = JSON.parse(await run(def, {
      bot: 'b',
      task: '写简报',
      dependsOn: ['t-up'],
      dependsOnMode: 'accepted',
      dependsOnTimeoutSec: 5,
    }))
    assert.equal(result.status, 'queued')
    assert.ok(Date.now() - started < 1000, '验收门不应该阻塞整轮调用')
    assert.equal(opts.tasks.get(result.taskId).dependsOnMode, 'accepted')
    // 模拟秘书在工具返回后去验收上游；后台等待应该自己醒。
    opts.tasks.get('t-up').status = 'accepted'
    for (let i = 0; i < 40; i += 1) {
      if (opts.tasks.get(result.taskId)?.status === 'ready') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(opts.tasks.get(result.taskId)?.status, 'ready')
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：accepted 门也不阻塞整批，验收后自动接上', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const started = Date.now()
    const result = JSON.parse(await run(def, {
      tasks: JSON.stringify([
        { key: 'collect', bot: 'a', task: '采集' },
        { key: 'write', bot: 'b', task: '写简报', dependsOn: ['collect'], dependsOnMode: 'accepted' },
      ]),
    }))
    assert.equal(result.status, 'done')
    assert.ok(Date.now() - started < 3000, 'accepted 门不应该把整批卡住')
    assert.equal(result.results[1].status, 'queued')
    opts.tasks.get(result.results[0].taskId).status = 'accepted'
    for (let i = 0; i < 60; i += 1) {
      if (opts.tasks.get(result.results[1].taskId)?.status === 'ready') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(opts.tasks.get(result.results[1].taskId)?.status, 'ready')
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：整链超时，未开始的下游标 blocked', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents({ delayMs: 250 })
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const result = JSON.parse(await run(def, {
      chainTimeoutSec: 0.05,
      tasks: JSON.stringify([
        { key: 'collect', bot: 'a', task: '采集' },
        { key: 'write', bot: 'b', task: '写简报', dependsOn: ['collect'] },
      ]),
    }))
    assert.equal(result.status, 'done')
    assert.equal(result.results[1].status, 'blocked')
    assert.match(result.results[1].message, /整链超过/)
  } finally {
    await cleanup()
  }
})

test('cancelChain：同一条链未结束的任务一起收掉', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-1', { taskId: 't-1', bot: 'a', status: 'running', chainId: 't-1', startedAt: Date.now() })
    opts.tasks.set('t-2', { taskId: 't-2', bot: 'b', status: 'queued', chainId: 't-1', startedAt: Date.now() })
    const result = await opts.api.cancelChain('t-1')
    assert.equal(result.ok, true)
    assert.deepEqual(result.cancelled.sort(), ['t-1', 't-2'])
    assert.equal(opts.tasks.get('t-1').status, 'cancelled')
    assert.equal(opts.tasks.get('t-2').status, 'cancelled')
  } finally {
    await cleanup()
  }
})

test('cancelChain：已经交活等验收的 ready 不被抹掉', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-1', { taskId: 't-1', bot: 'a', status: 'running', chainId: 't-1', startedAt: Date.now() })
    opts.tasks.set('t-2', {
      taskId: 't-2',
      bot: 'b',
      status: 'ready',
      chainId: 't-1',
      startedAt: Date.now(),
      doneAt: Date.now(),
    })
    const result = await opts.api.cancelChain('t-1')
    assert.equal(result.ok, true)
    assert.deepEqual(result.cancelled, ['t-1'])
    assert.equal(opts.tasks.get('t-2').status, 'ready')
  } finally {
    await cleanup()
  }
})

test('取消排队的验收门任务后，上游验收也不会把它偷偷启动', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-up', {
      taskId: 't-up',
      bot: 'a',
      status: 'ready',
      chainId: 't-up',
      startedAt: Date.now(),
      doneAt: Date.now(),
    })
    const def = definitionOf(tools, 'team_dispatch')
    const result = JSON.parse(await run(def, {
      bot: 'b',
      task: '写简报',
      dependsOn: ['t-up'],
      dependsOnMode: 'accepted',
    }))
    assert.equal(result.status, 'queued')
    await opts.api.cancel(result.taskId)
    opts.tasks.get('t-up').status = 'accepted'
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(opts.tasks.get(result.taskId).status, 'cancelled')
    assert.equal(subagents.calls.filter((call) => call.bot === 'b').length, 0)
  } finally {
    await cleanup()
  }
})

test('team_dispatch：有交付物的活自动建审计任务，审计未过不能验收', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const dispatch = definitionOf(tools, 'team_dispatch')
    const raw = JSON.parse(await run(dispatch, { bot: 'a', task: '写报告', deliverable: 'report.md' }))
    assert.equal(raw.status, 'ready')
    let audit = null
    for (let i = 0; i < 40; i += 1) {
      audit = [...opts.tasks.values()].find((row) => row.reviewOf === raw.taskId) ?? null
      if (audit) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(audit, '没有自动生成审计任务')
    assert.equal(audit.bot, 'auditor')
    const review = definitionOf(tools, 'team_review')
    const blocked = JSON.parse(await run(review, { taskId: raw.taskId, verdict: 'accepted', grade: 'good' }))
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /需要先审计/)
  } finally {
    await cleanup()
  }
})
