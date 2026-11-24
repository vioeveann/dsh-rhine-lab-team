/**
 * 私聊状态：一个 Bot 一条私聊，跨主会话复用。
 *
 * 和工作聊天分成两份记录，是因为它们回答的问题不一样：
 *  - 工作聊天跟着主会话走（A 的 B 工作聊天、B 的 B 工作聊天），记在账本 `tasks` 里；
 *  - 私聊只有一条，和当前是哪个主会话无关，所以单独放 `.state/private.json`。
 *
 * 这一份只管状态的读写，开会话的动作在 tools.js 里（要拿到 subagents 服务）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 状态文件格式版本；以后改结构时可以据此迁移。 */
export const PRIVATE_STATE_VERSION = 1

/**
 * 私聊状态文件路径。
 * @param root - 插件数据目录。
 */
export function privateStatePath(root) {
  return join(root, '.state', 'private.json')
}

/** 空状态。 */
export function blankPrivateState() {
  return { version: PRIVATE_STATE_VERSION, bots: {} }
}

/**
 * 把磁盘上读到的内容规整成可用状态：坏数据不该让整个面板起不来。
 * @param raw - JSON.parse 的结果。
 * @returns 规整后的状态。
 */
export function normalizePrivateState(raw) {
  const state = blankPrivateState()
  if (!raw || typeof raw !== 'object') return state
  const bots = raw.bots && typeof raw.bots === 'object' ? raw.bots : {}
  for (const [botId, value] of Object.entries(bots)) {
    if (!value || typeof value !== 'object') continue
    const sessionId = String(value.sessionId ?? '').trim()
    if (sessionId === '') continue
    state.bots[botId] = {
      sessionId,
      // 0.6.x 的私聊是主会话的子代理，它的结算通知会漏进主会话；
      // 0.7 起改成独立根会话，用 kind 区分。老记录标 legacy，不重复用。
      kind: value.kind === 'private' ? 'private' : 'legacy',
      cwd: String(value.cwd ?? '') || null,
      parentSession: String(value.parentSession ?? '') || null,
      dir: String(value.dir ?? '') || null,
      createdAt: Number(value.createdAt) || 0,
      soulMtime: Number(value.soulMtime) || 0,
      unread: Math.max(0, Number(value.unread) || 0),
      lastSeenAt: Number(value.lastSeenAt) || 0,
      greetingAt: Number(value.greetingAt) || 0,
      archivedCount: Math.max(0, Number(value.archivedCount) || 0),
    }
  }
  return state
}

/**
 * 读私聊状态；文件不存在或损坏都返回空状态。
 * @param root - 插件数据目录。
 */
export async function readPrivateState(root) {
  try {
    const text = await readFile(privateStatePath(root), 'utf8')
    return normalizePrivateState(JSON.parse(text))
  } catch {
    return blankPrivateState()
  }
}

/**
 * 写私聊状态：先写临时文件再改名，避免写一半被读到。
 * @param root - 插件数据目录。
 * @param state - 要写的状态。
 */
export async function writePrivateState(root, state) {
  const file = privateStatePath(root)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(normalizePrivateState(state), null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * 取某个 Bot 的私聊记录。
 * @param state - 私聊状态。
 * @param botId - Bot id。
 */
export function privateEntryOf(state, botId) {
  return state?.bots?.[String(botId ?? '')] ?? null
}

/**
 * 记下（或覆盖）某个 Bot 的私聊会话。
 * @param state - 私聊状态。
 * @param botId - Bot id。
 * @param patch - 要写的字段。
 * @returns 写入后的那一条。
 */
export function setPrivateEntry(state, botId, patch) {
  const id = String(botId ?? '').trim()
  if (id === '') return null
  const next = normalizePrivateState({
    bots: { [id]: { ...(state?.bots?.[id] ?? {}), ...patch } },
  })
  const entry = next.bots[id] ?? null
  if (state) {
    if (!state.bots) state.bots = {}
    if (entry) state.bots[id] = entry
  }
  return entry
}

/**
 * 未读数 +n（招呼、Bot 主动说话时用）。
 * @param state - 私聊状态。
 * @param botId - Bot id。
 * @param delta - 增量。
 */
export function addPrivateUnread(state, botId, delta = 1) {
  const entry = privateEntryOf(state, botId)
  if (!entry) return 0
  return setPrivateEntry(state, botId, { unread: entry.unread + Math.max(0, Number(delta) || 0) })?.unread ?? 0
}

/**
 * 清未读（用户点开私聊时）。
 * @param state - 私聊状态。
 * @param botId - Bot id。
 */
export function clearPrivateUnread(state, botId) {
  const entry = privateEntryOf(state, botId)
  if (!entry) return 0
  setPrivateEntry(state, botId, { unread: 0, lastSeenAt: Date.now() })
  return 0
}

/**
 * 私聊会话是不是这个 Bot 的（decoration 判类型用）。
 * @param state - 私聊状态。
 * @param sessionId - 会话 id。
 */
export function privateBotOfSession(state, sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return null
  for (const [botId, entry] of Object.entries(state?.bots ?? {})) {
    if (entry?.sessionId === id) return botId
  }
  return null
}
