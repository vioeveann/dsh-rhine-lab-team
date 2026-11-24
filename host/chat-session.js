/**
 * 单聊会话的存活判断。
 *
 * DSH 只允许往「根会话还活着」的子会话里发消息；创建它的会话离线没关系。
 * 单聊记录里存 rootSession（创建时所在的根），老记录没有就退回 parentSession。
 *
 * @param {object} entry 账本里的单聊行。
 * @returns {string} 根会话 id；没有就空串。
 */
export function chatRootId(entry) {
  return String(entry?.rootSession || entry?.parentSession || '')
}

/**
 * 根会话是否还活着。
 *
 * 当前会话一定是活的；不在当前会话时，只有 agents.get 还能拿到这个根才算活。
 * 拿不到 agent 就当作失效——宁可重开一条单聊，也不要让用户点开发不出去。
 *
 * @param {object} entry 账本里的单聊行。
 * @param {{ currentSession?: string, getAgent?: (id: string) => unknown }} options
 * @returns {boolean}
 */
export function chatRootAlive(entry, options = {}) {
  const root = chatRootId(entry)
  if (root === '') return false
  if (options.currentSession && root === options.currentSession) return true
  try {
    return Boolean(options.getAgent?.(root))
  } catch {
    return false
  }
}
