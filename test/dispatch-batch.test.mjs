/**
 * 批量派活、计划预览、返工带意见、重试带模型。
 *
 * 这些用例不碰真实子会话：`startActivation` 是桩，只记录调用参数并回一段文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTeamTools } from '../host/tools.js'

/** 收集注册结果的假 tools 服务。 */
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

/** 一个“带队会话”的最小 agent 形状。 */
const leadAgent = { session: { header: { id: 'session-test', parentSession: undefined } } }

/**
 * 造一个临时团队目录：三个 Bot，一个带模型。
 * @returns `{ root, cleanup }`。
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-batch-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(join(root, 'bots', 'a.json'), JSON.stringify({ id: 'a', name: '甲', role: '采集', model: 'deepseek-pro' }), 'utf8')
  await writeFile(join(root, 'bots', 'b.json'), JSON.stringify({ id: 'b', name: '乙', role: '写作' }), 'utf8')
  await writeFile(join(root, 'bots', 'auditor.json'), JSON.stringify({ id: 'auditor', name: '审计员', role: '成果审计' }), 'utf8')
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * 桩子会话：第一次按 `failFirst` 决定成功还是技术性失败。
 * @param options - `{ failFirst }`。
 */
function stubSubagents(options = {}) {
  const calls = []
  let started = 0
  return {
    calls,
    async startActivation(activation) {
      started += 1
      calls.push({ activation, activation_agentOptions: activation?.agentOptions ?? null })
      const index = started
      const shouldFail = options.failFirst === true && index === 1
      return {
        childId: `child-${index}`,
        name: activation?.name ?? `child-${index}`,
        dispose: async () => {},
        result: shouldFail
          ? Promise.reject(new Error('fetch failed'))
          : Promise.resolve({ output: [{ type: 'text', text: `完成 ${index}` }] }),
      }
    },
  }
}

/**
 * @param tools - fake tools.
 * @param root - temp root.
 * @param subagents - stub.
 * @returns options for registerTeamTools.
 */
function options(tools, root, subagents, agents = {}) {
  return {
    root,
    tools,
    agents,
    subagents,
    debug: async () => {},
    pending: new Map(),
    tasks: new Map(),
    deliverableRoot: join(root, 'deliverables'),
    getDeliverableRoot: () => join(root, 'deliverables'),
    getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 5 }),
    persistTasks: async () => {},
    isTeamSession: () => true,
  }
}

/**
 * 取出一个已注册的工具定义。
 * @param tools - fake tools.
 * @param name - tool name.
 */
function definitionOf(tools, name) {
  const hit = tools.registered.find((row) => row.definition.name === name)
  assert.ok(hit, `没有注册 ${name}`)
  return hit.definition
}

test('team_dispatch_many：互不依赖的活并行跑，任务号不撞', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    const def = definitionOf(tools, 'team_dispatch_many')
    const raw = await def.execute({
      tasks: JSON.stringify([
        { bot: 'a', task: '采集 npm 数据' },
        { bot: 'b', task: '写简报' },
        { bot: 'auditor', task: '只读复核' },
      ]),
    }, { agent: leadAgent, signal: undefined })
    const result = JSON.parse(raw)
    assert.equal(result.status, 'done')
    assert.equal(result.count, 3)
    assert.equal(subagents.calls.length, 3)
    // 三个任务号互不相同（并行时同一毫秒也不能撞）
    const ids = [...opts.tasks.keys()]
    assert.equal(new Set(ids).size, 3)
    for (const row of opts.tasks.values()) {
      assert.equal(row.status, 'ready')
    }
    // 每件活的结果都带一张可以立刻贴出去的卡片
    for (const row of result.results) {
      assert.match(row.relay, /^```member/)
      assert.match(row.relay, new RegExp(`task: ${row.taskId}`))
      assert.match(row.relay, /status: ready/)
    }
    // 子智能体列表显示 Bot 名字，不是 id
    assert.ok(subagents.calls.some((call) => /^甲：任务 t-/.test(call.activation.label)))
    assert.ok(subagents.calls.some((call) => /^乙：任务 t-/.test(call.activation.label)))
    // 名册里指定的模型必须带到激活参数里；没指定的留空跟随默认
    assert.equal(subagents.calls.find((call) => call.activation.name.startsWith('a-'))?.activation_agentOptions?.model, 'deepseek-pro')
    assert.equal(subagents.calls.find((call) => call.activation.name.startsWith('b-'))?.activation_agentOptions, null)
    // 审计单必须带固定口径：先查交付物在不在、是不是空的。
    const auditCall = subagents.calls.find((call) => call.activation.name.startsWith('auditor-'))
    const auditText = auditCall.activation.prompt.map((part) => part.text).join('\n')
    assert.match(auditText, /必查五条/)
    assert.match(auditText, /交付物存在、非空、数量与任务单一致/)
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：空数组和缺字段直接拒绝，不 spawn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    registerTeamTools({}, options(tools, root, subagents))
    const def = definitionOf(tools, 'team_dispatch_many')
    const empty = JSON.parse(await def.execute({ tasks: '[]' }))
    assert.equal(empty.status, 'failed')
    const missing = JSON.parse(await def.execute({ tasks: JSON.stringify([{ bot: 'a' }]) }))
    assert.equal(missing.status, 'failed')
    assert.match(missing.error, /缺 bot 或 task/)
    assert.equal(subagents.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('team_plan：只出计划，不 spawn', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    registerTeamTools({}, options(tools, root, subagents))
    const def = definitionOf(tools, 'team_plan')
    const result = JSON.parse(await def.execute({
      tasks: JSON.stringify([
        { bot: 'a', task: '采集', size: 'quick' },
        { bot: 'b', task: '写作', size: 'normal' },
        { bot: 'ghost', task: '不存在的 Bot' },
      ]),
    }))
    assert.equal(result.ok, true)
    assert.equal(result.plan.length, 3)
    assert.equal(subagents.calls.length, 0)
    assert.equal(result.plan[0].model, 'deepseek-pro')
    assert.equal(result.plan[1].model, '默认')
    assert.equal(result.plan[2].available, false)
    assert.equal(result.waves, 2)
    assert.ok(result.estimate.tokens > 0)
  } finally {
    await cleanup()
  }
})

test('team_retry：返工在原会话继续，不新开子会话', async () => {
  const { root, cleanup } = await fixture()
  try {
    const taskDir = join(root, '.team-work', 'a', 't-old')
    await mkdir(taskDir, { recursive: true })
    const sent = []
    const events = [{ type: 'assistant/message', message: { content: [{ type: 'text', text: '旧答案' }] } }]
    let status = 'idle'
    const agent = {
      get status() {
        return status
      },
      session: { snapshotEvents: () => events.slice() },
    }
    const subagents = {
      calls: [],
      async startActivation() {
        throw new Error('返工不该新开会话')
      },
      async sendMessage(sender, targetId, content, sendOptions) {
        sent.push({ sender, targetId, content, sendOptions })
        status = 'running'
        setTimeout(() => {
          events.push({ type: 'assistant/message', message: { content: [{ type: 'text', text: '新答案' }] } })
          status = 'idle'
        }, 15)
        return 'inbox-1'
      },
    }
    const agents = { get: (id) => (id === 'session-old' ? agent : null) }
    const tools = fakeTools()
    const opts = options(tools, root, subagents, agents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-old', {
      taskId: 't-old',
      bot: 'a',
      parentSession: 'session-test',
      sessionId: 'session-old',
      output: '旧答案',
      cwd: taskDir,
      note: '口径要改',
      status: 'rejected',
      brief: { task: '写一版' },
    })
    const def = definitionOf(tools, 'team_retry')
    const result = JSON.parse(await def.execute({ taskId: 't-old' }, { agent: leadAgent, signal: undefined }))
    assert.equal(result.status, 'ready')
    assert.equal(result.continued, true)
    assert.equal(result.output, '新答案')
    assert.equal(result.sessionId, 'session-old')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].targetId, 'session-old')
    assert.match(sent[0].content[0].text, /返工/)
    assert.match(sent[0].content[0].text, /口径要改/)
    const row = opts.tasks.get(result.taskId)
    assert.equal(row.sessionId, 'session-old')
    assert.equal(row.cwd, taskDir)
    assert.equal(row.continuesFrom, 't-old')
  } finally {
    await cleanup()
  }
})

test('team_retry：接不上原会话时才新开', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents() // 没有 sendMessage
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-old', {
      taskId: 't-old',
      bot: 'a',
      parentSession: 'session-test',
      sessionId: 'session-gone',
      output: '旧答案',
      status: 'rejected',
      note: '再改一次',
      brief: { task: '写一版' },
    })
    const def = definitionOf(tools, 'team_retry')
    const result = JSON.parse(await def.execute({ taskId: 't-old' }, { agent: leadAgent, signal: undefined }))
    assert.equal(result.status, 'ready')
    assert.equal(result.retriedFrom, 't-old')
    assert.equal(subagents.calls.length, 1)
  } finally {
    await cleanup()
  }
})

test('team_retry：把上一轮的验收意见带进新任务单', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-old', {
      taskId: 't-old',
      bot: 'a',
      parentSession: 'session-test',
      status: 'rejected',
      note: '第三处口径要改',
      brief: { task: '写一版' },
    })
    const def = definitionOf(tools, 'team_retry')
    const result = JSON.parse(await def.execute({ taskId: 't-old' }, { agent: leadAgent, signal: undefined }))
    assert.equal(result.status, 'ready')
    assert.equal(subagents.calls.length, 1)
    const prompt = subagents.calls[0].activation.prompt[0].text
    assert.match(prompt, /上一轮打回原因/)
    assert.match(prompt, /第三处口径要改/)
  } finally {
    await cleanup()
  }
})

test('team_dispatch：continueFrom 走原会话（同一件成果的后续改动）', async () => {
  const { root, cleanup } = await fixture()
  try {
    const taskDir = join(root, '.team-work', 'a', 't-old')
    await mkdir(taskDir, { recursive: true })
    const sent = []
    const events = [{ type: 'assistant/message', message: { content: [{ type: 'text', text: '旧答案' }] } }]
    let status = 'idle'
    const agent = {
      get status() {
        return status
      },
      session: { snapshotEvents: () => events.slice() },
    }
    const subagents = {
      calls: [],
      async startActivation() {
        throw new Error('后续改动不该新开会话')
      },
      async sendMessage(sender, targetId, content) {
        sent.push({ targetId, content })
        status = 'running'
        setTimeout(() => {
          events.push({ type: 'assistant/message', message: { content: [{ type: 'text', text: '改好的答案' }] } })
          status = 'idle'
        }, 15)
        return 'inbox-2'
      },
    }
    const tools = fakeTools()
    const opts = options(tools, root, subagents, { get: (id) => (id === 'session-old' ? agent : null) })
    registerTeamTools({}, opts)
    opts.tasks.set('t-old', {
      taskId: 't-old',
      bot: 'a',
      parentSession: 'session-test',
      sessionId: 'session-old',
      output: '旧答案',
      cwd: taskDir,
      status: 'accepted',
      brief: { task: '写一版' },
    })
    const def = definitionOf(tools, 'team_dispatch')
    const result = JSON.parse(await def.execute(
      { bot: 'a', task: '把第三段改短', continueFrom: 't-old' },
      { agent: leadAgent, signal: undefined },
    ))
    assert.equal(result.status, 'ready')
    assert.equal(result.continued, true)
    assert.equal(result.output, '改好的答案')
    assert.equal(result.sessionId, 'session-old')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].targetId, 'session-old')
    assert.match(sent[0].content[0].text, /接着上一件成果继续做/)
    const row = opts.tasks.get(result.taskId)
    assert.equal(row.continuesFrom, 't-old')
    assert.equal(row.cwd, taskDir)
  } finally {
    await cleanup()
  }
})

test('team_dispatch：continueFrom 不能换人续', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    const opts = options(tools, root, subagents)
    registerTeamTools({}, opts)
    opts.tasks.set('t-old', {
      taskId: 't-old',
      bot: 'a',
      parentSession: 'session-test',
      sessionId: 'session-old',
      output: '旧答案',
      status: 'accepted',
      brief: { task: '写一版' },
    })
    const def = definitionOf(tools, 'team_dispatch')
    const result = JSON.parse(await def.execute(
      { bot: 'b', task: '改一版', continueFrom: 't-old' },
      { agent: leadAgent, signal: undefined },
    ))
    assert.equal(result.status, 'failed')
    assert.match(result.error, /不能换人续/)
    assert.equal(subagents.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('team_dispatch_many：同一件成果不能在批量里派两路', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const subagents = stubSubagents()
    registerTeamTools({}, options(tools, root, subagents))
    const def = definitionOf(tools, 'team_dispatch_many')
    const result = JSON.parse(await def.execute({
      tasks: JSON.stringify([
        { bot: 'a', task: '改开头', continueFrom: 't-old' },
        { bot: 'a', task: '改结尾', continueFrom: 't-old' },
      ]),
    }))
    assert.equal(result.status, 'failed')
    assert.match(result.error, /不能在批量里派两路/)
    assert.equal(subagents.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('重试仍然带名册里的模型，不会退回默认', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    // 首跑技术性失败，触发一次自动重试
    const subagents = stubSubagents({ failFirst: true })
    registerTeamTools({}, options(tools, root, subagents))
    const def = definitionOf(tools, 'team_dispatch')
    const result = JSON.parse(await def.execute({ bot: 'a', task: '写一版' }, { agent: leadAgent, signal: undefined }))
    assert.equal(result.status, 'ready')
    assert.equal(result.retried, 1)
    assert.equal(subagents.calls.length, 2)
    assert.equal(subagents.calls[0].activation_agentOptions?.model, 'deepseek-pro')
    assert.equal(subagents.calls[1].activation_agentOptions?.model, 'deepseek-pro')
  } finally {
    await cleanup()
  }
})

test('team_user_feedback：改判同步状态，并按新评分补经验差额', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const opts = options(tools, root, stubSubagents())
    registerTeamTools({}, opts)
    opts.tasks.set('t-x', {
      taskId: 't-x',
      bot: 'a',
      parentSession: 'session-test',
      status: 'ready',
      startedAt: Date.now() - 1000,
      doneAt: Date.now(),
    })
    const review = definitionOf(tools, 'team_review')
    const accepted = JSON.parse(await review.execute({ taskId: 't-x', verdict: 'accepted', grade: 'good' }))
    assert.equal(accepted.ok, true)
    assert.equal(opts.tasks.get('t-x').growthGain, 175)

    const before = JSON.parse(await readFile(join(root, 'bots', 'a.json'), 'utf8')).growth.totalXp
    const feedback = definitionOf(tools, 'team_user_feedback')
    const fed = JSON.parse(await feedback.execute({ taskId: 't-x', signal: 'fix', note: '数字不对' }))
    assert.equal(fed.ok, true)

    const entry = opts.tasks.get('t-x')
    assert.equal(entry.status, 'rejected')
    assert.equal(entry.verdict, 'rejected')
    assert.equal(entry.grade, 'poor')
    assert.equal(entry.growthGain, 70)
    const after = JSON.parse(await readFile(join(root, 'bots', 'a.json'), 'utf8')).growth.totalXp
    assert.equal(before - after, 105)
  } finally {
    await cleanup()
  }
})

test('team_dispatch：交活时广播 task-done，卡片不用等这一轮收尾', async () => {
  const { root, cleanup } = await fixture()
  try {
    const tools = fakeTools()
    const opts = options(tools, root, stubSubagents())
    const broadcasts = []
    opts.api = { broadcast: (payload) => broadcasts.push(payload) }
    registerTeamTools({}, opts)
    const raw = await definitionOf(tools, 'team_dispatch').execute(
      { bot: 'b', task: '写简报' },
      { agent: leadAgent, signal: undefined },
    )
    const result = JSON.parse(raw)
    assert.equal(result.status, 'ready')
    const done = broadcasts.find((payload) => payload?.type === 'task-done')
    assert.ok(done, '没有广播 task-done')
    assert.equal(done.taskId, result.taskId)
    assert.equal(done.bot, 'b')
    assert.equal(done.status, 'ready')
    assert.match(done.text, /完成/)
  } finally {
    await cleanup()
  }
})
