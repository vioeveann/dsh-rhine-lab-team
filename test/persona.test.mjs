/**
 * 人设只有一份：`memory/soul.txt`。
 * JSON 里的 `persona` 只用来创建时写文件，之后一律不落盘、不注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptSoulFile, migratePersona, saveBot } from '../host/bots.js'
import { installChildDecoration } from '../host/tools.js'

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
      systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
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
  assert.match(persona.text, /文件里的人设/)
  assert.doesNotMatch(persona.text, /JSON 里的旧人设/)
})
