/**
 * 两条聊天线怎么分：工作聊天跟着主会话走，私聊一个 Bot 只有一条。
 *
 * 这两条要是混了，用户就会遇到「换了 newchat 点进去还是昨天的聊天」
 * 或者「同一个 Bot 开了两三条私聊、历史对不上」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTeamTools } from '../host/tools.js'
import { privateEntryOf, readPrivateState } from '../host/private-chat.js'

function fakeTools() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-private-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(
    join(root, 'bots', 'nova.json'),
    JSON.stringify({ id: 'nova', name: 'Nova', role: '研究员' }),
    'utf8',
  )
  return root
}

/** 一个够用的宿主桩：agents 只管「会话在不在」，subagents 只记谁被开出来了。
 *  0.7 起私聊走 sessionController 建独立根会话，所以这里也给它记一笔。 */
function harness(root) {
  const api = {}
  const tasks = new Map()
  const pending = new Map()
  const started = []
  const created = []
  const prompted = []
  const agentsById = new Map([
    ['S1', { session: { header: { id: 'S1', cwd: root } } }],
    ['S2', { session: { header: { id: 'S2', cwd: root } } }],
  ])
  const agents = { get: (id) => agentsById.get(id) }
  const subagents = {
    rootOf: (agent) => ({ session: { header: { id: agent?.session?.header?.id ?? 'S1' } } }),
    startActivation: async (args) => {
      started.push(args)
      return { childId: args.childId, result: Promise.resolve('') }
    },
  }
  const renamed = []
  const sessionController = {
    create: async (request) => {
      created.push(request)
      return { sessionId: request.sessionId }
    },
    prompt: async (request) => {
      prompted.push(request)
      return { accepted: true }
    },
    rename: async (request) => {
      renamed.push(request)
      return { title: request.title }
    },
  }
  const chatRoot = join(root, 'chats')
  const workspaceCreates = []
  const archived = []
  const unarchived = []
  let chatWorkspace
  const workspaceRegistry = {
    get archivedSessionIds() {
      return archived
    },
    unarchiveSession: async (sessionId) => {
      const at = archived.indexOf(sessionId)
      if (at >= 0) archived.splice(at, 1)
      unarchived.push(sessionId)
    },
    archiveSession: async (sessionId) => {
      if (!archived.includes(sessionId)) archived.push(sessionId)
    },
    resolveByPath: async (cwd) => {
      if (cwd === chatRoot) return chatWorkspace
      return { attachSession: async () => {}, setTitle: async () => {} }
    },
    create: async (cwd) => {
      workspaceCreates.push(cwd)
      chatWorkspace = { attachSession: async () => {}, setTitle: async () => {} }
      return chatWorkspace
    },
  }
  const services = { agents, subagents, tools: fakeTools(), sessionController, workspaceRegistry }
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: () => () => {},
  }
  registerTeamTools(ctx, {
    api,
    root,
    tools: services.tools,
    agents,
    subagents,
    debug: async () => {},
    pending,
    tasks,
    persistTasks: async () => {},
    deliverableRoot: root,
    getDeliverableRoot: () => root,
    getSettings: () => ({ maxConcurrent: 2, taskTimeoutSec: 600 }),
    isTeamSession: () => true,
    // 测试里没有 agent/created：别让人设在等装饰那一步卡满 8 秒。
    privateDecorationWaitMs: 10,
  })
  return { api, tasks, pending, started, created, prompted, workspaceCreates, renamed, archived, unarchived }
}

test('同一个会话里点两次卡片，只开一条工作聊天', async () => {
  const root = await fixture()
  try {
    const { api, tasks, started } = harness(root)
    const first = await api.openChat({ botId: 'nova', parentSession: 'S1' })
    assert.equal(first.ok, true)
    const second = await api.openChat({ botId: 'nova', parentSession: 'S1' })
    assert.equal(second.ok, true)
    assert.equal(second.reused, true, '第二次应该复用')
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(started.length, 1, '只应该真正开一条')
    assert.equal([...tasks.values()].filter((row) => row.chatKind === 'work').length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('换了主会话，工作聊天另开一条', async () => {
  const root = await fixture()
  try {
    const { api, started, tasks } = harness(root)
    const a = await api.openChat({ botId: 'nova', parentSession: 'S1' })
    const b = await api.openChat({ botId: 'nova', parentSession: 'S2' })
    assert.equal(b.reused, undefined)
    assert.notEqual(a.sessionId, b.sessionId, '每个主会话一份工作聊天')
    assert.equal(started.length, 2)
    const rows = [...tasks.values()].filter((row) => row.chatKind === 'work')
    assert.deepEqual(rows.map((row) => row.parentSession).sort(), ['S1', 'S2'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('私聊跨主会话复用同一条，永不新开', async () => {
  const root = await fixture()
  try {
    const { api, created, prompted, renamed } = harness(root)
    const a = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(a.ok, true)
    const b = await api.openPrivate({ botId: 'nova', parentSession: 'S2' })
    assert.equal(b.ok, true)
    assert.equal(b.reused, true, '私聊不因为换了主会话就新开')
    // 复用分支同样要标 standalone：不标的话客户端会按子会话地址去开，直接被拒。
    assert.equal(b.standalone, true, '复用也必须是独立根会话，不能走 subagentchat')
    assert.equal(b.sessionId, a.sessionId)
    assert.equal(created.length, 1, '只应该真正建一条会话')
    assert.match(a.sessionId, /^session-/)
    // 私聊是独立根会话，不是子代理：不能再走 startActivation。
    assert.equal(a.standalone, true)
    assert.equal(prompted.length, 1, '建好之后才招呼一句')
    assert.equal(prompted[0].sessionId, a.sessionId)
    const state = await readPrivateState(root)
    assert.equal(privateEntryOf(state, 'nova')?.sessionId, a.sessionId)
    assert.equal(privateEntryOf(state, 'nova')?.kind, 'private')
    // 标题就用 Bot 的名字：不然聊久了列表里还挂着第一句话。
    // 新建钉一次，复用（点开老会话）再钉一次，同一个会话。
    assert.ok(renamed.length >= 1, '建会话时应该把标题钉成 Bot 的名字')
    assert.equal(renamed[0].sessionId, a.sessionId)
    for (const call of renamed) assert.equal(call.title, 'Nova')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('私聊和工作聊天不是同一条', async () => {
  const root = await fixture()
  try {
    const { api } = harness(root)
    const work = await api.openChat({ botId: 'nova', parentSession: 'S1' })
    const priv = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.notEqual(work.sessionId, priv.sessionId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('点开私聊清未读，Bot 说话再加一', async () => {
  const root = await fixture()
  try {
    const { api } = harness(root)
    await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    const bumped = await api.bumpPrivateUnread({ botId: 'nova' })
    assert.equal(bumped.unread, 1)
    const state = await readPrivateState(root)
    assert.equal(privateEntryOf(state, 'nova')?.unread, 1)
    const read = await api.markPrivateRead({ botId: 'nova' })
    assert.equal(read.ok, true)
    const after = await readPrivateState(root)
    assert.equal(privateEntryOf(after, 'nova')?.unread, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('没有人设时招呼用固定句，不去编性格', async () => {
  const root = await fixture()
  try {
    const { api, prompted } = harness(root)
    await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    const prompt = prompted[0].content.map((block) => block.text).join('\n')
    assert.match(prompt, /一个字都不要改/)
    assert.match(prompt, /您好！我是Nova/)
    assert.match(prompt, /想找我私聊的话，点我的头像进来就行。/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('私聊落在单独的「私聊会话」工作区，不跟用户的工作区混在一起', async () => {
  const root = await fixture()
  try {
    const { api, created, workspaceCreates } = harness(root)
    const a = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(a.ok, true)
    const chatRoot = join(root, 'chats')
    assert.equal(created[0].cwd, chatRoot, '私聊会话要建在 chats 目录下')
    assert.deepEqual(workspaceCreates, [chatRoot], 'chats 还没有工作区时，替它建一个')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('归档过的私聊再点开：另开一条新的，旧的原样留在归档里', async () => {
  const root = await fixture()
  try {
    const { api, archived, created, renamed } = harness(root)
    const a = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(a.ok, true)
    // 用户把它归档了
    archived.push(a.sessionId)
    const b = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(b.ok, true)
    assert.notEqual(b.sessionId, a.sessionId, '归档过就开新的，不去把旧的拽回来')
    assert.equal(b.reused, undefined)
    assert.equal(b.standalone, true)
    assert.deepEqual(archived, [a.sessionId], '旧的还在归档里，用户随时能自己取消归档')
    assert.equal(created.length, 2, '真的建了两条会话')
    const state = await readPrivateState(root)
    assert.equal(privateEntryOf(state, 'nova')?.sessionId, b.sessionId, '私聊指针指向新的那条')
    // 旧会话改个名，别让列表里两条一模一样的「Nova」分不清
    const oldRename = renamed.find((call) => call.sessionId === a.sessionId && /存档/.test(call.title))
    assert.ok(oldRename, '旧的应该被标成「存档」')
    assert.equal(renamed.find((call) => call.sessionId === b.sessionId)?.title, 'Nova')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('分得清哪个会话是 Bot 私聊、哪个是工作聊天', async () => {
  const root = await fixture()
  try {
    const { api } = harness(root)
    const work = await api.openChat({ botId: 'nova', parentSession: 'S1' })
    const priv = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(await api.botChatOf(work.sessionId), 'work')
    assert.equal(await api.botChatOf(priv.sessionId), 'private')
    assert.equal(await api.botChatOf('S1'), '', '主会话不是 Bot 会话')
    assert.equal(await api.botChatOf(''), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('删掉 Bot 之后，它那条私聊会话被归档，不再挂在左侧栏', async () => {
  const root = await fixture()
  try {
    const { api, archived } = harness(root)
    const priv = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(priv.ok, true)
    // 用户把这个 Bot 删了（deleteBot 只删 bots/nova.json 和 bots/nova/）
    await rm(join(root, 'bots', 'nova.json'), { force: true })
    const result = await api.prunePrivateSessions({ only: 'nova' })
    assert.equal(result.ok, true)
    assert.equal(result.pruned, 1, 'private.json 里那条要摘掉')
    assert.equal(result.archived, 1, '会话要归档，从左侧栏收起来')
    assert.deepEqual(archived, [priv.sessionId])
    const state = await readPrivateState(root)
    assert.equal(privateEntryOf(state, 'nova'), null, 'Bot 都没了，私聊指针不能留着')
    // 再点一次什么也不做，不会把别人的会话也收进去
    const again = await api.prunePrivateSessions()
    assert.equal(again.archived, 0)
    assert.equal(again.pruned, 0)
    // 点已经删掉的 Bot：给一句人话，不是 ENOENT
    const gone = await api.openPrivate({ botId: 'nova', parentSession: 'S1' })
    assert.equal(gone.ok, false)
    assert.match(gone.error, /已经不在了/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
