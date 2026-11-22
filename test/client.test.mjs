/**
 * Offline checks for the Client half.
 *
 * The app loads `client.js` as a script that registers a lazy factory on
 * `window.__ModuleLoader__`. This harness reproduces that contract with a fake
 * React and a fake slot service, so the card and the registrations can be
 * verified without a browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Minimal React stand-in: elements are plain objects, hooks keep state per call. */
function fakeReact() {
  const state = []
  let cursor = 0
  return {
    Component: class Component {
      constructor(props) { this.props = props; this.state = {} }
      setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
    },
    reset() {
      cursor = 0
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(init) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
      return [state[index], (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    // 运行时是 React.memo；测试里当恒等包装即可
    memo(fn) {
      return fn
    },
  }
}

/** Load client.js with a captured module loader. */
async function loadClient() {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const react = fakeReact()
  const registrations = []
  let captured
  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  const require = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  assert.ok(captured, 'client.js did not register a module')
  const exported = captured.factory(require)
  const ctx = {
    effect: (run) => run(),
    slots: {
      inject(slot, callback) {
        callback()
      },
      register(definition, component) {
        registrations.push({ definition, component })
      },
    },
  }
  exported.apply(ctx)
  return { react, registrations, exported, id: captured.id }
}

/** Flatten a fake element tree into text, expanding function components. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') {
    // 类组件要 new 出来再渲染
    if (typeof node.type.prototype?.render === 'function') {
      const props = { ...(node.props ?? {}), children: node.children }
      return textOf(new node.type(props).render())
    }
    return textOf(node.type(node.props))
  }
  return (node.children ?? []).map(textOf).join('')
}

test('module id matches the package name and three slots register', async () => {
  const { id, registrations } = await loadClient()
  assert.equal(id, 'dsh-rhine-lab-team')
  const names = registrations.map((r) => r.definition.name)
  assert.deepEqual(names, [
    'conversation.chat.markdown.fence',
    'conversation.hero.options',
    'conversation.composer.dock',
  ])
  assert.equal(registrations[0].definition.key, 'member')
})

test('a member fence renders a card with name, role and body', async () => {
  const { react, registrations } = await loadClient()
  react.reset()
  const card = registrations[0].component
  const code = [
    'id: nova',
    'role: 研究员',
    'status: ready',
    'task: task-7',
    'body: 三篇文献都找到了，2023 年那篇结论不一致。',
  ].join('\n')
  const tree = card({ code, lang: 'member', streaming: false, children: null })
  const text = textOf(tree)
  assert.match(text, /@nova/)
  assert.match(text, /研究员/)
  assert.match(text, /等你验收/)
  assert.match(text, /三篇文献都找到了/)
  assert.match(text, /task-7/)
})

test('a multi-line body is preserved', async () => {
  const { react, registrations } = await loadClient()
  react.reset()
  const card = registrations[0].component
  const code = ['id: forge', 'status: blocked', 'body:', '第一行', '第二行'].join('\n')
  const text = textOf(card({ code, lang: 'member', streaming: false, children: null }))
  assert.match(text, /第一行\n第二行/)
  assert.match(text, /受阻/)
})

test('streaming falls back to the inner code block', async () => {
  const { react, registrations } = await loadClient()
  react.reset()
  const card = registrations[0].component
  const inner = { type: 'pre', props: {}, children: ['raw'] }
  const tree = card({ code: 'id: nova', streaming: true, children: inner })
  assert.equal(tree, inner)
})

test('unknown status still renders and does not throw', async () => {
  const { react, registrations } = await loadClient()
  react.reset()
  const card = registrations[0].component
  const text = textOf(card({ code: 'id: x\nstatus: weird', streaming: false, children: null }))
  assert.match(text, /weird/)
})

test('the toggle renders unchecked by default and flips', async () => {
  const { react, registrations } = await loadClient()
  react.reset()
  const Toggle = registrations.find((r) => r.definition.name === 'conversation.hero.options').component
  const tree = Toggle({ sessionId: 's-1' })
  const label = textOf(tree)
  assert.match(label, /团队协作/)
  const input = tree.children.find((child) => child?.type === 'input')
  assert.ok(input, 'toggle has no input')
  assert.equal(input.props.checked, false)
  input.props.onChange()
  react.reset()
  const tree2 = Toggle({ sessionId: 's-1' })
  const input2 = tree2.children.find((child) => child?.type === 'input')
  assert.equal(input2.props.checked, true)
})

test('apply registers the members tab type and body', async () => {
  const { react, exported } = await loadClient()
  react.reset()
  const tabs = []
  const bodies = []
  const ctx = {
    sidebarRightTabs: {
      register(definition) {
        tabs.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(_slot, callback) {
        callback()
      },
      register(definition, component) {
        bodies.push({ definition, component })
      },
    },
    effect(run) {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  exported.apply(ctx)
  const tab = tabs.find((entry) => entry.id === 'dsh-team/members')
  assert.ok(tab, 'members tab type was not registered')
  assert.equal(tab.kind, 'dsh-team-members')
  assert.equal(tab.title(), '成员')
  const body = bodies.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
  assert.ok(body, 'members tab body was not registered')
  assert.equal(body.definition.key, 'dsh-team/members')
  // The body renders the demo roster without props.
  const text = textOf(body.component({}))
  assert.match(text, /成员/)
  assert.match(text, /nova/)
  assert.match(text, /手上 1 件/)
})

test('面板头部只剩「新增成员组」和皮肤切换', async () => {
  const { react, exported } = await loadClient()
  react.reset()
  const bodies = []
  const ctx = {
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject(_slot, callback) {
        callback()
      },
      register(definition, component) {
        bodies.push({ definition, component })
      },
    },
    effect(run) {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  exported.apply(ctx)
  react.reset()
  const body = bodies.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
  const text = textOf(body.component({}))
  assert.match(text, /新增成员组/)
  // 重复的「＋（添加成员）」和「⚙（名册设置）」都不该再出现。
  assert.doesNotMatch(text, /添加成员/)
  assert.doesNotMatch(text, /名册设置/)
  assert.doesNotMatch(text, /＋/)

  // 锤子是画出来的 svg，不是字符；入口要带图标。
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /function HammerIcon/)
  assert.match(source, /icon: h\(HammerIcon, \{ size: 13 \}\)/)
  // 再点一下收起：展开/收起走同一个按钮。
  assert.match(source, /if \(editing\) \{\s*\n\s*setEditing\(false\)/)
})

test('这个面板不再有成员页：只剩团队设置，且能渲染', async () => {
  const { react, exported } = await loadClient()
  react.reset()
  // 直接渲染编辑器：面板里已经点不到「成员」页，它是纯团队设置。
  const panelApi = exported.internals.createMembersPanel(react, {})
  react.reset()
  const text = textOf(panelApi.BotEditor({ onClose() {}, sessionId: 's-1', focusGroup: 0 }))
  assert.match(text, /团队设置/)
  assert.match(text, /成员分组/)
  assert.doesNotMatch(text, /新增成员用组里的/)
  assert.doesNotMatch(text, /移出名册/)

  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // 编辑器里没有成员页签和成员表单（改人设/停用这些在卡片行内设置里）。
  assert.doesNotMatch(source, /'member', 'team'/)
  assert.doesNotMatch(source, /ID（改名会连记忆目录一起搬）/)
  assert.doesNotMatch(source, /button\('保存', save, 'primary'\)/)
  // 行内设置里的旧提示也别再指向一个已经删掉的「完整设置」
  assert.doesNotMatch(source, /请在完整设置里改/)
})

test('卡片右上角有 ×：点开莱茵确认卡彻底删除成员', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // 卡片右侧那一列第一个按钮是 ×
  assert.match(source, /'aria-label': `彻底删除 \$\{member\?\.name \|\| member\?\.id\}`/)
  assert.match(source, /onRemove: \(target\) => setConfirmRemove\(target\)/)
  // 和删分组同一张卡
  assert.match(source, /function RhineConfirmDialog/)
  assert.match(source, /function ConfirmRemoveDialog/)
  assert.match(source, /confirmText: '删除'/)
  assert.match(source, /记忆、头像、背景图会一起删掉，删了不能恢复/)
  // 自带 Bot：确认框里说明它是干什么的，并建议不要删
  assert.match(source, /member\?\.builtin === true/)
  assert.match(source, /建议不予删除，该审计员为特殊BOT，删除后可找回/)
  assert.match(source, /confirmText: builtin \? '仍然删除' : '删除'/)
  // 删掉之后，行动预备组的招募条右边有恢复键
  assert.match(source, /const missingAuditor = live !== null/)
  assert.match(source, /group.key === auditorRestoreKey && missingAuditor/, '恢复键跟着它原来的组')
  assert.match(source, /const auditorRestoreKey = auditorGroup === '' \? 'reserve'/)
  assert.match(source, /'恢复审计员'/, '按钮文案')
  assert.doesNotMatch(source, /自带的审计员不在了/, '别再把入口塞进团队设置')
  // 行内设置里补了改 ID / 换组 / 停用
  assert.match(source, /\/dsh-team\/bots-rename/)
  assert.match(source, /\/dsh-team\/bots-status/)
  assert.match(source, /setGroupList\(groups\.groups\)/)
  // 自带的 Bot 名字后面挂「限定」小标签（橙底深棕描边）
  assert.match(source, /member\?\.builtin/)
  assert.match(source, /'限定'/)
  assert.match(source, /background: 'linear-gradient\(#F7BC63, #EFA038\)'/, '暖色渐变')
  assert.doesNotMatch(source, /border: '1px solid #4A3A22'/, '不要黑框')
  assert.match(source, /boxShadow: '0 1px 2px rgba\(80, 50, 10, 0.35\)'/, '改用落影')
  assert.match(source, /Songti SC/, '衬线字')
  // 三个图标同一套：30×30 命中区、16px 图标
  assert.match(source, /function CloseIcon/)
  assert.match(source, /h\(CloseIcon, \{ size: 16 \}\)/)
  assert.match(source, /h\(ChartIcon, \{ size: 16 \}\)/)
  assert.match(source, /h\(WrenchIcon, \{ size: 16 \}\)/)
})

test('「新增成员组」把编辑面板送到新组名的输入框', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // 面板把「聚焦分组」的信号交给编辑器
  assert.match(source, /focusGroup: groupFocus/)
  // 编辑器据此滚动并聚焦，锚点是这个属性
  assert.match(source, /'data-dsh-team': 'new-group'/)
})

/** Render function/class components while walking, with a depth guard. */
function expandTree(node, depth = 0) {
  if (node === null || node === undefined || depth > 40) return node
  if (Array.isArray(node)) return node.map((child) => expandTree(child, depth + 1))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const props = { ...(node.props ?? {}), children: node.children }
    const rendered = typeof node.type.prototype?.render === 'function'
      ? new node.type(props).render()
      : node.type(props)
    return expandTree(rendered, depth + 1)
  }
  return { ...node, children: (node.children ?? []).map((child) => expandTree(child, depth + 1)) }
}

test('the editor receives the panel session, not a stray identifier', async () => {  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const start = source.indexOf('h(BotEditor')
  assert.ok(start >= 0, 'BotEditor call site missing')
  const slice = source.slice(start, start + 400)
  // 面板里的变量叫 sessionForRoster；写成裸 sessionId 会在点开设置时抛 ReferenceError。
  assert.match(slice, /sessionId: sessionForRoster/)
  assert.doesNotMatch(slice, /^\s+sessionId,\s*$/m)
})

test('deleting a group asks through the Rhine dialog, not window.confirm', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /function ConfirmGroupDialog/)
  assert.match(source, /RHINE LAB/)
  assert.match(source, /组里的 Bot 会回到行动预备组/)
  // 组设置里的「删除这个组」只负责打开确认框；直接 window.confirm 的老写法不该回来。
  assert.match(source, /setConfirmGroup\(\{ id: target\.id, name: target\.name \}\)/)
  assert.doesNotMatch(source, /window\.confirm\(/)
})

test('每个成员组卡片最右边有同款锤子：在卡片下面展开团队设置', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // 卡片头部复用的是「新增成员组」那颗锤子
  assert.match(source, /setSettingsGroup\(\(current\) => \(current\?\.key === group\.key \? null : entry\)\)/)
  assert.match(source, /h\(HammerIcon, \{ size: 13 \}\)/)
  // 展开的是同一个编辑器，不弹窗
  assert.match(source, /inline: true/)
  assert.match(source, /settingsGroup\?\.key === group\.key/)
  assert.doesNotMatch(source, /function GroupSettingsDialog/)
  // 内置组只能看：编辑器里说明它不能改名/删除
  assert.match(source, /内置组，不能改名或删除/)
})

test('recruiting lives inside a group, not behind the gear', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /function RecruitInline/)
  assert.match(source, /招募员工/)
  // 行动组是自动分配的，不给招募入口。
  assert.match(source, /group\.key === 'action'/)
  // 设置页里的「新建」按钮已经搬走。
  assert.doesNotMatch(source, /button\('新建', startNew\)/)
})

test('recruit form offers models and a capability card', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /dsh-team\/models/)
  assert.match(source, /optgroup/)
  assert.match(source, /能力卡 · 只给这些工具/)
  assert.match(source, /capability: \{ tools \}/)
  // 浅色底，不再是深色表单。
  assert.match(source, /RECRUIT_LIGHT/)
  assert.doesNotMatch(source, /background: "#2F2F2F"/)
})

test('recruit form can upload an avatar', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /dsh-team\/avatar/)
  assert.match(source, /头像（可选/)
  assert.ok(source.includes('h(AvatarCropper, {'))
})

test('avatar zoom slider is relative to the cover scale', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /baseScale/)
  assert.match(source, /scaleFactor/)
  assert.match(source, /min: 1,\n        max: 4,/)
  // 头像裁切用 scaleFactor 记录缩放，不再引入独立的 setZoom 状态
  const cropper = source.slice(source.indexOf('function AvatarCropper'), source.indexOf('function BackgroundCropper'))
  assert.doesNotMatch(cropper, /setZoom\(/)
})

test('the no-session hint lives inside the member card', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /正在开会话…/)
  assert.match(source, /hint: noSessionHint === member\.id/)
  // 不再另外弹一行 notice。
  assert.doesNotMatch(source, /还没有会话：先派一件活/)
})

test('the card wrench opens inline settings under the card', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /function WrenchIcon/)
  assert.match(source, /function MemberSettingsInline/)
  assert.match(source, /onSettings: \(target\)/)
  // 右侧那个没用的 › 已经去掉。
  assert.doesNotMatch(source, />'\),\s*\n\s*h\(\n\s*'button'/)
})

test('the card shows growth and can promote', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /精英化一阶/)
  assert.match(source, /好评 \$\{percent/)
  assert.match(source, /function PromoteDialog/)
  assert.match(source, /dsh-team\/promote/)
})

test('a promotion shows the speech the bot wrote, not a canned line', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // 一个框走完晋升：确认 → 正在晋升（动效）→ 逐字出感言 → 成功摘要
  assert.match(source, /dshTeamPromoteSpin/)
  assert.match(source, /正在晋升…/)
  assert.match(source, /已晋升完成！/)
  assert.match(source, /三色线条一直在/)
  assert.doesNotMatch(source, /稍等几秒/, '不要「等几秒」那句提示')
  assert.match(source, /speech\.slice\(0, shown\)/)
  assert.match(source, /星级上限：/)
  // 晋升摘要要提解锁的背景图功能
  assert.match(source, /解锁：人物卡背景图/)
  // 固定文案时动效至少转 3 秒
  assert.match(source, /3000 - \(Date\.now\(\) - startedAt\)/, '动效至少 3 秒')
  // 晋升摘要不写教学备注；按钮是「确定」，点了关框
  assert.doesNotMatch(source, /3 条教学后到 50/)
  assert.match(source, /}, '确定'/)
  // 星级上限：普通 4 / 一阶 5 / 二阶 6
  assert.match(source, /rank >= 2 \? 6 : rank === 1 \? 5 : 4/)
  assert.match(source, /RHINE LAB/)
  // 晋升请求要把当前会话一起报上去，感言在这个秘书会话下写。
  assert.match(source, /JSON\.stringify\(\{ bot: member\?\.id, sessionId: sessionForRoster \}\)/)
  assert.match(source, /speechError/)
  // 独立的感言卡已经并进晋升框，不再另弹一层
  assert.doesNotMatch(source, /function SpeechDialog/)
})

test('the card opens a read-only growth archive', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /function GrowthDialog/)
  assert.match(source, /dsh-team\/growth\?bot=/)
  assert.match(source, /onArchive: \(target\) => setGrowthBot\(target\)/)
  assert.match(source, /评分样本/)
  assert.match(source, /教学记录/)
  assert.match(source, /晋升历史/)
  // 没写感言的晋升要如实标出来
  assert.match(source, /这次没写感言/)
})

test('a lesson can be confirmed as kept from the archive', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /dsh-team\/improve/)
  assert.match(source, /确认守住 \+120/)
  assert.match(source, /canConfirm/)
  // 服务端会再判一次；失败原因要显示出来，不能只在按钮上转圈
  assert.match(source, /setFlash\(payload\?\.error/)
})

test('one task can be exported as Markdown from its detail view', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /dsh-team\/task-export/)
  assert.match(source, /'导出记录'/)
  // 写到哪里由服务端回，客户端只把路径报出来
  assert.match(source, /已导出：\$\{data\.path\}/)
})

test('groups sort by stars, then level, then who got there first', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const start = source.indexOf('function sortGroupItems')
  assert.ok(start > 0, 'sortGroupItems missing')
  const body = source.slice(start, start + 900)
  assert.match(body, /starsB - starsA/)
  assert.match(body, /lvB - lvA/)
  assert.match(body, /sinceA - sinceB/)
})

test('card background unlocks only from rank one', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /卡片背景（精英化一阶解锁）/)
  assert.match(source, /dsh-team\/background/)
  assert.match(source, /createImageBitmap/)
})

test('the settings panel exposes a background opacity slider', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /"遮罩"/)
  assert.match(source, /scheduleBgOpacity/)
  assert.match(source, /bgAlpha/)
})

test('the settings panel exposes a font weight slider', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /"字重"/)
  assert.match(source, /const scheduleBotPatch = \(patch\)/)
  assert.match(source, /cardFontWeight/)
})

test('卡片不再显示复犯；卡在等级上限时提示差几条教学', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /· 复犯 \$\{percent\(/, '卡片上不显示复犯率')
  assert.match(source, /条教学记录才到 50/, '缺教学记录要有提示')
  assert.match(source, /Number\(member\?\.rank\) === 1/, '提示按段位判断')
})

test('感言框带「名字@id：」的抬头', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /const speakerLabel =/, '要有说话人标签')
  assert.match(source, /@\${member\?\.id \?\? ''}：/, '标签形如 名字@id：')
  assert.match(source, /key: 'who'/, '抬头单独一行')
})

test('开团队协作要打开右栏并切到成员页', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  // 开关翻到「开」的时候要调用
  assert.match(source, /if \(next\) openMembersPane\(\)/, '开团队协作时自动打开成员页')
  // 切 tab 之外还要把右栏显示出来（openTab 只换内容）
  assert.match(source, /openTab\(MEMBERS_TAB_KIND, \{ params: \{\} \}\)/, '开团队协作要打开右栏')
  assert.match(source, /membersPaneVisible/, '已经显示成员列表时不要重复打开')
  assert.match(source, /getBoundingClientRect/, '按「可见」判断，不能只看节点在不在')
  assert.match(source, /openTab\(MEMBERS_TAB_KIND, \{ params: \{\} \}\)/, '切到成员页')
})

test('团队协作开着就把成员面板推出来', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /installOpenMembersPane\(\)/, '打开成员页的实现要装在面板作用域里')
  assert.match(source, /event: 'open-members'/, '打开成员页要记诊断')
})

test('入口卡和其它卡一样圆角', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /borderRadius: 20/, '入口卡要圆角')
})

test('团队知识库编辑入口在面板头部', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /function TeamKnowledgeDialog/, '要有编辑弹窗')
  assert.match(source, /key: 'knowledge'/, '头部要有入口')
  assert.match(source, /team-memory\?file=/, '读取走已有路由')
})

test('启动自检会记录缺哪些服务', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.match(source, /const SELF_CHECK = \{ missing: \[\], checked: false \}/, '要有自检结果容器')
  assert.match(source, /event: 'selfcheck'/, '自检结果要记诊断')
  assert.match(source, /当前 DSH 版本缺少：/, '缺服务要在面板上写明')
})

test('不再依赖 layout；打不开成员页时给出提示而不是静默', async () => {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /inject: \[[^\]]*'layout'/, 'inject 里不该再有 layout')
  assert.doesNotMatch(source, /const required = \[[^\]]*'layout'/, '自检清单里不该再有 layout')
  assert.match(source, /onMembersPaneFailed\?\./, '失败时要交给面板提示')
  assert.match(source, /拿不到右栏接口/, '提示文案要写清原因')
})
