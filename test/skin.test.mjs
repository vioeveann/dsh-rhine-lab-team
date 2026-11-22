/**
 * Skin: the palette must switch the components that read it, and the choice
 * must survive a reload through localStorage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Tiny React stand-in with working state and effects. */
function fakeReact() {
  const state = []
  const effects = []
  let cursor = 0
  return {
    Component: class Component {
      constructor(props) { this.props = props; this.state = {} }
      setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
    },
    reset() {
      cursor = 0
    },
    runEffects() {
      for (const effect of effects.splice(0)) effect()
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
    useEffect(fn) {
      effects.push(fn)
    },
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

/** In-memory localStorage shared across loads. */
function fakeStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value)
    },
    removeItem: (key) => {
      delete data[key]
    },
    dump: () => ({ ...data }),
  }
}

/** Load the client with given globals and return its registrations. */
async function loadClient({ storage } = {}) {
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
  if (storage) globalThis.localStorage = storage
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  const exported = captured.factory(require)
  exported.apply({
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_s, cb) => cb(), register: (definition, component) => registrations.push({ definition, component }) },
    effect: (run) => run(),
  })
  return { react, registrations }
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

const sampleFence = 'id: nova\nrole: 研究员\nstatus: ready\nbody: 测试内容'

test('classic is the default and uses host tokens', async () => {
  const storage = fakeStorage()
  const { react, registrations } = await loadClient({ storage })
  react.reset()
  const card = registrations.find((entry) => entry.definition.key === 'member').component
  react.reset()
  const tree = card({ code: sampleFence, streaming: false, children: null })
  assert.equal(tree.props['data-dsh-team-skin'], 'classic')
  assert.equal(storage.getItem('dsh-team:skin'), null)
})

test('存过 aurora 也回到默认那套', async () => {
  const storage = fakeStorage({ 'dsh-team:skin': 'aurora' })
  const { react, registrations } = await loadClient({ storage })
  const card = registrations.find((entry) => entry.definition.key === 'member').component
  react.reset()
  const tree = card({ code: sampleFence, streaming: false, children: null })
  assert.equal(tree.props['data-dsh-team-skin'], 'classic')
})

test('面板上的皮肤按钮还在，点下去仍是默认那套', async () => {
  const storage = fakeStorage()
  const { react, registrations } = await loadClient({ storage })
  react.reset()
  // The panel is registered under the sidebar slot; render it and click ◐.
  const panel = registrations.find((entry) => entry.definition.name === 'sidebar.right.pane.tab').component
  react.reset()
  const tree = panel({})
  const buttons = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'button') buttons.push(node)
    ;(node.children ?? []).forEach(walk)
    if (typeof node.type === 'function') {
      if (typeof node.type.prototype?.render === 'function') {
        walk(new node.type({ ...(node.props ?? {}), children: node.children }).render())
      } else {
        walk(node.type(node.props))
      }
    }
  }
  walk(tree)
  const skinButton = buttons.find((button) => button.props['aria-label']?.startsWith('皮肤：'))
  assert.ok(skinButton, 'no skin button rendered')
  skinButton.props.onClick()
  assert.equal(storage.getItem('dsh-team:skin'), 'classic')
})
