/**
 * Host runtime: the team side of dsh-team.
 *
 * Responsibilities (S0 / one-shot version)
 *  - register `team_dispatch`, which starts a bot through the subagent runtime;
 *  - decorate each dispatched child at `agent/created` (sandbox + persona);
 *  - keep a temporary `.debug/host.log` trace so runtime contracts can be read
 *    from disk instead of guessed.
 *
 * This module is imported with a cache-busting query by `index.js`, so editing
 * it and toggling the bundle is enough to pick up a change.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkspaceGuard } from './guard.js'
import { adoptSoulFile, loadBots, migratePersona } from './bots.js'
import { ensureBuiltinBots } from './builtin-bots.js'
import { loadSettings, resolveDeliverableRoot, saveSettings } from './settings.js'
import { createUsageBook } from './usage.js'
import { createMailbox } from './mailbox.js'
import { migrateDataRoot, resolveDataRoot } from './paths.js'
import { privateEntryOf, readPrivateState } from './private-chat.js'
import { createPersonaWatcher } from './persona-watch.js'
/**
 * 工具层和面板路由这两块改得最勤，所以带缓存戳动态 import：
 * 静态 import 会命中 ESM 模块缓存，改完翻开关也不会重新加载，只能重启 DSH。
 * 里面的 ./bots.js 之类仍是普通 import——它们没改，共用一份就行。
 */
const toolsModule = await import(`./tools.js?v=${Date.now()}`)
const teamModeModule = await import(`./team-mode.js?v=${Date.now()}`)
const {
  installChildDecoration,
  readTeamMemory,
  registerMemoryTools,
  registerTeamTools,
  SECRETARY_RULES,
} = toolsModule
const { installTeamMode, readRoster } = teamModeModule

/** 插件包目录：只放代码，不放数据。升级时它会被整个替换。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 数据目录：Bot 名册、记忆、头像、账本都在这儿，升级不会动它。 */
const ROOT = resolveDataRoot()
/** 老版本把数据放在包目录里；启动时搬一次，别让升级把用户的 Bot 抹掉。 */
const MIGRATED = await migrateDataRoot(PACKAGE_ROOT, ROOT)

const DEBUG_DIR = join(ROOT, '.debug')
const CONFIG_FILE = join(ROOT, '.state', 'config.json')

/** Live settings shared by the tools and the panel. */
const SETTINGS = await loadSettings(ROOT)
const DELIVERABLES = resolveDeliverableRoot(ROOT, SETTINGS, process.env.DSH_TEAM_DELIVERABLES)

/** 工具层与 HTTP 路由共享的钩子（例如面板上的「重试」）。 */
const TEAM_API = {}
/**
 * 人设段的撤换句柄，按子会话 id 存。
 * 用户改完 soul.txt，靠这张表把「已经在跑的会话」下一轮就换上新设定，
 * 不用关了重开。
 */
const personas = new Map()
const DEBUG_LOG = join(DEBUG_DIR, 'host.log')

/** Children waiting to be decorated, keyed by the session id we reserved. */
const pending = new Map()

/** Live and recently finished tasks, keyed by task id. */
const tasks = new Map()
const TASKS_FILE = join(ROOT, '.state', 'tasks.json')
/** Bot 之间的持久信箱；秘书可以读，但不能作为收件人。 */
const mailbox = createMailbox({ root: ROOT })

/** 每个子会话已经烧掉的真实 token，结算时由派活/单聊领走。 */
const usageBook = createUsageBook()
/** 累计簿落盘：重载插件时正在跑的那件活的已花用量不再丢。 */
const USAGE_FILE = join(ROOT, '.state', 'usage.json')
let usageTimer = null

/** 2 秒内合并一次写盘，别每步都写文件。 */
function scheduleUsagePersist() {
  if (usageTimer) return
  usageTimer = setTimeout(() => {
    usageTimer = null
    void (async () => {
      try {
        await mkdir(join(ROOT, '.state'), { recursive: true })
        await writeFile(USAGE_FILE, `${JSON.stringify(usageBook.dump(), null, 2)}\n`, 'utf8')
      } catch {
        // 写不进去不影响记账
      }
    })()
  }, 2000)
  usageTimer.unref?.()
}

/** 启动时把上次的累计簿读回来。 */
async function loadUsage() {
  try {
    usageBook.restore(JSON.parse(await readFile(USAGE_FILE, 'utf8')))
  } catch {
    // 第一次跑，没有文件
  }
}

/** 给工具层用的累计簿：读写时顺手排一次落盘。 */
const usage = {
  add(sessionId, value) {
    usageBook.add(sessionId, value)
    scheduleUsagePersist()
  },
  get(sessionId) {
    return usageBook.get(sessionId)
  },
  take(sessionId) {
    const hit = usageBook.take(sessionId)
    scheduleUsagePersist()
    return hit
  },
}

/** 另一个进程也在用这个目录时记一下：`{ pid, at }`。 */
let instanceConflict = null
const INSTANCE_FILE = join(ROOT, '.state', 'instance.json')

/** 这个 pid 还活着吗。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 声明这个目录归当前进程用；发现另一个活着的进程占着就记下来（不阻止自己跑）。
 */
async function claimInstance() {
  try {
    const raw = JSON.parse(await readFile(INSTANCE_FILE, 'utf8'))
    const pid = Number(raw?.pid)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      instanceConflict = { pid, at: Number(raw?.at) || 0 }
      await debug({ event: 'instance-conflict', pid, at: instanceConflict.at })
    }
  } catch {
    // 没有文件 = 第一个实例
  }
  try {
    await mkdir(join(ROOT, '.state'), { recursive: true })
    await writeFile(INSTANCE_FILE, `${JSON.stringify({ pid: process.pid, at: Date.now() }, null, 2)}\n`, 'utf8')
  } catch {
    // 写不进去就算了
  }
}

/** Persist the task ledger so a reload keeps the books. */
async function persistTasks() {
  try {
    await mkdir(join(ROOT, '.state'), { recursive: true })
    await writeFile(TASKS_FILE, JSON.stringify([...tasks.values()], null, 2), 'utf8')
  } catch {
    // A failed write must not break dispatch.
  }
}

/** Load the ledger written by a previous process. */
async function loadTasks() {
  try {
    const rows = JSON.parse(await readFile(TASKS_FILE, 'utf8'))
    for (const row of rows) {
      if (!row?.taskId) continue
      // 上次进程退出时还在跑的行：现在肯定没有句柄了，收成 failed。
      // 老账本里的 chat 入口行没有 doneAt，收一下，否则会一直算作在跑。
      if (row.status === 'chat' && !row.doneAt) {
        row.doneAt = row.startedAt ?? Date.now()
      }
      if (row.status === 'running' && !row.doneAt) {
        row.status = 'interrupted'
        row.doneAt = Date.now()
        row.restartInterrupted = true
        row.note = row.note || '进程重启时中断，等手动恢复整链'
      }
      // 排队等依赖的任务没起过子会话，重启后保留在队列里；
      // 秘书下次打开团队会话时自动尝试恢复，不需要重新派。
      if (row.status === 'queued' && !row.doneAt) {
        row.restartInterrupted = true
        row.note = row.note || '进程重启时仍在排队，等待自动恢复'
      }
      tasks.set(row.taskId, row)
    }
    // 迁移过的行写回磁盘，下次启动不会再算一遍。
    await persistTasks?.()
  } catch {
    // First run: nothing to load.
  }
}

/**
 * Append one line to the debug log; never throws into the host.
 * @param line - JSON-serializable record.
 */
async function debug(line) {
  try {
    await mkdir(DEBUG_DIR, { recursive: true })
    await appendFile(DEBUG_LOG, `${new Date().toISOString()} ${JSON.stringify(line)}\n`, 'utf8')
  } catch {
    // Debug logging must never break a session.
  }
}

/**
 * @param ctx - plugin context.
 * @param config - bundle config (`enabled: false` disables everything).
 */
export async function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  await debug({ event: 'apply', enabled, root: ROOT, package: PACKAGE_ROOT })
  if (MIGRATED.length > 0) {
    await debug({ event: 'data-migrated', from: PACKAGE_ROOT, to: ROOT, entries: MIGRATED })
  }
  await loadTasks()
  if (!enabled) return

  // 人设迁移（一次性）：JSON 里的 persona 搬进 memory/soul.txt，之后只认文件。
  // 老的人设文件叫 soul.md，先统一改名成 soul.txt（txt 哪台电脑都能打开）。
  try {
    let moved = 0
    let renamed = 0
    for (const bot of await loadBots(ROOT)) {
      try {
        if (await adoptSoulFile(join(ROOT, 'bots', bot.id, 'memory'))) renamed += 1
        const result = await migratePersona(ROOT, bot)
        if (result.migrated) moved += 1
      } catch (error) {
        await debug({ event: 'persona-migrate', bot: bot?.id, ok: false, error: String(error?.message ?? error) })
      }
    }
    if (moved > 0 || renamed > 0) await debug({ event: 'persona-migrate', ok: true, bots: moved, renamed })
  } catch (error) {
    await debug({ event: 'persona-migrate', ok: false, error: String(error?.message ?? error) })
  }

  // 插件自带的 Bot（审计员）：新装就有，只种一次。
  try {
    await ensureBuiltinBots(ROOT, debug)
  } catch (error) {
    await debug({ event: 'builtin-bots', ok: false, error: String(error?.message ?? error) })
  }

  try {
    await loadUsage()
    await claimInstance()
    const dispose = installChildDecoration(ctx, {
      debug,
      pending,
      tasks,
      persistTasks,
      root: ROOT,
      usageBook: usage,
      personas,
      api: TEAM_API,
    })

    // 秘书也要读团队知识库，不然它不知道 Bot 知道什么。
    // 注册返回的 disposer 必须挂到 effect 清理上，否则重载时旧段落还在，
    // 新一次注册会撞名、而且改了知识库也不会生效。
    const knowledgeOff = []
    try {
      const teamText = await readTeamMemory(ROOT)
      if (teamText !== '') {
        const agents = ctx.get('agents')
        const live = typeof agents?.list === 'function' ? agents.list() : []
        let injected = 0
        for (const agent of live) {
          const header = agent?.session?.header ?? {}
          if (header.parentSession) continue
          try {
            const off = agent.ctx.systemPrompt.section({
              name: 'dsh-team:team-knowledge',
              order: 115,
              text: `团队知识库（所有 Bot 都按这些事实干活）：\n\n${teamText}`,
            })
            if (typeof off === 'function') knowledgeOff.push(off)
            injected += 1
          } catch (error) {
            await debug({ event: 'lead-knowledge', ok: false, error: String(error?.message ?? error) })
          }
        }
        await debug({ event: 'lead-knowledge', ok: true, agents: injected, chars: teamText.length })
      }
    } catch (error) {
      await debug({ event: 'lead-knowledge', ok: false, error: String(error?.message ?? error) })
    }
    ctx.effect(() => () => {
      for (const off of knowledgeOff) {
        try {
          off()
        } catch {
          // 已卸载就忽略
        }
      }
    })
    ctx.effect(() => dispose)
  } catch (error) {
    await debug({ event: 'listener', ok: false, error: String(error?.message ?? error) })
  }

  // 人设热更新：只在用户点「编辑人设」之后开一个 30 分钟窗口盯着 soul.txt。
  // 文件一变，就把正在跑的会话里的设定段整段换掉——不关会话、不重开。
  let personaWatch = null
  try {
    personaWatch = createPersonaWatcher({
      debug,
      onChanged: async (botId) => {
        const result = await TEAM_API.refreshPersona?.(botId)
        await debug({ event: 'persona-refresh', bot: botId, refreshed: result?.refreshed ?? 0, ok: Boolean(result?.ok) })
        // 私聊那条线也立刻照新设定说话，不然用户改完人设、私聊里还是老腔调。
        try {
          const state = await readPrivateState(ROOT)
          const entry = privateEntryOf(state, botId)
          const agents = ctx.get('agents')
          // 0.7 的私聊是根会话，没有父代理可走 subagents.sendMessage，
          // 只能让宿主直接往那个会话里推一句。
          if (entry?.kind === 'private' && typeof TEAM_API.nudgePrivate === 'function') {
            const nudged = await TEAM_API.nudgePrivate({
              botId,
              text: '（设定已经更新了。按新的设定重新来一遍，一两句打个招呼就好。）',
            })
            await debug({ event: 'persona-nudge', bot: botId, ok: Boolean(nudged?.ok) })
            return
          }
          if (!entry?.sessionId) {
            // 还没私聊过：借当前这个会话当父会话，起一条私聊让它照新人设打个招呼。
            // 拿不到活着的根会话就只换热更新，等他点头像再说。
            const live = typeof agents?.list === 'function' ? agents.list() : []
            const rootAgent = live.find((agent) => {
              const header = agent?.session?.header ?? {}
              return !header.parentSession && typeof header.id === 'string' && header.id !== ''
            })
            const parentSession = rootAgent?.session?.header?.id ?? ''
            if (parentSession !== '' && typeof TEAM_API.openPrivate === 'function') {
              await TEAM_API.openPrivate({ botId, parentSession })
              await debug({ event: 'persona-greeting', bot: botId, ok: true })
            }
            return
          }
        } catch (error) {
          await debug({ event: 'persona-nudge', bot: botId, ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    ctx.effect(() => () => personaWatch?.dispose?.())
  } catch (error) {
    await debug({ event: 'persona-watch', ok: false, error: String(error?.message ?? error) })
  }

  let teamMode
  try {
    teamMode = installTeamMode(ctx, {
      root: ROOT,
      debug,
      tasks,
      mailbox,
      api: TEAM_API,
      persistTasks,
      getRoster: ({ sessionId }) => readRoster({ root: ROOT, tasks, sessionId, mailbox }),
      // 点「编辑人设」时开窗，盯一会儿文件有没有变。
      armPersona: (botId, file) => personaWatch?.arm?.(botId, file),
      getInstanceConflict: () => instanceConflict,
      // 面板里的「模型」要能列出真正可调用的模型，而不是让人手填。
      getModels: async () => {
        let llm
        try {
          llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
        } catch {
          return []
        }
        if (!llm?.listProviders || !llm?.listModels) return []
        const groups = []
        for (const provider of llm.listProviders()) {
          try {
            const models = await llm.listModels(provider.id)
            groups.push({
              provider: provider.id,
              name: provider.name ?? provider.id,
              models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
            })
          } catch {
            // 某个 provider 取不到就跳过，别拖垮整个下拉
          }
        }
        return groups
      },
      getSettings: () => SETTINGS,
      saveSettings: async (patch) => {
        Object.assign(SETTINGS, await saveSettings(ROOT, { ...SETTINGS, ...patch }))
        return SETTINGS
      },
    })
    if (teamMode?.dispose) ctx.effect(() => teamMode.dispose)
    await debug({ event: 'team-mode', ok: true })
  } catch (error) {
    await debug({ event: 'team-mode', ok: false, error: String(error?.message ?? error) })
  }

  try {
    const tools = ctx.get('tools')
    const agents = ctx.get('agents')
    const subagents = ctx.get('subagents')
    if (!tools || !agents || !subagents) {
      await debug({
        event: 'tools',
        ok: false,
        error: `missing service(s): tools=${Boolean(tools)} agents=${Boolean(agents)} subagents=${Boolean(subagents)}`,
      })
      return
    }
  const disposeTools = registerTeamTools(ctx, {
      api: TEAM_API,
      root: ROOT,
      tools,
      agents,
      subagents,
      debug,
      pending,
      tasks,
      mailbox,
      usageBook: usage,
      deliverableRoot: DELIVERABLES,
      getDeliverableRoot: () => resolveDeliverableRoot(ROOT, SETTINGS, process.env.DSH_TEAM_DELIVERABLES),
      getSettings: () => SETTINGS,
      persistTasks,

      isTeamSession: (sessionId) => Boolean(teamMode?.isEnabled?.(sessionId)),
      personas,
    })
    ctx.effect(() => disposeTools)
    // 启动扫一遍：早期删掉的 Bot 还留着私聊会话的那份，现在归档收起来。
    void TEAM_API?.prunePrivateSessions?.().catch(() => {})
    const disposeGuard = tools.guard(createWorkspaceGuard({ tasks, deliverableRoot: DELIVERABLES }))
    ctx.effect(() => disposeGuard)
    const disposeMemory = registerMemoryTools(ctx, { root: ROOT, tools, debug, pending })
    ctx.effect(() => disposeMemory)
    await debug({ event: 'tools', name: 'team_dispatch+team_recall', ok: true })
    // 启动自检：核心服务缺了就是功能不可用，先记下来（面板顶上也会报客户端那份）。
    {
      const checks = {
        subagents: Boolean(ctx.get?.('subagents')),
        systemPrompt: Boolean(ctx.get?.('systemPrompt')),
        agents: Boolean(ctx.get?.('agents')),
        agentTeams: Boolean(ctx.get?.('agentTeams')),
      }
      await debug({ event: 'selfcheck', ...checks })
      const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
      if (missing.length > 0) {
        await debug({ event: 'selfcheck-missing', missing })
      }
      // 体检报告：给人看不如给下一个维护者看。升级出问题时先读这份。
      try {
        let pluginVersion = ''
        let dshEngine = ''
        try {
          // 版本号在包目录里，不在数据目录里——以前读错了地方，体检报告永远是空的。
          const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
          pluginVersion = String(pkg.version ?? '')
          dshEngine = String(pkg.engines?.dsh ?? '')
        } catch {
          // 读不到就留空
        }
        const report = {
          kind: 'dsh-team-selfcheck',
          checkedAt: new Date().toISOString(),
          pluginVersion,
          dshEngine,
          services: checks,
          missing,
          hint: missing.length === 0
            ? '宿主依赖齐全'
            : `当前 DSH 缺这些服务：${missing.join(', ')}；对照 docs/DSH-API.md 适配`,
        }
        await writeFile(join(ROOT, '.debug', 'selfcheck.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      } catch (error) {
        await debug({ event: 'selfcheck-write-failed', error: String(error?.message ?? error) })
      }
    }

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt?.section) {
      const disposeSection = systemPrompt.section({
        name: 'dsh-team/secretary',
        order: 130,
        text: SECRETARY_RULES,
      })
      ctx.effect(() => disposeSection)
      await debug({ event: 'prompt', ok: true })
    } else {
      await debug({ event: 'prompt', ok: false, error: 'no systemPrompt service' })
    }
  } catch (error) {
    await debug({ event: 'tools', ok: false, error: String(error?.message ?? error) })
  }
}
