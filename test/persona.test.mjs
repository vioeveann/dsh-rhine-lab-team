/**
 * 人设只有一份：`memory/soul.txt`。
 * JSON 里的 `persona` 只用来创建时写文件，之后一律不落盘、不注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptSoulFile, migratePersona, saveBot, stripSoulPlaceholder } from '../host/bots.js'
import { installChildDecoration, registerTeamTools } from '../host/tools.js'

async function emptyRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-persona-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  return root
}

test('saveBot 建 Bot 时把人设写进 soul.txt，JSON 里不留 persona', async () => {
  const root = await emptyRoot()
  const saved = await saveBot(root, { id: 'nova', name: 'Nova', role: '研究员', persona: '我是 Nova，只做核对。' })
  assert.equal('persona' in saved, false)
  const json = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
  assert.equal('persona' in json, false)
  const soul = await readFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), 'utf8')
  assert.match(soul, /我是 Nova，只做核对。/)
})

test('迁移：soul.txt 还是占位句时，用 JSON 里那份人设写进去，并清掉字段', async () => {
  const root = await emptyRoot()
  await mkdir(join(root, 'bots', 'nova', 'memory'), { recursive: true })
  await writeFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), '# Nova · 灵魂\n\n（在这里写它是谁、守什么规矩）\n', 'utf8')
  await writeFile(join(root, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员', persona: '旧人设全文' }), 'utf8')

  const result = await migratePersona(root, { id: 'nova', name: 'Nova', role: '研究员', persona: '旧人设全文' })
  assert.equal(result.migrated, true)
  assert.equal(result.soulWritten, true)
  const soul = await readFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), 'utf8')
  assert.match(soul, /旧人设全文/)
  const json = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
  assert.equal('persona' in json, false)
})

test('迁移：soul.txt 已有真内容时，文件优先，JSON 字段照样清掉', async () => {
  const root = await emptyRoot()
  await mkdir(join(root, 'bots', 'nova', 'memory'), { recursive: true })
  await writeFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), '# Nova · 灵魂\n\n文件里的人设\n', 'utf8')
  await writeFile(join(root, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员', persona: 'JSON 里的旧人设' }), 'utf8')

  const result = await migratePersona(root, { id: 'nova', name: 'Nova', role: '研究员', persona: 'JSON 里的旧人设' })
  assert.equal(result.soulWritten, false)
  const soul = await readFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), 'utf8')
  assert.match(soul, /文件里的人设/)
  assert.doesNotMatch(soul, /JSON 里的旧人设/)
  const json = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
  assert.equal('persona' in json, false)
})

test('老的人设文件 soul.md 会改名成 soul.txt，已有 .txt 就不动', async () => {
  const root = await emptyRoot()
  const dir = join(root, 'bots', 'nova', 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'soul.md'), '老文件里的人设\n', 'utf8')

  assert.equal(await adoptSoulFile(dir), true)
  assert.match(await readFile(join(dir, 'soul.txt'), 'utf8'), /老文件里的人设/)

  // 第二次跑是幂等的
  assert.equal(await adoptSoulFile(dir), false)
  assert.match(await readFile(join(dir, 'soul.txt'), 'utf8'), /老文件里的人设/)
})

test('装饰子会话时只注入 soul.txt，不再读 JSON 里的 persona', async () => {
  const root = await emptyRoot()
  await mkdir(join(root, 'bots', 'nova', 'memory'), { recursive: true })
  await writeFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), '# Nova\n\n文件里的人设\n', 'utf8')
  await writeFile(join(root, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员' }), 'utf8')

  const sections = []
  const handlers = new Map()
  const childId = 'session-child-persona'
  const agent = {
    id: childId,
    session: { header: { id: childId, parentSession: 'session-lead' }, append() {} },
    ctx: {
      on() { return () => {} },
      systemPrompt: {
        section: (section) => {
          sections.push({ ...section, text: typeof section.text === 'function' ? section.text() : section.text })
          return () => {}
        },
      },
      tools: { restrict() {} },
    },
  }

  installChildDecoration(
    { on(name, fn) { handlers.set(name, fn); return () => {} }, effect() {}, get() { return undefined } },
    {
      debug: async () => {},
      pending: new Map([[childId, { bot: { id: 'nova', name: 'Nova', role: '研究员', persona: 'JSON 里的旧人设' }, taskDir: root }]]),
      tasks: new Map(),
      persistTasks: async () => {},
      root,
    },
  )

  await handlers.get('agent/created')({ agent })

  const persona = sections.find((section) => section.name === 'dsh-team/persona')
  assert.ok(persona, '没注入人设段')
  const personaText = typeof persona.text === 'function' ? persona.text() : persona.text
  assert.match(personaText, /文件里的人设/)
  assert.doesNotMatch(personaText, /JSON 里的旧人设/)

  // AGENTS.md 是宿主塞的用户消息，删不掉，只能在 system prompt 里压过它。
  const scope = sections.find((section) => section.name === 'dsh-team/scope')
  assert.ok(scope, '没注入会话范围段')
  assert.equal(scope.order, 121)
  assert.ok(scope.order > persona.order, '会话范围段必须排在人设段后面')
  assert.match(scope.text, /AGENTS\.md/)
  assert.match(scope.text, /以本段为准/)
})

test('改完 soul.txt 后，人设段不用重挂也会换成新文本（热更新）', async () => {
  const root = await emptyRoot()
  const dir = join(root, 'bots', 'nova', 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'soul.txt'), '# Nova\n\n旧人设：只做核对。\n', 'utf8')
  await writeFile(join(root, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员' }), 'utf8')

  const sections = []
  const handlers = new Map()
  const childId = 'session-child-hot'
  const agent = {
    id: childId,
    session: { header: { id: childId, parentSession: 'session-lead' }, append() {} },
    ctx: {
      on() {
        return () => {}
      },
      systemPrompt: {
        section(section) {
          const raw = typeof section.text === 'function' ? section.text : () => section.text
          sections.push({ ...section, text: raw(), raw })
          return () => {}
        },
      },
      tools: { restrict() {}, definitions: () => [] },
    },
  }
  installChildDecoration(
    { on(name, fn) { handlers.set(name, fn); return () => {} }, effect() {}, get() { return undefined } },
    {
      debug: async () => {},
      pending: new Map([[childId, { bot: { id: 'nova', name: 'Nova', role: '研究员' }, taskDir: root }]]),
      tasks: new Map(),
      persistTasks: async () => {},
      root,
    },
  )
  await handlers.get('agent/created')({ agent })

  const persona = sections.find((section) => section.name === 'dsh-team/persona')
  assert.ok(persona, '没注入人设段')
  // 人设段的 text 必须是取值函数：空闲会话挂不了新段，只能靠它现取。
  assert.equal(typeof persona.raw, 'function')
  assert.match(persona.raw(), /旧人设/)

  await writeFile(join(dir, 'soul.txt'), '# Nova\n\n新人设：先问文种，再动笔。\n', 'utf8')
  const api = {}
  registerTeamTools(
    { get: () => undefined, on: () => () => {}, effect: () => () => {} },
    {
      api,
      root,
      tools: { register: () => () => {} },
      agents: { get: () => undefined, list: () => [] },
      subagents: { rootOf: () => null },
      debug: async () => {},
      pending: new Map(),
      tasks: new Map(),
      persistTasks: async () => {},
      deliverableRoot: root,
      getDeliverableRoot: () => root,
      getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 600 }),
      isTeamSession: () => true,
    },
  )
  const result = await api.refreshPersona('nova')
  assert.equal(result.ok, true)
  assert.match(persona.raw(), /新人设/)
  assert.doesNotMatch(persona.raw(), /旧人设/)
})

test('占位句下面接着写的人设不会被丢掉：只丢占位那一行和抬头', async () => {
  const fresh = '# Nova · 灵魂\n\n（在这里写它是谁、守什么规矩。写完保存，下次对话生效。）\n'
  // 只有抬头 + 占位句 = 还没写人设。
  assert.equal(stripSoulPlaceholder(fresh), '')
  // 用户在占位句下面接着写：整份人设要留下来，只去掉抬头和占位句。
  const written = `${fresh}\n## 她是谁\n\n我是 Nova，只做核对。\n`
  assert.equal(stripSoulPlaceholder(written), '## 她是谁\n\n我是 Nova，只做核对。')
})
