/**
 * Team tools: the host half that actually starts a bot.
 *
 * A linked plugin cannot import `@deepseek-ai/*` packages (they live inside the
 * app bundle, not in the profile's node_modules), so this file registers a
 * plain tool definition — the same path installed plugins such as dsh-ops use.
 * Only `output.schema` is validated on that path; the body validates its own
 * arguments.
 *
 * Delegation goes through the subagent runtime (`ctx.subagents`), because a
 * child created with `ctx.agents.create()` is rejected at `agent/pre-step`:
 * it never receives the delegated policy grant the runtime attaches. The
 * runtime only changes the child's working directory (its session header keeps
 * the parent's `cwd`), so the fence is `workspace-write` over the whole
 * workspace rather than one directory per task.
 *
 * Persona is installed when the child is announced: `agent/created` fires
 * before the first prompt is assembled, which is the last safe moment to add a
 * scoped prompt section.
 */
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile, appendFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { collectTask } from './deliver.js'
import { buildTaskPrompt } from './brief.js'
import { buildTaskRecord } from './record.js'
import { summarizeTasks } from './health.js'
import { commitMemory, listSnapshots, restoreSnapshot } from './memory.js'
import { confirmImprovement, promoteBot, savePromotionSpeech, updateGrowth } from './growth-store.js'
import { growthDetail, growthSummary, promote, regrade, settleRepeat, settleTask, settleTeaching } from './growth.js'
import { taskGain } from './progress.js'
import { loadBots, stripSoulPlaceholder } from './bots.js'
import { formatMailPrompt } from './mailbox.js'

/** 插件自带审计员的 id；打 excellent 前必须先有它的审计记录。 */
const AUDITOR_ID = 'auditor'

/**
 * 恢复出来的子会话：`agents.get()` 有时拿不到（它只认活着的根会话），
 * 但 `agent/created` 会带着 agent 过来。留一份，续聊时用它等回复。
 */
const liveChildren = new Map()

/**
 * 审计单的固定口径：只读、只核受影响处、输出一页。
 * 上一版的审计会重读全文、重抓数据，四次审计吃掉 59% 的墙钟。
 */
const AUDIT_BRIEF = `

审计口径（固定，照做）：
- 只读复核，只挑问题，不改被审文件；审完报告里写明「文件未改」。
- 先看任务单里「改了什么 / 只核哪几处」，只核受影响的部分；不要重抓数据、不要重算全文。
- 输出一页以内：结论（通过 / 不通过）+ 问题清单（位置、问题、依据、改法）；没有必须改就写「无必须改」。
- 必查五条：①交付物存在、非空、数量与任务单一致（缺了直接不通过）；②数字与原文一致；③出处能落到材料的具体节或行；④口径有来源，不许把自定口径说成官方口径；⑤无法确认的写「不确定」。`
import { DEFAULT_SPEECH, extractPersonaSpeech } from './speech.js'
import { BASE_RULES, BASE_RULES_ORDER, BASE_RULES_SECTION, SCOPE_ORDER, SCOPE_RULES, SCOPE_SECTION } from './base-rules.js'
import { usageOfFrame } from './usage.js'

/** Prompt section name used for a bot persona. */
const PERSONA_SECTION = 'dsh-team/persona'
/** 写感言最多等这么久；它只是一句话的话，不值得按任务超时算。 */
const SPEECH_TIMEOUT_MS = 120_000

/**
 * Build one user-role message without importing the llm package.
 * @param text - the prompt text.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Durable events of one session.
 * @param session - the session.
 */
function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  return session?.events ?? session?.log ?? []
}

/**
 * 这条错误算不算「技术性失败」——值得原样再跑一次。
 * 只认网络/网关/超时/限流这几类；内容问题不重试。
 * @param error - 错误对象或错误文本。
 * @returns 是否值得重试。
 */
export function isTechnicalFailure(error) {
  const text = String(error?.message ?? error ?? '')
  if (text === '') return false
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network|rate.?limit|429|500|502|503|504|overloaded|capacity/i.test(text)
}

/**
 * Join the text blocks of a content array.
 * @param blocks - content blocks.
 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 拼一张可以直接贴进对话的 member 卡片。
 * 卡片要即时反馈，所以工具结果里直接带成品，秘书不用自己排版。
 * @param bot - Bot 定义。
 * @param status - 卡片状态。
 * @param taskId - 任务号。
 * @param text - Bot 的结论。
 */
function memberRelay(bot, status, taskId, text) {
  const body = String(text ?? '')
    .replace(/```/g, "'''")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ')
    .slice(0, 400)
  return ['```member', `id: ${bot.id}`, `role: ${bot.role ?? ''}`, `status: ${status}`, `task: ${taskId}`, `body: ${body}`, '```'].join('\n')
}

/**
 * Join the text blocks of the last assistant message in a session.
 * @param session - the session.
 * @returns the final text, or an empty string.
 */
function finalAssistantText(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const blocks = event.message?.content ?? []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * Wait until a child finished at least one assistant turn.
 * @param readAgent - resolves the live child agent, or undefined.
 * @param timeoutMs - upper bound.
 */
async function waitForReply(readAgent, timeoutMs = 180_000) {
  const startedAt = Date.now()
  for (;;) {
    const agent = readAgent()
    if (agent) {
      const events = sessionEvents(agent.session)
      if (events.some((event) => event?.type === 'assistant/message') && agent.status === 'idle') {
        return finalAssistantText(agent.session)
      }
    }
    if (Date.now() - startedAt > timeoutMs) return ''
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/**
 * 等一个「已存在的会话」回出**新**内容（返工续聊用）。
 *
 * 恢复出来的会话里还留着上一轮的回复，所以不能只看「有没有 assistant 消息」：
 * 必须和上一轮的最后一句不同。会话里还没有消息、或者新回复和上一轮一字不差，
 * 都会被当作「还没回来」。
 *
 * @param readAgent - 解析出活的子 agent。
 * @param baselineText - 上一轮的最后一句。
 * @param timeoutMs - 上限。
 * @returns 新回复正文，或空串。
 */
export async function waitForContinuedReply(readAgent, baselineText, timeoutMs, options = {}) {
  const startedAt = Date.now()
  const readDiskText = typeof options.readDiskText === 'function' ? options.readDiskText : null
  const diskEveryMs = Number(options.diskEveryMs) > 0 ? Number(options.diskEveryMs) : 1000
  let seen = false
  let lastText = ''
  let stable = 0
  let lastDiskAt = 0
  while (Date.now() - startedAt <= timeoutMs) {
    const agent = readAgent()
    if (agent) seen = true
    // agent 的 session 可能一条事件都没有（恢复出来的会话不挂事件），
    // 所以优先读落盘文件里的 turn/end；agent 只作兜底。
    let text = ''
    let fromDisk = false
    if (readDiskText && Date.now() - lastDiskAt >= diskEveryMs) {
      lastDiskAt = Date.now()
      try {
        const disk = await readDiskText()
        if (disk !== '') {
          text = disk
          fromDisk = true
        }
      } catch {
        // 文件还没落盘或读不了，下一轮再试
      }
    }
    if (text === '' && agent) text = finalAssistantText(agent.session)
    // 账本里的上一轮回复可能被截断，用前缀判断「是不是还是同一段」。
    if (text !== '' && !text.startsWith(baselineText)) {
      if (fromDisk) return { text, why: 'ok' }
      if (String(agent?.status ?? '') === 'idle') return { text, why: 'ok' }
      // 有的恢复会话状态迟迟不转 idle，但消息已经落盘：连续两次读到同一段新文字就算回来。
      if (text === lastText) stable += 1
      else {
        lastText = text
        stable = 0
      }
      if (stable >= 2) return { text, why: 'ok' }
    } else if (!agent && !seen && Date.now() - startedAt > 15_000) {
      // 15 秒都拿不到 agent：会话没恢复出来，再等也只是空耗。
      return { text: '', why: 'no-agent' }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return { text: '', why: 'timeout' }
}

/** 会话文件查找缓存：sessionId → 文件绝对路径。 */
const sessionFileCache = new Map()
/** 每个会话文件是一个 JSONL，每行一个独立 zstd 帧；只读尾部就够等最后一句。 */
const SESSION_TAIL_BYTES = 1024 * 1024
/** 只看最近的工具调用，判断是不是在同一步上打转。 */
const DIGEST_TAIL_BYTES = 256 * 1024
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 找到某个子会话的落盘文件：`~/.dsh/sessions/<任意目录>/<sessionId>/session.v4.jsonl.zstd`。
 * 目录名是 cwd 编码出来的，不可逆推，所以按 sessionId 扫一层。
 * @param sessionId - 子会话 id。
 * @param root - sessions 根目录（测试可传临时目录）。
 */
async function findSessionFile(sessionId, root) {
  const key = `${root}\u0000${sessionId}`
  const cached = sessionFileCache.get(key)
  if (cached) return cached
  let dirs = []
  try {
    dirs = await readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const file = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
    try {
      const info = await stat(file)
      if (info.isFile()) {
        sessionFileCache.set(key, file)
        return file
      }
    } catch {
      // 不在这个目录
    }
  }
  return null
}

/**
 * 直接从子会话的落盘文件里读「这一轮结束时的最后一句」。
 *
 * 为什么需要它：恢复出来的 agent 有时 status=idle 但 session 里一条事件都没有，
 * 光等 agent 会空转到超时。文件里已经有 `turn/end`，以它为准最可靠。
 *
 * @param sessionId - 子会话 id。
 * @param afterTime - 只要这个时间之后开始的轮次（epoch ms）。
 * @param root - sessions 根目录（测试可传临时目录）。
 * @returns 该轮最后的 assistant 文本，没有则空串。
 */
export async function readSessionTurnReply(sessionId, afterTime, root = join(homedir(), '.dsh', 'sessions')) {
  const file = await findSessionFile(sessionId, root)
  if (!file) return ''
  let buffer
  try {
    buffer = await readFile(file)
  } catch {
    return ''
  }
  const from = Math.max(0, buffer.length - SESSION_TAIL_BYTES)
  let offset = buffer.indexOf(ZSTD_MAGIC, from)
  let turnStarted = 0
  let current = ''
  let final = ''
  while (offset !== -1) {
    let text = ''
    try {
      text = zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const type = event?.type
      if (type === 'turn/start') {
        turnStarted = Number(event?.time ?? 0)
        current = ''
      } else if (type === 'assistant/message') {
        const blocks = (event?.data?.message ?? event?.message)?.content ?? []
        const body = blocksToText(blocks)
        if (body) current = body
      } else if (type === 'turn/end' && current !== '' && turnStarted >= afterTime) {
        final = current
      }
    }
    offset = buffer.indexOf(ZSTD_MAGIC, offset + 4)
  }
  return final
}

/**
 * 读「某时刻之后收到的最新一句 assistant 文本」，不等 turn/end。
 *
 * 监考问「是不是卡住了」时，BOT 的答复可能还在同一轮里，turn/end 还没写；
 * 所以这里按事件时间取，不要求轮次结束。
 */
export async function readSessionAssistantSince(sessionId, afterTime, root = join(homedir(), '.dsh', 'sessions')) {
  const file = await findSessionFile(sessionId, root)
  if (!file) return ''
  let buffer
  try {
    buffer = await readFile(file)
  } catch {
    return ''
  }
  const from = Math.max(0, buffer.length - SESSION_TAIL_BYTES)
  let offset = buffer.indexOf(ZSTD_MAGIC, from)
  let last = ''
  while (offset !== -1) {
    let text = ''
    try {
      text = zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'assistant/message') continue
      const when = Number(event?.time ?? event?.ts ?? 0)
      if (when < afterTime) continue
      const blocks = (event?.data?.message ?? event?.message)?.content ?? []
      const body = blocksToText(blocks)
      if (body) last = body
    }
    offset = buffer.indexOf(ZSTD_MAGIC, offset + 4)
  }
  return last
}

/**
 * 判断 BOT 对「是不是卡住了」的答复。
 * 只做关键词分流，不做语义猜测；分不清就按「正常」继续观察。
 * @returns 'stuck' | 'normal'
 */
export function classifyCheckinReply(text) {
  const value = String(text ?? '')
  if (/(没|没有|不|不是)(卡住|卡死|卡了)/.test(value)) return 'normal'
  if (/(卡住|卡死|卡了|走不动|死循环)/.test(value)) return 'stuck'
  if (/(正常|在等|正在|还在|继续|长命令|跑着)/.test(value)) return 'normal'
  if (/(报错|失败|重试|调整|修复)/.test(value)) return 'stuck'
  return 'normal'
}

/**
 * 读最近一段会话，回答「它还在动吗、是不是在原地打转」。
 *
 * 打转的判据只认确定性事实：同一轮里，同一个工具、同一组参数被调用 3 次以上。
 * 不猜语义，也不把「重试同一个接口等限流」之外的长任务当打转。
 *
 * @param sessionId - 子会话 id。
 * @param root - sessions 根目录（测试可传临时目录）。
 * @returns `{ size, lastEventAt, maxRepeat }`；maxRepeat 是当前轮某个工具调用的最大重复次数。
 */
export async function readSessionDigest(sessionId, root = join(homedir(), '.dsh', 'sessions')) {
  const file = await findSessionFile(sessionId, root)
  if (!file) return { size: 0, lastEventAt: 0, maxRepeat: 0 }
  let buffer
  try {
    buffer = await readFile(file)
  } catch {
    return { size: 0, lastEventAt: 0, maxRepeat: 0 }
  }
  const from = Math.max(0, buffer.length - DIGEST_TAIL_BYTES)
  const events = []
  let offset = buffer.indexOf(ZSTD_MAGIC, from)
  while (offset !== -1) {
    let text = ''
    try {
      text = zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // 半个帧或非 JSON 行，跳过
      }
    }
    offset = buffer.indexOf(ZSTD_MAGIC, offset + 4)
  }
  // 只看最后一轮：turn/start 之前的调用是上一轮的，不该算进「打转」。
  let start = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      start = i
      break
    }
  }
  const counts = new Map()
  const seen = new Set()
  let lastEventAt = 0
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]
    const time = Number(event?.time ?? 0)
    if (time > lastEventAt) lastEventAt = time
    if (event?.type !== 'tool/call') continue
    const name = String(event?.data?.name ?? '')
    const args = JSON.stringify(event?.data?.arguments ?? null)
    // 从每个 zstd 帧头解压会把后面的帧重复读出来；用 seq 去重。
    const id = `${event?.seq ?? ''}\u0000${time}\u0000${name}\u0000${args}`
    if (seen.has(id)) continue
    seen.add(id)
    const key = `${name}\u0000${args}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let maxRepeat = 0
  for (const count of counts.values()) if (count > maxRepeat) maxRepeat = count
  return { size: buffer.length, lastEventAt, maxRepeat }
}

/**
 * 等子会话「这一轮」结束，事件驱动：文件一变就立刻读，不靠定时轮询空等。
 *
 * - 文件已落 `turn/end` 的回复 → 立即返回；
 * - 否则挂 `fs.watch`，子会话一写就醒；1 秒兜底检查一次，防 Windows 丢事件；
 * - 子会话文件一直找不到、且 agent 侧也读不到任何东西 → 15 秒返回 no-agent；
 * - 180 秒没有任何新事件 → 问一次「是不是卡住了」；没回答就再问一次；
 *   两次都没回答、日志也完全不动 → 停掉当前 turn，再问它卡在哪；
 *   回答正常则每 5 分钟再问，封顶 10 次 → needs-decision（交给你判断）；
 *   回答卡住就让 BOT 自己修；
 * - 同一轮里同一个工具、同一组参数调用 3 次 → 提醒换路；8 次 → 判定打转。
 *
 * @param sessionId - 子会话 id。
 * @param afterTime - 只要这个时间之后开始的轮次（epoch ms）。
 * @param timeoutMs - 上限。
 * @param options - `{ root, signal, readFallback, stallWarnMs, stallAskMs, stallGraceMs, stallMaxNormal, nudge, cancel }`。
 * @returns `{ text, why }`，why ∈ ok/no-agent/timeout/stalled/loop/needs-decision。
 */
export async function waitForSessionTurnReply(sessionId, afterTime, timeoutMs, options = {}) {
  const root = options.root ?? join(homedir(), '.dsh', 'sessions')
  const startedAt = Date.now()
  const readDisk = () => readSessionTurnReply(sessionId, afterTime, root)
  const readFallback = typeof options.readFallback === 'function' ? options.readFallback : null
  const baselineText = options.baselineText ?? ''
  const stallWarnMs = Number(options.stallWarnMs ?? 180_000)
  const stallAskMs = Number(options.stallAskMs ?? 300_000)
  const stallGraceMs = Number(options.stallGraceMs ?? 120_000)
  const stallMaxNormal = Number(options.stallMaxNormal ?? 10)
  // 磁盘文本已经按 afterTime 过滤过轮次，哪怕和上一轮一字不差，也是这轮的新回复。
  const fresh = (text) => text !== '' && !text.startsWith(baselineText)
  let file = await findSessionFile(sessionId, root)
  let reply = await readDisk()
  if (reply !== '') return { text: reply, why: 'ok' }
  if (file && readFallback) {
    const text = readFallback()
    if (fresh(text)) return { text, why: 'ok' }
  }
  let watcher = null
  let wake = null
  let lastSize = -1
  let lastProgressAt = Date.now()
  let nextAskAt = Date.now() + stallWarnMs
  let askingSince = 0
  let askCount = 0
  let cancelSent = false
  let normalCount = 0
  let loopWarned = false
  let lastDigestAt = 0
  let ignoreGrowthUntil = 0
  const nudge = typeof options.nudge === 'function' ? options.nudge : null
  const cancel = typeof options.cancel === 'function' ? options.cancel : null
  // 提醒本身会写进子会话，不能让它把自己的写入当成「BOT 还在动」。
  const sendNudge = (text) => {
    if (!nudge) return
    ignoreGrowthUntil = Date.now() + 5000
    void Promise.resolve(nudge(text)).catch(() => {})
  }
  const attach = () => {
    if (!file || watcher) return
    try {
      watcher = watch(file, { persistent: false })
      watcher.on('change', () => {
        if (wake) {
          const resume = wake
          wake = null
          resume()
        }
      })
      watcher.on('error', () => {})
    } catch {
      watcher = null
    }
  }
  attach()
  try {
    while (Date.now() - startedAt <= timeoutMs) {
      if (options.signal?.aborted) return { text: '', why: 'timeout' }
      reply = await readDisk()
      if (reply !== '') return { text: reply, why: 'ok' }
      if (readFallback) {
        const text = readFallback()
        if (fresh(text)) return { text, why: 'ok' }
      }
      if (!file) {
        file = await findSessionFile(sessionId, root)
        attach()
        if (!file && Date.now() - startedAt > 15_000) {
          // 既没有会话文件、agent 侧也读不到任何东西：别再空等满超时。
          const text = readFallback ? readFallback() : ''
          if (text === '') return { text: '', why: 'no-agent' }
        }
      }
      if (file) {
        let grew = false
        try {
          const info = await stat(file)
          if (info.size !== lastSize) {
            const changed = info.size > lastSize
            lastSize = info.size
            // 提醒本身会写会话；3 秒内只认大小变化，不认「有进展」。
            if (Date.now() >= ignoreGrowthUntil) {
              grew = changed
              lastProgressAt = Date.now()
            }
          }
        } catch {
          // 文件正在被替换，下一轮再看
        }
        const now = Date.now()
        if (askingSince) {
          const reply = await readSessionAssistantSince(sessionId, askingSince, root)
          if (reply) {
            askingSince = 0
            askCount = 0
            cancelSent = false
            if (classifyCheckinReply(reply) === 'stuck') {
              lastProgressAt = now
              nextAskAt = now + stallAskMs
            } else {
              normalCount += 1
              if (normalCount > stallMaxNormal) return { text: '', why: 'needs-decision', idleMs: now - lastProgressAt }
              nextAskAt = now + stallAskMs
            }
          } else if (grew && !cancelSent) {
            // 没回话但还在写文件：当作还在干，先不判卡。
            askingSince = 0
            askCount = 0
            nextAskAt = now + stallAskMs
          } else if (now - askingSince >= stallGraceMs) {
            if (askCount < 2) {
              // 第一次询问没有回答：再问一次，两次都没回答才考虑停掉。
              askCount += 1
              askingSince = now
              if (nudge) {
                sendNudge('第二次确认：你仍然没有回答，也没有新动作。如果还在干活，请用一句话说明在等什么；如果卡住了，直接说卡在哪。')
              }
            } else if (!cancelSent) {
              // 两次询问都没回答，日志也完全不动：停掉当前 turn，再问它卡在哪。
              cancelSent = true
              askCount += 1
              try {
                await cancel?.()
              } catch {
                // 取消失败也继续问，至少把消息送到。
              }
              await new Promise((resolve) => setTimeout(resolve, 500))
              askingSince = now
              if (nudge) {
                sendNudge('刚才停掉了你当前的动作。请报告卡在哪一步、已经做到哪里，然后从断点继续。')
              }
            } else {
              return { text: '', why: 'stalled', idleMs: now - lastProgressAt }
            }
          }
        } else if (now >= nextAskAt) {
          askingSince = now
          askCount = 1
          const seconds = Math.round((now - lastProgressAt) / 1000)
          if (nudge) {
            sendNudge(`你已经有 ${seconds} 秒没有新动作。是不是卡住了？先自查一遍：卡在哪一步、是不是在等长命令。请用一句话回答：卡住了 / 正常，在等 X。`)
          }
        }
        // 每 10 秒看一次有没有在原地打转，别每秒解压一遍会话。
        if (Date.now() - lastDigestAt >= 10_000 || lastDigestAt === 0) {
          lastDigestAt = Date.now()
          const digest = await readSessionDigest(sessionId, root)
          if (digest.maxRepeat >= 3 && !loopWarned) {
            loopWarned = true
            if (nudge) {
              sendNudge(`同一个工具、同一组参数你已经调用了 ${digest.maxRepeat} 次。别重复了，换一种做法，或者直接说明卡在哪里。`)
            }
          }
          if (digest.maxRepeat >= 8) {
            return { text: '', why: 'loop', idleMs: now - lastProgressAt }
          }
        }
      }
      // 事件驱动：文件变化立即唤醒；1 秒只是兜底，不是主路径。
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, 1000)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    return { text: '', why: 'timeout' }
  } finally {
    try {
      watcher?.close()
    } catch {
      // 已经关了
    }
  }
}

/**
 * 续聊时挑「活的那个 agent」：恢复出来的会话只会进 liveChildren，
 * agents.get 可能还拿着旧对象，所以 live 优先。
 * @param sessionId - 子会话 id。
 * @param live - 恢复出来的 agent 表。
 * @param registry - agents 服务。
 */
export function pickContinueAgent(sessionId, live, registry) {
  return live?.get?.(sessionId) ?? registry?.get?.(sessionId) ?? null
}

/**
 * 派活时盯住子会话：不只看它有没有崩，还要发现「没崩但不动了」。
 *
 * 只看会话落盘文件的确定事实：文件多久没长、同一个工具同一组参数重复几次。
 * 到 180 秒先问「是不是卡住了」；没回答就再问一次；两次都没回答、日志也不动，
 * 就停掉当前 turn，再问它卡在哪；回答正常就每 5 分钟再问，封顶 10 次交给你判断；
 * 回答卡住就让 BOT 自己修；
 *
 * @param sessionId - 子会话 id。
 * @param options - `{ root, warnMs, askMs, graceMs, maxNormal, nudge, cancel, signal }`。
 * @returns `{ promise, stop }`；promise 解析为 null（正常退出）或 'stalled'/'loop'/'needs-decision'。
 */
export function startStallWatch(sessionId, options = {}) {
  const root = options.root ?? join(homedir(), '.dsh', 'sessions')
  const warnMs = Number(options.warnMs ?? 180_000)
  const askMs = Number(options.askMs ?? 300_000)
  const graceMs = Number(options.graceMs ?? 120_000)
  const maxNormal = Number(options.maxNormal ?? 10)
  const nudge = typeof options.nudge === 'function' ? options.nudge : null
  const cancel = typeof options.cancel === 'function' ? options.cancel : null
  const startedAt = Date.now()
  let stopped = false
  let timer = null
  let lastSize = -1
  let lastProgressAt = Date.now()
  let nextAskAt = startedAt + warnMs
  let askingSince = 0
  let askCount = 0
  let cancelSent = false
  let cancelledAt = 0
  let normalCount = 0
  let loopWarned = false
  let lastDigestAt = 0
  let ignoreGrowthUntil = 0
  let file = null
  const sendNudge = (text) => {
    if (!nudge) return
    // 提醒会写进子会话；把它自己的写入排除在「有进展」之外。
    ignoreGrowthUntil = Date.now() + 5000
    void Promise.resolve(nudge(text)).catch(() => {})
  }
  const promise = new Promise((resolve) => {
    const finish = (why) => {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      resolve(why)
    }
    const check = async () => {
      if (stopped) return
      if (options.signal?.aborted) return finish(null)
      if (!file) file = await findSessionFile(sessionId, root)
      if (!file) {
        if (Date.now() - lastProgressAt >= warnMs + graceMs) finish('stalled')
        return
      }
      let grew = false
      try {
        const info = await stat(file)
        if (info.size !== lastSize) {
          const changed = info.size > lastSize
          lastSize = info.size
          if (Date.now() >= ignoreGrowthUntil) {
            grew = changed
            lastProgressAt = Date.now()
          }
        }
      } catch {
        return
      }
      const now = Date.now()
      if (askingSince) {
        const reply = await readSessionAssistantSince(sessionId, askingSince, root)
        if (reply) {
          askingSince = 0
          askCount = 0
          cancelSent = false
          if (classifyCheckinReply(reply) === 'stuck') {
            // BOT 说卡住了：它自己会修，把计时重置，下一轮再问。
            lastProgressAt = now
            nextAskAt = now + askMs
          } else {
            normalCount += 1
            if (normalCount > maxNormal) return finish('needs-decision')
            nextAskAt = now + askMs
          }
        } else if (grew && !cancelSent) {
          // 没回话但还在写文件：当作还在干，先不判卡。
          askingSince = 0
          askCount = 0
          nextAskAt = now + askMs
        } else if (now - askingSince >= graceMs) {
          if (askCount < 2) {
            // 第一次询问没有回答：再问一次，两次都没回答才考虑停掉。
            askCount += 1
            askingSince = now
            if (nudge) {
              sendNudge('第二次确认：你仍然没有回答，也没有新动作。如果还在干活，请用一句话说明在等什么；如果卡住了，直接说卡在哪。')
            }
          } else if (!cancelSent) {
            // 两次询问都没回答，日志也完全不动：停掉当前 turn，再问它卡在哪。
            cancelSent = true
            cancelledAt = Date.now()
            askCount += 1
            try {
              await cancel?.()
            } catch {
              // 取消失败也继续问，至少把消息送到。
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
            askingSince = now
            if (nudge) {
              sendNudge('刚才停掉了你当前的动作。请报告卡在哪一步、已经做到哪里，然后从断点继续。')
            }
          } else {
            return finish('stalled')
          }
        }
      } else if (now >= nextAskAt) {
        askingSince = now
        askCount = 1
        const seconds = Math.round((now - lastProgressAt) / 1000)
        if (nudge) {
          sendNudge(`你已经有 ${seconds} 秒没有新动作。是不是卡住了？先自查一遍：卡在哪一步、是不是在等长命令。请用一句话回答：卡住了 / 正常，在等 X。`)
        }
      }
      if (Date.now() - lastDigestAt >= 10_000 || lastDigestAt === 0) {
        lastDigestAt = Date.now()
        const digest = await readSessionDigest(sessionId, root)
        if (digest.maxRepeat >= 3 && !loopWarned) {
          loopWarned = true
          if (nudge) {
            sendNudge(`同一个工具、同一组参数你已经调用了 ${digest.maxRepeat} 次。别重复了，换一种做法，或者直接说明卡在哪里。`)
          }
        }
        if (digest.maxRepeat >= 8) finish('loop')
      }
    }
    timer = setInterval(() => void check(), 1000)
    // 监考只是旁路：主流程结束后不该靠它把进程拖住。
    timer.unref?.()
    void check()
  })
  return {
    promise,
    get cancelledAt() {
      return cancelledAt
    },
    stop: () => {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}

/**
 * Read a bot's memory file, returning '' when it does not exist.
 * @param root - package directory.
 * @param id - bot id.
 * @param file - memory file name.
 */
/**
 * Read the team-level memory shared by every bot: who the user is and how the
 * team writes. Missing files are simply skipped.
 * @param root - package directory.
 */
export async function readTeamMemory(root) {
  const parts = []
  for (const name of ['knowledge.md', 'user.md', 'style.md']) {
    try {
      const text = (await readFile(join(root, 'bots', '_team', name), 'utf8')).trim()
      if (text) parts.push(text)
    } catch {
      // No team memory yet.
    }
  }
  return parts.join('\n\n')
}

async function readMemory(root, id, file) {
  try {
    return await readFile(join(root, 'bots', id, 'memory', file), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Score memory lines against a query: tag hits first, then substring hits.
 * @param text - memory file content.
 * @param query - free text from the bot.
 * @param limit - maximum lines returned.
 */
export function recallLines(text, query, limit = 6) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .filter(Boolean)
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const scored = lines.map((line) => {
    const lower = line.toLowerCase()
    const tag = /^\[([^\]]+)\]/.exec(line)?.[1]?.toLowerCase() ?? ''
    let score = 0
    for (const term of terms) {
      if (tag.includes(term)) score += 3
      if (lower.includes(term)) score += 1
    }
    return { line, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.line)
}

/**
 * Register the memory tool: a bot looks up its own tagged memory on demand.
 * @param ctx - plugin context.
 * @param options - `{ root, tools, debug }`.
 * @returns the tools disposer.
 */
export function registerMemoryTools(ctx, options) {
  const { root, tools, debug, pending } = options

  /**
   * Resolve which bot is asking: the task session we dispatched, or the name it
   * quoted (a compiled child name looks like `nova-t-abc123`), or the raw id.
   */
  function resolveBotId(raw, exec) {
    const sessionId = exec?.agent?.session?.header?.id
    const known = sessionId ? pending.get(sessionId)?.bot?.id : undefined
    if (known) return known
    const name = String(raw ?? '').trim()
    if (name === '') return ''
    const match = /^([a-z0-9_]+)-t-[a-z0-9]+$/.exec(name)
    return match ? match[1] : name
  }

  const disposeRecall = tools.register({
    name: 'team_recall',
    description:
      '查自己的项目记忆。写东西之前先查一次：用你手上的线索当关键词（文件、材料名、话题），会返回相关的旧条目。查不到就说明没记过。bot 参数可以省略，会自动认成你自己。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词：材料名、文件名、话题' },
      bot: { type: 'string', description: '你自己的 bot id；不知道就省略' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const botId = resolveBotId(args?.bot, exec)
      const query = String(args?.query ?? '').trim()
      const text = await readMemory(root, botId, 'project.md')
      const hits = recallLines(text, query)
      await debug?.({ event: 'recall', bot: botId, query, hits: hits.length })
      return hits.length === 0 ? '（没有相关记忆）' : hits.join('\n')
    },
  })

  const disposeAppend = tools.register({
    name: 'team_memory_append',
    description:
      '往自己的项目记忆里写一行。只写「这次学到的、以后还用得上的」：一条一行，[标签] 开头。不要记录一次性细节，也不要写自己的职责（那在 soul 里）。',
    parameters: {
      tag: { type: 'string', required: true, description: '一个词的主题，例如 沙箱 / 图纸 / 口径' },
      text: { type: 'string', required: true, description: '一句话，写事实或结论，不写过程' },
      bot: { type: 'string', description: '你自己；省略即可' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const botId = resolveBotId(args?.bot, exec)
      const tag = String(args?.tag ?? '').trim().replace(/[[\]]/g, '')
      const text = String(args?.text ?? '').trim().replace(/\s*\n\s*/g, ' ')
      if (!botId || !tag || !text) return '写入失败：缺少 bot / tag / text'

      const file = join(root, 'bots', botId, 'memory', 'project.md')
      const line = `[${tag}] ${text}\n`
      try {
        await appendFile(file, line, 'utf8')
        const hash = await commitMemory(join(root, 'bots', botId, 'memory'), `memory: [${tag}] ${text.slice(0, 40)}`)
        await debug?.({ event: 'memory_append', bot: botId, tag, chars: text.length, commit: hash })
        return `已记下：[${tag}] ${text}${hash ? `（快照 ${hash}）` : ''}`
      } catch (error) {
        await debug?.({ event: 'memory_append', bot: botId, ok: false, error: String(error?.message ?? error) })
        return `写入失败：${String(error?.message ?? error)}`
      }
    },
  })

  const disposeRestore = tools.register({
    name: 'team_memory_restore',
    description:
      '把某个 Bot 的记忆文件回退到某个快照。先用 team_memory_snapshots 查 hash，再回退；只回退 project.md，soul 不动。',
    parameters: {
      bot: { type: 'string', required: true, description: 'Bot 的 id' },
      hash: { type: 'string', required: true, description: '快照 hash（team_memory_snapshots 给的短 hash）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const botId = String(args?.bot ?? '').trim()
      const hash = String(args?.hash ?? '').trim()
      if (!botId || !hash) return '缺少 bot 或 hash'
      const result = await restoreSnapshot(join(root, 'bots', botId, 'memory'), hash, 'project.md')
      await debug?.({ event: 'memory_restore', bot: botId, hash, ok: result.ok })
      return result.ok ? `已回到 ${hash}（project.md）` : `回退失败：${result.error}`
    },
  })

  const disposeSnapshots = tools.register({
    name: 'team_memory_snapshots',
    description: '列出某个 Bot 的记忆快照（最近 20 条），用来决定回退到哪一版。',
    parameters: {
      bot: { type: 'string', required: true, description: 'Bot 的 id' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const botId = String(args?.bot ?? '').trim()
      const rows = await listSnapshots(join(root, 'bots', botId, 'memory'))
      if (rows.length === 0) return '（还没有快照）'
      return rows.map((row) => `${row.hash}  ${row.when}  ${row.subject}`).join('\n')
    },
  })

  return () => {
    disposeRecall()
    disposeAppend()
    disposeRestore()
    disposeSnapshots()
  }
}

/**
 * Read one bot definition.
 * @param root - the package directory.
 * @param id - bot id.
 */
async function readBot(root, id) {
  const raw = await readFile(join(root, 'bots', `${id}.json`), 'utf8')
  return JSON.parse(raw)
}

/**
 * Rules the secretary follows when relaying team work into the transcript.
 * Kept short: it is added to every prompt assembly.
 */
export const SECRETARY_RULES = [
  '团队协作（dsh-team）：**这几条只适用于带队的那一个会话（秘书）**。如果你是被派活的子会话，忽略下面全部内容，只做交给你的任务。',
  '当你带队时，可以用 team_dispatch 把一段工作交给某个 Bot。',
  '派活时写清目标、交付物、验收标准、红线。轻活、你自己几分钟能做完的，不要派。',
  '动手之前先想清楚这一趟要谁：要用 team_assign 把需要的 Bot（包括只在后面做审计/验收的）一次拉进行动组，没在干活的会显示「待命」。',
  '拿到 team_dispatch 的结果后，先自己核对产物或结论（别只看它怎么说），再用 team_review 记一笔：通过记 accepted **并给评分**（excellent / good / pass / poor，见工具说明），打回记 rejected 并写清哪一条不过。不填评分这次活不结算经验、也不进好评率。',
  '每件活一回来就立刻把结果里的 relay 原样贴进对话（body 可以改短，id/task/status 不要改），再继续派下一件或做别的；不要攒到全部干完才一次性发卡片。',
  '看到它把教过的规矩守住了（教下之后干了 2 件活、期间没复犯），用 team_improve 记一笔，别攒着。',
  '用户就是审计：用户对交付物的反应（挑错、说漏了、说老毛病又犯、说不错）比你的评分更权威。看到这种反应，立刻用 team_user_feedback 把用户原话记下来——别等用户说第二次，也别自己美化。',
  '插件自带一个审计员（bot id `auditor`，职责「成果审计」：只挑问题、不打分、不改文件）。**你准备打 excellent 时必须先派它只读复核**，然后把那次审计的任务号填进 team_review 的 auditTaskId；没审计就想打 excellent 会被拒。其余分档不用审。它要是被用户删了，这步跳过、自己复核，并在回话里提一句。',
  '晋升（team_promote）成功后它会写一段感言；那几句用下面的围栏块原样转述，不要改写成你自己的话。',
  '核对完再用下面这种围栏块把 Bot 的话转述进对话，不要直接粘贴 JSON：',
  '```member',
  'id: <bot 的 id>',
  'role: <它的职责>',
  'status: <ready|accepted|rejected|blocked|needs-decision|failed>',
  'task: <taskId>',
  'body: <它说的话，一到三句，只写结论和关键分歧>',
  '```',
  '转述可以概括，但不要替它编造。',
].join('\n')

/**
 * Tools a bot may never use, from its capability card. Unknown names are
 * filtered by the caller, because restrict() rejects names it cannot resolve.
 * @param bot - bot definition.
 */
export const DEFAULT_DENY = [
  'workflow',
  'create_goal',
  'update_goal',
  'schedule_create',
  'schedule_edit',
  'schedule_delete',
  'plugin_manager',
  'server_manager',
  'mcp_manage',
  // Bot 不能把问题弹回给你：要拍板就结束本轮，由秘书转述。
  'ask_user_question',
  'request_user_input',
]

/**
 * Resolve the deny list for one bot: its own card, otherwise the defaults.
 * @param bot - bot definition.
 */
export function capabilityDenyList(bot) {
  const card = bot?.capability?.tools?.deny
  if (Array.isArray(card) && card.length > 0) return card.map(String)
  return DEFAULT_DENY
}

/**
 * Decide how a bot's capability card restricts tools.
 * A non-empty allow list wins; otherwise the deny list applies.
 * @param bot - bot definition.
 * @returns `{ allow }` or `{ deny }`.
 */
export function capabilityPlan(bot) {
  const card = bot?.capability?.tools
  if (Array.isArray(card?.allow) && card.allow.length > 0) {
    return { allow: card.allow.map(String) }
  }
  return { deny: capabilityDenyList(bot) }
}

/**
 * Count the tasks a session still has in flight.
 * @param tasks - task map.
 * @param sessionId - parent session id.
 */
export function activeTaskCount(tasks, sessionId) {
  let count = 0
  for (const entry of tasks?.values?.() ?? []) {
    if (entry.doneAt) continue
    // 排队等依赖的任务不占并发名额：它还没起子会话。
    if (entry.status === 'queued') continue
    // 重启时中断的任务没有句柄，恢复前也不占名额。
    if (entry.status === 'interrupted') continue
    if (entry.parentSession !== sessionId) continue
    count += 1
  }
  return count
}

/**
 * 任务依赖：接受数组、JSON 数组字符串，或逗号/空白分隔的字符串。
 * 去重、去空，保持原顺序。
 * @param raw - dependsOn 参数。
 * @returns 任务号数组。
 */
export function normalizeDependsOn(raw) {
  let list = []
  if (Array.isArray(raw)) {
    list = raw
  } else {
    const text = String(raw ?? '').trim()
    if (text === '') return []
    try {
      const parsed = JSON.parse(text)
      list = Array.isArray(parsed) ? parsed : [text]
    } catch {
      list = text.split(/[,\s]+/)
    }
  }
  const seen = new Set()
  const out = []
  for (const value of list) {
    const id = String(value ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 重启恢复时，把旧任务号映射到新任务号；映射为空的依赖说明上游没恢复，保留原值让下游受阻。
 * @param ids - 原依赖任务号。
 * @param mapping - old -> new（new 为空表示失败）。
 * @returns 新依赖数组。
 */
export function remapDependsOn(ids, mapping) {
  return (ids ?? []).map((id) => {
    const next = mapping instanceof Map ? mapping.get(id) : mapping?.[id]
    return String(next || id)
  })
}

/**
 * 一个依赖任务当前算什么状态。
 * ready 只是「跑完了、等验收」，下游可以先做；rejected/failed 等才算坏。
 * @param entry - 依赖的账本行。
 * @returns ok | bad | pending | missing。
 */
export function dependencyState(entry, mode = 'done') {
  if (!entry) return 'missing'
  const status = String(entry.status ?? '')
  if (status === 'accepted') return 'ok'
  // accepted 模式：跑完还不算数，必须验收通过；验收前下游不能动。
  if (mode === 'accepted' && status === 'ready') return 'pending'
  if (status === 'ready') return 'ok'
  if (['rejected', 'failed', 'timeout', 'blocked', 'cancelled', 'needs-decision', 'interrupted'].includes(status)) return 'bad'
  // queued 只是在排队，还没有结论；和 running 一样先等。
  return 'pending'
}

/**
 * 依赖放行模式：done = 上游跑完就放行；accepted = 上游验收通过才放行。
 * @param raw - 工具参数。
 * @returns done | accepted。
 */
export function normalizeDependsOnMode(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'accepted' ? 'accepted' : 'done'
}

/**
 * Decide whether a new task may start for this session.
 * @param tasks - task map.
 * @param sessionId - parent session id.
 * @param limit - concurrency cap.
 * @returns `{ ok, active }`.
 */
export function canStartTask(tasks, sessionId, limit) {
  const active = activeTaskCount(tasks, sessionId)
  return { ok: active < limit, active }
}

/**
 * Register the team tools on a plugin context.
 * @param ctx - plugin context.
 * @param options - `{ root, tools, agents, subagents, debug, pending }`.
 * @returns the tools disposer.
 */
export function registerTeamTools(ctx, options) {
  const { root, tools, agents, subagents, debug, pending, tasks, mailbox, isTeamSession, persistTasks, usageBook } = options

  /**
   * 怎么称呼用户：设置里的 address，默认「你」。
   * 不写死称呼——用户可能不想被叫「博士」。
   * @returns 称谓。
   */
  const address = () => {
    try {
      return String(getSettings?.()?.address ?? '').trim() || '你'
    } catch {
      return '你'
    }
  }
  /** 正在跑的任务 → 句柄，用来中止。 */
  const running = new Map()

  /** 任务号：并行派活时同一毫秒可能起两件，随机尾必须带。 */
  const newTaskId = () => `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  // 有交付物的活默认要过审计；秘书可以显式 review:false 跳过，审计员自己不审自己。
  function wantsReview(bot, args) {
    if (bot?.id === AUDITOR_ID) return false
    if (args?.review === false) return false
    if (args?.review === true) return true
    return String(args?.deliverable ?? '').trim() !== ''
  }

  /** 当前会话属于哪个 Bot：子会话的 sessionId 在账本里。 */
  function botOfSession(sessionId) {
    if (!sessionId) return ''
    let hit = ''
    for (const entry of tasks?.values?.() ?? []) {
      if (entry.sessionId !== sessionId) continue
      if (!entry.bot) continue
      // 同一会话只会属于一个 Bot；优先取最近一条，避免历史行误判。
      if (!hit) hit = entry.bot
    }
    return hit
  }

  /** 信箱身份：Bot 用 id，秘书用 secretary。 */
  function mailboxIdentity(exec) {
    const sessionId = exec?.agent?.session?.header?.id
    const bot = botOfSession(sessionId)
    if (bot) return bot
    return isTeamSession?.(sessionId) ? 'secretary' : ''
  }

  /** 信箱工具只对 Bot 子会话和秘书会话开放。 */
  const mailboxWhen = ({ agent }) => {
    const sessionId = agent?.session?.header?.id
    if (!sessionId) return false
    return Boolean(botOfSession(sessionId)) || Boolean(isTeamSession?.(sessionId))
  }

  /** 收件人必须是团队内已启用的 Bot。 */
  async function readRecipient(botId) {
    const id = String(botId ?? '').trim()
    if (!id) return null
    const bots = await loadBots(root)
    const bot = bots.find((item) => item.id === id)
    if (!bot || bot.status === 'disabled') return null
    return bot
  }

  const reviewQueued = new Set()

  // 有交付物的任务完成后，自动给它建一张审计子任务；终审仍由秘书做。
  async function maybeQueueReview(entry, exec) {
    if (!entry?.review || entry.bot === AUDITOR_ID) return
    if (reviewQueued.has(entry.taskId)) return
    if ([...tasks.values()].some((row) => row.reviewOf === entry.taskId)) return
    let auditor
    try {
      auditor = await readBot(root, AUDITOR_ID)
    } catch {
      auditor = null
    }
    if (!auditor || auditor.status === 'disabled') return
    reviewQueued.add(entry.taskId)
    const reviewTaskId = newTaskId()
    entry.reviewTaskId = reviewTaskId
    void persistTasks?.()
    const excerpt = String(entry.output ?? entry.note ?? '').slice(0, 4000)
    const prompt = [
      `审计任务：只读复核 ${entry.taskId}（${entry.bot}）。`,
      '',
      `原任务：${entry.brief?.task ?? ''}`,
      `交付物：${entry.brief?.deliverable ?? ''}`,
      `验收标准：${entry.brief?.accept ?? ''}`,
      '',
      '原任务产出（节选）：',
      excerpt === '' ? '（没有文字产出，去看 ./from-previous/ 里的文件）' : excerpt,
      '',
      '按固定清单检查：产物存在、数字可核、口径写清、引用有出处、没有不确定装确定。只挑问题，不改文件。',
      '结论写清楚：通过，或不通过并逐条列必须改。',
    ].join('\n')
    const reviewAbort = new AbortController()
    void dispatchTask({
      bot: AUDITOR_ID,
      task: prompt,
      fromTask: entry.taskId,
      review: false,
      __taskId: reviewTaskId,
      __reviewOf: entry.taskId,
      __batch: true,
      dependsOn: [entry.taskId],
      dependsOnMode: 'done',
      chainId: entry.chainId ?? entry.taskId,
    }, { ...exec, signal: reviewAbort.signal }).catch((error) => {
      entry.reviewTaskId = ''
      void persistTasks?.()
      void debug?.({ event: 'review-queue', ok: false, taskId: entry.taskId, error: String(error?.message ?? error) })
    })
  }

  /**
   * 把一件活标成「受阻」：账本留痕，面板能看见为什么没跑。
   * @param taskId - 任务号。
   * @param botId - Bot id。
   * @param parentSession - 父会话。
   * @param brief - 任务单。
   * @param dependsOn - 依赖任务号。
   * @param reason - 阻塞原因。
   */
  function markBlocked(taskId, botId, parentSession, brief, dependsOn, reason, extra = {}) {
    tasks?.set(taskId, {
      taskId,
      bot: botId,
      parentSession,
      startedAt: Date.now(),
      doneAt: Date.now(),
      status: 'blocked',
      dependsOn,
      dependsOnMode: extra.dependsOnMode ?? 'done',
      chainId: extra.chainId ?? taskId,
      blockedBy: reason,
      note: reason,
      brief,
    })
    void persistTasks?.()
    options.api?.broadcast?.({ type: 'tasks' })
    options.api?.broadcast?.({ type: 'task-done', taskId, bot: botId, status: 'blocked', text: reason.slice(0, 600) })
  }

  /**
   * 等依赖都跑完。上游坏掉就立刻返回，不等满超时。
   * @param ids - 依赖任务号。
   * @param signal - 父会话信号。
   * @returns `{ ok, reason? }`。
   */
  async function waitForDependencies(ids, signal, mode = 'done', timeoutMs = 1_800_000) {
    const list = normalizeDependsOn(ids)
    const deadline = Date.now() + Math.max(10_000, Number(timeoutMs) || 0)
    while (list.length > 0) {
      if (signal?.aborted) return { ok: false, reason: '等依赖时父会话被中止' }
      if (Date.now() > deadline) return { ok: false, reason: '等依赖超时' }
      let pending = false
      for (const id of list) {
        const entry = tasks?.get(id)
        const state = dependencyState(entry, mode)
        if (state === 'missing') return { ok: false, reason: `依赖任务不存在：${id}` }
        if (state === 'bad') {
          const status = String(entry?.status ?? '')
          return { ok: false, reason: `上游 ${id} ${status === 'rejected' ? '被打回' : `状态是 ${status}`}` }
        }
        if (state === 'pending') pending = true
      }
      if (!pending) return { ok: true }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { ok: true }
  }

  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({})
  const maxConcurrent = () => Number(getSettings()?.maxConcurrent ?? 2)
  const taskTimeoutMs = () => Number(getSettings()?.taskTimeoutSec ?? 600) * 1000

  /**
   * 批量/计划工具接受 JSON 字符串或数组。
   * @param raw - 工具参数里的 tasks。
   * @returns 任务数组；解析失败返回空数组。
   */
  function parseTaskList(raw) {
    if (Array.isArray(raw)) return raw
    const text = String(raw ?? '').trim()
    if (text === '') return []
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 粗估一件活的时间与 token（经验值，用来做计划，不是承诺）。 */
  const SIZE_ESTIMATE = {
    quick: { sec: 90, tokens: 150_000 },
    normal: { sec: 180, tokens: 400_000 },
    complex: { sec: 300, tokens: 900_000 },
  }

  /**
   * @param item - 任务项（可带 size）。
   * @returns `{ size, sec, tokens }`。
   */
  function estimateOf(item) {
    const size = SIZE_ESTIMATE[String(item?.size ?? 'normal')] ? String(item?.size ?? 'normal') : 'normal'
    return { size, ...SIZE_ESTIMATE[size] }
  }

  /**
   * 这次晋升的感言：人设里写了就抄原文，没写就用固定一句。不叫模型。
   * @param botId - bot id。
   * @param toRank - 这次升到的段位，用来挑人设里的哪一条感言。
   * @returns 感言正文（不为空）。
   */
  async function resolveSpeech(botId, toRank = 1) {
    try {
      const soul = await readFile(join(root, 'bots', botId, 'memory', 'soul.txt'), 'utf8')
      const text = extractPersonaSpeech(soul, toRank)
      if (text !== '') return text
    } catch {
      // 读不到人设就当没写
    }
    return DEFAULT_SPEECH
  }

  /**
   * 派一件活。抽成函数是为了让「按原单重派」能复用同一套逻辑。
   * @param args - 任务单参数。
   * @param exec - 工具执行上下文。
   */
  function dependenciesSatisfied(ids, mode = 'done') {
    const list = normalizeDependsOn(ids)
    return list.every((id) => dependencyState(tasks?.get(id), mode) === 'ok')
  }

  /**
   * 验收门不能把秘书的整轮调用卡住：先落一条 queued，后台等上游验收。
   * 上游 accepted 后自动派下去；失败/打回则把这件标 blocked。
   */
  async function deferAccepted(args, exec, bot, taskId, dependsOn, chainId) {
    const parentSession = exec?.agent?.session?.header?.id
    const brief = {
      task: String(args?.task ?? ''),
      goal: args?.goal,
      deliverable: args?.deliverable,
      accept: args?.accept,
      redlines: args?.redlines,
      materials: args?.materials,
      retryNote: String(args?.retryNote ?? '').trim(),
    }
    tasks?.set(taskId, {
      taskId,
      bot: bot.id,
      parentSession,
      startedAt: Date.now(),
      status: 'queued',
      dependsOn,
      dependsOnMode: 'accepted',
      chainId,
      review: wantsReview(bot, args),
      reviewOf: String(args?.__reviewOf ?? '').trim() || null,
      model: typeof bot.model === 'string' ? bot.model : '',
      brief,
    })
    void persistTasks?.()
    options.api?.broadcast?.({ type: 'tasks' })
    const controller = new AbortController()
    const bgExec = { ...exec, signal: controller.signal }
    void (async () => {
      const ready = await waitForDependencies(dependsOn, controller.signal, 'accepted', 24 * 60 * 60 * 1000)
      if (!ready.ok) {
        markBlocked(taskId, bot.id, parentSession, brief, dependsOn, ready.reason, {
          dependsOnMode: 'accepted',
          chainId,
        })
        return
      }
      // 后台接上：不传 __batch，让并发闸正常生效；闸满就等下一轮。
      let started = false
      let lastParsed = null
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const raw = await dispatchTask({
          ...args,
          bot: bot.id,
          __taskId: taskId,
          __fromQueue: true,
          dependsOn,
          dependsOnMode: 'accepted',
          chainId,
        }, bgExec)
        let parsed = null
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
        lastParsed = parsed
        if (parsed?.status === 'queued' && String(parsed?.message ?? '').includes('在跑')) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
        started = true
        break
      }
      // 队列里的任务必须有个结论：并发位等不到/启动直接失败，都不能永远挂在 queued。
      const queuedRow = tasks?.get(taskId)
      if (queuedRow?.status === 'queued') {
        const reason = started
          ? String(lastParsed?.error ?? lastParsed?.message ?? '后台启动失败')
          : '一直没等到并发位，任务没有开始'
        markBlocked(taskId, bot.id, parentSession, brief, dependsOn, reason, {
          dependsOnMode: 'accepted',
          chainId,
        })
      }
    })().catch((error) => {
      markBlocked(taskId, bot.id, parentSession, brief, dependsOn, String(error?.message ?? error), {
        dependsOnMode: 'accepted',
        chainId,
      })
    })
    return {
      status: 'queued',
      bot: bot.id,
      taskId,
      dependsOn,
      dependsOnMode: 'accepted',
      chainId,
      message: '等上游验收通过后自动开始；秘书这轮可以先做别的。',
    }
  }

  async function dispatchTask(args, exec) {

      const botId = String(args?.bot ?? '').trim()
      const task = String(args?.task ?? '').trim()
      if (!botId || !task) {
        return JSON.stringify({ status: 'failed', error: 'bot and task are required' })
      }

      const bot = await readBot(root, botId)
      if (bot.status === 'disabled') {
        return JSON.stringify({ status: 'failed', bot: bot.id, error: `${bot.id} 已停用，先在成员面板里启用它` })
      }

      const handoffNote = String(args?.fromTask ?? '').trim() === ''
        ? ''
        : `\n上一件的产物已复制到 ./from-previous/，可以直接读。`
      // 返工：把上一轮的打回原因直接带进任务单，Bot 不用猜要改什么。
      const retryNote = String(args?.retryNote ?? '').trim()
      const retryBlock = retryNote === '' ? '' : `\n\n上一轮打回原因（必须逐条处理）：\n${retryNote}`
      const auditBlock = bot.id === AUDITOR_ID ? AUDIT_BRIEF : ''
      let mailBlock = ''
      let mailMessages = []
      try {
        mailMessages = await mailbox?.peekForPrompt?.(bot.id, 5) ?? []
        mailBlock = formatMailPrompt(mailMessages)
      } catch (error) {
        await debug?.({ event: 'mailbox-prompt', ok: false, bot: bot.id, error: String(error?.message ?? error) })
      }
      // 只有任务真正启动后才标已读；拼任务单时只观察。
      const markPromptMailRead = async () => {
        if (mailMessages.length === 0) return
        try {
          await mailbox?.markRead?.(bot.id, mailMessages.map((message) => message.id))
        } catch (error) {
          await debug?.({ event: 'mailbox-mark-read', ok: false, bot: bot.id, error: String(error?.message ?? error) })
        }
      }
      const brief = buildTaskPrompt({ ...args, task }) + handoffNote + retryBlock + auditBlock + mailBlock
      if (!brief) {
        return JSON.stringify({ status: 'failed', error: '任务单是空的' })
      }
      // 同一件成果的后续改动（改、补、优化）：回原会话，不新开。
      // 判断标准是「和上一件成果有没有关系」，由秘书在派单时用 continueFrom 指定。
      const continueFrom = String(args?.continueFrom ?? '').trim()
      if (continueFrom !== '') {
        const previous = tasks?.get(continueFrom)
        if (!previous) {
          return JSON.stringify({ status: 'failed', error: `continueFrom 找不到这条任务：${continueFrom}` })
        }
        if (previous.bot !== bot.id) {
          return JSON.stringify({
            status: 'failed',
            error: `这件活是 ${previous.bot} 的，不能换人续；让 ${previous.bot} 改，或者当成新活新开会话。`,
          })
        }
        const prompt = [
          '接着上一件成果继续做（同一件活，不换会话）：',
          '',
          brief,
          '',
          '沿用你这个目录里已有的文件改，不要重开一份；改完写清楚改了哪几处。',
        ].join('\n')
        const continued = await continueTask(previous, {
          prompt,
          brief: {
            task,
            goal: args?.goal,
            deliverable: args?.deliverable,
            accept: args?.accept,
            redlines: args?.redlines,
            materials: args?.materials,
          },
        }, exec)
        if (continued && continued.status !== 'failed') {
          await markPromptMailRead()
          return JSON.stringify(continued)
        }
        if (continued) {
          await debug?.({ event: 'continue-fallback', from: continueFrom, error: continued.error })
        }
        // 接不上原会话（旧任务没存回复、会话没了）：退回新开会话，任务本身不丢。
      }
      // 并行/带依赖的批量会预分配任务号，好在依赖里互相引用。
      const suppliedTaskId = String(args?.__taskId ?? '').trim()
      const fromQueue = args?.__fromQueue === true
      if (suppliedTaskId !== '' && tasks?.has(suppliedTaskId) && !fromQueue) {
        return JSON.stringify({ status: 'failed', error: `任务号已存在：${suppliedTaskId}` })
      }
      const taskId = suppliedTaskId || newTaskId()
      const parentSessionForLimit = exec?.agent?.session?.header?.id
      const dependsOn = normalizeDependsOn(args?.dependsOn)
      const dependsOnMode = normalizeDependsOnMode(args?.dependsOnMode)
      // 一条链共用根任务号；下游继承上游的链，整链取消时一次收干净。
      const chainId =
        String(args?.chainId ?? '').trim() ||
        (dependsOn.length > 0 ? String(tasks?.get(dependsOn[0])?.chainId ?? dependsOn[0]) : taskId)
      if (dependsOn.length > 0 && !fromQueue) {
        // 验收门不能阻塞整轮：上游还没验收就先排队，后台等 accepted 再自动派。
        if (dependsOnMode === 'accepted' && !dependenciesSatisfied(dependsOn, 'accepted')) {
          return JSON.stringify(await deferAccepted(args, exec, bot, taskId, dependsOn, chainId))
        }
        const queuedBrief = {
          task,
          goal: args?.goal,
          deliverable: args?.deliverable,
          accept: args?.accept,
          redlines: args?.redlines,
          materials: args?.materials,
          retryNote,
        }
        tasks?.set(taskId, {
          taskId,
          bot: bot.id,
          parentSession: parentSessionForLimit,
          startedAt: Date.now(),
          status: 'queued',
          dependsOn,
          dependsOnMode,
          chainId,
          review: wantsReview(bot, args),
          reviewOf: String(args?.__reviewOf ?? '').trim() || null,
          model: typeof bot.model === 'string' ? bot.model : '',
          brief: queuedBrief,
        })
        void persistTasks?.()
        options.api?.broadcast?.({ type: 'tasks' })
        const waitMs = Number(args?.dependsOnTimeoutSec ?? 1800) * 1000
        const ready = await waitForDependencies(dependsOn, exec?.signal, dependsOnMode, waitMs)
        if (!ready.ok) {
          markBlocked(taskId, bot.id, parentSessionForLimit, queuedBrief, dependsOn, ready.reason, {
            dependsOnMode,
            chainId,
          })
          return JSON.stringify({
            status: 'blocked',
            bot: bot.id,
            taskId,
            dependsOn,
            dependsOnMode,
            chainId,
            message: `依赖没满足：${ready.reason}`,
          })
        }
      }
      // 后台从队列接手时，先确认这件还在排队；取消/已被别的循环接走就不能再启动。
      if (fromQueue) {
        const existing = tasks?.get(taskId)
        if (existing?.status === 'cancelled') {
          return JSON.stringify({ status: 'cancelled', bot: bot.id, taskId, message: '任务已取消，不再启动' })
        }
        if (!existing || existing.status !== 'queued') {
          return JSON.stringify({
            status: 'failed',
            bot: bot.id,
            taskId,
            error: `任务 ${taskId} 不在排队状态（${existing?.status ?? '不存在'}），不能从队列启动`,
          })
        }
      }
      const limit = maxConcurrent()
      const gate = canStartTask(tasks, parentSessionForLimit, limit)
      // 批量派活自己按并发上限分批，不再逐件过这个闸。
      if (!gate.ok && args?.__batch !== true) {
        return JSON.stringify({
          status: 'queued',
          bot: bot.id,
          taskId,
          message: `这个会话还有 ${gate.active} 件在跑（上限 ${limit}），等一件回来再派。`,
        })
      }
      const taskDir = join(root, '.team-work', bot.id, taskId)
      await mkdir(taskDir, { recursive: true })

      // 交接：把上一件的产物复制进新任务目录，Bot 直接就能读。
      const fromTask = String(args?.fromTask ?? '').trim()
      if (fromTask !== '') {
        const previous = tasks?.get(fromTask)
        if (previous?.cwd) {
          try {
            const { cp, readdir } = await import('node:fs/promises')
            const inbox = join(taskDir, 'from-previous')
            await mkdir(inbox, { recursive: true })
            for (const name of await readdir(previous.cwd)) {
              if (name === 'from-previous') continue
              await cp(join(previous.cwd, name), join(inbox, name), { recursive: true })
            }
            await debug?.({ event: 'handoff', fromTask, toTask: taskId })
          } catch (error) {
            await debug?.({ event: 'handoff-failed', fromTask, error: String(error?.message ?? error) })
          }
        }
      }

      const childId = `session-${randomUUID()}`
      // The listener below decorates this child when it is announced.
      pending.set(childId, { bot, taskDir })
      const parentSession = exec?.agent?.session?.header?.id
      tasks?.set(taskId, {
        taskId,
        bot: bot.id,
        parentSession,
        cwd: taskDir,
        startedAt: Date.now(),
        status: 'running',
        dependsOn,
        dependsOnMode,
        chainId,
        review: wantsReview(bot, args),
        reviewOf: String(args?.__reviewOf ?? '').trim() || null,
        // 面板要能看出这次实际用的是哪个模型（空 = 跟随默认）。
        model: typeof bot.model === 'string' ? bot.model : '',
        brief: {
          task,
          goal: args?.goal,
          deliverable: args?.deliverable,
          accept: args?.accept,
          redlines: args?.redlines,
          materials: args?.materials,
          retryNote,
        },
      })
      void persistTasks?.()
      options.api?.broadcast?.({ type: 'tasks' })

      let started
      // 这一轮最后回的话：返工时用它判断是不是新回复，也留在账本里。
      let finalText = ''
      // 提到外面：失败重试时要复用同一张启动参数。
      let activation
      let startChild
      let retryCount = 0
      try {
        activation = {
          provider: 'spawn',
          // 子智能体列表里显示这一行：先认人（Bot 名字），再看是哪件活。
          label: `${bot.name ?? bot.id}：任务 ${taskId}`,
          name: `${bot.id}-${taskId}`.slice(0, 32),
          childId,
          cwd: taskDir,
          prompt: [{ type: 'text', text: brief }],
          parent: exec.agent,
          signal: exec.signal,
          delivery: 'caller',
        }
        // 首跑与重试共用同一套启动参数：名册里指定了模型就带上，
        // 失败时退回默认模型，别让派活整体失败。重试也必须带模型，
        // 否则同一件活两次跑的不是同一个模型。
        startChild = async () => {
          // 重试不能再占原名字：子会话名在 DSH 里必须唯一。
          const name = `${bot.id}-${taskId}${retryCount > 0 ? `-r${retryCount}` : ''}`.slice(0, 32)
          if (typeof bot.model === 'string' && bot.model !== '') {
            try {
              return await subagents.startActivation({ ...activation, name, agentOptions: { model: bot.model } })
            } catch (error) {
              await debug?.({ event: 'model-override-failed', bot: bot.id, model: bot.model, error: String(error?.message ?? error) })
            }
          }
          return subagents.startActivation({ ...activation, name })
        }
        started = await startChild()
        await markPromptMailRead()
      } catch (error) {
        pending.delete(childId)
        running.delete(taskId)
        const failed = tasks?.get(taskId)
        if (failed) {
          failed.status = 'failed'
          failed.doneAt = Date.now()
          failed.note = String(error?.message ?? error)
        }
        void persistTasks?.()
        options.api?.broadcast?.({ type: 'tasks' })
        await debug?.({ event: 'dispatch', ok: false, error: String(error?.message ?? error) })
        return JSON.stringify({ status: 'failed', bot: bot.id, taskId, error: String(error?.message ?? error) })
      }

      const ledger = tasks?.get(taskId)
      if (ledger) ledger.sessionId = started.childId ?? childId
      void persistTasks?.()
      await debug?.({ event: 'dispatch', ok: true, child: started.childId ?? childId, name: started.name })
      running.set(taskId, started)
      const stallWatch = startStallWatch(started.childId ?? childId, {
        warnMs: Number(getSettings()?.stallWarnSec ?? 180) * 1000,
        askMs: Number(getSettings()?.stallHardSec ?? 300) * 1000,
        graceMs: Number(getSettings()?.stallGraceSec ?? 120) * 1000,
        maxNormal: 10,
        signal: exec.signal,
        nudge: async (text) => {
          try {
            await subagents.sendMessage(exec.agent, started.childId ?? childId, [{ type: 'text', text }], { signal: exec.signal })
            await debug?.({ event: 'nudge', taskId, reason: text.slice(0, 60) })
          } catch (error) {
            await debug?.({ event: 'nudge', taskId, ok: false, error: String(error?.message ?? error) })
          }
        },
        cancel: async () => {
          const id = started.childId ?? childId
          // 用 interrupt 而不是 agent.cancel：前者保留未领取的 inbox，
          // 停止当前 turn 后还能在同一会话里接话，不会冷恢复出新 chat 子会话。
          if (typeof subagents.interrupt === 'function') {
            await subagents.interrupt(id, { kind: 'ancestor', agent: exec.agent })
          } else {
            const agent = liveChildren.get(id) ?? agents?.get?.(id) ?? null
            await agent?.cancel?.({ kind: 'parent' })
          }
          await debug?.({ event: 'cancel', taskId, reason: '两次询问无答复且日志无增长' })
        },
      })
      /**
       * 静默重跑一次：同一份启动参数、新开一个子会话。
       * 只把「真有文字回来」算成功，避免把空回复当成完成。
       * @param reason - 日志里的原因：timeout / error。
       * @returns `{ ok, text, childId }`。
       */
      const retryOnce = async (reason) => {
        try {
          await debug?.({ event: 'retry', taskId, bot: bot.id, reason })
          retryCount += 1
          const again = await startChild()
          let timer
          const settled = await Promise.race([
            again.result,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve('timeout'), taskTimeoutMs())
            }),
          ])
          clearTimeout(timer)
          const text = settled && settled !== 'timeout' ? blocksToText(settled.output) : ''
          if (text === '') {
            await again.dispose?.()
            await debug?.({ event: 'retry', taskId, ok: false, reason: `${reason}-again` })
            return { ok: false }
          }
          const entry = tasks?.get(taskId)
          if (entry) {
            entry.sessionId = again.childId ?? entry.sessionId
            entry.retried = (Number(entry.retried) || 0) + 1
            entry.status = 'running'
            delete entry.note
          }
          void persistTasks?.()
          options.api?.broadcast?.({ type: 'tasks' })
          await debug?.({ event: 'retry', taskId, ok: true, bytes: text.length })
          return { ok: true, text, childId: again.childId ?? childId }
        } catch (error) {
          await debug?.({ event: 'retry', taskId, ok: false, error: String(error?.message ?? error) })
          return { ok: false }
        }
      }
      // 被安排干活了 → 进这个会话的行动组（干完也留着）。
      try {
        await options.api?.addToAction?.(parentSessionForLimit, bot.id)
      } catch {
        // 入组失败不影响派活
      }

      try {
        // `result` settles after the child's teardown; `output` is its final
        // assistant text, so the tool can return the answer synchronously.
        let timeoutTimer
        const result = await Promise.race([
          started.result,
          stallWatch.promise,
          new Promise((resolve) => {
            timeoutTimer = setTimeout(() => resolve('timeout'), taskTimeoutMs())
          }),
        ])
        // 定时器不清掉会把进程拖住（测试和 Node 退出都会被它挂住）。
        clearTimeout(timeoutTimer)
        const cancelledAt = stallWatch.cancelledAt
        stallWatch.stop()
        if (result === 'stalled' || result === 'loop' || result === 'needs-decision') {
          if (result !== 'needs-decision') {
            try {
              await started.dispose?.()
            } catch {
              // Best effort：孩子可能还在后台，父会话不能继续挂着。
            }
          }
          const stalled = tasks?.get(taskId)
          if (stalled) {
            stalled.status = result === 'needs-decision' ? 'needs-decision' : 'timeout'
            stalled.doneAt = Date.now()
            stalled.note =
              result === 'loop'
                ? '子会话在原地打转（同一工具、同一组参数反复调用），已提前结束'
                : result === 'needs-decision'
                  ? '连续追问 10 次都回答「正常，还在等」，停在这里，等你判断'
                  : '问了「是不是卡住了」，宽限内没有回答也没有新动作，判定卡住；没等满超时'
          }
          void persistTasks?.()
          options.api?.broadcast?.({ type: 'tasks' })
          if (stalled) {
            options.api?.broadcast?.({
              type: 'task-done',
              taskId,
              bot: bot.id,
              status: stalled.status,
              text: String(stalled.note ?? '').slice(0, 600),
            })
          }
          await debug?.({ event: result, taskId, bot: bot.id })
          return JSON.stringify({
            status: result === 'needs-decision' ? 'needs-decision' : 'timeout',
            bot: bot.id,
            taskId,
            sessionId: started.childId ?? childId,
            message:
              result === 'loop'
                ? '子会话在原地打转（同一个工具、同一组参数反复调用），已提前结束；让它换个做法再来。'
                : result === 'needs-decision'
                  ? '连续追问 10 次都回答「正常，还在等」，按规矩停在这里，请你判断是继续等还是换做法。'
                  : '问了「是不是卡住了」，宽限内没有回答也没有新动作，判定卡住，已提前结束；它可能还在后台跑，先别急着重派。',
          })
        }
        if (result === 'timeout') {
          try {
            await started.dispose?.()
          } catch {
            // Best effort: a stuck child must not keep the tool open.
          }
          await debug?.({ event: 'timeout', taskId, bot: bot.id })
          {
            const timedOut = tasks?.get(taskId)
            if (timedOut) {
              timedOut.status = 'timeout'
              timedOut.doneAt = Date.now()
              timedOut.note = `超过 ${Math.round(taskTimeoutMs() / 1000)} 秒没回来`
            }
            void persistTasks?.()
            options.api?.broadcast?.({ type: 'tasks' })
          }
          // 技术性失败先自动重试一次：同一张单、新子会话。
          {
            const retried = await retryOnce('timeout')
            if (retried.ok) {
              finalText = retried.text
              return JSON.stringify({
                status: 'ready',
                bot: bot.id,
                taskId,
                sessionId: retried.childId,
                cwd: taskDir,
                output: retried.text,
                relay: memberRelay(bot, 'ready', taskId, retried.text),
                retried: 1,
              })
            }
          }
          return JSON.stringify({
            status: 'timeout',
            bot: bot.id,
            taskId,
            sessionId: started.childId ?? childId,
            message: `超过 ${Math.round(taskTimeoutMs() / 1000)} 秒没回来，已自动重试一次（合计约 ${Math.round((taskTimeoutMs() * 2) / 1000)} 秒），还是没结果；可以让它拆小，或者换人。`,
          })
        }
        let text = result ? blocksToText(result.output) : ''
        if (text === '' && cancelledAt) {
          // cancel 会把当前 turn 直接结束，先等它把「断点在哪」写回来，别交一张空卡。
          const sid = started.childId ?? childId
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            const reply = await readSessionAssistantSince(sid, cancelledAt)
            if (reply !== '') {
              text = reply
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          const row = tasks?.get(taskId)
          if (row) {
            if (text !== '') {
              row.status = 'ready'
              row.doneAt = Date.now()
              row.output = text
              row.note = '监考停掉卡住的动作后，Bot 报告了断点并继续'
            } else {
              row.status = 'timeout'
              row.doneAt = Date.now()
              row.note = '已停掉卡住的动作，但没等到它回话'
            }
          }
        }
        finalText = text
        options.api?.broadcast?.({ type: 'tasks' })
        await debug?.({ event: 'result', ok: Boolean(result), bytes: text.length })
        return JSON.stringify({
          status: text ? 'ready' : 'empty',
          bot: bot.id,
          taskId,
          sessionId: started.childId ?? childId,
          cwd: taskDir,
          output: text,
          relay: memberRelay(bot, 'ready', taskId, text),
        })
      } catch (error) {
        await debug?.({ event: 'result', ok: false, error: String(error?.message ?? error) })
        // 技术性失败（网络 / 起不了子会话）再试一次；内容问题不重试。
        if (activation && isTechnicalFailure(error)) {
          const retried = await retryOnce('error')
          if (retried.ok) {
            finalText = retried.text
            return JSON.stringify({
              status: 'ready',
              bot: bot.id,
              taskId,
              sessionId: retried.childId,
              cwd: taskDir,
              output: retried.text,
              relay: memberRelay(bot, 'ready', taskId, retried.text),
              retried: 1,
            })
          }
        }
        const failedEntry = tasks?.get(taskId)
        if (failedEntry) {
          failedEntry.status = 'failed'
          failedEntry.doneAt = Date.now()
          failedEntry.note = String(error?.message ?? error)
        }
        void persistTasks?.()
        options.api?.broadcast?.({ type: 'tasks' })
        return JSON.stringify({
          status: 'failed',
          bot: bot.id,
          taskId,
          dependsOn,
          sessionId: started.childId ?? childId,
          cwd: taskDir,
          error: String(error?.message ?? error),
        })
      } finally {
        pending.delete(childId)
        running.delete(taskId)
        const entry = tasks?.get(taskId)
        if (entry) {
          // 真实 token：子会话这一趟跑掉的全部 usage，结算时一次性领走。
          const usage = usageBook?.take?.(started?.childId ?? childId)
          if (usage) entry.tokens = usage
        }
        // 只把「还在跑」的行收成 ready：失败 / 超时 / 取消已经写过自己的状态，别覆盖。
        if (entry && (!entry.status || entry.status === 'running')) {
          entry.doneAt = Date.now()
          entry.status = 'ready'
        } else if (entry && !entry.doneAt) {
          entry.doneAt = Date.now()
        }
        // 留下这一轮的回复：返工续聊时用来判断「这是不是新回复」。
        if (entry && finalText !== '') entry.output = finalText.slice(0, 4000)
        void persistTasks?.()
        // 干完就推一张实时卡片：不等秘书收尾再贴。
        if (entry?.status === 'ready') void maybeQueueReview(entry, exec)
        if (entry) {
          options.api?.broadcast?.({
            type: 'task-done',
            taskId,
            bot: bot.id,
            status: entry.status,
            text: String(entry.output ?? entry.note ?? '').slice(0, 600),
          })
        }
      }
      }

  /**
   * 同一件成果的后续改动，走原会话：把新指令发回原来的子会话，等它出新回复。
   *
   * 两种入口共用：返工（带打回意见）和「接着改」（同一件成果的优化/补充）。
   * 为什么能续：DSH 的 `subagents.sendMessage` 会把消息投进目标的持久会话，
   * 目标不在就按需唤醒；会话恢复时会走 `agent/created`，人设和能力卡会重新挂上。
   * 返回 null 表示「这件没有可续的会话」，交给调用方退回新开会话。
   *
   * @param entry - 上一件任务。
   * @param request - `{ prompt, brief, retried }`：发出去的指令、账本任务单、是否返工。
   * @param exec - 工具执行上下文。
   */
  async function continueTask(entry, request, exec) {
    const prompt = String(request?.prompt ?? '').trim()
    const brief = request?.brief ?? entry?.brief ?? null
    const sessionId = String(entry?.sessionId ?? '').trim()
    const baseline = String(entry?.output ?? '')
    if (prompt === '' || !brief?.task) return null
    if (sessionId === '' || baseline === '') return null
    if (typeof subagents?.sendMessage !== 'function') return null
    const bot = await readBot(root, entry.bot)
    if (bot.status === 'disabled') return { status: 'failed', error: `${bot.id} 已停用，先启用再继续` }
    const taskId = `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const taskDir = entry.cwd || join(root, '.team-work', bot.id, taskId)
    // 恢复出来的新 agent 会盖到 liveChildren 上；先清掉上一轮的旧对象，免得等回复时读错。
    liveChildren.delete(sessionId)
    // 会话会被按需唤醒：先登记装饰信息，agent/created 时照常挂人设与能力卡。
    pending.set(sessionId, { bot, taskDir })
    const continuedAt = Date.now()
    try {
      await subagents.sendMessage(exec.agent, sessionId, [{ type: 'text', text: prompt }], { signal: exec.signal })
    } catch (error) {
      pending.delete(sessionId)
      await debug?.({ event: 'continue-failed', from: entry.taskId, error: String(error?.message ?? error) })
      return { status: 'failed', bot: bot.id, error: `原会话接不上：${String(error?.message ?? error)}` }
    }
    tasks?.set(taskId, {
      taskId,
      bot: bot.id,
      parentSession: entry.parentSession,
      cwd: taskDir,
      startedAt: Date.now(),
      status: 'running',
      sessionId,
      model: entry.model ?? '',
      review: entry.review === true,
      continuesFrom: entry.taskId,
      brief,
    })
    void persistTasks?.()
    options.api?.broadcast?.({ type: 'tasks' })
    await debug?.({ event: 'continue', from: entry.taskId, taskId, sessionId, retried: request?.retried === true })
    let probedAt = 0
    const readContinuedAgent = () => {
      const live = liveChildren.get(sessionId) ?? null
      const registered = agents?.get?.(sessionId) ?? null
      const agent = pickContinueAgent(sessionId, liveChildren, agents)
      if (Date.now() - probedAt >= 5000) {
        probedAt = Date.now()
        void debug?.({
          event: 'continue-wait',
          source: live ? 'live' : registered ? 'registry' : 'none',
          status: agent?.status ?? null,
          bytes: agent ? finalAssistantText(agent.session).length : 0,
        })
      }
      return agent
    }
    const { text, why } = await waitForSessionTurnReply(sessionId, continuedAt, taskTimeoutMs(), {
      baselineText: baseline,
      signal: exec.signal,
      stallWarnMs: Number(getSettings()?.stallWarnSec ?? 180) * 1000,
      stallAskMs: Number(getSettings()?.stallHardSec ?? 300) * 1000,
      stallGraceMs: Number(getSettings()?.stallGraceSec ?? 120) * 1000,
      stallMaxNormal: 10,
      // agent 侧只作兜底：恢复出来的会话有时 status=idle 但 session 里没有任何事件。
      readFallback: () => {
        const agent = readContinuedAgent()
        return agent ? finalAssistantText(agent.session) : ''
      },
      // 卡住时从父会话发一条提醒，不额外开子会话；发不出去也不影响等待。
      nudge: async (text) => {
        try {
          await subagents.sendMessage(exec.agent, sessionId, [{ type: 'text', text }], { signal: exec.signal })
          await debug?.({ event: 'nudge', taskId, reason: text.slice(0, 60) })
        } catch (error) {
          await debug?.({ event: 'nudge', taskId, ok: false, error: String(error?.message ?? error) })
        }
      },
      cancel: async () => {
        // 同派活：interrupt 保留 inbox，停掉当前 turn 后还能在同一会话里接话。
        if (typeof subagents.interrupt === 'function') {
          await subagents.interrupt(sessionId, { kind: 'ancestor', agent: exec.agent })
        } else {
          const agent = readContinuedAgent()
          await agent?.cancel?.({ kind: 'parent' })
        }
        await debug?.({ event: 'cancel', taskId, reason: '两次询问无答复且日志无增长' })
      },
    })
    pending.delete(sessionId)
    const row = tasks?.get(taskId)
    const usage = usageBook?.take?.(sessionId)
    if (row) {
      row.doneAt = Date.now()
      row.status = why === 'ok' ? 'ready' : why === 'needs-decision' ? 'needs-decision' : 'timeout'
      if (why === 'no-agent') row.note = '子会话没恢复出来（15 秒内没拿到 agent），没空等满超时'
      else if (why === 'stalled') row.note = '问了「是不是卡住了」，宽限内没有回答也没有新动作，判定卡住；没等满超时'
      else if (why === 'needs-decision') row.note = '连续追问 10 次都回答「正常，还在等」，停在这里，等你判断'
      else if (why === 'loop') row.note = '子会话在原地打转（同一工具、同一组参数调用 8 次），已提前结束'
      else if (why === 'timeout') row.note = `续聊超过 ${Math.round(taskTimeoutMs() / 1000)} 秒没回来`
      else if (text !== '') row.output = text.slice(0, 4000)
      if (usage) row.tokens = usage
    }
    void persistTasks?.()
    options.api?.broadcast?.({ type: 'tasks' })
    if (row?.status === 'ready') void maybeQueueReview(row, exec)
    if (row) {
      options.api?.broadcast?.({
        type: 'task-done',
        taskId,
        bot: bot.id,
        status: row.status,
        text: String(row.output ?? row.note ?? '').slice(0, 600),
      })
    }
    if (why !== 'ok') {
      await debug?.({ event: 'continue-failed', taskId, why })
      return {
        status: why === 'needs-decision' ? 'needs-decision' : 'timeout',
        bot: bot.id,
        taskId,
        sessionId,
        cwd: taskDir,
        message:
          why === 'no-agent'
            ? '原会话没恢复出来，续聊没发出去'
            : why === 'stalled'
              ? '问了「是不是卡住了」，宽限内没有回答也没有新动作，判定卡住；它可能还在后台跑，先别急着重派。'
              : why === 'needs-decision'
                ? '连续追问 10 次都回答「正常，还在等」，按规矩停在这里，请你判断是继续等还是换做法。'
                : why === 'loop'
                  ? '子会话在原地打转（同一个工具、同一组参数反复调用），已提前结束；让它换个做法再来。'
                  : '原会话续聊超时，没等到新回复',
      }
    }
    return {
      status: 'ready',
      bot: bot.id,
      taskId,
      sessionId,
      cwd: taskDir,
      output: text,
      relay: memberRelay(bot, 'ready', taskId, text),
      continued: true,
      continuesFrom: entry.taskId,
      ...(request?.retried === true ? { retriedFrom: entry.taskId } : {}),
    }
  }

  /**
   * 按原任务单重派：优先在原会话里返工；接不上才新开一个会话。
   * @param entry - 原任务。
   * @param note - 这次要改什么。
   * @param exec - 工具执行上下文。
   * @returns 工具结果的 JSON 字符串。
   */
  async function retryTask(entry, note, exec) {
    const prompt = [
      '继续这件活（返工，不换会话）：',
      '',
      '上一轮打回原因（逐条处理）：',
      note,
      '',
      `任务单：${entry?.brief?.task ?? ''}`,
      '沿用你这个目录里已有的文件改，不要重开一份；改完写清楚改了哪几处。',
    ].join('\n')
    const continued = await continueTask(
      entry,
      { prompt, brief: { ...entry.brief, retryNote: note }, retried: true },
      exec,
    )
    if (continued && continued.status !== 'failed') return JSON.stringify(continued)
    if (continued) {
      await debug?.({ event: 'continue-fallback', from: entry.taskId, error: continued.error })
    }
    const raw = await dispatchTask({ ...entry.brief, bot: entry.bot, retryNote: note }, exec)
    try {
      const parsed = JSON.parse(raw)
      parsed.retriedFrom = entry.taskId
      if (continued) parsed.continueError = continued.error
      return JSON.stringify(parsed)
    } catch {
      return raw
    }
  }

  // 成员信箱：Bot 之间直接对齐，不再让所有话都经秘书转。
  const mailboxSend = tools.register({
      name: 'team_send',
      description: '给团队里的另一个 Bot 发一条持久消息。不能发给自己，也不能发给用户；秘书可以发给 Bot。',
      parameters: {
        to: { type: 'string', required: true, description: '收件 Bot id' },
        body: { type: 'string', required: true, description: '正文' },
        subject: { type: 'string', description: '主题（可省略）' },
        threadId: { type: 'string', description: '回复时带上原 threadId' },
        taskId: { type: 'string', description: '关联任务号（可省略）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      when: mailboxWhen,
      async execute(args, exec) {
        try {
          const from = mailboxIdentity(exec)
          if (!from) return JSON.stringify({ ok: false, error: '当前会话不是团队成员' })
          const to = String(args?.to ?? '').trim()
          if (to === 'secretary' || to === 'user') {
            return JSON.stringify({ ok: false, error: '信箱只收 Bot 之间的消息，不能发给秘书或用户' })
          }
          const recipient = await readRecipient(to)
          if (!recipient) return JSON.stringify({ ok: false, error: `没有这个 Bot，或它已停用：${to}` })
          const result = await mailbox.send({
            from,
            to,
            subject: args?.subject,
            body: args?.body,
            threadId: args?.threadId,
            taskId: args?.taskId,
          })
          return JSON.stringify(result)
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error?.message ?? error) })
        }
      },
    })

  const mailboxInbox = tools.register({
      name: 'team_inbox',
      description: '查看自己的成员信箱；秘书要指定 bot 才能看某个 Bot 的信箱。默认把取到的消息标为已读（秘书查看不算 Bot 已读）。',
      parameters: {
        bot: { type: 'string', description: '秘书查看某个 Bot 时填；Bot 自己调用不用填' },
        unreadOnly: { type: 'boolean', description: '只看未读' },
        limit: { type: 'number', description: '最多几条，默认 20' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      when: mailboxWhen,
      async execute(args, exec) {
        try {
          const identity = mailboxIdentity(exec)
          if (!identity) return JSON.stringify({ ok: false, error: '当前会话不是团队成员' })
          const target = identity === 'secretary' ? String(args?.bot ?? '').trim() : identity
          if (!target) return JSON.stringify({ ok: false, error: '秘书查看信箱要指定 bot' })
          const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20))
          const messages = await mailbox.inbox(target, { unreadOnly: args?.unreadOnly === true, limit })
          if (identity !== 'secretary' && args?.unreadOnly !== true && messages.length > 0) {
            await mailbox.markRead(target, messages.map((row) => row.id))
          }
          const counts = await mailbox.unreadCounts()
          return JSON.stringify({ ok: true, bot: target, messages, unread: Number(counts[target] ?? 0) })
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error?.message ?? error) })
        }
      },
    })

  const mailboxReply = tools.register({
      name: 'team_reply',
      description: '回复一条已有信箱线程。收件人从线程里自动判断，不用手填。',
      parameters: {
        threadId: { type: 'string', required: true, description: '线程号，team_inbox 会带出来' },
        body: { type: 'string', required: true, description: '回复正文' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      when: mailboxWhen,
      async execute(args, exec) {
        try {
          const identity = mailboxIdentity(exec)
          if (!identity) return JSON.stringify({ ok: false, error: '当前会话不是团队成员' })
          const threadId = String(args?.threadId ?? '').trim()
          if (!threadId) return JSON.stringify({ ok: false, error: 'threadId 不能为空' })
          const rows = await mailbox.thread(threadId)
          if (rows.length === 0) return JSON.stringify({ ok: false, error: `没有这个线程：${threadId}` })
          let to = ''
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            const row = rows[i]
            if (row.to === identity) { to = row.from; break }
            if (row.from === identity) { to = row.to; break }
          }
          if (!to || to === identity) return JSON.stringify({ ok: false, error: '线程里找不到可回复的对方' })
          if (to === 'secretary' || to === 'user') {
            return JSON.stringify({ ok: false, error: '不能回复秘书或用户；请把结论写回任务结果' })
          }
          const recipient = await readRecipient(to)
          if (!recipient) return JSON.stringify({ ok: false, error: `对方已不在团队里或已停用：${to}` })
          const source = rows.find((row) => row.to === identity) ?? rows[rows.length - 1]
          const result = await mailbox.send({
            from: identity,
            to,
            subject: source?.subject ? `回复：${source.subject}` : '回复',
            body: args?.body,
            threadId,
            taskId: source?.taskId,
          })
          return JSON.stringify(result)
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error?.message ?? error) })
        }
      },
  })

  // 按原任务单重派：复用 dispatchTask，要求不用再写一遍。
  const teachTools = tools.register(
    {
      name: 'team_teach',
      description: '教某个 Bot 一条以后要记住的规矩：写入它的项目记忆，并给成长经验。同一个标签一周内只算一次。',
      parameters: {
        bot: { type: 'string', required: true, description: 'Bot id' },
        tag: { type: 'string', required: true, description: '主题标签，例如 退线 / 图号' },
        text: { type: 'string', required: true, description: '要它记住的那句话，至少 10 个字' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const botId = String(args?.bot ?? '').trim()
        const tag = String(args?.tag ?? '').trim()
        const text = String(args?.text ?? '').trim()
        const result = await updateGrowth(root, botId, (_bot, state) => {
          const settled = settleTeaching(state, { tag, text })
          return settled.ok
            ? { ok: true, growth: settled.growth, gained: settled.gained, teaches: settled.teaches }
            : settled
        })
        if (!result?.ok) return JSON.stringify(result ?? { ok: false })
        try {
          const file = join(root, 'bots', botId, 'memory', 'project.md')
          await appendFile(file, `[${tag}] ${text}\n`, 'utf8')
          await commitMemory(join(root, 'bots', botId, 'memory'), `teach: [${tag}] ${text.slice(0, 40)}`)
        } catch {
          // 记忆写失败也把经验结果告诉秘书
        }
        options.api?.broadcast?.({ type: 'roster' })
        await debug?.({ event: 'teach', bot: botId, tag, gained: result.gained })
        return JSON.stringify({ ok: true, bot: botId, tag, gained: result.gained, teaches: result.teaches })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const improveTools = tools.register(
    {
      name: 'team_improve',
      description: '确认某个 Bot 把一条教过的规矩守住了，给 +120：要求教下之后又干满 2 件活、期间没复犯，一次教学只能确认一次。',
      parameters: {
        bot: { type: 'string', required: true, description: 'Bot id' },
        tag: { type: 'string', required: true, description: '教过的主题标签，例如 退线' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const botId = String(args?.bot ?? '').trim()
        const tag = String(args?.tag ?? '').trim()
        const result = await confirmImprovement(root, botId, tag)
        if (!result?.ok) return JSON.stringify({ ok: false, error: result?.error ?? '确认失败' })
        try {
          const file = join(root, 'bots', botId, 'memory', 'project.md')
          await appendFile(file, `[守住] ${result.tag}\n`, 'utf8')
          await commitMemory(join(root, 'bots', botId, 'memory'), `improve: [${result.tag}] 守住了`)
        } catch {
          // 记忆写失败不影响经验
        }
        options.api?.broadcast?.({ type: 'roster' })
        await debug?.({ event: 'improve', bot: botId, tag: result.tag, gained: result.gained })
        return JSON.stringify({ ok: true, bot: botId, tag: result.tag, gained: result.gained })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const promoteTools = tools.register(
    {
      name: 'team_promote',
      description: '把 Bot 升一阶：普通满 20 级即可；精英化一阶满 50 级且满足门槛。经验清零，教学与晋升记录保留。晋升后它会按人设写一段感言，用 member 围栏转述给用户。',
      parameters: {
        bot: { type: 'string', required: true, description: 'Bot id' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const botId = String(args?.bot ?? '').trim()
        let known = null
        try {
          const bot = await readBot(root, botId)
          known = { bot, summary: growthSummary(bot.growth) }
        } catch {
          known = null
        }
        const result = await promoteBot(root, botId)
        if (!result?.ok) return JSON.stringify(result ?? { ok: false })
        options.api?.broadcast?.({ type: 'roster' })
        // 晋升已经生效；感言是后话，写不出来也不回滚。
        const after = growthSummary(result.growth)
        const speechText = await resolveSpeech(botId, result.growth.rank)
        const speech = { ok: true, speech: speechText }
        if (speech.ok) await savePromotionSpeech(root, botId, speech.speech)
        await debug?.({ event: 'promote', bot: botId, speech: speech.ok })
        return JSON.stringify({
          ok: true,
          bot: botId,
          rank: result.growth.rank,
          label: after.label,
          speech: speech.ok ? speech.speech : null,
        // 固定文案（没写人设）时面板要让动效至少转一会儿，别一闪而过。
        fixed: !personaSpeech,
          ...(speech.ok
            ? { relay: `这段感言用 member 围栏转述给${address()}：id 用它自己，role 用它职责，status 用 ready，body 放感言原文，不要改写。` }
            : { speechError: speech.error }),
        })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const assignTools = tools.register(
    {
      name: 'team_assign',
      description: '开工前先把这一趟要用的 Bot 拉进这个会话的行动组；没立刻干活的会显示「待命」。',
      parameters: {
        bots: { type: 'string', required: true, description: 'Bot id，逗号分隔，例如 nova,forge' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.header?.id
        if (!sessionId) return JSON.stringify({ ok: false, error: '拿不到当前会话' })
        const ids = String(args?.bots ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
        if (ids.length === 0) return JSON.stringify({ ok: false, error: '至少要给一个 Bot' })
        const done = []
        for (const id of ids) {
          try {
            const bot = await readBot(root, id)
            if (!bot || bot.status === 'disabled') continue
            await options.api?.addToAction?.(sessionId, bot.id)
            done.push(bot.id)
          } catch {
            // 单个失败不拖累其余
          }
        }
        return JSON.stringify({ ok: true, team: done })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const cancelTools = tools.register(
    {
      name: 'team_cancel',
      description: '中止一件正在跑的任务。它不会回结果，账本里记成「已取消」。传 chain=true 会收掉同一条依赖链里所有没结束的任务。',
      parameters: {
        taskId: { type: 'string', required: true, description: '要中止的任务号' },
        chain: { type: 'boolean', description: 'true = 整条依赖链一起中止。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const result =
          args?.chain === true
            ? await options.api?.cancelChain?.(args?.taskId)
            : await options.api?.cancel?.(args?.taskId)
        return JSON.stringify(result ?? { ok: false, error: '取消接口没接上' })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  function parseToolJson(raw) {
    try {
      return JSON.parse(raw)
    } catch {
      return { status: 'failed', error: String(raw) }
    }
  }

  /**
   * 重启恢复：按链恢复排队/中断的任务。
   * - 排队任务：依赖已满足就原地启动，保持原 taskId，下游引用不断。
   * - 中断任务：重派新 taskId，把下游依赖改到新号；旧行标 supersededBy。
   * - 恢复不了的依赖标空，下游受阻，不偷偷跳过。
   */
  async function resumeTasks(args, exec) {
    const one = String(args?.taskId ?? '').trim()
    const chain = String(args?.chainId ?? '').trim()
    const target = one === '' ? null : tasks?.get(one) ?? null
    if (one !== '' && !target) return { status: 'failed', error: '没有这个任务' }
    const scopeChain = chain || target?.chainId || ''
    let rows = [...(tasks?.values?.() ?? [])].filter((row) => {
      if (!row?.restartInterrupted) return false
      if (row?.supersededBy) return false
      if (!['queued', 'interrupted'].includes(row.status)) return false
      if (scopeChain !== '') return row.chainId === scopeChain
      return true
    })
    if (rows.length === 0) return { status: 'failed', error: '没有可恢复的任务' }

    // 先按链内依赖排序；有环就不恢复，宁可报错也不乱跑。
    const selected = new Map(rows.map((row) => [row.taskId, row]))
    const order = []
    const mark = new Map()
    const visit = (id) => {
      if (mark.get(id) === 2) return true
      if (mark.get(id) === 1) return false
      const row = selected.get(id)
      if (!row) return true
      mark.set(id, 1)
      for (const dep of row.dependsOn ?? []) {
        if (selected.has(dep) && !visit(dep)) return false
      }
      mark.set(id, 2)
      order.push(row)
      return true
    }
    for (const row of rows) {
      if (!visit(row.taskId)) return { status: 'failed', error: '链上有循环依赖，不能恢复' }
    }

    const mapping = new Map()
    const results = []
    for (const row of order) {
      const deps = remapDependsOn(row.dependsOn, mapping)
      const states = deps.map((id) => dependencyState(tasks?.get(id), row.dependsOnMode ?? 'done'))
      const firstBad = deps.find((_, index) => states[index] !== 'ok')
      if (row.status === 'queued') {
        if (firstBad) {
          // 上游还没好：留在队列里，等定时恢复再试，不标 blocked。
          mapping.set(row.taskId, row.taskId)
          results.push({ from: row.taskId, status: 'queued', message: `还在等 ${firstBad}` })
          continue
        }
        const brief = row.brief ?? {}
        const raw = await dispatchTask(
          {
            ...brief,
            bot: row.bot,
            dependsOn: deps,
            dependsOnMode: row.dependsOnMode,
            chainId: row.chainId,
            review: row.review === true,
            __taskId: row.taskId,
            __fromQueue: true,
          },
          exec,
        )
        const parsed = parseToolJson(raw)
        if (parsed?.status === 'failed' || parsed?.status === 'blocked') {
          mapping.set(row.taskId, '')
          results.push({ from: row.taskId, status: parsed?.status ?? 'failed', message: parsed?.error ?? parsed?.message })
        } else {
          mapping.set(row.taskId, row.taskId)
          row.restartInterrupted = false
          row.note = '重启恢复：排队任务已启动'
          results.push({ from: row.taskId, to: row.taskId, status: parsed?.status ?? 'running' })
        }
        continue
      }

      if (firstBad) {
        const reason = `恢复中断任务时依赖没满足：${firstBad}`
        markBlocked(row.taskId, row.bot, row.parentSession, row.brief ?? {}, deps, reason, {
          dependsOnMode: row.dependsOnMode,
          chainId: row.chainId,
        })
        mapping.set(row.taskId, '')
        results.push({ from: row.taskId, status: 'blocked', message: reason })
        continue
      }
      const brief = row.brief ?? {}
      const raw = await dispatchTask(
        {
          ...brief,
          bot: row.bot,
          dependsOn: deps,
          dependsOnMode: row.dependsOnMode,
          chainId: row.chainId,
          review: row.review === true,
          retryNote: '进程重启时这件活被中断了。先检查已有产物，从断点继续；不要重复已经做完的步骤。',
        },
        exec,
      )
      const parsed = parseToolJson(raw)
      if (parsed?.status === 'failed' || parsed?.status === 'blocked') {
        mapping.set(row.taskId, '')
        results.push({ from: row.taskId, status: parsed?.status ?? 'failed', message: parsed?.error ?? parsed?.message })
      } else {
        const next = String(parsed?.taskId ?? '').trim()
        mapping.set(row.taskId, next)
        row.supersededBy = next
        row.note = `重启后已恢复为 ${next || '未知'}`
        if (next !== '') {
          const fresh = tasks?.get(next)
          if (fresh) fresh.continuesFrom = row.taskId
        }
        results.push({ from: row.taskId, to: next, status: parsed?.status ?? 'running' })
      }
    }

    // 没启动的排队任务，把依赖改到映射后的新号；映射为空则保留原号，等下一次恢复。
    for (const row of rows) {
      if (row.status !== 'queued') continue
      if (!mapping.has(row.taskId)) continue
      const next = remapDependsOn(row.dependsOn, mapping)
      row.dependsOn = next
    }
    void persistTasks?.()
    options.api?.broadcast?.({ type: 'tasks' })
    await debug?.({ event: 'resume-restart', count: results.length, results })
    return { status: 'done', count: results.length, results }
  }

  const resumeTools = tools.register(
    {
      name: 'team_resume',
      description: '重启后恢复整链：排队任务原地启动，中断任务重派并把下游依赖改到新任务号。可指定 taskId 或 chainId。',
      parameters: {
        taskId: { type: 'string', description: '只恢复这个任务所在的链；不填则恢复全部可恢复任务。' },
        chainId: { type: 'string', description: '只恢复这条链。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const result = await resumeTasks(args, exec)
        return JSON.stringify(result)
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const retryTools = tools.register(
    {
      name: 'team_retry',
      description: '按原任务单重派一件活。被打回或者明确要重做时用，省得把要求再写一遍。会把上一轮的验收意见/审计意见一起带进新任务单。',
      parameters: {
        taskId: { type: 'string', required: true, description: '要重派的任务号' },
        note: { type: 'string', description: '这次要改什么；不填就用这条任务上次的验收意见' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const taskId = String(args?.taskId ?? '').trim()
        const entry = tasks?.get(taskId)
        if (!entry) return JSON.stringify({ status: 'failed', error: `没有这个任务：${taskId}` })
        if (!entry.brief?.task) return JSON.stringify({ status: 'failed', error: '这件任务没有留下任务单，没法重派' })
        // 返工必须带上原因：显式给的优先，否则用上次验收写的那条。
        const note = String(args?.note ?? '').trim() || String(entry.note ?? '').trim()
        await debug?.({ event: 'retry', taskId, bot: entry.bot, hasNote: note !== '' })
        return retryTask(entry, note, exec)
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const disposeDispatch = tools.register(
    {
      name: 'team_dispatch',
    description:
      '把一件活派给团队里的某个 Bot。Bot 在自己的任务会话里干活（只能写工作区，写不出去），干完返回结论。同一件成果的修改 / 补充 / 优化，用 continueFrom 接回原会话；和上一件无关的新活不要填，直接新开。',
    parameters: {
      bot: { type: 'string', required: true, description: 'Bot 的 id，例如 nova' },
      task: { type: 'string', required: true, description: '任务单正文（一句话说清要干什么）' },
      goal: { type: 'string', description: '目标：这件事要达成什么' },
      deliverable: { type: 'string', description: '交付物：交什么、交到哪、什么格式' },
      accept: { type: 'string', description: '验收标准：我按什么判断算过' },
      redlines: { type: 'string', description: '红线：绝对不许做的事' },
      materials: { type: 'string', description: '材料：它能读哪些文件或目录' },
      fromTask: { type: 'string', description: '交接：上一件任务号，把它的产物复制到新任务目录再开干' },
      continueFrom: { type: 'string', description: '同一件成果的后续改动（改 / 补 / 优化）：填上一件任务号，回原会话继续，不新开。和上一件无关的新活不要填。' },
      dependsOn: { type: 'string', description: '依赖：JSON 数组或逗号分隔的任务号。上游默认跑完（ready）就放行；写 dependsOnMode=accepted 则必须验收通过。上游失败/打回就直接判 blocked，不 spawn。' },
      dependsOnMode: { type: 'string', description: 'done（默认，上游跑完就放行）或 accepted（上游验收通过才放行）。' },
      dependsOnTimeoutSec: { type: 'number', description: '等依赖的最长秒数，默认 1800；超时则 blocked。' },
      review: { type: 'boolean', description: '是否强制审计：默认有 deliverable 就 true；显式 false 可跳过。审计员的活不审。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: dispatchTask,
    },
    {
      // Only a team lead (a root session with the switch on) may dispatch.
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  // The gate: a bot stops at "ready"; the secretary inspects the artifact and
  // records accepted or rejected. Nothing else may flip that verdict.
  const disposeBatch = tools.register(
    {
      name: 'team_dispatch_many',
      description:
        '一次派多件活，可声明依赖。带 dependsOn 的项等上游跑完再开；同一批里可以用 key 给任务起别名，dependsOn 直接写 key。互不依赖的项并行，最多按并发上限；某件失败/打回，它下游会标 blocked，不会 spawn。',
      parameters: {
        tasks: {
          type: 'string',
          required: true,
          description: 'JSON 数组，每项字段同 team_dispatch，可另加 key（批内别名）、dependsOn（任务号或批内 key 数组）、dependsOnMode（done/accepted）。',
        },
        chainTimeoutSec: { type: 'number', description: '整条依赖链的最长秒数；超时后还没开始的任务标 blocked。默认不设。' },
        dependsOnMode: { type: 'string', description: '整批默认的依赖放行模式：done（跑完就放行）或 accepted（验收通过才放行）。每项可单独覆盖。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const items = parseTaskList(args?.tasks)
        if (items.length === 0) {
          return JSON.stringify({ status: 'failed', error: 'tasks 要是非空 JSON 数组，每项至少 {bot, task}' })
        }
        const bad = items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => String(item?.bot ?? '').trim() === '' || String(item?.task ?? '').trim() === '')
        if (bad.length > 0) {
          return JSON.stringify({
            status: 'failed',
            error: `第 ${bad.map(({ index }) => index + 1).join('、')} 项缺 bot 或 task`,
          })
        }
        // 同一件成果只能续一路：两路同时改一个会话会互相踩。
        const continuations = items
          .map((item) => String(item?.continueFrom ?? '').trim())
          .filter((id) => id !== '')
        if (new Set(continuations).size !== continuations.length) {
          return JSON.stringify({
            status: 'failed',
            error: '同一件成果不能在批量里派两路；继续改请单独派一件。',
          })
        }
        const limit = Math.max(1, Math.min(8, maxConcurrent()))
        const startedAt = Date.now()
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const usedIds = new Set(tasks?.keys?.() ?? [])
        const freshId = () => {
          let id = newTaskId()
          while (usedIds.has(id)) id = newTaskId()
          usedIds.add(id)
          return id
        }
        const prepared = items.map((item, index) => ({
          item,
          index,
          taskId: freshId(),
          key: String(item?.key ?? '').trim(),
          mode: normalizeDependsOnMode(item?.dependsOnMode ?? args?.dependsOnMode),
        }))
        const aliases = new Map()
        for (const row of prepared) {
          if (row.key !== '') {
            if (aliases.has(row.key)) {
              return JSON.stringify({ status: 'failed', error: `批量里 key 重复：${row.key}` })
            }
            aliases.set(row.key, row.taskId)
          }
          aliases.set(row.taskId, row.taskId)
        }
        const resolved = new Map()
        for (const row of prepared) {
          const ids = []
          for (const dep of normalizeDependsOn(row.item?.dependsOn)) {
            const hit = aliases.get(dep)
            if (hit) {
              ids.push(hit)
            } else if (tasks?.has(dep)) {
              ids.push(dep)
            } else {
              return JSON.stringify({ status: 'failed', error: `第 ${row.index + 1} 项的依赖找不到：${dep}` })
            }
          }
          if (ids.includes(row.taskId)) {
            return JSON.stringify({ status: 'failed', error: `第 ${row.index + 1} 项不能依赖自己` })
          }
          resolved.set(row.taskId, ids)
        }
        const internal = new Set(prepared.map((row) => row.taskId))
        const chainIds = new Map()
        const chainIdOf = (id, seen = new Set()) => {
          if (seen.has(id)) return id
          seen.add(id)
          const row = prepared.find((item) => item.taskId === id)
          const own = String(row?.item?.chainId ?? '').trim()
          if (own !== '') return own
          const deps = resolved.get(id) ?? []
          for (const dep of deps) {
            if (internal.has(dep)) {
              const inherited = chainIdOf(dep, seen)
              if (inherited) return inherited
            } else {
              const inherited = tasks?.get(dep)?.chainId
              if (inherited) return String(inherited)
            }
          }
          return deps[0] || id
        }
        for (const row of prepared) {
          chainIds.set(row.taskId, chainIdOf(row.taskId))
        }
        // 成环检查：只算同一批内部的边；外部任务号不参与拓扑。
        const indegree = new Map(prepared.map((row) => [row.taskId, 0]))
        const outgoing = new Map(prepared.map((row) => [row.taskId, []]))
        for (const row of prepared) {
          for (const dep of resolved.get(row.taskId)) {
            if (!internal.has(dep)) continue
            indegree.set(row.taskId, indegree.get(row.taskId) + 1)
            outgoing.get(dep).push(row.taskId)
          }
        }
        const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id)
        let seen = 0
        while (queue.length > 0) {
          const id = queue.shift()
          seen += 1
          for (const next of outgoing.get(id)) {
            indegree.set(next, indegree.get(next) - 1)
            if (indegree.get(next) === 0) queue.push(next)
          }
        }
        if (seen !== internal.size) {
          return JSON.stringify({ status: 'failed', error: '这批任务的 dependsOn 成环了，先理清先后顺序。' })
        }
        const results = new Array(items.length)
        const pending = new Map(prepared.map((row) => [row.taskId, row]))
        const active = new Map()
        let externalDeadline = 0
        const chainTimeoutSec = Number(args?.chainTimeoutSec ?? 0)
        const chainDeadline = chainTimeoutSec > 0 ? startedAt + chainTimeoutSec * 1000 : 0
        const block = (row, reason) => {
          const deps = resolved.get(row.taskId)
          tasks?.set(row.taskId, {
            taskId: row.taskId,
            bot: row.item.bot,
            parentSession: exec?.agent?.session?.header?.id,
            startedAt: Date.now(),
            doneAt: Date.now(),
            status: 'blocked',
            dependsOn: deps,
            dependsOnMode: row.mode,
            chainId: chainIds.get(row.taskId),
            blockedBy: reason,
            note: reason,
            brief: { task: String(row.item?.task ?? '') },
          })
          results[row.index] = {
            status: 'blocked',
            bot: row.item.bot,
            taskId: row.taskId,
            dependsOn: deps,
            dependsOnMode: row.mode,
            chainId: chainIds.get(row.taskId),
            message: `依赖没满足：${reason}`,
          }
        }
        while (pending.size > 0 || active.size > 0) {
          if (chainDeadline > 0 && Date.now() > chainDeadline && pending.size > 0) {
            for (const row of [...pending.values()]) {
              block(row, `整链超过 ${chainTimeoutSec} 秒，剩下的任务没有开始`)
            }
            pending.clear()
          }
          for (const row of [...pending.values()]) {
            if (active.size >= limit) break
            const states = resolved.get(row.taskId).map((dep) => {
              const entry = tasks?.get(dep)
              // 同一批里还没轮到的任务：账本里暂时没有行，不能算「找不到」。
              if (internal.has(dep) && (!entry || entry.status === 'queued')) {
                return { dep, state: 'pending' }
              }
              return { dep, state: dependencyState(entry, row.mode) }
            })
            const bad = states.find((item) => item.state === 'bad' || item.state === 'missing')
            if (bad) {
              block(row, bad.state === 'missing' ? `找不到 ${bad.dep}` : `上游 ${bad.dep} 状态是 ${tasks?.get(bad.dep)?.status ?? '失败'}`)
              pending.delete(row.taskId)
              continue
            }
            // 验收门：上游跑完但还没验收，继续等；这不是失败，不要阻塞。
            if (states.some((item) => item.state === 'pending')) {
              // 批内上游还没落账本时先别 defer：等它先开始，下一轮再交后台等验收。
              const depsExist = resolved.get(row.taskId).every((dep) => tasks?.has(dep))
              if (row.mode === 'accepted' && depsExist) {
                // 批量调用同样不能被验收门卡住：先回 queued，后台等验收后自动派。
                pending.delete(row.taskId)
                results[row.index] = await deferAccepted(
                  { ...row.item, task: String(row.item?.task ?? '') },
                  exec,
                  { id: row.item.bot, model: row.item.model },
                  row.taskId,
                  resolved.get(row.taskId),
                  chainIds.get(row.taskId),
                )
              }
              continue
            }
            pending.delete(row.taskId)
            const promise = (async () => {
              try {
                const raw = await dispatchTask({
                  ...row.item,
                  __taskId: row.taskId,
                  __batch: true,
                  dependsOn: resolved.get(row.taskId),
                  dependsOnMode: row.mode,
                  chainId: chainIds.get(row.taskId),
                }, exec)
                try {
                  const parsed = JSON.parse(raw)
                  return {
                    ...parsed,
                    dependsOn: resolved.get(row.taskId),
                    dependsOnMode: row.mode,
                    chainId: chainIds.get(row.taskId),
                  }
                } catch {
                  return {
                    status: 'failed',
                    bot: row.item.bot,
                    taskId: row.taskId,
                    dependsOn: resolved.get(row.taskId),
                    dependsOnMode: row.mode,
                    chainId: chainIds.get(row.taskId),
                    output: String(raw),
                  }
                }
              } catch (error) {
                return {
                  status: 'failed',
                  bot: row.item.bot,
                  taskId: row.taskId,
                  dependsOn: resolved.get(row.taskId),
                  dependsOnMode: row.mode,
                  chainId: chainIds.get(row.taskId),
                  error: String(error?.message ?? error),
                }
              }
            })()
            active.set(row.taskId, { row, promise })
          }
          if (active.size === 0) {
            if (pending.size === 0) break
            // 只剩外部依赖还在跑：等一会儿；超时就整批标受阻，不无限挂住。
            if (externalDeadline === 0) externalDeadline = Date.now() + Math.max(60_000, taskTimeoutMs() * 2)
            if (Date.now() > externalDeadline) {
              for (const row of pending.values()) block(row, '等外部依赖超时')
              pending.clear()
              break
            }
            await sleep(500)
            continue
          }
          const settled = await Promise.race(
            [...active.entries()].map(([id, item]) => item.promise.then((result) => ({ id, result }))),
          )
          active.delete(settled.id)
          const row = prepared.find((item) => item.taskId === settled.id)
          results[row.index] = settled.result
          pending.delete(settled.id)
        }
        void persistTasks?.()
        options.api?.broadcast?.({ type: 'tasks' })
        return JSON.stringify({
          status: 'done',
          count: results.length,
          elapsedMs: Date.now() - startedAt,
          results,
        })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  // 先出计划再派活：不 spawn、不花 token，只把任务单和预算摆出来给用户过目。
  const disposePlan = tools.register(
    {
      name: 'team_plan',
      description:
        '不派活，只出计划：把要交给哪些 Bot、任务单、预计耗时与 token 摆出来，方便先给用户过目。确认后再用 team_dispatch 或 team_dispatch_many。可带 dependsOn，计划里会标出等待关系。',
      parameters: {
        tasks: {
          type: 'string',
          required: true,
          description: 'JSON 数组，字段同 team_dispatch，可加 size（quick / normal / complex）与 dependsOn 用来估时',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const items = parseTaskList(args?.tasks)
        if (items.length === 0) {
          return JSON.stringify({ ok: false, error: 'tasks 要是非空 JSON 数组' })
        }
        let bots = []
        try {
          bots = await loadBots(root)
        } catch {
          bots = []
        }
        const byId = new Map(bots.map((bot) => [bot.id, bot]))
        const plan = items.map((item) => {
          const id = String(item?.bot ?? '').trim()
          const bot = byId.get(id)
          const estimate = estimateOf(item)
          return {
            bot: id,
            name: bot?.name ?? id,
            role: bot?.role ?? '',
            key: String(item?.key ?? ''),
            dependsOn: normalizeDependsOn(item?.dependsOn),
            model: typeof bot?.model === 'string' && bot.model !== '' ? bot.model : '默认',
            available: bot ? bot.status !== 'disabled' : false,
            task: String(item?.task ?? ''),
            size: estimate.size,
            estimateSec: estimate.sec,
            estimateTokens: estimate.tokens,
            brief: bot ? buildTaskPrompt({ ...item, task: String(item?.task ?? '') }) : '',
          }
        })
        const limit = Math.max(1, Math.min(8, maxConcurrent()))
        const waves = Math.ceil(plan.length / limit)
        const serialSec = plan.reduce((sum, row) => sum + row.estimateSec, 0)
        const wallSec = plan.length === 0 ? 0 : waves * Math.max(...plan.map((row) => row.estimateSec))
        return JSON.stringify({
          ok: true,
          plan,
          parallel: limit,
          waves,
          estimate: {
            tokens: plan.reduce((sum, row) => sum + row.estimateTokens, 0),
            serialSec,
            wallSec,
          },
          note: '估算是经验值，不是承诺；确认后再用 team_dispatch 或 team_dispatch_many。',
        })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  // The gate: a bot stops at "ready"; the secretary inspects the artifact and
  // records accepted or rejected. Nothing else may flip that verdict.
  const disposeReview = tools.register(
    {
      name: 'team_review',
      description:
        '验收一件已完成的活。先自己去看产物或结论（不要只看 Bot 的描述），再记通过或打回。通过必须给评分；打回必须写清哪一条不过。普通交付可以不派审计；只有打 excellent 才必须先派审计员只读复核，并把审计任务号填进 auditTaskId（审计员被删了就不需要）。同一件活只能验收一次，改判用 team_user_feedback。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务号，例如 t-mwm8ljoo' },
        verdict: { type: 'string', required: true, description: 'accepted 或 rejected' },
        note: { type: 'string', description: '打回时的理由；通过时可以不写' },
        evidence: { type: 'string', description: '核对的依据：看了哪个文件、哪一页、哪一段' },
        grade: {
          type: 'string',
          required: true,
          description: '评分，通过时必填：excellent（全对且超出交代）/ good（全对，能直接用）/ pass（能用但有小毛病）/ poor（要返工）',
        },
        auditTaskId: { type: 'string', description: '要打 excellent 时必填：审计员那次只读复核的任务号' },
        size: { type: 'string', description: '任务规模：quick / normal / complex；默认 normal' },
        repeatOf: { type: 'string', description: '打回时如果又是教过的老毛病，填那个 tag，会扣经验' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const taskId = String(args?.taskId ?? '').trim()
        const verdict = String(args?.verdict ?? '').trim()
        const note = String(args?.note ?? '').trim()
        const evidence = String(args?.evidence ?? '').trim()
        const entry = tasks?.get(taskId)
        if (!entry) return JSON.stringify({ ok: false, error: `没有这个任务：${taskId}` })
        // 一件活只结算一次：重复 review 会重复加经验。改判走 team_user_feedback。
        if (entry.verdict === 'accepted' || entry.verdict === 'rejected') {
          return JSON.stringify({
            ok: false,
            error: `这件已经验收过了（${entry.verdict}，已结算经验）。要改判请用 team_user_feedback，它会按新评分回滚；不要重复 review。`,
          })
        }
        if (verdict !== 'accepted' && verdict !== 'rejected') {
          return JSON.stringify({ ok: false, error: 'verdict 只能是 accepted 或 rejected' })
        }
        // 有交付物的活必须先过审计：这是流程，不靠秘书自觉。
        if (verdict === 'accepted' && entry.review === true && entry.bot !== AUDITOR_ID) {
          const auditorThere = (await loadBots(root)).some((bot) => bot.id === AUDITOR_ID && bot.status !== 'disabled')
          if (auditorThere) {
            const audits = [...tasks.values()].filter((row) => row.reviewOf === entry.taskId)
            const passed = audits.find((row) => row.status === 'accepted' || row.verdict === 'accepted')
            if (!passed) {
              const pending = audits.find((row) => ['queued', 'running', 'ready'].includes(row.status))
              return JSON.stringify({
                ok: false,
                error: pending
                  ? `这件活需要先审计：审计任务 ${pending.taskId} 还没验收通过（${pending.status}）。先审它，再回来验这件。`
                  : `这件活需要先审计：审计任务还没建好或已被打回。等审计员接单，或让审计员重审后再验收。`,
                code: 'review-required',
              })
            }
            entry.auditTaskId = passed.taskId
          }
        }
        if (verdict === 'rejected' && note === '') {
          return JSON.stringify({ ok: false, error: '打回必须写清哪一条不过' })
        }
        // 通过必须给评分：不给评分就没有经验、也不进好评率，等于这次活白干。
        const gradeInput = String(args?.grade ?? '').trim()
        if (verdict === 'accepted' && !['excellent', 'good', 'pass', 'poor'].includes(gradeInput)) {
          return JSON.stringify({
            ok: false,
            error: '通过必须填 grade：excellent / good / pass / poor（不填就不结算经验，也不算好评率）',
          })
        }
        // excellent 是唯一会把好评率抬起来的一档：必须有审计记录才准给。
        // 审计员不在了（用户删了）就放行——那时候没有第二双眼睛，只能靠我自己核。
        if (verdict === 'accepted' && gradeInput === 'excellent') {
          const auditorThere = (await loadBots(root)).some((bot) => bot.id === AUDITOR_ID && bot.status !== 'disabled')
          if (auditorThere) {
            const auditTaskId = String(args?.auditTaskId ?? entry.auditTaskId ?? '').trim()
            if (auditTaskId === '') {
              return JSON.stringify({
                ok: false,
                error: `要打 excellent 必须先派 ${AUDITOR_ID} 只读审一遍，并把那个审计任务号填进 auditTaskId`,
              })
            }
            const audit = tasks?.get(auditTaskId)
            if (!audit) return JSON.stringify({ ok: false, error: `没有这个审计任务：${auditTaskId}` })
            if (audit.bot !== AUDITOR_ID) {
              return JSON.stringify({ ok: false, error: `${auditTaskId} 不是审计员的活（是 ${audit.bot}）` })
            }
            if (audit.status === 'running' || audit.status === 'queued') {
              return JSON.stringify({ ok: false, error: '审计还没跑完，等它出结论再打分' })
            }
            entry.auditTaskId = auditTaskId
          }
        }
        entry.status = verdict
        entry.verdict = verdict
        // 记下秘书打的评分：用户以后改判要按它扣回旧样本。
        if (verdict === 'accepted') entry.grade = gradeInput
        options.api?.broadcast?.({ type: 'tasks' })
        entry.reviewedAt = Date.now()
        entry.note = note
        if (evidence !== '') entry.evidence = evidence

        // 成长结算：通过按评分给经验，打回命中老毛病就扣。
        let growthNote = null
        if (verdict === 'accepted') {
          const day = new Date().toDateString()
          const nthToday = [...tasks.values()]
            .filter((row) => row.bot === entry.bot && row.growthDay === day)
            .length + 1
          const result = await updateGrowth(root, entry.bot, (_bot, state) => {
            const settled = settleTask(state, {
              size: String(args?.size ?? 'normal'),
              grade: String(args?.grade ?? 'pass'),
              nthToday,
            })
            return {
              ok: true,
              growth: settled.growth,
              gained: settled.gained,
              levelBefore: settled.levelBefore,
              levelAfter: settled.levelAfter,
              // 记下结算参数：用户改判时要按同一组参数重算这一件的经验。
              streakBefore: state.streak,
            }
          })
          if (result?.ok) {
            entry.growthDay = day
            entry.growthGain = result.gained
            entry.growthContext = {
              size: String(args?.size ?? 'normal'),
              nthToday,
              streak: Number(result.streakBefore) || 0,
            }
            growthNote = { gained: result.gained, levelBefore: result.levelBefore, levelAfter: result.levelAfter }
            options.api?.broadcast?.({ type: 'roster' })
          }
        } else {
          const repeatOf = String(args?.repeatOf ?? '').trim()
          if (repeatOf !== '') {
            const result = await updateGrowth(root, entry.bot, (_bot, state) => {
              const settled = settleRepeat(state, { tag: repeatOf })
              return settled.ok
                ? { ok: true, growth: settled.growth, lost: settled.lost }
                : settled
            })
            if (result?.ok) {
              entry.growthLost = result.lost
              growthNote = { lost: result.lost }
              options.api?.broadcast?.({ type: 'roster' })
            }
          }
        }

        void persistTasks?.()
        await debug?.({ event: 'review', taskId, verdict, note, growth: growthNote })
        return JSON.stringify({ ok: true, taskId, verdict, bot: entry.bot, growth: growthNote })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const feedbackTools = tools.register(
    {
      name: 'team_user_feedback',
      description:
        '用户对交付物的反应就是验收。用户挑错、说漏了、说老毛病又犯 → 记 rejected；用户说不错 → 记 excellent。用户的原话照抄进 note。同一个任务只记一次，改主意就再记一次覆盖。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务号' },
        signal: {
          type: 'string',
          required: true,
          description: 'praise（说不错）/ fix（要改）/ miss（漏了东西）/ repeat（老毛病又犯）',
        },
        note: { type: 'string', required: true, description: '用户的原话，照抄，不要改写' },
        repeatTag: { type: 'string', description: 'signal=repeat 时填犯的是哪条教过的规矩（tag）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const taskId = String(args?.taskId ?? '').trim()
        const signal = String(args?.signal ?? '').trim()
        const note = String(args?.note ?? '').trim()
        const entry = tasks?.get(taskId)
        if (!entry) return JSON.stringify({ ok: false, error: `没有这个任务：${taskId}` })
        if (!['praise', 'fix', 'miss', 'repeat'].includes(signal)) {
          return JSON.stringify({ ok: false, error: 'signal 只能是 praise / fix / miss / repeat' })
        }
        if (note === '') return JSON.stringify({ ok: false, error: 'note 要抄用户的原话' })

        // 用户口径换算成评分：夸 = 优秀，其余三种 = 差。
        const grade = signal === 'praise' ? 'excellent' : 'poor'
        const previousGrade = typeof entry.grade === 'string' ? entry.grade : null
        entry.userSignal = signal
        entry.userNote = note
        entry.userFedAt = Date.now()
        entry.verdict = grade === 'excellent' ? 'accepted' : 'rejected'
        // 状态与判定必须同步，否则看板显示 accepted、判定却是 rejected。
        entry.status = entry.verdict
        entry.grade = grade
        entry.reviewedAt = Date.now()

        let growthNote = null
        // 改判要把这一件的经验一起改掉：按结算时记下的参数重算，补差额。
        const context = entry.growthContext
        const oldGain = Number(entry.growthGain)
        let nextGain = null
        if (context && Number.isFinite(oldGain)) {
          nextGain = taskGain({ size: context.size, grade, streak: context.streak, nthToday: context.nthToday })
        }
        const result = await updateGrowth(root, entry.bot, (_bot, state) => {
          const regraded = regrade(state, { from: previousGrade, to: grade })
          let next = regraded.growth
          if (nextGain !== null) {
            next = { ...next, totalXp: Math.max(0, next.totalXp + (nextGain - oldGain)) }
          }
          return { ok: true, growth: next, changed: regraded.changed || nextGain !== null }
        })
        if (result?.ok) {
          if (nextGain !== null) entry.growthGain = nextGain
          growthNote = { grade, changed: result.changed === true, gained: nextGain }
        }

        // 用户说「老毛病又犯」时，如果给了 tag，按复犯扣分。
        let repeatNote = null
        const repeatTag = String(args?.repeatTag ?? '').trim()
        if (signal === 'repeat' && repeatTag !== '') {
          const repeat = await updateGrowth(root, entry.bot, (_bot, state) => {
            const settled = settleRepeat(state, { tag: repeatTag })
            return settled.ok ? { ok: true, growth: settled.growth, lost: settled.lost } : settled
          })
          if (repeat?.ok) repeatNote = { lost: repeat.lost }
        }

        options.api?.broadcast?.({ type: 'tasks' })
        options.api?.broadcast?.({ type: 'roster' })
        void persistTasks?.()
        await debug?.({ event: 'user-feedback', taskId, bot: entry.bot, signal, grade })
        return JSON.stringify({ ok: true, taskId, bot: entry.bot, signal, grade, growth: growthNote, repeat: repeatNote })
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const healthTools = tools.register(
    {
      name: 'team_health',
      description: '看一眼团队状态：有几件在跑、几件等你验收、有没有卡住的。拿不准要不要派活、或者觉得哪里不对时先调它。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(_args, exec) {
        const sessionId = exec?.agent?.session?.header?.id ?? ''
        return JSON.stringify(summarizeTasks(tasks ?? new Map(), sessionId))
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  const deliverableTools = tools.register(
    {
      name: 'team_collect',
      description:
        '把某个任务目录里的产物收进正式交付目录。Bot 写的草稿在它自己的任务目录里，这一步才是「交出去」。同名目录不会覆盖：会自动收进 `<名字>-2`、`<名字>-3`，返回实际路径。收完把路径告诉用户。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务号，例如 t-mwm8ljoo' },
        into: { type: 'string', description: '交付目录下的子目录名，一般是事由，例如「2026-11 报建审查」' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const taskId = String(args?.taskId ?? '').trim()
        const entry = tasks?.get(taskId)
        if (!entry) return JSON.stringify({ ok: false, error: `没有这个任务：${taskId}` })
        if (!entry.cwd) return JSON.stringify({ ok: false, error: '这个任务没有记录目录' })
        const result = await collectTask({
          taskDir: entry.cwd,
          deliverableRoot: typeof options.getDeliverableRoot === 'function' ? options.getDeliverableRoot() : options.deliverableRoot,
          into: String(args?.into ?? taskId),
        })
        await debug?.({ event: 'collect', taskId, ok: result.ok, files: result.files?.length ?? 0, renamed: result.renamed === true })
        return JSON.stringify(result)
      },
    },
    {
      when: ({ agent }) => {
        const header = agent?.session?.header
        if (!header || header.parentSession) return false
        return isTeamSession ? isTeamSession(header.id) : false
      },
    },
  )

  // 面板上的「重试」按钮走这里：拿到原会话的 live agent 再派一次。
  if (options.api && typeof options.api === 'object') {
    options.api.cancel = async (taskId) => {
      const id = String(taskId ?? '').trim()
      const entry = tasks?.get(id)
      if (!entry) return { ok: false, error: '没有这个任务' }
      if (entry.doneAt) return { ok: false, error: '这件已经结束了' }
      const handle = running.get(id)
      entry.status = 'cancelled'
      entry.doneAt = Date.now()
      entry.note = entry.note || '手动中止'
      running.delete(id)
      void persistTasks?.()
      try {
        await handle?.dispose?.()
      } catch {
        // 句柄可能已经自己结束了
      }
      options.api?.broadcast?.({ type: 'tasks' })
      await debug?.({ event: 'cancel', taskId: id, bot: entry.bot, hadHandle: handle !== undefined })
      return { ok: true, taskId: id, status: 'cancelled' }
    }
    // 整链中止：同 chainId 里还没结束的任务一起收掉；正在跑的子会话尽力停。
    options.api.cancelChain = async (taskId) => {
      const id = String(taskId ?? '').trim()
      const entry = tasks?.get(id)
      if (!entry) return { ok: false, error: '没有这个任务' }
      const chainId = String(entry.chainId ?? entry.taskId)
      const rows = [...(tasks?.values?.() ?? [])].filter((row) => {
        if (String(row?.chainId ?? row?.taskId) !== chainId) return false
        if (row?.doneAt) return false
        // ready 是已经交活、等你验收的结果，不该被「整链取消」抹掉。
        return ['queued', 'running'].includes(String(row?.status ?? ''))
      })
      if (rows.length === 0) return { ok: false, error: '这条链没有在跑的任务' }
      const cancelled = []
      for (const row of rows) {
        row.status = 'cancelled'
        row.doneAt = Date.now()
        row.note = row.note || '整链中止'
        const handle = running.get(row.taskId)
        running.delete(row.taskId)
        cancelled.push(row.taskId)
        try {
          await handle?.dispose?.()
        } catch {
          // 忽略已结束的句柄
        }
      }
      void persistTasks?.()
      options.api?.broadcast?.({ type: 'tasks' })
      await debug?.({ event: 'cancel-chain', taskId: id, chainId, cancelled })
      return { ok: true, taskId: id, chainId, cancelled }
    }
    // 面板上的「晋升」：条件由 growth 判定，够格就升一阶、经验清零；
    // 升完让它在秘书会话下写一段感言，面板弹卡片。
    options.api.promote = async (input) => {
      const botId = String(typeof input === 'string' ? input : (input?.botId ?? input?.bot ?? '')).trim()
      const parentSession = String(typeof input === 'string' ? '' : (input?.parentSession ?? '')).trim()
      let known = null
      try {
        const bot = await readBot(root, botId)
        known = { bot, summary: growthSummary(bot.growth) }
      } catch {
        known = null
      }
      const result = await promoteBot(root, botId)
      if (!result?.ok) return result ?? { ok: false, error: '晋升失败' }
      options.api?.broadcast?.({ type: 'roster' })
      const after = growthSummary(result.growth)
      let parentAgent = null
      if (parentSession !== '') {
        try {
          parentAgent = agents?.get?.(parentSession) ?? null
        } catch {
          parentAgent = null
        }
      }
      // 感言：人设里写了就抄原文，没写用固定一句；这一步不会失败，也不叫模型。
      const speech = { ok: true, speech: await resolveSpeech(botId, result.growth.rank) }
      if (speech.ok) await savePromotionSpeech(root, botId, speech.speech)
      await debug?.({ event: 'promote', bot: botId, via: 'panel', speech: speech.ok })
      return {
        ok: true,
        bot: botId,
        rank: result.growth.rank,
        label: after.label,
        speech: speech.ok ? speech.speech : null,
        ...(speech.ok ? {} : { speechError: speech.error }),
      }
    }

    // 面板任务详情里的「导出记录」：写一份 Markdown 到交付目录，返回绝对路径。
    options.api.exportTask = async (taskId) => {
      const id = String(taskId ?? '').trim()
      const entry = tasks?.get(id)
      if (!entry) return { ok: false, error: `没有这个任务：${id}` }
      let botName = entry.bot
      try {
        const bot = await readBot(root, entry.bot)
        botName = bot.name ?? bot.id
      } catch {
        // 读不到定义就用 id
      }
      const files = []
      if (entry.cwd) {
        try {
          for (const dirent of await readdir(entry.cwd, { withFileTypes: true })) {
            if (dirent.name === 'from-previous') continue
            let size = 0
            if (!dirent.isDirectory()) {
              try {
                size = (await stat(join(entry.cwd, dirent.name))).size
              } catch {
                // 读不到大小就不写
              }
            }
            files.push({ name: dirent.isDirectory() ? `${dirent.name}/` : dirent.name, size })
          }
        } catch {
          // 目录被清过：只导出账本
        }
      }
      const markdown = buildTaskRecord(entry, { botName, files, now: Date.now() })
      const base = typeof options.getDeliverableRoot === 'function' ? options.getDeliverableRoot() : options.deliverableRoot
      const outDir = join(base, '任务记录')
      await mkdir(outDir, { recursive: true })
      const file = join(outDir, `${id}.md`)
      await writeFile(file, markdown, 'utf8')
      await debug?.({ event: 'task-export', taskId: id, ok: true, chars: markdown.length })
      return { ok: true, taskId: id, path: file, chars: markdown.length }
    }

    // 面板档案里的「确认守住」：教下之后干满 2 件活、期间没复犯，才给 +120。
    options.api.improve = async (input) => {
      const botId = String(typeof input === 'string' ? input : (input?.botId ?? input?.bot ?? '')).trim()
      const tag = String(typeof input === 'string' ? '' : (input?.tag ?? '')).trim()
      const result = await confirmImprovement(root, botId, tag)
      // 失败只回原因，别把整段成长状态塞回页面。
      if (!result?.ok) return { ok: false, error: result?.error ?? '确认失败' }
      options.api?.broadcast?.({ type: 'roster' })
      await debug?.({ event: 'improve', bot: botId, tag: result.tag, gained: result.gained, via: 'panel' })
      return { ok: true, bot: botId, tag: result.tag, gained: result.gained }
    }

    // 面板上的「成长档案」：只读，取评分样本、教学记录和带感言的晋升历史。
    options.api.botGrowth = async (botId) => {
      const id = String(botId ?? '').trim()
      if (id === '') return { ok: false, error: '缺少 bot id' }
      let bot
      try {
        bot = await readBot(root, id)
      } catch {
        return { ok: false, error: `找不到 ${id}` }
      }
      const detail = growthDetail(bot.growth)
      return {
        ok: true,
        bot: {
          id: bot.id,
          name: bot.name ?? bot.id,
          role: bot.role ?? '',
          note: bot.note ?? '',
          stars: Number(bot.stars) || 0,
        },
        ...detail,
      }
    }

    // 给没有会话的 Bot 开一个单聊：起个子会话，让它只问一句好，然后等你说话。
    options.api.openChat = async ({ botId, parentSession }) => {
      const bot = await readBot(root, String(botId ?? '').trim())
      if (!bot) return { ok: false, error: '没有这个 Bot' }
      if (bot.status === 'disabled') return { ok: false, error: '这个 Bot 已停用' }
      const parent = String(parentSession ?? '').trim()
      const parentAgent = parent === '' ? null : agents?.get?.(parent)
      if (!parentAgent) return { ok: false, error: '拿不到当前会话' }
      const childId = `session-${randomUUID()}`
      const dir = join(root, '.team-work', bot.id, `chat-${Date.now().toString(36)}`)
      await mkdir(dir, { recursive: true })
      pending.set(childId, { bot, taskDir: dir })
      const prompt = `主动打开这个会话想和你说话，不是派任务：不要调用任何工具，不要写文件，也不要给自己派活。只回一句「在」，然后等${address()}开口。`
      const base = {
        provider: 'spawn',
        label: `单聊 ${bot.name ?? bot.id}`,
        // 名字必须唯一，否则同名子会话会被拒。
        name: `${bot.id}-chat-${Date.now().toString(36)}`.slice(0, 40),
        childId,
        cwd: dir,
        prompt: [{ type: 'text', text: prompt }],
        parent: parentAgent,
        signal: new AbortController().signal,
        delivery: 'caller',
      }
      try {
        const started = typeof bot.model === 'string' && bot.model !== ''
          ? await subagents.startActivation({ ...base, agentOptions: { model: bot.model } }).catch(() => subagents.startActivation(base))
          : await subagents.startActivation(base)
        // 不等它说完：会话一建好就把 id 交给面板去打开。
        Promise.resolve(started?.result).catch(() => {})
        // 记一条「单聊」，下次点卡片直接复用这个会话。
        const chatId = `c-open-${Date.now().toString(36)}`
        tasks.set(chatId, {
          taskId: chatId,
          bot: bot.id,
          parentSession: parent,
          cwd: dir,
          startedAt: Date.now(),
          // 这是「入口标记」，不是在跑的活：立刻收尾，免得名册一直显示忙。
          doneAt: Date.now(),
          status: 'chat',
          sessionId: childId,
          note: '单聊入口',
        })
        void persistTasks?.()
        options.api?.broadcast?.({ type: 'tasks' })
        await debug?.({ event: 'chat-open', bot: bot.id, sessionId: childId })
        // 父会话 id 一起回去：面板拿到就能直接开出「子会话」标签，
        // 不用等名册刷新（等那一下，用户第一次点必然失败）。
        // identity 也一起回去：面板拿它先写进头像映射，第一帧就不会顶着主会话的头像。
        // 字段跟 `/dsh-team/identity-map` 那份保持一致，改的时候两边一起改。
        const identity = {
          id: bot.id,
          name: bot.name ?? bot.id,
          src: `/dsh-team/avatar?bot=${encodeURIComponent(bot.id)}&v=3`,
          onOpen: true,
          speech: false,
        }
        return { ok: true, sessionId: childId, parentSessionId: parent, identity, bot: bot.id }
      } catch (error) {
        pending.delete(childId)
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    options.api.retry = async (taskId) => {
      const entry = tasks?.get(String(taskId ?? '').trim())
      if (!entry) return { ok: false, error: '没有这个任务' }
      if (!entry.brief?.task) return { ok: false, error: '这件任务没有留下任务单' }
      if (!entry.parentSession) return { ok: false, error: '这个任务没有记录父会话' }
      let parent
      try {
        parent = agents?.get?.(entry.parentSession)
      } catch {
        parent = undefined
      }
      if (!parent) return { ok: false, error: '父会话不在线，重试需要秘书在场' }
      await debug?.({ event: 'retry-http', taskId, bot: entry.bot })
      // HTTP 路由没有工具调用的 signal，自己造一个，避免 startActivation 里读到 undefined。
      const controller = new AbortController()
      const raw = await retryTask(
        entry,
        String(entry.note ?? ''),
        { agent: parent, signal: controller.signal },
      )
      try {
        return JSON.parse(raw)
      } catch {
        return { ok: false, error: String(raw) }
      }
    }

    options.api.resume = async ({ taskId, chainId } = {}) => {
      const id = String(taskId ?? '').trim()
      const chain = String(chainId ?? '').trim()
      const ref = id === '' ? null : tasks?.get(id) ?? null
      const scope = chain || ref?.chainId || ''
      const candidates = [...(tasks?.values?.() ?? [])].filter((row) => {
        if (scope !== '') return row.chainId === scope
        return row.taskId === id
      })
      let parent = null
      for (const row of candidates) {
        if (!row?.parentSession) continue
        try {
          parent = agents?.get?.(row.parentSession) ?? null
        } catch {
          parent = null
        }
        if (parent) break
      }
      if (!parent) return { ok: false, error: '父会话不在线，恢复需要秘书在场' }
      await debug?.({ event: 'resume-http', taskId: id, chainId: scope })
      const controller = new AbortController()
      return resumeTasks({ taskId: id, chainId: scope }, { agent: parent, signal: controller.signal })
    }

    // 排队任务自动恢复：进程重启后，等父会话重新上线，再原地启动。
    // 运行中的任务不自动续跑，交给「恢复整链」按钮，避免重复副作用。
    let autoResuming = false
    let autoResumeTimer = null
    const autoResumeQueued = async () => {
      if (autoResuming) return
      autoResuming = true
      try {
        for (const row of [...(tasks?.values?.() ?? [])]) {
          if (row.status !== 'queued' || !row.restartInterrupted || row.supersededBy) continue
          if (!row.parentSession) continue
          let parent = null
          try {
            parent = agents?.get?.(row.parentSession) ?? null
          } catch {
            parent = null
          }
          if (!parent) continue
          if (typeof isTeamSession === 'function' && !isTeamSession(row.parentSession)) continue
          await resumeTasks(
            { taskId: row.taskId, chainId: row.chainId },
            { agent: parent, signal: new AbortController().signal },
          )
        }
      } finally {
        autoResuming = false
      }
    }
    const firstAuto = setTimeout(autoResumeQueued, 2000)
    firstAuto.unref?.()
    autoResumeTimer = setInterval(autoResumeQueued, 15000)
    autoResumeTimer.unref?.()
  }

  return () => {
    disposeDispatch()
    disposeBatch()
    disposePlan()
    disposeReview()
    mailboxSend()
    mailboxInbox()
    mailboxReply()
    retryTools()
    cancelTools()
    assignTools()
    teachTools()
    improveTools()
    promoteTools()
    deliverableTools()
    healthTools()
    feedbackTools()
  }
}

/**
 * Capture what a team child says when the user chats with it directly.
 *
 * Dispatch children already write their own ledger row, so they are skipped.
 * The text comes from the assistant stream; if the event shape changes the
 * capture silently produces nothing rather than breaking the session.
 *
 * @param options - agent, roster hit and the ledger plumbing.
 */
function armChatCapture({ agent, hit, bot, tasks, persistTasks, broadcast, debug, usageBook }) {
  if (!agent?.ctx?.on || !tasks) return
  if (hit?.kind === 'dispatch') return // 派活子会话由 dispatch 自己记账

  let text = ''
  let startedAt = Date.now()
  let turns = 0
  let timer = null

  // 事件形状：{ agent, frame }；frame.type 为 chunk 时带 chunk.text
  const pickDelta = (event) => {
    const frame = event?.frame ?? event
    if (frame?.type !== 'chunk') return ''
    const chunk = frame.chunk ?? frame
    // 只收正文；reasoning-delta 是它的思考过程，不进账本。
    if (chunk?.type !== undefined && chunk.type !== 'text-delta') return ''
    const piece = chunk?.text ?? chunk?.content ?? chunk?.value
    return typeof piece === 'string' ? piece : ''
  }

  const flush = () => {
    timer = null
    const trimmed = text.trim()
    text = ''
    if (trimmed === '') {
      startedAt = Date.now()
      return
    }
    turns += 1
    const taskId = `c-${Date.now().toString(36)}`
    const usage = usageBook?.take?.(hit?.sessionId)
    const row = {
      taskId,
      bot: bot.id,
      parentSession: hit?.parentSession,
      sessionId: hit?.sessionId,
      cwd: hit?.cwd ?? null,
      startedAt,
      doneAt: Date.now(),
      status: 'chat',
      verdict: 'accepted',
      output: trimmed.slice(0, 4000),
      note: `单聊第 ${turns} 轮`,
    }
    // 真实 token：这一轮说话花掉的用量。
    if (usage) row.tokens = usage
    tasks.set(taskId, row)
    void persistTasks?.()
    broadcast?.({ type: 'tasks' })
    void debug?.({ event: 'chat-captured', bot: bot.id, taskId })
    startedAt = Date.now()
  }

  try {
    agent.ctx.on('agent/assistant-stream', (event) => {
      const piece = pickDelta(event)
      if (piece === '') return
      text += piece
      // 新内容来了：取消待落账的计时，等这一轮真的结束。
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    })
  } catch {
    return
  }

  try {
    agent.ctx.on('agent/status', (event) => {
      const state = typeof event === 'string' ? event : event?.status
      if (state !== 'idle') return
      // 有的回合会短暂 idle 再续上，等一秒半确认说完。
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, 1500)
    })
  } catch {
    // 事件名不存在时静默放弃
  }
}

/**
 * Decorate a delegated team child the moment it is announced.
 * @param ctx - plugin context.
 * @param options - `{ debug, pending }`.
 */
export function installChildDecoration(ctx, options) {
  const { debug, pending, tasks, persistTasks, root, usageBook } = options
  const knowledgeOffs = []
  // 插件卸载时把注入的系统提示段落撤掉，否则重载会撞名、改内容也不生效。
  ctx.effect(() => () => {
    for (const off of knowledgeOffs.splice(0)) {
      try {
        off()
      } catch {
        // 已卸载
      }
    }
  })
  return ctx.on('agent/created', async ({ agent }) => {
    const header = agent?.session?.header ?? {}
    let hit = pending.get(header.id)
    let kind = 'dispatch'
    if (hit) {
      hit = { ...hit, sessionId: header.id, parentSession: header.parentSession, kind }
    } else {
      // 不是刚派的活，可能是用户在这个 Bot 的会话里继续聊：用账本反查。
      const entry = [...(tasks?.values?.() ?? [])].find((row) => row.sessionId === header.id)
      if (entry) {
        try {
          const bot = await readBot(root, entry.bot)
          hit = {
            bot,
            sessionId: header.id,
            parentSession: entry.parentSession,
            cwd: entry.cwd ?? null,
            kind: 'chat',
          }
          kind = 'chat'
        } catch {
          hit = undefined
        }
      }
    }
    await debug?.({
      event: 'agent/created',
      source: header.origin ?? null,
      cwd: header.cwd ?? null,
      known: Boolean(hit),
      kind,
    })
    pending.delete(header.id)
    // 恢复出来的子会话进这里：续聊等回复时 agents.get 可能拿不到它。
    if (hit) liveChildren.set(header.id, agent)
    if (!hit) {
      // 没有派活记录也不一定是普通会话：根会话就是秘书，它也要知道知识库。
      if (!header.parentSession) {
        try {
          const teamText = await readTeamMemory(root)
          if (teamText !== '') {
            const off = agent.ctx.systemPrompt.section({
              name: 'dsh-team:team-knowledge',
              order: 115,
              text: `团队知识库（所有 Bot 都按这些事实干活）：\n\n${teamText}`,
            })
            if (typeof off === 'function') knowledgeOffs.push(off)
            await debug({ event: 'lead-knowledge', ok: true, agents: 1, chars: teamText.length })
          }
        } catch (error) {
          await debug({ event: 'lead-knowledge', ok: false, error: String(error?.message ?? error) })
        }
      }
      return
    }


    // 真实 token：每一步模型都会推一个 usage 块，按子会话攒着，结算时领走。
    if (usageBook && agent?.ctx?.on) {
      try {
        agent.ctx.on('agent/assistant-stream', (event) => {
          const usage = usageOfFrame(event)
          if (usage) usageBook.add(header.id, usage)
        })
      } catch {
        // 事件名不存在时静默放弃
      }
    }

    // 任务目录在 DSH_HOME 下，不在默认工作区里；把这一条显式挂进该子会话的
    // workspace-write 授权，否则 Bot 连自己的任务目录都写不进去。
    let writableRootRegistered = false
    try {
      const sandboxPolicy = (typeof agent?.ctx?.get === 'function' ? agent.ctx.get('sandboxPolicy') : undefined)
        ?? (typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined)
      if (hit?.taskDir && typeof sandboxPolicy?.registerWritableRoot === 'function') {
        sandboxPolicy.registerWritableRoot(agent.session, hit.taskDir)
        writableRootRegistered = true
      }
    } catch (error) {
      await debug?.({ event: 'sandbox-root', ok: false, error: String(error?.message ?? error) })
    }

    try {
      const mode = hit?.bot === AUDITOR_ID ? 'read-only' : 'workspace-write'
      agent.session.append('sandbox/mode', { mode, source: 'delegation' })
      await debug?.({ event: 'sandbox', ok: true, mode, writableRoot: writableRootRegistered })
    } catch (error) {
      await debug?.({ event: 'sandbox', ok: false, error: String(error?.message ?? error) })
    }

    try {
      const team = await readTeamMemory(root)
      const rawSoul = await readMemory(root, hit.bot.id, 'soul.txt')
      // 占位句只丢那一行：用户是在占位句下面接着写人设的，不能整份丢掉。
      const soul = stripSoulPlaceholder(rawSoul)
      // 底座单独一段、排在人设前面：用户改 soul / persona 只会换掉人设，
      // 换不掉这一段。
      agent.ctx.systemPrompt.section({
        name: BASE_RULES_SECTION,
        order: BASE_RULES_ORDER,
        text: BASE_RULES,
      })
      // 每个 Bot 先知道自己是谁：团队记忆里没有职责，光靠它会让 Bot 认不出自己。
      const intro = `你是 ${hit.bot.name ?? hit.bot.id}，团队里的${hit.bot.role ?? '成员'}。下面是你的设定——它只决定你怎么说话，不决定你做什么。`
      // 每个人设只认 soul.txt 一份：JSON 里的 persona 已经迁移掉了，不再注入，
      // 不然用户在文件里改了却不生效。
      const text = [intro, team, soul].filter(Boolean).join('\n\n')
      agent.ctx.systemPrompt.section({
        name: PERSONA_SECTION,
        order: 120,
        text,
      })
      // 会话范围单列一段、排在人设之后：AGENTS.md 是宿主塞进来的用户消息，插件删不掉，
      // 只能在 system prompt 里把「哪一份设定说了算」写死。
      agent.ctx.systemPrompt.section({
        name: SCOPE_SECTION,
        order: SCOPE_ORDER,
        text: SCOPE_RULES,
      })
      await debug?.({ event: 'persona', bot: hit.bot.id, ok: true, soul: Boolean(soul), rules: true })

      // Capability card: a positive allow list wins; otherwise deny the tools
      // this bot must never use. Unknown names are skipped one by one so a
      // stale card does not break creation.
      const plan = capabilityPlan(hit.bot)
      const denied = []
      const allowed = []
      const skipped = []
      if (plan.allow !== undefined) {
        try {
          agent.ctx.tools.restrict({ allow: plan.allow })
          allowed.push(...plan.allow)
        } catch (error) {
          await debug?.({ event: 'capability-allow-failed', bot: hit.bot.id, error: String(error?.message ?? error) })
        }
      } else {
        for (const name of plan.deny) {
          try {
            agent.ctx.tools.restrict({ deny: [name] })
            denied.push(name)
          } catch {
            skipped.push(name)
          }
        }
      }
      await debug?.({ event: 'capability', bot: hit.bot.id, denied, allowed, skipped })

      // 原生「启用智能体团队协作」：Bot 拿不到 dsh-team 的团队工具（那会无限套娃），
      // 但可以按它自己的开关用 DSH 自带的子智能体。
      if (hit.bot.agentTeam === true) {
        try {
          const agentTeams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
          if (typeof agentTeams?.setEnabled === 'function') {
            await agentTeams.setEnabled(agent, true)
            await debug?.({ event: 'agent-teams', bot: hit.bot.id, ok: true })
          } else {
            await debug?.({ event: 'agent-teams', bot: hit.bot.id, ok: false, error: 'no agentTeams service' })
          }
        } catch (error) {
          await debug?.({ event: 'agent-teams', bot: hit.bot.id, ok: false, error: String(error?.message ?? error) })
        }
      }

      // 单聊回传：团队子会话里聊出来的内容也记账。派活子会话跳过，免得重复。
      armChatCapture({ agent, hit, bot: hit.bot, tasks, persistTasks, broadcast: options.api?.broadcast, debug, usageBook })
    } catch (error) {
      await debug?.({ event: 'persona', bot: hit.bot.id, ok: false, error: String(error?.message ?? error) })
    }
  })
}
