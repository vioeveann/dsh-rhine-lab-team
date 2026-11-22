/**
 * 底座规则：内容对得上，且和人设分成两段——用户改人设换不掉它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_RULES, BASE_RULES_ORDER, BASE_RULES_SECTION } from '../host/base-rules.js'
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
          sections.push(definition)
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
