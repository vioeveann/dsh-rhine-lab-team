/**
 * UI 行为测试：真的渲染、真的点、看副作用。
 *
 * 和 client.test.mjs 的区别：那里断言的是「源码里有这行」，这里跑的是组件，
 * 点按钮之后检查发出了什么请求、状态切到哪一步。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** React 替身：状态留在闭包数组里，重渲染就是 reset 之后再调用一次组件。 */
function fakeReact() {
  const state = []
  const effects = []
  let cursor = 0
  return {
    Component: class Component {
      constructor(props) { this.props = props; this.state = {} }
    },
    reset() { cursor = 0 },
    runEffects() {
      for (const effect of effects.splice(0)) effect()
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(init) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
      return [state[index], (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
    useEffect(fn) { effects.push(fn) },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    memo(fn) { return fn },
  }
}

/** 渲染成普通树，展开函数组件（类组件也认）。 */
function render(node) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(render)
  const { type, props, children } = node
  if (typeof type === 'function') {
    if (typeof type.prototype?.render === 'function') {
      return render(new type({ ...props, children }).render())
    }
    return render(type({ ...props, children }))
  }
  return { type, props: props ?? {}, children: (children ?? []).map(render) }
}

/** 深度优先找第一个满足条件的节点。 */
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return undefined
}

const byLabel = (label) => (node) => node.props?.['aria-label'] === label
const byText = (text) => (node) => (node.children ?? []).includes(text)

/** 装一个客户端实例：fetch 记账、侧栏服务记账。 */
async function loadClient({ members = [], seedIdentity = null } = {}) {
  const source = await readFile(join(here, '..', 'client.js'), 'utf8')
  const react = fakeReact()
  const registrations = []
  const calls = []
  const sidebarCalls = []

  let captured
  // 头像映射写在 localStorage 里：真存一份，测试才看得到写了什么。
  const storage = new Map()
  if (seedIdentity !== null) storage.set('dsh-team:identity/v1', JSON.stringify(seedIdentity))
  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    __ModuleLoader__: {
      load(definition) { captured = definition },
    },
  }
  const require = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }

  const fetchStub = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ?? null })
    return {
      ok: true,
      json: async () => (String(url).includes('/dsh-team/session-bot')
        ? { ok: true, bot: (members.find((item) => item.sessionId === new URL('http://x' + String(url)).searchParams.get('sessionId')) ?? null) }
        : ({
        ok: true,
        members,
        groups: [],
        removedBuiltins: [],
        tasks: [],
        bots: [],
        text: '',
        file: 'knowledge',
        chars: 0,
      })),
    }
  }

  // 面板会 setInterval 轮询：测试里换成不会挂住进程的假定时器。
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => ({ unref() {} })
  globalThis.localStorage = window.localStorage
  globalThis.fetch = fetchStub
  // 头像映射的同步挂在 window.fetch 上：不给的话那段直接跳过，测不到。
  window.fetch = fetchStub
  globalThis.window = window

  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  const exported = captured.factory(require)
  exported.apply({
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (definition, component) => registrations.push({ definition, component }),
    },
    effect: (run) => run(),
    get: (name) => (name === 'sidebarRight'
      ? { openTab: (kind, options) => sidebarCalls.push({ kind, options }) }
      : undefined),
  })

  const panel = registrations.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')?.component
  const toggle = registrations.find((entry) => entry.definition.name === 'conversation.hero.options')?.component
  assert.ok(panel, '成员面板没注册')
  assert.ok(toggle, '团队协作开关没注册')

  return { react, panel, toggle, calls, sidebarCalls, members, registrations, storage }
}

/** 渲染面板并跑一次挂载 effect。 */
function mountPanel(harness, props = {}) {
  const { react, panel } = harness
  react.reset()
  const tree = render(panel({ members: harness.members, params: {}, ...props }))
  react.runEffects()
  return tree
}

/** 只重渲染（不点东西），用来把状态变化应用到新树上。 */
function rerenderPanel(harness, props = {}) {
  const { react, panel } = harness
  react.reset()
  const tree = render(panel({ members: harness.members, params: {}, ...props }))
  react.runEffects()
  return tree
}

/** 点一下之后重渲染，拿到新树。 */
function clickAndRerender(harness, target, props = {}) {
  target.props.onClick?.()
  const { react, panel } = harness
  react.reset()
  const tree = render(panel({ members: harness.members, params: {}, ...props }))
  react.runEffects()
  return tree
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('点「团队知识」能打开弹窗，并真的去读 knowledge.md', async () => {
  const harness = await loadClient()
  let tree = mountPanel(harness)
  await flush()

  const entry = find(tree, byLabel('团队知识库'))
  assert.ok(entry, '头部没有团队知识入口')
  tree = clickAndRerender(harness, entry)
  await flush()

  // 弹窗出现，并且已经请求了 knowledge 文件
  assert.ok(find(tree, byText('团队知识库')), '弹窗没出现')
  assert.ok(
    harness.calls.some((call) => call.url.includes('/dsh-team/team-memory?file=knowledge')),
    '没有去读 knowledge.md',
  )
})

test('弹窗里切页签会换文件，保存会 POST 当前文件的正文', async () => {
  const harness = await loadClient()
  let tree = mountPanel(harness)
  await flush()
  tree = clickAndRerender(harness, find(tree, byLabel('团队知识库')))
  await flush()

  // 切到「关于用户」
  const userTab = find(tree, byText('关于用户'))
  assert.ok(userTab, '没有「关于用户」页签')
  tree = clickAndRerender(harness, userTab)
  await flush()
  assert.ok(
    harness.calls.some((call) => call.url.includes('file=user')),
    '切页签没有去读 user.md',
  )

  // 改一行字再保存
  const box = find(tree, (node) => node.type === 'textarea')
  assert.ok(box, '没有编辑框')
  box.props.onChange({ target: { value: '我是博士。' } })
  // 输入后先重渲染，再点保存——否则拿到的是上一次渲染的闭包（旧值）。
  tree = rerenderPanel(harness)
  tree = clickAndRerender(harness, find(tree, byText('保存')))
  await flush()

  const saved = harness.calls.filter((call) => call.method === 'POST' && call.url.includes('/dsh-team/team-memory'))
  assert.equal(saved.length, 1, '应该只有一次保存')
  assert.deepEqual(JSON.parse(saved[0].body), { file: 'user', text: '我是博士。' })
})

test('把团队协作勾上，会真的去打开成员页', async () => {
  const harness = await loadClient()
  const { react, toggle } = harness
  react.reset()
  const tree = render(toggle({ sessionId: 'session-00000000-0000-0000-0000-000000000000' }))
  react.runEffects()

  const box = find(tree, (node) => node.type === 'input' && node.props?.type === 'checkbox')
  assert.ok(box, '没有勾选框')
  box.props.onChange()

  assert.equal(harness.sidebarCalls.length, 1, '应该调用一次 openTab')
  assert.equal(harness.sidebarCalls[0].kind, 'dsh-team-members')
})

test('成员卡点一下会去开它的会话', async () => {
  const harness = await loadClient({
    members: [{
      id: 'nova',
      name: 'Nova',
      role: '研究员',
      status: 'idle',
      rank: 0,
      lv: 1,
      stars: 0,
      teaches: 0,
      tasks: 0,
      group: '',
      // 这个会话里派过活：点卡片进工作聊天。
      worked: true,
    }],
  })
  const tree = mountPanel(harness)
  await flush()

  const card = find(tree, (node) => node.props?.['data-dsh-team-member'] === 'nova')
  assert.ok(card, '成员卡没渲染出来')
  card.props.onClick()
  await flush()

  assert.ok(
    harness.calls.some((call) => call.url.includes('/dsh-team/open')),
    '点卡片没有去开会话',
  )
})

test('没派过活的成员，点卡片进私聊', async () => {
  const harness = await loadClient({
    members: [{
      id: 'nova',
      name: 'Nova',
      role: '研究员',
      status: 'idle',
      rank: 0,
      lv: 1,
      stars: 0,
      teaches: 0,
      tasks: 0,
      group: '',
      worked: false,
      privateUnread: 2,
    }],
  })
  const tree = mountPanel(harness)
  await flush()

  const card = find(tree, (node) => node.props?.['data-dsh-team-member'] === 'nova')
  assert.ok(card, '成员卡没渲染出来')
  card.props.onClick()
  await flush()

  const urls = harness.calls.map((call) => call.url)
  assert.ok(
    urls.some((url) => url.includes('/dsh-team/private/open')),
    '没派过活时点卡片应该进私聊',
  )
  // 点进来就算读过：红点清掉。
  assert.ok(
    urls.some((url) => url.includes('/dsh-team/private/read')),
    '进私聊后应该把未读清掉',
  )
})

test('私聊会话也写进头像映射：账本里没有它，按名册补', async () => {
  const harness = await loadClient({
    members: [{
      id: 'nova',
      name: 'Nova',
      role: '研究员',
      status: 'idle',
      worked: false,
      privateSessionId: 'session-private-1',
      privateUnread: 0,
    }],
  })
  await flush()

  const raw = harness.storage.get('dsh-team:identity/v1')
  assert.ok(raw, '没有写出头像映射')
  const map = JSON.parse(raw)
  assert.equal(map['session-private-1']?.id, 'nova', '私聊会话没有对到 Bot')
  assert.equal(map['session-private-1']?.name, 'Nova')
})

test('已经写进去的映射不会被账本重拼冲掉', async () => {
  // 面板刚点开时会先 stamp 一条进去，随后 publishTeamIdentity(force) 整体重写：
  // 起点必须带上已有那份，否则刚写的那条立刻被冲掉，头像回落成主会话的。
  const harness = await loadClient({
    seedIdentity: {
      'session-manual-9': { id: 'nova', name: '手工写进去的名字', src: '/dsh-team/avatar?bot=nova&v=3', onOpen: true, speech: false },
    },
    members: [{
      id: 'nova',
      name: 'Nova',
      role: '研究员',
      status: 'idle',
      worked: false,
      privateUnread: 0,
    }],
  })
  await flush()

  const map = JSON.parse(harness.storage.get('dsh-team:identity/v1'))
  assert.equal(map['session-manual-9']?.name, '手工写进去的名字', '重拼之后已有的身份被冲掉了')
})
