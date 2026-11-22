/**
 * token 记账的接线测试：装饰子会话时挂上 usage 监听，派活结算时把用量写进账本。
 *
 * 用的是真 `installChildDecoration` + 真 `team_dispatch`，只把 subagent 运行时
 * 和文件系统换成桩：这样能挡住「事件名写错、账本字段没写进去」那类断链，
 * 又不用起一个真子会话去烧 token。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installChildDecoration, registerTeamTools } from '../host/tools.js'
import { createUsageBook } from '../host/usage.js'

/** 一个只收集注册结果的假 tools 服务。 */
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

/** 建一个只放了 nova 的临时 bot 目录。 */
async function tmpRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-usage-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(
    join(root, 'bots', 'nova.json'),
    JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员' }),
    'utf8',
  )
  return root
}

/** 子会话 agent 的最小形状：够装饰流程用。 */
function childAgent(id) {
  const handlers = new Map()
  return {
    handlers,
    agent: {
      id,
      session: { header: { id, parentSession: 'session-lead' }, append() {} },
      ctx: {
        on(name, fn) {
          handlers.set(name, fn)
          return () => {}
        },
        systemPrompt: { section: () => () => {} },
        tools: { restrict() {} },
      },
    },
  }
}

const leadAgent = { session: { header: { id: 'session-lead' } } }

test('派活结算时把子会话的真实 usage 写进任务账本', async () => {
  const root = await tmpRoot()
  const tasks = new Map()
  const usageBook = createUsageBook()
  const pending = new Map()
  const tools = fakeTools()

  // 插件级 ctx：只收 agent/created。
  const createdHandlers = new Map()
  const pluginCtx = {
    on(name, fn) {
      createdHandlers.set(name, fn)
      return () => {}
    },
    effect() {},
    get() {},
  }
  installChildDecoration(pluginCtx, {
    debug: async () => {},
    pending,
    tasks,
    persistTasks: async () => {},
    root,
    usageBook,
  })

  const children = []
  const subagents = {
    async startActivation(spec) {
      const child = childAgent(spec.childId)
      children.push(child)
      const armed = Promise.resolve(createdHandlers.get('agent/created')({ agent: child.agent }))
      return {
        childId: spec.childId,
        name: spec.name,
        result: (async () => {
          await armed
          const emit = child.handlers.get('agent/assistant-stream')
          // 两个模型步，各自一个 usage 块：合计 total 120 + 80 = 200。
          emit({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } })
          emit({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 } } })
          return { output: [{ type: 'text', text: '干完了' }] }
        })(),
        dispose: async () => {},
      }
    },
  }

  registerTeamTools({}, {
    root,
    tools,
    agents: {},
    subagents,
    debug: async () => {},
    pending,
    tasks,
    usageBook,
    deliverableRoot: root,
    getDeliverableRoot: () => root,
    getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 600 }),
    persistTasks: async () => {},
    isTeamSession: () => true,
  })

  const dispatch = tools.registered.find((row) => row.definition.name === 'team_dispatch').definition
  const raw = await dispatch.execute(
    { bot: 'nova', task: '看一下这个文件' },
    { agent: leadAgent, signal: undefined },
  )
  const result = JSON.parse(raw)
  assert.equal(result.status, 'ready')
  assert.equal(result.output, '干完了')

  const entry = tasks.get(result.taskId)
  assert.ok(entry, '账本里要有这一行')
  assert.deepEqual(entry.tokens, {
    input: 160,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
    total: 200,
    steps: 2,
  })
  // 领走之后簿子是空的，后面的单聊不会被算进这一件。
  assert.equal(usageBook.get(entry.sessionId), null)
  // 账本里不再记字数：字数和成本没关系，闸门也已经拆掉了。
  assert.equal('chars' in entry, false)
})

test('没报 usage 的子会话不会留下空的 token 字段', async () => {
  const root = await tmpRoot()
  const tasks = new Map()
  const usageBook = createUsageBook()
  const pending = new Map()
  const tools = fakeTools()
  const createdHandlers = new Map()
  installChildDecoration(
    { on: (name, fn) => (createdHandlers.set(name, fn), () => {}), effect() {}, get() {} },
    { debug: async () => {}, pending, tasks, persistTasks: async () => {}, root, usageBook },
  )

  const subagents = {
    async startActivation(spec) {
      const child = childAgent(spec.childId)
      const armed = Promise.resolve(createdHandlers.get('agent/created')({ agent: child.agent }))
      return {
        childId: spec.childId,
        name: spec.name,
        result: (async () => {
          await armed
          // 只推正文，不推 usage（比如请求直接失败）。
          child.handlers.get('agent/assistant-stream')({
            type: 'chunk',
            chunk: { type: 'text-delta', index: 0, text: '在' },
          })
          return { output: [{ type: 'text', text: '在' }] }
        })(),
        dispose: async () => {},
      }
    },
  }

  registerTeamTools({}, {
    root,
    tools,
    agents: {},
    subagents,
    debug: async () => {},
    pending,
    tasks,
    usageBook,
    deliverableRoot: root,
    getDeliverableRoot: () => root,
    getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 600 }),
    persistTasks: async () => {},
    isTeamSession: () => true,
  })

  const dispatch = tools.registered.find((row) => row.definition.name === 'team_dispatch').definition
  const result = JSON.parse(await dispatch.execute({ bot: 'nova', task: '回一句' }, { agent: leadAgent }))
  const entry = tasks.get(result.taskId)
  assert.equal(entry.tokens, undefined)
  assert.equal('chars' in entry, false)
})
