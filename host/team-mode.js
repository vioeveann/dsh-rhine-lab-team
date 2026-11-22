/**
 * HTTP surface of the team: the composer switch and the member roster.
 *
 * The browser cannot call host services directly, so this one route family
 * carries both directions. DSH listens on loopback only and its own routes do
 * no server-level authentication; the same holds here, which is acceptable for
 * a single-machine plugin.
 */
import { exportBot, exportPack, importBot, importBotFiles } from './export.js'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { BUILTIN_BOTS, listRemovedBuiltins, rememberRemovedBuiltin, restoreBuiltinBot } from './builtin-bots.js'
import { clearBackground, deleteBot, findAvatar, findBackground, loadBots, normalizeBot, renameBot, saveAvatar, saveBackground, saveBot, SOUL_PLACEHOLDER } from './bots.js'
import { listSnapshots } from './memory.js'
import { addActionBot, botsForSession, explicitTeamBots, loadTeams, saveTeams, setSessionTeam } from './teams.js'
import { createGroup, groupOf, loadGroups, normalizeGroups, removeGroup, renameGroup, saveGroups } from './groups.js'
import { join } from 'node:path'
import { growthSummary, normalizeGrowth } from './growth.js'
import { sumTaskTokens } from './usage.js'
import { updateGrowth } from './growth-store.js'
import { commitMemory } from './memory.js'

const SWITCH_ROUTE = '/dsh-team/team-mode'
const ROSTER_ROUTE = '/dsh-team/roster'
const TASKS_ROUTE = '/dsh-team/tasks'
/** 单件任务：member 卡片用它同步真实状态（卡里的状态是写死的历史文本）。 */
const TASK_ROUTE = '/dsh-team/task'
const BOTS_ROUTE = '/dsh-team/bots'
const MEMORY_ROUTE = '/dsh-team/memory'
const PERSONA_ROUTE = '/dsh-team/persona'
const AVATAR_ROUTE = '/dsh-team/avatar'
const BACKGROUND_ROUTE = '/dsh-team/background'
const RENAME_ROUTE = '/dsh-team/bots-rename'
const STATUS_ROUTE = '/dsh-team/bots-status'
const BUILTIN_ROUTE = '/dsh-team/builtin'
const EXPORT_ROUTE = '/dsh-team/roster-export'
const EXPORT_PACK_ROUTE = '/dsh-team/export-pack'
const EXPORT_BOT_ROUTE = '/dsh-team/export-bot'
const IMPORT_BOT_ROUTE = '/dsh-team/import-bot'
const IMPORT_BOT_FILES_ROUTE = '/dsh-team/import-bot-files'
const QUICKSTART_ROUTE = '/dsh-team/quickstart'
const SESSION_BOT_ROUTE = '/dsh-team/session-bot'
const IDENTITY_MAP_ROUTE = '/dsh-team/identity-map'
const DIAG_ROUTE = '/dsh-team/diag'
const CONFIG_ROUTE = '/dsh-team/config'
const RETRY_ROUTE = '/dsh-team/retry'
const CANCEL_ROUTE = '/dsh-team/cancel'
const CLEAN_ROUTE = '/dsh-team/tasks-clean'
const TEAM_BOTS_ROUTE = '/dsh-team/team-bots'
const GROUPS_ROUTE = '/dsh-team/groups'
const MODELS_ROUTE = '/dsh-team/models'
const OPEN_ROUTE = '/dsh-team/open'
const GROWTH_ROUTE = '/dsh-team/growth'
const IMPROVE_ROUTE = '/dsh-team/improve'
const TASK_EXPORT_ROUTE = '/dsh-team/task-export'
const PROMOTE_ROUTE = '/dsh-team/promote'
const STATS_ROUTE = '/dsh-team/stats'
const TEAM_MEMORY_ROUTE = '/dsh-team/team-memory'
const TEMPLATES_ROUTE = '/dsh-team/templates'
const EVENTS_ROUTE = '/dsh-team/events'

/**
 * Read a request body as text.
 * @param req - incoming request.
 * @param limit - byte cap.
 */
function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Send a JSON response.
 * @param res - server response.
 * @param status - HTTP status.
 * @param value - JSON-serializable body.
 */
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * 没上传头像时的默认头像：一张浅色底的工牌（挂绳夹 + 暖白卡套 + 卡面），
 * 卡面上的字默认是 BOT；自带的审计员那张写「审计」，是它专用的。
 * @param label - 卡面文字，默认 BOT。
 */
export function placeholderAvatar(label = 'BOT') {
  const safe = String(label).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch] ?? ch)
  // 两个字（审计）比三个字母占宽，字号收一点才不会顶到右边那块。
  const size = Array.from(safe).length > 2 ? 24 : 22
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    '<rect width="128" height="128" fill="#E7DDC8"/>',
    // 挂绳夹
    '<rect x="50" y="8" width="28" height="10" rx="4" fill="#C9C0AC"/>',
    // 浅色卡套（描边收一下边）与卡面
    '<rect x="12" y="20" width="104" height="86" rx="10" fill="#F5EEDC"/>',
    '<rect x="12" y="20" width="104" height="86" rx="10" fill="none" stroke="#D8CDB4" stroke-width="2"/>',
    '<rect x="20" y="28" width="88" height="70" rx="5" fill="#F9F3E2"/>',
    // 左侧彩条：红 / 绿 / 金 / 青
    '<rect x="20" y="28" width="5" height="70" fill="#C23A2B"/>',
    '<rect x="25" y="28" width="3" height="70" fill="#7FB98A"/>',
    '<rect x="28" y="28" width="3" height="70" fill="#E4B44C"/>',
    '<rect x="31" y="28" width="3" height="70" fill="#6FA8A0"/>',
    // 卡面文字 + 红条
    '<text x="63" y="60" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"',
    ` font-size="${size}" font-weight="700" letter-spacing="1.2" fill="#2B2B24">${safe}</text>`,
    '<rect x="40" y="64" width="22" height="6" rx="1" fill="#C23A2B"/>',
    // 右侧浅灰块 + 金条
    '<rect x="86" y="36" width="16" height="34" rx="4" fill="#EBE3D0"/>',
    '<rect x="90" y="41" width="6" height="24" rx="3" fill="#E4B44C"/>',
    // 底部色块
    '<rect x="40" y="76" width="34" height="10" rx="2" fill="#7FB98A"/>',
    '<rect x="76" y="76" width="10" height="10" fill="#E4B44C"/>',
    '<rect x="86" y="76" width="10" height="10" fill="#C23A2B"/>',
    '</svg>',
  ].join('')
}

/**
 * 用系统默认程序打开一个文件。
 *
 * Windows 走 `explorer.exe <file>`：它按文件关联打开，退出码通常是 1（不代表失败），
 * 所以只认「进程起没起来」，不看退出码。用 `spawn(detached)` 是为了不被宿主进程绑住。
 * 之前用 `cmd /c start`，Node 的引号转义和 cmd 对不上，静默失败（点了没反应）。
 *
 * @param file - 绝对路径。
 */
function openInEditor(file) {
  return new Promise((resolve, reject) => {
    // 想固定用某个编辑器就设 DSH_TEAM_EDITOR（例如 `code` 或 `"C:\\...\\Notepad++.exe"`）。
    const custom = String(process.env.DSH_TEAM_EDITOR ?? '').trim()
    let command
    let args
    if (custom !== '') {
      const parts = custom.match(/"[^"]+"|\S+/g) ?? []
      command = String(parts.shift() ?? '').replace(/^"|"$/g, '')
      args = [...parts.map((part) => part.replace(/^"|"$/g, '')), file]
    } else {
      [command, args] = process.platform === 'win32'
        ? ['explorer.exe', [file]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [file]]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * A task is stuck when it has run far longer than a single turn should.
 * Computed on read, so there is no timer to leak or double-register.
 * @param entry - task record.
 * @param now - current epoch ms.
 * @param thresholdMs - how long counts as stuck.
 */
export function isStuck(entry, now = Date.now(), thresholdMs = 10 * 60_000) {
  if (!entry || entry.doneAt) return false
  const startedAt = Number(entry.startedAt ?? 0)
  if (!startedAt) return false
  return now - startedAt > thresholdMs
}

/**
 * Install the team routes and return the switch gate.
 * @param ctx - plugin context.
 * @param options - `{ root, debug, tasks, getRoster }`.
 */
export function installTeamMode(ctx, options) {
  const { root, debug, tasks, getRoster, getSettings, saveSettings, api, persistTasks, getModels, getInstanceConflict } = options
  const storeFile = join(root, '.state', 'team-mode.json')

  /** 在线的 SSE 客户端。 */
  const eventClients = new Set()

  /** 用户自建的组；内置的行动组/预备组不在这里。 */
  let groups = []
  const groupsReady = loadGroups(root).then((loaded) => {
    groups = loaded
  })

  /** 会话 → 可用 Bot 列表；空表示整个名册。 */
  let teams = {}
  const teamsReady = loadTeams(root).then((loaded) => {
    teams = loaded
  })

  /**
   * 推一次变更通知。
   * @param payload - 例如 { type: 'tasks' }
   */
  const broadcast = (payload) => {
    const line = `data: ${JSON.stringify(payload ?? {})}\n\n`
    for (const client of eventClients) {
      try {
        client.write(line)
      } catch {
        eventClients.delete(client)
      }
    }
  }
  if (api && typeof api === 'object') {
    api.broadcast = broadcast
    // 被派过活的 Bot 进这个会话的行动组，干完也留着。
    api.addToAction = async (sessionId, botId) => {
      await teamsReady
      teams = addActionBot(teams, sessionId, botId)
      teams = await saveTeams(root, teams)
      api?.broadcast?.({ type: 'roster' })
      void debug({ event: 'action-add', sessionId, bot: botId })
    }
    api.isBotAllowed = (sessionId, botId) => {
      const assigned = teams?.[String(sessionId ?? '')]
      if (!Array.isArray(assigned) || assigned.length === 0) return true
      return assigned.includes(String(botId ?? ''))
    }
  }
  const state = new Map()

  const load = readFile(storeFile, 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw)
      for (const [sessionId, on] of Object.entries(parsed)) state.set(sessionId, Boolean(on))
    })
    .catch(() => {})

  const save = async () => {
    try {
      await mkdir(join(root, '.state'), { recursive: true })
      await writeFile(storeFile, JSON.stringify(Object.fromEntries(state), null, 2), 'utf8')
    } catch {
      // Persistence failure must not break the toggle.
    }
  }

  // The service is registered as `webServer` (camelCase), not `webserver`.
  const webserver = ctx.get('webServer') ?? ctx.get('webserver')
  /**
   * 注册一条路由。撞重复（上次实例没撤干净）时只记日志，不让整次安装挂掉——
   * 一条路由坏了不该连带后面的头像、背景全都不注册。
   * @param definition - webserver.register 的参数。
   * @returns 卸载函数（失败时是空函数）。
   */
  const registerRoute = (definition) => {
    try {
      return webserver.register(definition)
    } catch (error) {
      void debug({ event: 'route-register-failed', path: definition?.path, error: String(error?.message ?? error) })
      return () => {}
    }
  }
  if (!webserver?.register) {
    void debug({ event: 'team-mode', ok: false, error: 'no webServer service' })
    return { isEnabled: () => false, dispose: () => {} }
  }

  const disposeSwitch = registerRoute({
    kind: 'exact',
    path: SWITCH_ROUTE,
    async handler(req, res) {
      await load
      if (req.method === 'GET') {
        json(res, 200, { sessions: Object.fromEntries(state) })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const sessionId = String(body.sessionId ?? '').trim()
        if (!sessionId) {
          json(res, 400, { error: 'sessionId required' })
          return
        }
        state.set(sessionId, Boolean(body.on))
        await save()
        void debug({ event: 'team-mode', sessionId, on: Boolean(body.on) })
        json(res, 200, { ok: true, sessionId, on: Boolean(body.on) })
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) })
      }
    },
  })

  const disposeRoster = registerRoute({
    kind: 'exact',
    path: ROSTER_ROUTE,
    async handler(req, res) {
      await load
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawRoster = url.searchParams.get('sessionId') ?? ''
        const sessionId = rawRoster === 'unknown' ? '' : rawRoster
        const members = await getRoster({ sessionId, tasks })
        // 会话级队伍决定「能不能派活」，不影响显示：面板要按行动组/自定义组分类。
        await teamsReady
        await groupsReady
        const allowed = new Set(botsForSession(teams, sessionId, members.map((member) => member.id)))
        // inTeam 表示「被选进这个会话的队伍」；没设队伍时谁都不在行动组。
        const explicit = explicitTeamBots(teams, sessionId)
        const visible = members.map((member) => ({
          ...member,
          inTeam: explicit.has(member.id),
          usable: allowed.has(member.id),
          // 行动组里闲着叫「待命」；其它组里闲着还是「空闲」。
          status: explicit.has(member.id) && member.status === 'idle' ? 'standby' : member.status,
          group: groupOf(groups, member),
        }))
        const conflict = typeof getInstanceConflict === 'function' ? getInstanceConflict() : null
        let removedBuiltins = []
        try {
          removedBuiltins = await listRemovedBuiltins(root)
        } catch {
          removedBuiltins = []
        }
        json(res, 200, { members: visible, groups, instanceConflict: conflict, removedBuiltins })
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  const disposeTasks = registerRoute({
    kind: 'exact',
    path: TASKS_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = url.searchParams.get('sessionId') ?? ''
        const sessionId = raw === 'unknown' ? '' : raw
        const rows = [...tasks.values()]
          .filter((entry) => sessionId === '' || entry.parentSession === sessionId)
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
          .slice(0, 20)
          .map((entry) => ({
            taskId: entry.taskId,
            bot: entry.bot,
            status: entry.status ?? 'running',
            startedAt: entry.startedAt ?? null,
            doneAt: entry.doneAt ?? null,
            reviewedAt: entry.reviewedAt ?? null,
            note: entry.note ?? '',
            // 最近任务里要用文字展示 Bot 的回话，卡片取消后这是唯一的正文来源。
            output: entry.output ?? '',
            stuck: isStuck(entry),
            // 任务卡要看耗时与 token/分钟；模型表示这次实际用的路由（空 = 默认）。
            tokens: entry.tokens ?? null,
            model: entry.model ?? '',
            grade: entry.grade ?? '',
            continuesFrom: entry.continuesFrom ?? '',
          }))
        json(res, 200, { tasks: rows })
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  const disposeTaskOne = registerRoute({
    kind: 'exact',
    path: TASK_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const taskId = String(url.searchParams.get('taskId') ?? '').trim()
        const entry = tasks?.get(taskId)
        if (!entry) {
          json(res, 404, { error: `没有这个任务：${taskId}` })
          return
        }
        json(res, 200, {
          task: {
            taskId: entry.taskId,
            bot: entry.bot,
            status: entry.status ?? 'running',
            grade: entry.grade ?? '',
            verdict: entry.verdict ?? '',
            model: entry.model ?? '',
            tokens: entry.tokens ?? null,
            startedAt: entry.startedAt ?? null,
            doneAt: entry.doneAt ?? null,
          },
        })
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  const disposeBots = registerRoute({
    kind: 'exact',
    path: BOTS_ROUTE,
    async handler(req, res) {
      if (req.method === 'GET') {
        json(res, 200, { bots: await loadBots(root) })
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const normalized = normalizeBot(body)
          if (!normalized.ok) {
            json(res, 400, { ok: false, error: normalized.error })
            return
          }
          // 职责变了：等级与经验保留，评分样本清零，并记一条转岗。
          let previous = null
          try {
            previous = JSON.parse(await readFile(join(root, 'bots', `${normalized.bot.id}.json`), 'utf8'))
          } catch {
            previous = null
          }
          const roleChanged = previous !== null
            && typeof previous.role === 'string'
            && previous.role !== normalized.bot.role
          const saved = await saveBot(root, normalized.bot)
          // 换组：显式传空串 = 回「行动预备组」。normalizeBot 空串不带字段，
          // merge 会保留旧组，所以这里直接把 group 从 JSON 里删掉。
          if (typeof body.group === 'string' && body.group.trim() === '') {
            try {
              const file = join(root, 'bots', `${saved.id}.json`)
              const current = JSON.parse(await readFile(file, 'utf8'))
              if ('group' in current) {
                const { group: _dropped, ...rest } = current
                await writeFile(file, `${JSON.stringify(rest, null, 2)}\n`, 'utf8')
                delete saved.group
              }
            } catch {
              // 删不掉就保持原样，下次保存再试
            }
          }
          if (roleChanged) {
            await updateGrowth(root, saved.id, (_bot, growth) => ({
              ok: true,
              growth: {
                ...growth,
                // 评分样本按岗位重算；复犯记录属于「教过的错」，保留。
                stats: { ...growth.stats, excellent: 0, good: 0, pass: 0, poor: 0 },
                // 换了岗位，原来的连续好评也失效。
                streak: 0,
              },
            }))
            try {
              const memoryDir = join(root, 'bots', saved.id, 'memory')
              await appendFile(
                join(memoryDir, 'project.md'),
                `[转岗] 从「${previous.role}」调到「${saved.role}」；评分样本已清零，等级与经验保留。\n`,
                'utf8',
              )
              await commitMemory(memoryDir, `role: ${previous.role} -> ${saved.role}`)
            } catch {
              // 记忆写不进去不影响本次保存
            }
            void debug({ event: 'role-change', id: saved.id, from: previous.role, to: saved.role })
          }
          // 转岗时成长在保存之后才更新，回给面板的要是磁盘上的最新值。
          let fresh = saved
          if (roleChanged) {
            try {
              fresh = JSON.parse(await readFile(join(root, 'bots', `${saved.id}.json`), 'utf8'))
            } catch {
              fresh = saved
            }
          }
          broadcast({ type: 'roster' })
          void debug({ event: 'bot-saved', id: saved.id })
          json(res, 200, { ok: true, bot: fresh, roleChanged })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      if (req.method === 'DELETE') {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = String(url.searchParams.get('id') ?? '')
          // 手上还有活就别删：等它跑完，免得删掉目录后还在往里写。
          const busy = [...tasks.values()].some((row) => row.bot === id && row.status === 'running')
          if (busy) {
            json(res, 400, { ok: false, error: '它手上还有一件活在跑，等跑完再删' })
            return
          }
          // 自带的 Bot：先记下它在哪个组，恢复时放回原处。
          try {
            const file = join(root, 'bots', `${id}.json`)
            const bot = JSON.parse(await readFile(file, 'utf8'))
            await rememberRemovedBuiltin(root, id, bot?.group ?? '')
          } catch {
            // 读不到就按行动预备组处理
          }
          const result = await deleteBot(root, id)
          broadcast({ type: 'roster' })
          void debug({ event: 'bot-deleted', id, ok: result.ok })
          json(res, result.ok ? 200 : 400, result)
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      res.writeHead(405, { allow: 'GET, POST, DELETE' })
      res.end()
    },
  })

  const disposeMemoryRoute = registerRoute({
    kind: 'exact',
    path: MEMORY_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const bot = String(url.searchParams.get('bot') ?? '')
        if (!/^[a-z][a-z0-9-]{0,23}$/.test(bot)) {
          json(res, 400, { error: 'bot required' })
          return
        }
        json(res, 200, { bot, snapshots: await listSnapshots(join(root, 'bots', bot, 'memory')) })
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  /**
   * 人设文件（`bots/<id>/memory/soul.txt`）：读回来给面板看，或者用系统默认程序打开让用户改。
   * 人设只认这一份文件。
   */
  const disposePersona = registerRoute({
    kind: 'exact',
    path: PERSONA_ROUTE,
    async handler(req, res) {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        let bot = String(url.searchParams.get('bot') ?? '')
        let body = {}
        if (req.method === 'POST') {
          body = JSON.parse((await readBody(req)) || '{}')
          bot = String(body.bot ?? bot)
        } else if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end()
          return
        }
        if (!/^[a-z][a-z0-9-]{0,23}$/.test(bot)) {
          json(res, 400, { ok: false, error: 'bot required' })
          return
        }
        const file = join(root, 'bots', bot, 'memory', 'soul.txt')
        if (req.method === 'POST') {
          // 用系统默认程序打开；打不开就把路径回给面板，让它自己提示。
          try {
            await openInEditor(file)
            json(res, 200, { ok: true, bot, path: file })
          } catch (error) {
            json(res, 200, { ok: false, bot, path: file, error: String(error?.message ?? error) })
          }
          return
        }
        let text = ''
        try {
          text = await readFile(file, 'utf8')
        } catch {
          text = ''
        }
        // 只有占位句等于没写：面板那边当空处理，提示去写。
        const blank = text.trim() === '' || text.includes(SOUL_PLACEHOLDER)
        json(res, 200, { ok: true, bot, path: file, exists: !blank, text: blank ? '' : text })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeEvents = registerRoute({
    kind: 'exact',
    path: EVENTS_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write('retry: 3000\n\n')
      res.write('data: {"type":"hello"}\n\n')
      eventClients.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(heartbeat)
          eventClients.delete(res)
        }
      }, 25_000)
      heartbeat.unref?.()
      req.on?.('close', () => {
        clearInterval(heartbeat)
        eventClients.delete(res)
      })
    },
  })

  const disposeTemplates = registerRoute({
    kind: 'exact',
    path: TEMPLATES_ROUTE,
    async handler(req, res) {
      const dir = join(root, 'templates')
      try {
        if (req.method === 'GET') {
          let files = []
          try {
            files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
          } catch {
            files = []
          }
          const rows = []
          for (const file of files.sort()) {
            try {
              const parsed = JSON.parse(await readFile(join(dir, file), 'utf8'))
              rows.push({ id: file.replace(/\.json$/, ''), name: parsed.name ?? file, description: parsed.description ?? '', bots: (parsed.bots ?? []).map((bot) => bot.id) })
            } catch {
              // 坏模板跳过
            }
          }
          json(res, 200, { templates: rows })
          return
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = String(body.id ?? '').replace(/[^a-z0-9-]/gi, '')
          if (id === '') {
            json(res, 400, { ok: false, error: '缺少模板 id' })
            return
          }
          const parsed = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'))
          const imported = []
          for (const bot of parsed.bots ?? []) {
            const normalized = normalizeBot(bot)
            if (!normalized.ok) continue
            await saveBot(root, normalized.bot)
            imported.push(normalized.bot.id)
          }
          void debug({ event: 'template-apply', id, bots: imported })
          json(res, 200, { ok: true, id, imported })
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeStats = registerRoute({
    kind: 'exact',
    path: STATS_ROUTE,
    async handler(req, res) {
      try {
        const byBot = new Map()
        for (const entry of tasks?.values?.() ?? []) {
          const bot = entry.bot ?? '?'
          const row = byBot.get(bot) ?? { bot, tasks: 0, tokens: 0, accepted: 0, rejected: 0 }
          row.tasks += 1
          row.tokens += Number(entry.tokens?.total) || 0
          if (entry.verdict === 'accepted') row.accepted += 1
          if (entry.verdict === 'rejected') row.rejected += 1
          byBot.set(bot, row)
        }
        json(res, 200, { bots: [...byBot.values()].sort((a, b) => b.tasks - a.tasks) })
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  const disposeExportPack = registerRoute({
    kind: 'exact',
    path: EXPORT_PACK_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const settings = getSettings?.() ?? {}
        const into = String(settings.deliverableRoot ?? '').trim() || join(root, 'deliverables')
        const result = await exportPack(root, into, { version: options.version ?? '' })
        void debug({ event: 'export-pack', ok: result.ok, path: result.path, bots: result.bots, files: result.files })
        json(res, 200, result)
      } catch (error) {
        void debug({ event: 'export-pack', ok: false, error: String(error?.message ?? error) })
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeExportBot = registerRoute({
    kind: 'exact',
    path: EXPORT_BOT_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const settings = getSettings?.() ?? {}
        const into = String(settings.deliverableRoot ?? '').trim() || join(root, 'deliverables')
        const result = await exportBot(root, into, body.bot, { version: options.version ?? '' })
        void debug({ event: 'export-bot', ok: result.ok, id: body.bot, path: result.path })
        json(res, result.ok ? 200 : 400, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeImportBot = registerRoute({
    kind: 'exact',
    path: IMPORT_BOT_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await importBot(root, body.path, body.group ?? '')
        if (result.ok) api?.broadcast?.({ type: 'roster' })
        void debug({ event: 'import-bot', ok: result.ok, id: result.id, renamed: result.renamed })
        json(res, result.ok ? 200 : 400, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
  const disposeQuickstart = registerRoute({
    kind: 'exact',
    path: QUICKSTART_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const text = await readFile(join(root, 'docs', 'QUICKSTART.md'), 'utf8')
        json(res, 200, { ok: true, text })
      } catch (error) {
        json(res, 404, { ok: false, error: `读不到使用说明：${String(error?.message ?? error)}` })
      }
    },
  })

  const disposeImportBotFiles = registerRoute({
    kind: 'exact',
    path: IMPORT_BOT_FILES_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      try {
        const body = JSON.parse((await readBody(req, 20 * 1024 * 1024)) || '{}')
        const result = await importBotFiles(root, body.group ?? '', body)
        if (result.ok) api?.broadcast?.({ type: 'roster' })
        void debug({ event: 'import-bot-files', ok: result.ok, id: result.id, renamed: result.renamed })
        json(res, result.ok ? 200 : 400, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
  const disposeIdentityMap = registerRoute({
    kind: 'exact',
    path: IDENTITY_MAP_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      // 账本里每件任务都带自己的子会话号：全部收进来，老会话也能认。
      const map = {}
      const names = new Map()
      for (const entry of tasks?.values?.() ?? []) {
        if (!entry?.sessionId || !entry?.bot) continue
        map[entry.sessionId] = { id: entry.bot }
      }
      const ids = [...new Set(Object.values(map).map((item) => item.id))]
      for (const bot of await loadBots(root, ids).catch(() => [])) {
        names.set(bot.id, bot.name ?? bot.id)
      }
      for (const [sessionId, item] of Object.entries(map)) {
        item.name = names.get(item.id) ?? item.id
        item.src = `/dsh-team/avatar?bot=${encodeURIComponent(item.id)}&v=3`
        item.onOpen = true
        item.speech = false
      }
      json(res, 200, { ok: true, map })
    },
  })

  const disposeSessionBot = registerRoute({
    kind: 'exact',
    path: SESSION_BOT_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = String(url.searchParams.get('sessionId') ?? '').trim()
      if (sessionId === '') {
        json(res, 400, { ok: false, error: '缺少 sessionId' })
        return
      }
      // 账本里找这个会话属于哪个 Bot：老任务会话也能认出来。
      const row = [...(tasks?.values?.() ?? [])].find((entry) => entry.sessionId === sessionId)
      if (!row) {
        json(res, 200, { ok: true, bot: null })
        return
      }
      let name = row.bot
      let label = ''
      try {
        const [bot] = await loadBots(root, [row.bot])
        name = bot?.name ?? row.bot
        label = bot?.role ?? ''
      } catch {
        // 读不到定义就用 id
      }
      json(res, 200, { ok: true, bot: { id: row.bot, name, label, taskId: row.taskId } })
    },
  })

  const disposeTeamMemory = registerRoute({
    kind: 'exact',
    path: TEAM_MEMORY_ROUTE,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const file = String(url.searchParams.get('file') ?? 'user')
      if (!/^(user|style|knowledge)$/.test(file)) {
        json(res, 400, { ok: false, error: 'file 只能是 user / style / knowledge' })
        return
      }
      const target = join(root, 'bots', '_team', `${file}.md`)
      try {
        if (req.method === 'GET') {
          let text = ''
          try {
            text = await readFile(target, 'utf8')
          } catch {
            text = ''
          }
          json(res, 200, { ok: true, file, text })
          return
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 256 * 1024)) || '{}')
          const text = String(body.text ?? '')
          if (text.length > 100_000) {
            json(res, 400, { ok: false, error: '太长了（上限 10 万字）' })
            return
          }
          await mkdir(join(root, 'bots', '_team'), { recursive: true })
          await writeFile(target, text, 'utf8')
          void debug({ event: 'team-memory', file, chars: text.length })
          json(res, 200, { ok: true, file, chars: text.length })
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposePromote = registerRoute({
    kind: 'exact',
    path: PROMOTE_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await api?.promote?.({
          botId: String(body.bot ?? ''),
          // 面板把当前会话一起报上来：感言要在这个秘书会话下写。
          parentSession: String(body.sessionId ?? ''),
        })
        json(res, 200, result ?? { ok: false, error: '晋升接口没接上' })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeTaskExport = registerRoute({
    kind: 'exact',
    path: TASK_EXPORT_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await api?.exportTask?.(String(body.taskId ?? ''))
        json(res, 200, result ?? { ok: false, error: '导出接口没接上' })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeImprove = registerRoute({
    kind: 'exact',
    path: IMPROVE_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await api?.improve?.({
          botId: String(body.bot ?? ''),
          tag: String(body.tag ?? ''),
        })
        json(res, 200, result ?? { ok: false, error: '确认接口没接上' })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeGrowth = registerRoute({
    kind: 'exact',
    path: GROWTH_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = String(url.searchParams.get('bot') ?? '').trim()
        const result = await api?.botGrowth?.(id)
        json(res, 200, result ?? { ok: false, error: '成长档案接口没接上' })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeOpen = registerRoute({
    kind: 'exact',
    path: OPEN_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await api?.openChat?.({
          botId: String(body.bot ?? ''),
          parentSession: String(body.sessionId ?? ''),
        })
        json(res, 200, result ?? { ok: false, error: '单聊接口没接上' })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeModels = registerRoute({
    kind: 'exact',
    path: MODELS_ROUTE,
    async handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      try {
        const groups = typeof getModels === 'function' ? await getModels() : []
        json(res, 200, { ok: true, groups })
      } catch (error) {
        json(res, 200, { ok: false, groups: [], error: String(error?.message ?? error) })
      }
    },
  })

  const disposeGroups = registerRoute({
    kind: 'exact',
    path: GROUPS_ROUTE,
    async handler(req, res) {
      await groupsReady
      try {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, groups })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end()
          return
        }
        const body = JSON.parse((await readBody(req)) || '{}')
        const action = String(body.action ?? 'create')
        let result
        if (action === 'create') result = createGroup(groups, body.name)
        else if (action === 'rename') result = renameGroup(groups, String(body.id ?? ''), body.name)
        else if (action === 'delete') result = removeGroup(groups, String(body.id ?? ''))
        else {
          json(res, 400, { ok: false, error: 'action 只能是 create / rename / delete' })
          return
        }
        if (!result.ok) {
          json(res, 400, result)
          return
        }
        groups = await saveGroups(root, result.groups)
        // 组没了，成员别留着悬空的 group id：直接回行动预备组。
        if (action === 'delete') {
          const removedId = String(body.id ?? '')
          for (const bot of await loadBots(root)) {
            if (bot?.group !== removedId) continue
            // saveBot 会和磁盘上的旧内容合并，清字段必须直接重写。
            const { group: _dropped, ...rest } = bot
            await writeFile(
              join(root, "bots", `${bot.id}.json`),
              `${JSON.stringify(rest, null, 2)}\n`,
              "utf8",
            )
          }
        }
        api?.broadcast?.({ type: 'roster' })
        void debug({ event: 'groups', action, count: groups.length })
        json(res, 200, { ok: true, groups, group: result.group ?? null })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeTeamBots = registerRoute({
    kind: 'exact',
    path: TEAM_BOTS_ROUTE,
    async handler(req, res) {
      await teamsReady
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = String(url.searchParams.get('sessionId') ?? '')
          const all = (await loadBots(root)).map((bot) => bot.id)
          json(res, 200, { sessionId, bots: botsForSession(teams, sessionId, all), all })
          return
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const sessionId = String(body.sessionId ?? '').trim()
          if (sessionId === '') {
            json(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }
          teams = setSessionTeam(teams, sessionId, body.bots)
          teams = await saveTeams(root, teams)
          api?.broadcast?.({ type: 'roster' })
          void debug({ event: 'team-bots', sessionId, bots: teams[sessionId] ?? 'all' })
          json(res, 200, { ok: true, sessionId, bots: teams[sessionId] ?? [] })
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeClean = registerRoute({
    kind: 'exact',
    path: CLEAN_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const status = String(body.status ?? '').trim()
        const allowed = ['ready', 'accepted', 'rejected', 'cancelled', 'failed', 'all']
        if (!allowed.includes(status)) {
          json(res, 400, { ok: false, error: `status 只能是 ${allowed.join(' / ')}` })
          return
        }
        const removed = []
        for (const [taskId, entry] of [...(tasks?.entries?.() ?? [])]) {
          if (entry.doneAt === undefined) continue
          if (status !== 'all' && entry.status !== status) continue
          tasks.delete(taskId)
          removed.push(taskId)
        }
        await persistTasks?.()
        api?.broadcast?.({ type: 'tasks' })
        void debug({ event: 'tasks-clean', status, removed: removed.length })
        json(res, 200, { ok: true, status, removed })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeCancel = registerRoute({
    kind: 'exact',
    path: CANCEL_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await api?.cancel?.(body.taskId)
        json(res, 200, result ?? { ok: false, error: '取消接口没接上' })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeRetry = registerRoute({
    kind: 'exact',
    path: RETRY_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (typeof api?.retry !== 'function') {
          json(res, 503, { ok: false, error: '重试接口没接上（插件可能刚重载）' })
          return
        }
        const result = await api.retry(body.taskId)
        json(res, 200, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeConfig = registerRoute({
    kind: 'exact',
    path: CONFIG_ROUTE,
    async handler(req, res) {
      if (req.method === 'GET') {
        json(res, 200, { settings: getSettings?.() ?? {} })
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          if (typeof saveSettings !== 'function') {
            json(res, 500, { ok: false, error: '设置接口没接上' })
            return
          }
          const saved = await saveSettings(body)
          void debug({ event: 'settings', ok: true, settings: saved })
          json(res, 200, { ok: true, settings: saved })
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    },
  })

  const disposeDiag = registerRoute({
    kind: 'exact',
    path: DIAG_ROUTE,
    async handler(req, res) {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        await debug({ event: 'client', ...body })
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeExport = registerRoute({
    kind: 'exact',
    path: EXPORT_ROUTE,
    async handler(req, res) {
      try {
        if (req.method === 'GET') {
          const bots = await loadBots(root)
          json(res, 200, { version: 1, bots })
          return
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || '{}')
          const rows = Array.isArray(body?.bots) ? body.bots : []
          const saved = []
          const failed = []
          for (const row of rows) {
            // 这条接口只同步名册定义；成长值不能从请求体写入，否则防作弊形同虚设。
            // 需要带成长迁移的备份走 /dsh-team/import-bot 或 /dsh-team/import-bot-files。
            const normalized = normalizeBot(row)
            if (!normalized.ok) {
              failed.push({ id: row?.id ?? '?', error: normalized.error })
              continue
            }
            // 保留启停状态；其余字段以名册为准。
            const status = row?.status === 'disabled' ? 'disabled' : 'active'
            saved.push(await saveBot(root, { ...normalized.bot, status }))
          }
          void debug({ event: 'roster-import', ok: saved.length, failed: failed.length })
          json(res, 200, { ok: true, imported: saved.map((bot) => bot.id), failed })
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeStatus = registerRoute({
    kind: 'exact',
    path: STATUS_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const id = String(body.id ?? '').trim()
        const status = body.status === 'disabled' ? 'disabled' : 'active'
        if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) {
          json(res, 400, { ok: false, error: 'id 不合法' })
          return
        }
        const file = join(root, 'bots', `${id}.json`)
        const bot = JSON.parse(await readFile(file, 'utf8'))
        await writeFile(file, `${JSON.stringify({ ...bot, status }, null, 2)}\n`, 'utf8')
        broadcast({ type: 'roster' })
        void debug({ event: 'bot-status', id, status })
        json(res, 200, { ok: true, id, status })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // 自带的 Bot 被删掉了：面板里点「恢复」走这里重新种一个。
  const disposeBuiltin = registerRoute({
    kind: 'exact',
    path: BUILTIN_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (String(body.action ?? '') !== 'restore') {
          json(res, 400, { ok: false, error: '只支持 action=restore' })
          return
        }
        const result = await restoreBuiltinBot(root, String(body.id ?? '').trim(), debug)
        broadcast({ type: 'roster' })
        void debug({ event: 'builtin-restore', id: body.id, ok: result.ok })
        json(res, result.ok ? 200 : 400, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeRename = registerRoute({
    kind: 'exact',
    path: RENAME_ROUTE,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await renameBot(root, body.from, body.to)
        if (result.ok) broadcast({ type: 'roster' })
        void debug({ event: 'bot-renamed', from: body.from, to: body.to, ok: result.ok })
        json(res, result.ok ? 200 : 400, result)
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  const disposeAvatar = registerRoute({
    kind: 'exact',
    path: AVATAR_ROUTE,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const bot = String(url.searchParams.get('bot') ?? '')
      if (req.method === 'GET') {
        const found = await findAvatar(root, bot)
        if (!found) {
          // 没传过头像：给一张默认的人像剪影，子会话和卡片都不会出现裂图。
          res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
          // 「审计」那张只给限定（审计员）；写作、资料整理这些普通自带 Bot 还是 BOT。
          const limited = BUILTIN_BOTS.some((entry) => entry.id === bot && entry.limited === true)
          res.end(placeholderAvatar(limited ? '审计' : 'BOT'))
          return
        }
        const bytes = await readFile(found.path)
        res.writeHead(200, { 'content-type': found.type, 'cache-control': 'no-cache' })
        res.end(bytes)
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)) || '{}')
          const match = /^data:image\/(png|jpe?g|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl ?? ''))
          if (!match) {
            json(res, 400, { ok: false, error: '只接受 png / jpg / webp / svg 的 data URL' })
            return
          }
          const ext = match[1] === 'svg+xml' ? 'svg' : match[1] === 'jpeg' ? 'jpg' : match[1]
          const target = String(body.bot ?? '').trim()
          const result = await saveAvatar(root, target, Buffer.from(match[2], 'base64'), ext)
          void debug({ event: 'avatar', bot: target, ok: result.ok })
          json(res, result.ok ? 200 : 400, result)
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
    },
  })

  // 卡片背景：精英化一阶起才能设置，读写方式和头像一致。
  const disposeBackground = registerRoute({
    kind: 'exact',
    path: BACKGROUND_ROUTE,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const botId = String(url.searchParams.get('bot') ?? '')
      if (req.method === 'GET') {
        const found = await findBackground(root, botId)
        if (!found) {
          res.writeHead(404)
          res.end()
          return
        }
        const bytes = await readFile(found.path)
        res.writeHead(200, { 'content-type': found.type, 'cache-control': 'no-cache' })
        res.end(bytes)
        return
      }
      if (req.method === 'DELETE') {
        const result = await clearBackground(root, botId)
        broadcast({ type: 'roster' })
        json(res, 200, result)
        return
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || '{}')
          const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl ?? ''))
          if (!match) {
            json(res, 400, { ok: false, error: '只接受 png / jpg / webp' })
            return
          }
          const target = String(body.bot ?? '').trim()
          const bots = await loadBots(root)
          const targetBot = bots.find((entry) => entry.id === target)
          const rank = normalizeGrowth(targetBot?.growth).rank
          if (rank < 1) {
            json(res, 403, { ok: false, error: '升到精英化一阶才能自定义卡片背景' })
            return
          }
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
          const result = await saveBackground(root, target, Buffer.from(match[2], 'base64'), ext)
          void debug({ event: 'background', bot: target, ok: result.ok })
          broadcast({ type: 'roster' })
          json(res, result.ok ? 200 : 400, result)
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      res.writeHead(405, { allow: 'GET, POST, DELETE' })
      res.end()
    },
  })

  return {
    isEnabled: (sessionId) => state.get(String(sessionId)) === true,
    dispose: () => {
      // 新加的路由也要撤；漏一个，下次重载就会撞「duplicate exact route」。
      for (const dispose of [
        disposeExportPack,
        disposeExportBot,
        disposeImportBot,
        disposeImportBotFiles,
        disposeQuickstart,
      ]) {
        try {
          dispose?.()
        } catch {
          // 已经撤过
        }
      }
      disposeBuiltin()
      disposeSwitch()
      disposeRoster()
      disposeTasks()
      disposeTaskOne()
      disposeBots()
      disposeEvents()
      disposeTemplates()
      disposeStats()
      disposeTeamMemory()
      disposePromote()
      disposeImprove()
      disposeTaskExport()
      disposeGrowth()
      disposeOpen()
      disposeModels()
      disposeGroups()
      disposeTeamBots()
      disposeClean()
      disposeCancel()
      disposeRetry()
      disposeConfig()
      disposeDiag()
      disposeExport()
      disposeStatus()
      disposeRename()
      disposeBackground()
      disposeAvatar()
      disposeMemoryRoute()
      disposePersona()
    },
  }
}

/**
 * Read the bot roster from disk and merge in live task state.
 * @param options - `{ root, tasks, sessionId }`.
 * @returns member rows for the panel.
 */
export async function readRoster(options) {
  const { root, tasks, sessionId } = options
  let files = []
  try {
    files = (await readdir(join(root, 'bots'))).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }

  // Most recent child session per bot, so the panel can open its chat.
  const latestSession = new Map()
  for (const entry of tasks.values()) {
    if (!entry.sessionId) continue
    const seen = latestSession.get(entry.bot)
    if (!seen || (entry.startedAt ?? 0) > (seen.startedAt ?? 0)) {
      latestSession.set(entry.bot, {
      sessionId: entry.sessionId,
      parentSession: entry.parentSession ?? null,
      startedAt: entry.startedAt,
    })
    }
  }

  const live = new Map()
  for (const entry of tasks.values()) {
    if (entry.doneAt) continue
    if (sessionId && entry.parentSession !== sessionId) continue
    const current = live.get(entry.bot) ?? []
    current.push(entry)
    live.set(entry.bot, current)
  }

  const members = []
  for (const file of files) {
    let bot
    try {
      bot = JSON.parse(await readFile(join(root, 'bots', file), 'utf8'))
    } catch {
      continue
    }
    const running = live.get(bot.id) ?? []
    members.push({
      id: bot.id,
      name: bot.name ?? bot.id,
      role: bot.role ?? '',
      status: bot.status === 'disabled' ? 'disabled' : running.length > 0 ? 'busy' : 'idle',
      group: bot.group ?? '',
      stars: bot.stars ?? 0,
      // 插件自带的 Bot；limited 表示「限定」（带标签、删了能恢复）。
      builtin: BUILTIN_BOTS.some((entry) => entry.id === bot.id),
      limited: BUILTIN_BOTS.some((entry) => entry.id === bot.id && entry.limited === true),
      note: bot.note ?? '',
      enabled: bot.status !== 'disabled',
      tasks: running.length,
      since: running[0]?.startedAt ?? null,
      avatar: (await findAvatar(root, bot.id)) !== null,
      background: (await findBackground(root, bot.id)) !== null,
      backgroundOpacity: Number.isFinite(bot.bgOpacity) ? bot.bgOpacity : 1,
      fontWeight: Number.isFinite(bot.fontWeight) ? bot.fontWeight : 400,
      backgroundAt: (await findBackground(root, bot.id))?.at ?? null,
      // 这个 Bot 在本次会话 / 全部会话里已经产出的字数（token 按它估）。
      ...(() => {
        const growth = growthSummary(bot.growth)
        return {
          rank: growth.rank,
          label: growth.label,
          lv: growth.level,
          xpInto: growth.into,
          xpNeed: growth.need,
          xpCapped: growth.capped,
          teaches: growth.teaches,
          goodRate: growth.goodRate,
          repeatRate: growth.repeatRate,
          streak: growth.streak,
          canPromote: growth.canPromote,
          levelSince: growth.levelSince,
        }
      })(),
      // 这个 Bot 用不用 DSH 原生的子智能体（团队工具它永远拿不到）。
      agentTeam: bot.agentTeam === true,
      // 真实 token：账本里记着每次派活/单聊领到的 usage 合计。
      // 老记录没有 tokens，只能按字数折算，用 partial 标出来，卡片上加「≈」。
      ...(() => {
        const inSession = sumTaskTokens(
          [...tasks.values()].filter((entry) => entry.bot === bot.id && entry.parentSession === sessionId),
        )
        const all = sumTaskTokens([...tasks.values()].filter((entry) => entry.bot === bot.id))
        return {
          tokensSession: inSession.real,
          tokensSessionEstimated: inSession.estimated,
          tokensSessionPartial: inSession.partial,
          tokensTotal: all.real,
          tokensTotalEstimated: all.estimated,
          tokensTotalPartial: all.partial,
          tokensBreakdown: { input: all.input, output: all.output, cacheRead: all.cacheRead },
        }
      })(),
      // 这个会话里有没有干过活：决定「待命」还是「空闲」。
      worked: [...tasks.values()].some((entry) => entry.bot === bot.id && entry.parentSession === sessionId),
      sessionId: latestSession.get(bot.id)?.sessionId ?? null,
      parentSessionId: latestSession.get(bot.id)?.parentSession ?? null,
    })
  }
  return members
}
