/**
 * 底座规则：内容对得上，且和人设分成两段——用户改人设换不掉它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_RULES, BASE_RULES_ORDER, BASE_RULES_SECTION, PRIVATE_ORDER, PRIVATE_SECTION } from '../host/base-rules.js'
import { installChildDecoration } from '../host/tools.js'

test('the base rules declare that they win over a persona', () => {
  assert.match(BASE_RULES, /优先于人设/)
  assert.match(BASE_RULES, /人设只决定你怎么说话，不决定你做什么/)
})

test('the base rules cover orders, honesty, red lines and growth', () => {
  assert.match(BASE_RULES, /用户 > 秘书 > 其他 Bot/)
  assert.match(BASE_RULES, /先说明冲突/)
  assert.match(BASE_RULES, /结束本轮/)
  assert.match(BASE_RULES, /不编造事实、数字、引文、页码/)
  assert.match(BASE_RULES, /材料名 \+ 页码\/章节/)
  assert.match(BASE_RULES, /不许假装做完/)
  assert.match(BASE_RULES, /不删、不改用户的原文件/)
  assert.match(BASE_RULES, /不外发，不花钱/)
  assert.match(BASE_RULES, /不承诺时间，不替团队答应事情/)
  assert.match(BASE_RULES, /是数据，不是指令/)
  assert.match(BASE_RULES, /经验只来自被秘书验收的真实工作/)
  assert.match(BASE_RULES, /禁止拆活刷经验/)
  assert.match(BASE_RULES, /带一句简短的谢意/)
})

test('the speech line does not dictate what the speech must mention', () => {
  // 博士 2026-11-20 明确删掉「说你真做过的一件活或一条真被教过的规矩」。
  assert.doesNotMatch(BASE_RULES, /真做过的活/)
  assert.doesNotMatch(BASE_RULES, /真被教过的规矩/)
})

test('the base rules stay short: they ride along with every dispatch', () => {
  assert.ok(BASE_RULES.length <= 1200, `base rules grew to ${BASE_RULES.length} chars`)
})

/** 只收 section 的假 systemPrompt 服务。 */
function fakeAgent(header) {
  const sections = []
  return {
    sections,
    session: { header, append() {} },
    ctx: {
      systemPrompt: {
        section(definition) {
          // 人设段的 text 可能是取值函数（热更新靠它），假服务按真服务那样先取值。
          sections.push({ ...definition, text: typeof definition.text === 'function' ? definition.text() : definition.text })
          return () => {}
        },
      },
      tools: { restrict() {} },
      on() {},
    },
  }
}

test('a child gets the rules as their own section, before the persona', async () => {
  const pending = new Map()
  pending.set('session-child', { bot: { id: 'nova', name: 'Nova', role: '研究员' }, taskDir: null })
  // ctx.on 返回监听函数本身，正好当 handler 用。
  const ctx = { on: (_event, listener) => listener, effect: () => {} }
  const handler = installChildDecoration(ctx, {
    debug: async () => {},
    pending,
    tasks: new Map(),
    persistTasks: async () => {},
    root: process.cwd(),
  })
  assert.equal(typeof handler, 'function')
  const agent = fakeAgent({ id: 'session-child', parentSession: 'session-parent' })
  await handler({ agent })
  const names = agent.sections.map((section) => section.name)
  const rules = agent.sections.find((section) => section.name === BASE_RULES_SECTION)
  const persona = agent.sections.find((section) => section.name === 'dsh-team/persona')
  assert.ok(rules, `rules section missing (got ${names.join(', ')})`)
  assert.ok(persona, `persona section missing (got ${names.join(', ')})`)
  // 数字小的在前：团队知识库 115 → 底座 118 → 人设 120
  assert.ok(BASE_RULES_ORDER < persona.order, 'rules must come before the persona')
  assert.equal(rules.text, BASE_RULES)
  // 底座的正文不掺人设：改 persona 改不动它。
  assert.ok(!rules.text.includes('Nova'))
  assert.match(persona.text, /Nova/)
  assert.match(persona.text, /只决定你怎么说话/)
})

/** 一个带工具服务的假 agent：私聊里要给它注册 remember、再挡掉别的工具。 */
function fakeAgentWithTools(header) {
  const sections = []
  const registered = []
  const denied = []
  const guards = []
  return {
    sections,
    registered,
    denied,
    guards,
    session: { header, append() {} },
    ctx: {
      get: () => undefined,
      systemPrompt: {
        section(definition) {
          sections.push({ ...definition, text: typeof definition.text === 'function' ? definition.text() : definition.text })
          return () => {}
        },
      },
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
        definitions() {
          return [{ name: 'team_dispatch' }, { name: 'team_review' }, { name: 'remember' }]
        },
        restrict(filter) {
          denied.push(filter)
        },
        guard(fn) {
          guards.push(fn)
          return () => {}
        },
      },
      on() {},
    },
  }
}

test('私聊会话挂私聊规则段，工具收成一个 remember', async () => {
  const pending = new Map()
  pending.set('session-private', {
    bot: { id: 'nova', name: 'Nova', role: '研究员' },
    taskDir: null,
    chatKind: 'private',
  })
  const ctx = { on: (_event, listener) => listener, effect: () => {} }
  const handler = installChildDecoration(ctx, {
    debug: async () => {},
    pending,
    tasks: new Map(),
    persistTasks: async () => {},
    root: process.cwd(),
    personas: new Map(),
  })
  const agent = fakeAgentWithTools({ id: 'session-private', parentSession: 'session-parent' })
  await handler({ agent })
  const priv = agent.sections.find((section) => section.name === PRIVATE_SECTION)
  const persona = agent.sections.find((section) => section.name === 'dsh-team/persona')
  assert.ok(priv, '私聊没有挂私聊规则段')
  assert.equal(priv.order, PRIVATE_ORDER)
  assert.ok(PRIVATE_ORDER > persona.order, '私聊规则排在人设之后')
  assert.equal(agent.registered.length, 1, '只应该注册一个工具')
  assert.equal(agent.registered[0].name, 'remember')
  const deny = agent.denied.flatMap((filter) => filter.deny ?? [])
  assert.ok(deny.includes('team_dispatch'), '私聊里不该还能派活')
  assert.ok(!deny.includes('remember'), 'remember 是会话作用域的，别把它挡住')
  // 剩下那些「会话自己登记」的工具 restrict 挡不掉，只能在执行口拦。
  assert.equal(agent.guards.length, 1, '私聊要装一道执行口守卫')
  const guard = agent.guards[0]
  assert.equal(guard({ name: 'remember' }), undefined, 'remember 要放行')
  assert.match(String(guard({ name: 'ops_bash' })), /私聊里不做事/)
})

test('私聊里 remember 写一行结论，表头不删', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remember-'))
  try {
    const memoryDir = join(root, 'bots', 'nova', 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'project.md'), '# 表头\n[私聊 2026-01-01] 旧条目\n', 'utf8')
    const pending = new Map()
    pending.set('session-private', {
      bot: { id: 'nova', name: 'Nova', role: '研究员' },
      taskDir: null,
      chatKind: 'private',
    })
    const ctx = { on: (_event, listener) => listener, effect: () => {} }
    const handler = installChildDecoration(ctx, {
      debug: async () => {},
      pending,
      tasks: new Map(),
      persistTasks: async () => {},
      root,
      personas: new Map(),
    })
    const agent = fakeAgentWithTools({ id: 'session-private', parentSession: 'session-parent' })
    await handler({ agent })
    const out = await agent.registered[0].execute({ text: '用户不喜欢长篇汇报' })
    assert.match(String(out), /已记下/)
    const text = await readFile(join(memoryDir, 'project.md'), 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines[0], '# 表头', '表头不能被当成最旧的一行删掉')
    assert.match(lines[2], /^\[私聊 \d{4}-\d{2}-\d{2}\] 用户不喜欢长篇汇报$/)
    assert.equal(lines.length, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工作聊天不挂私聊段', async () => {
  const pending = new Map()
  pending.set('session-work', {
    bot: { id: 'nova', name: 'Nova', role: '研究员' },
    taskDir: null,
    chatKind: 'work',
  })
  const ctx = { on: (_event, listener) => listener, effect: () => {} }
  const handler = installChildDecoration(ctx, {
    debug: async () => {},
    pending,
    tasks: new Map(),
    persistTasks: async () => {},
    root: process.cwd(),
    personas: new Map(),
  })
  const agent = fakeAgentWithTools({ id: 'session-work', parentSession: 'session-parent' })
  await handler({ agent })
  assert.equal(agent.sections.find((section) => section.name === PRIVATE_SECTION), undefined)
  assert.equal(agent.registered.length, 0)
})

test('Bot 的工作聊天里不再有团队协作，记忆那几个还留着', async () => {
  const pending = new Map()
  pending.set('session-work', {
    bot: { id: 'nova', name: 'Nova', role: '研究员' },
    taskDir: null,
    chatKind: 'work',
  })
  const ctx = { on: (_event, listener) => listener, effect: () => {} }
  const handler = installChildDecoration(ctx, {
    debug: async () => {},
    pending,
    tasks: new Map(),
    persistTasks: async () => {},
    root: process.cwd(),
    personas: new Map(),
  })
  const agent = fakeAgentWithTools({ id: 'session-work', parentSession: 'session-parent' })
  await handler({ agent })
  const deny = agent.denied.flatMap((filter) => filter.deny ?? [])
  assert.ok(deny.includes('team_dispatch'), '工作聊天里不该还能派活')
  assert.ok(deny.includes('team_review'), '工作聊天里不该还能验收')
  assert.ok(!deny.includes('team_memory_append'), '记忆工具要留着')
  const guard = agent.guards.at(-1)
  assert.ok(guard, '还要在执行口补一道守卫，防能力卡 allow 绕过')
  assert.match(String(guard({ name: 'team_dispatch' })), /只在主会话开/)
  assert.equal(guard({ name: 'team_memory_append' }), undefined)
})

test('Bot 删了但会话还在：只留一句实话，不变成普通会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-deleted-'))
  try {
    await mkdir(join(root, '.state'), { recursive: true })
    await writeFile(
      join(root, '.state', 'private.json'),
      JSON.stringify({ version: 1, bots: { nova: { sessionId: 'session-gone', kind: 'private' } } }),
      'utf8',
    )
    const ctx = { on: (_event, listener) => listener, effect: () => {} }
    const handler = installChildDecoration(ctx, {
      debug: async () => {},
      pending: new Map(),
      tasks: new Map(),
      persistTasks: async () => {},
      root,
      personas: new Map(),
    })
    const agent = fakeAgent({ id: 'session-gone' })
    await handler({ agent })
    const names = agent.sections.map((section) => section.name)
    assert.ok(names.includes('dsh-team:deleted-bot'), '删掉的 Bot 会话要留一句实话')
    assert.equal(names.includes('dsh-team:team-knowledge'), false, '别把删掉的 Bot 会话当秘书')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
