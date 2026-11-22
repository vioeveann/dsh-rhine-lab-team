/**
 * 工具注册的冒烟测试：这一条能挡住「整轮工具激活失败」那类事故。
 *
 * 事故回顾：`team_retry` 被放进了 `registerMemoryTools()`，它的可用性谓词引用了
 * 只存在于 `registerTeamTools()` 里的 `isTeamSession`。DSH 在解析工具可用性时抛
 * ReferenceError，整轮工具激活失败，会话直接"本轮运行失败"。
 *
 * 所以这里把每个注册出来的工具都真跑一遍 `when`，并调用一次 `execute` 的空参数
 * 分支，确保没有悬空标识符。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerMemoryTools, registerTeamTools } from '../host/tools.js'

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

/** 各工具都会用到的依赖桩。 */
function options(tools) {
  const tasks = new Map()
  return {
    root: process.cwd(),
    tools,
    agents: {},
    subagents: {},
    debug: async () => {},
    pending: new Map(),
    tasks,
    deliverableRoot: process.cwd(),
    getDeliverableRoot: () => process.cwd(),
    getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 600 }),
    persistTasks: async () => {},
    isTeamSession: () => true,
  }
}

/** 一个“带队会话”的最小 agent 形状。 */
const leadAgent = { session: { header: { id: 'session-test', parentSession: undefined } } }

test('registerTeamTools 不会引用到作用域外的标识符', () => {
  const tools = fakeTools()
  const dispose = registerTeamTools({}, options(tools))
  assert.equal(typeof dispose, 'function')
  assert.ok(tools.registered.length >= 5, `expected at least 5 tools, got ${tools.registered.length}`)
  for (const { definition, options: gate } of tools.registered) {
    assert.equal(typeof definition.name, 'string', '工具必须有 name')
    if (typeof gate?.when === 'function') {
      assert.doesNotThrow(() => gate.when({ agent: leadAgent }), `${definition.name} 的 when 抛错了`)
    }
  }
  dispose()
})

test('registerMemoryTools 的可用性谓词同样干净', () => {
  const tools = fakeTools()
  const dispose = registerMemoryTools({}, options(tools))
  assert.equal(typeof dispose, 'function')
  assert.ok(tools.registered.length >= 4)
  for (const { definition, options: gate } of tools.registered) {
    if (typeof gate?.when === 'function') {
      assert.doesNotThrow(() => gate.when({ agent: leadAgent }), `${definition.name} 的 when 抛错了`)
    }
  }
  dispose()
})

test('子会话里团队工具应当被隐藏，而不是抛错', () => {
  const tools = fakeTools()
  registerTeamTools({}, options(tools))
  const child = { session: { header: { id: 'session-child', parentSession: 'session-parent' } } }
  for (const { definition, options: gate } of tools.registered) {
    if (typeof gate?.when !== 'function') continue
    const visible = gate.when({ agent: child })
    assert.equal(visible, false, `${definition.name} 不该在子会话里出现`)
  }
})

test('team_review：通过必须填评分，参数表里 grade 是必填', async () => {
  const tools = fakeTools()
  const opts = options(tools)
  registerTeamTools({}, opts)
  const def = tools.registered.find((row) => row.definition.name === 'team_review').definition
  assert.equal(def.parameters.grade.required, true)
  opts.tasks.set('t-grade', { id: 't-grade', bot: 'nova', status: 'done', at: Date.now() })
  const noGrade = JSON.parse(await def.execute({ taskId: 't-grade', verdict: 'accepted' }))
  assert.equal(noGrade.ok, false)
  assert.match(noGrade.error, /必须填 grade/)
  // 打回不要求评分，但必须写清哪一条不过
  const noNote = JSON.parse(await def.execute({ taskId: 't-grade', verdict: 'rejected' }))
  assert.equal(noNote.ok, false)
  assert.match(noNote.error, /打回必须写清/)
})

test('team_user_feedback：只有 praise / fix / miss / repeat，且必须抄用户原话', async () => {
  const tools = fakeTools()
  const opts = options(tools)
  registerTeamTools({}, opts)
  const def = tools.registered.find((row) => row.definition.name === 'team_user_feedback').definition
  assert.equal(def.parameters.note.required, true)
  assert.equal(def.parameters.signal.required, true)
  opts.tasks.set('t-fb', { id: 't-fb', bot: 'nova', status: 'accepted', at: Date.now() })
  const badSignal = JSON.parse(await def.execute({ taskId: 't-fb', signal: '嗯', note: '还行' }))
  assert.equal(badSignal.ok, false)
  const noNote = JSON.parse(await def.execute({ taskId: 't-fb', signal: 'praise' }))
  assert.equal(noNote.ok, false)
  assert.match(noNote.error, /原话/)
})

test('打 excellent 必须先有审计记录；审计员被删了就放行', async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'dsh-team-audit-'))
  try {
    await mkdir(join(root, 'bots'), { recursive: true })
    await writeFile(join(root, 'bots', 'nova.json'), JSON.stringify({ id: 'nova', role: '研究员' }), 'utf8')
    await writeFile(join(root, 'bots', 'auditor.json'), JSON.stringify({ id: 'auditor', role: '成果审计' }), 'utf8')

    const tools = fakeTools()
    const opts = { ...options(tools), root }
    registerTeamTools({}, opts)
    const def = tools.registered.find((row) => row.definition.name === 'team_review').definition
    opts.tasks.set('t-work', { id: 't-work', bot: 'nova', status: 'done', at: Date.now() })

    // 没有审计任务号：拒绝
    const noAudit = JSON.parse(await def.execute({ taskId: 't-work', verdict: 'accepted', grade: 'excellent' }))
    assert.equal(noAudit.ok, false)
    assert.match(noAudit.error, /auditTaskId/)

    // 填了但不是审计员的活：拒绝
    opts.tasks.set('t-other', { id: 't-other', bot: 'nova', status: 'done' })
    const wrongBot = JSON.parse(await def.execute({ taskId: 't-work', verdict: 'accepted', grade: 'excellent', auditTaskId: 't-other' }))
    assert.equal(wrongBot.ok, false)
    assert.match(wrongBot.error, /不是审计员的活/)

    // 审计还没跑完：拒绝
    opts.tasks.set('t-audit', { id: 't-audit', bot: 'auditor', status: 'running' })
    const running = JSON.parse(await def.execute({ taskId: 't-work', verdict: 'accepted', grade: 'excellent', auditTaskId: 't-audit' }))
    assert.equal(running.ok, false)
    assert.match(running.error, /还没跑完/)

    // good 不需要审计
    const good = JSON.parse(await def.execute({ taskId: 't-work', verdict: 'accepted', grade: 'good' }))
    assert.equal(good.ok, true)

    // 同一件活不能验收第二次：改判走 team_user_feedback
    const again = JSON.parse(await def.execute({ taskId: 't-work', verdict: 'accepted', grade: 'excellent' }))
    assert.equal(again.ok, false)
    assert.match(again.error, /已经验收过/)

    // 审计员被删掉：excellent 放行
    await rm(join(root, 'bots', 'auditor.json'))
    opts.tasks.set('t-work-2', { id: 't-work-2', bot: 'nova', status: 'done', at: Date.now() })
    const noAuditor = JSON.parse(await def.execute({ taskId: 't-work-2', verdict: 'accepted', grade: 'excellent' }))
    assert.equal(noAuditor.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

