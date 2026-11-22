/**
 * 整包导出：把成员、人设、记忆、头像/背景、团队知识库、设置复制出一个独立的
 * 目录快照，方便备份、迁移到另一台机器。
 *
 * 为什么不打包成 zip：Node 没有内置 zip 写入，引一个依赖只为这件事不值；
 * 导出成目录，用户能用资源管理器直接打开看、直接拷走。
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BOT_ID } from './bots.js'

/**
 * 导出目录名：`dsh-team-export-YYYYMMDD-HHmm`。
 * @param at - 时间戳。
 * @returns 目录名。
 */
export function exportFolderName(at = Date.now()) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return [
    'dsh-team-export-',
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('')
}

/**
 * 把插件目录里该带走的东西复制到目标目录。
 *
 * 带走：`bots/`（含 `_team/` 知识库、各 bot 的 memory/头像/背景图）。
 * 不带走：`.state/`（运行时状态）、`.debug/`（日志）、`.team-work/`（任务目录）、
 * `tasks.json`（任务账本）、`node_modules/`。
 *
 * @param root - 插件目录。
 * @param into - 目标父目录；实际会写进 `<into>/<导出目录名>/`。
 * @param options - `{ version, at }`，写进 manifest。
 * @returns `{ ok, path, bots, files }`。
 */
export async function exportPack(root, into, options = {}) {
  const at = Number(options.at) || Date.now()
  const target = join(String(into), exportFolderName(at))
  await mkdir(target, { recursive: true })

  // 成员目录整棵拷走（人设、记忆、头像、背景图都在里面）。
  let botIds = []
  try {
    const entries = await readdir(join(root, 'bots'), { withFileTypes: true })
    botIds = entries.filter((entry) => entry.isDirectory() && entry.name !== '_team').map((entry) => entry.name)
    // 团队知识库也在 bots/_team 里，整棵拷过去就有了。
    await cp(join(root, 'bots'), join(target, 'bots'), { recursive: true })
  } catch {
    // 还没有 bots/：导出空包也能用（团队知识库会缺）。
  }

  // 设置单独带一份：跨机器迁移时省得重填。
  let settings = null
  try {
    settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    await writeFile(join(target, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  } catch {
    settings = null
  }

  // 数一下带走了多少文件，写进 manifest 让人一眼看出包全不全。
  let files = 0
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else {
        try {
          await stat(path)
          files += 1
        } catch {
          // 读不到的跳过，不影响导出
        }
      }
    }
  }
  await walk(join(target, 'bots'))

  const manifest = {
    kind: 'dsh-team-export',
    version: String(options.version ?? ''),
    exportedAt: new Date(at).toISOString(),
    bots: botIds.sort(),
    botCount: botIds.length,
    files,
    includes: ['bots/（含记忆、人设、头像、背景图、团队知识库 _team/）', 'settings.json'],
    excludes: ['.state/', '.debug/', '.team-work/', 'tasks.json', 'node_modules/'],
    settings,
  }
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { ok: true, path: target, bots: manifest.botCount, files }
}

/**
 * 导出单个成员：一个以 id 和时间命名的目录，里面是去掉分组信息的定义 + 记忆/头像/背景。
 * 不带 group 字段——导入到哪个组由目标组决定。
 *
 * @param root - 插件目录。
 * @param into - 目标父目录。
 * @param botId - 要导出的成员 id。
 * @param options - `{ version, at }`。
 * @returns `{ ok, path, id }`。
 */
export async function exportBot(root, into, botId, options = {}) {
  const id = String(botId ?? '').trim()
  if (id === '') return { ok: false, error: '没有指定成员' }
  if (!BOT_ID.test(id)) return { ok: false, error: 'id 不合法' }
  const at = Number(options.at) || Date.now()
  const folder = `dsh-team-bot-${id}-${exportFolderName(at).replace('dsh-team-export-', '')}`
  const target = join(String(into), folder)
  await mkdir(target, { recursive: true })

  let bot
  try {
    bot = JSON.parse(await readFile(join(root, 'bots', `${id}.json`), 'utf8'))
  } catch {
    return { ok: false, error: `没有这个成员：${id}` }
  }
  // 分组不带走。
  const { group, ...rest } = bot
  await writeFile(join(target, 'bot.json'), `${JSON.stringify(rest, null, 2)}\n`, 'utf8')

  // 目录里只拷记忆与图片，别把任务缓存带出去。
  for (const name of ['memory', 'avatar.png', 'avatar.jpg', 'avatar.webp', 'background.png', 'background.jpg', 'background.webp']) {
    try {
      await cp(join(root, 'bots', id, name), join(target, name), { recursive: true })
    } catch {
      // 没有就跳过
    }
  }

  await writeFile(
    join(target, 'manifest.json'),
    `${JSON.stringify({
      kind: 'dsh-team-bot-export',
      version: String(options.version ?? ''),
      id,
      name: rest.name ?? id,
      exportedAt: new Date(at).toISOString(),
    }, null, 2)}\n`,
    'utf8',
  )
  return { ok: true, path: target, id }
}

/**
 * 从导出目录导入一个成员到指定分组。
 * 同名成员已存在时给 id 加后缀（nova-2），不覆盖别人的数据。
 *
 * @param root - 插件目录。
 * @param from - 导出目录（含 bot.json）。
 * @param group - 目标分组 id，空串表示行动预备组。
 * @returns `{ ok, id, renamed }`。
 */
export async function importBot(root, from, group = '') {
  const dir = String(from ?? '').trim()
  if (dir === '') return { ok: false, error: '没有指定导入目录' }
  let bot
  try {
    bot = JSON.parse(await readFile(join(dir, 'bot.json'), 'utf8'))
  } catch {
    return { ok: false, error: '这个目录里没有 bot.json（不是单成员导出目录）' }
  }

  const base = String(bot.id ?? '').trim() || 'bot'
  if (!BOT_ID.test(base)) return { ok: false, error: 'bot.json 里的 id 不合法' }
  let id = base
  let renamed = false
  for (let n = 2; n < 100; n += 1) {
    try {
      await readFile(join(root, 'bots', `${id}.json`), 'utf8')
      id = `${base}-${n}`
      renamed = true
    } catch {
      break
    }
  }

  const record = { ...bot, id, group: String(group ?? '') }
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(join(root, 'bots', `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  for (const name of ['memory', 'avatar.png', 'avatar.jpg', 'avatar.webp', 'background.png', 'background.jpg', 'background.webp']) {
    try {
      await cp(join(dir, name), join(root, 'bots', id, name), { recursive: true })
    } catch {
      // 没有就跳过
    }
  }
  return { ok: true, id, renamed }
}

/**
 * 从浏览器选中的目录导入（不依赖用户输路径）。
 *
 * 客户端把导出目录里的文件读成 base64 传上来；这里只认白名单路径，
 * 避免 `..` 之类的穿越，也避免把奇怪的二进制塞进 bots/。
 *
 * @param root - 插件目录。
 * @param group - 目标分组 id，空串表示行动预备组。
 * @param payload - `{ bot, files: [{ path, data }] }`，data 是 base64。
 * @returns `{ ok, id, renamed }`。
 */
export async function importBotFiles(root, group, payload) {
  const files = Array.isArray(payload?.files) ? payload.files : []
  const botJson = files.find((entry) => String(entry?.path ?? '').replace(/^\.\//, '') === 'bot.json')
  let bot = payload?.bot
  if (!bot && botJson) {
    try {
      bot = JSON.parse(Buffer.from(String(botJson.data ?? ''), 'base64').toString('utf8'))
    } catch {
      return { ok: false, error: 'bot.json 解析失败' }
    }
  }
  if (!bot || typeof bot !== 'object') return { ok: false, error: '这个目录里没有 bot.json（不是单成员导出目录）' }

  const base = String(bot.id ?? '').trim() || 'bot'
  if (!BOT_ID.test(base)) return { ok: false, error: 'bot.json 里的 id 不合法' }
  let id = base
  let renamed = false
  for (let n = 2; n < 100; n += 1) {
    try {
      await readFile(join(root, 'bots', `${id}.json`), 'utf8')
      id = `${base}-${n}`
      renamed = true
    } catch {
      break
    }
  }

  const record = { ...bot, id, group: String(group ?? '') }
  await mkdir(join(root, 'bots'), { recursive: true })
  await writeFile(join(root, 'bots', `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

  const allowed = /^(memory\/[^/]+|avatar\.(png|jpg|webp)|background\.(png|jpg|webp))$/
  for (const entry of files) {
    const path = String(entry?.path ?? '').replace(/^\.\//, '')
    if (path === 'bot.json' || path === 'manifest.json') continue
    if (!allowed.test(path)) continue
    const target = join(root, 'bots', id, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(String(entry.data ?? ''), 'base64'))
  }

  return { ok: true, id, renamed }
}
