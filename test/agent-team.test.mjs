/**
 * 原生的「启用智能体团队协作」：只有 Bot 定义里勾了 agentTeam，装饰子会话时才去开。
 * 这里用真 `installChildDecoration` + 假 agent，验证挂点和开关语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installChildDecoration } from '../host/tools.js'

/** 建一个临时 bot 目录，只放一个 Bot。 */
async function rootWith(bot) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-agentteam-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(join(root, 'bots', `${bot.id}.json`), JSON.stringify(bot), 'utf8')
  return root
}

/** 子会话 agent 的最小形状。 */
function childAgent(id) {
  return {
    id,
    session: { header: { id, parentSession: 'session-lead' }, append() {} },
    ctx: {
      on() { return () => {} },
      systemPrompt: { section: () => () => {} },
      tools: { restrict() {} },
    },
  }
}

/** 插件 ctx：收 agent/created，并把 agentTeams 桩放进 get()。 */
function pluginCtx(calls) {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(name, fn) {
        handlers.set(name, fn)
        return () => {}
      },
      effect() {},
      get(name) {
        if (name !== 'agentTeams') return undefined
        return {
          async setEnabled(agent, enabled) {
            calls.push({ sessionId: agent?.session?.header?.id, enabled })
          },
        }
      },
    },
  }
}

test('Bot 勾了 agentTeam：装饰时打开原生子智能体', async () => {
  const root = await rootWith({ id: 'nova', name: 'Nova', role: '研究员', agentTeam: true })
  const calls = []
  const plugin = pluginCtx(calls)
  const pending = new Map()
  const childId = 'session-child-1'
  pending.set(childId, { bot: { id: 'nova', name: 'Nova', role: '研究员', agentTeam: true }, taskDir: root })

  installChildDecoration(plugin.ctx, {
    debug: async () => {},
    pending,
    tasks: new Map(),
    persistTasks: async () => {},
    root,
  })

  await plugin.handlers.get('agent/created')({ agent: childAgent(childId) })
  assert.deepEqual(calls, [{ sessionId: childId, enabled: true }])
})

test('没勾 agentTeam：不碰原生开关', async () => {
  const root = await rootWith({ id: 'nova', name: 'Nova', role: '研究员' })
  const calls = []
  const plugin = pluginCtx(calls)
  const pending = new Map()
  const childId = 'session-child-2'
  pending.set(childId, { bot: { id: 'nova', name: 'Nova', role: '研究员' }, taskDir: root })

  installChildDecoration(plugin.ctx, {
    debug: async () => {},
    pending,
    tasks: new Map(),
    persistTasks: async () => {},
    root,
  })

  await plugin.handlers.get('agent/created')({ agent: childAgent(childId) })
  assert.deepEqual(calls, [])
})

test('拿不到 agentTeams 服务也不炸子会话', async () => {
  const root = await rootWith({ id: 'nova', name: 'Nova', role: '研究员', agentTeam: true })
  const handlers = new Map()
  const pending = new Map()
  const childId = 'session-child-3'
  pending.set(childId, { bot: { id: 'nova', name: 'Nova', role: '研究员', agentTeam: true }, taskDir: root })

  installChildDecoration(
    {
      on(name, fn) {
        handlers.set(name, fn)
        return () => {}
      },
      effect() {},
      get() {
        return undefined
      },
    },
    { debug: async () => {}, pending, tasks: new Map(), persistTasks: async () => {}, root },
  )

  await handlers.get('agent/created')({ agent: childAgent(childId) })
  assert.equal(pending.has(childId), false)
})
