/**
 * Bot roster on disk: one JSON per bot under `bots/`, plus a memory skeleton.
 *
 * Keeping the roster as files was the first step; this module is what makes it
 * editable from the panel instead of by hand.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyGrowth, normalizeGrowth } from './growth.js'
import { isMigrated, markMigrated, signGrowth, verifyGrowth } from './integrity.js'

/** Legal bot ids: lower-case letters, digits, dash, starting with a letter. */
export const BOT_ID = /^[a-z][a-z0-9-]{0,23}$/

/**
 * Validate and normalize one roster input.
 * @param input - raw request body.
 * @param options - `{ allowGrowth }`; only the explicit roster-import path sets it.
 * @returns `{ ok: true, bot }` or `{ ok: false, error }`.
 */
export function normalizeBot(input, options = {}) {
  const id = String(input?.id ?? '').trim().toLowerCase()
  if (!BOT_ID.test(id)) {
    return { ok: false, error: 'id 只能是小写字母、数字和短横线，字母开头，最长 24 个字符' }
  }
  const name = String(input?.name ?? '').trim() || id
  const role = String(input?.role ?? '').trim()
  const persona = String(input?.persona ?? '').trim()
  if (role === '') return { ok: false, error: '职责不能为空' }
  if (persona.length > 4000) return { ok: false, error: '人设太长了（上限 4000 字）' }
  const model = String(input?.model ?? '').trim()
  const group = String(input?.group ?? '').trim()
  // 星级 1–6；0/空表示不评。
  const starsRaw = Number(input?.stars ?? 0)
  const stars = Number.isInteger(starsRaw) && starsRaw >= 1 && starsRaw <= 6 ? starsRaw : 0
  // 备注：允许文字和符号，限长。
  const note = String(input?.note ?? '').trim().slice(0, 40)
  // 卡片背景遮罩强度：0 = 不铺白，1 = 默认；没传就保持原值。
  const bgOpacityRaw = Number(input?.bgOpacity)
  const bgOpacity = input?.bgOpacity === undefined
    ? null
    : Math.min(1, Math.max(0, Number.isFinite(bgOpacityRaw) ? bgOpacityRaw : 1))
  // 卡片字重：300–900，没传就保持原值。
  const weightRaw = Number(input?.fontWeight)
  const fontWeight = input?.fontWeight === undefined
    ? null
    : Math.min(900, Math.max(300, Math.round(Number.isFinite(weightRaw) ? weightRaw : 400)))
  const bot = {
    id,
    name,
    role,
    persona,
    ...(model === '' ? {} : { model }),
    ...(group === '' ? {} : { group }),
    ...(stars === 0 ? {} : { stars }),
    ...(note === '' ? {} : { note }),
    ...(bgOpacity === null ? {} : { bgOpacity }),
    ...(fontWeight === null ? {} : { fontWeight }),
    // 原生「启用智能体团队协作」：不传就保持原值，传 false 才关。
    ...(input?.agentTeam === undefined ? {} : { agentTeam: input.agentTeam === true }),
  }
  // 成长只走 growth-store 的服务端结算；请求体里带的 growth 一律丢掉，
  // 避免一句「把我改成 Lv.90」通过保存接口直接写等级。
  // 例外（allowGrowth）只给成员备份的显式导入用：那是用户自己恢复的存档。
  const growth = options.allowGrowth && input?.growth !== undefined
    ? normalizeGrowth(input.growth)
    : null
  // 能力卡：只接受 allow / deny 两个字符串数组，其余丢弃。
  const tools = input?.capability?.tools
  const list = (value) => (Array.isArray(value) ? value.map(String).filter((name) => name !== '') : [])
  const allow = list(tools?.allow)
  const deny = list(tools?.deny)
  if (allow.length > 0 || deny.length > 0) {
    bot.capability = { tools: { ...(allow.length > 0 ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) } }
  }
  if (growth !== null) bot.growth = growth
  return { ok: true, bot }
}

/**
 * Reset a growth record that was edited without going through `saveBot`.
 * Legacy records without a signature get one free migration (then signed);
 * after that, a missing or wrong signature is treated as tampering.
 * @param root - package directory.
 * @param bot - parsed bot JSON.
 */
async function guardGrowth(root, bot) {
  if (!bot?.growth) {
    // 没有成长记录的 Bot 也算「已纳入签名」：以后有人手写一个 growth
    // 字段进来，会因为没有签名而被当成篡改，而不是白捡一次迁移。
    await markMigrated(root, bot.id)
    return bot
  }
  if (await verifyGrowth(root, bot.id, bot.growth, bot.integrity)) return bot
  if (!bot.integrity && !(await isMigrated(root, bot.id))) {
    // First load after upgrading: trust the current record once and sign it.
    await saveBot(root, bot)
    return bot
  }
  bot.growth = emptyGrowth()
  delete bot.integrity
  bot.growthReset = true
  try {
    await saveBot(root, bot)
  } catch {
    // If the reset cannot be written, still show the safe in-memory value.
  }
  return bot
}

/**
 * Read every bot definition.
 * @param root - package directory.
 * @param ids - optional id filter.
 */
export async function loadBots(root, ids) {
  let files = []
  try {
    files = (await readdir(join(root, 'bots'))).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const wanted = Array.isArray(ids) ? new Set(ids) : null
  const bots = []
  for (const file of files.sort()) {
    try {
      const bot = JSON.parse(await readFile(join(root, 'bots', file), 'utf8'))
      if (wanted && !wanted.has(bot.id)) continue
      bots.push(await guardGrowth(root, bot))
    } catch {
      // A broken file must not hide the rest of the roster.
    }
  }
  return bots
}

/**
 * Write one bot definition, creating its memory skeleton when new.
 * @param root - package directory.
 * @param bot - normalized bot.
 */
export async function saveBot(root, bot) {
  const dir = join(root, 'bots')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${bot.id}.json`)
  let existing = null
  try {
    existing = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    existing = null
  }
  const merged = { ...(existing ?? {}), ...bot }
  // 老存档里的 elite 字段顺手迁成 rank，下一次保存就定型。
  if (merged.growth) {
    merged.growth = normalizeGrowth(merged.growth)
  }
  // 星级上限跟段位：普通 4 星，精英化一阶及以上 6 星。
  const rank = Number(merged?.growth?.rank) || 0
  // 星级上限跟段位：普通 4 星、精英化一阶 5 星、精英化二阶 6 星。
  const starCap = rank >= 2 ? 6 : rank === 1 ? 5 : 4
  merged.stars = Math.min(starCap, Math.max(0, Number(merged.stars) || 0))
  // 老存档没有「到达当前等级的时间」，补一个，排序才有依据。
  if (merged.growth && !(Number(merged.growth.levelSince) > 0)) {
    merged.growth.levelSince = Date.now()
  }
  // 签名放在所有会改 growth 的补全之后：合法写入（结算、晋升、教学、重置）
  // 都会重签；手改 JSON 不会。
  if (merged.growth) {
    merged.integrity = await signGrowth(root, merged.id, merged.growth)
  }
  // 人设只存在 `memory/soul.txt` 一份：JSON 不再落 persona，
  // 否则文件里改了、JSON 里那份还在注入，会「改了不生效」。
  const { persona: incomingPersona, ...rest } = merged
  await writeFile(file, `${JSON.stringify(rest, null, 2)}\n`, 'utf8')
  await markMigrated(root, merged.id)
  const memoryDir = join(dir, bot.id, 'memory')
  await mkdir(memoryDir, { recursive: true })
  const soul = join(memoryDir, 'soul.txt')
  const project = join(memoryDir, 'project.md')
  try {
    await readFile(soul, 'utf8')
  } catch {
    const seed = String(incomingPersona ?? bot.persona ?? '').trim()
    await writeFile(
      soul,
      `# ${bot.name} · 灵魂\n\n${seed === '' ? '（在这里写它是谁、守什么规矩）' : seed}\n`,
      'utf8',
    )
  }
  try {
    await readFile(project, 'utf8')
  } catch {
    await writeFile(project, `# ${bot.name} · 项目记忆（一行一条，[标签] 开头）\n`, 'utf8')
  }
  return rest
}

/** soul 文件的占位句：出现它就算没写过人设。 */
export const SOUL_PLACEHOLDER = '（在这里写它是谁'

/**
 * 人设文件早先叫 `soul.md`，现在统一成 `soul.txt`（哪台电脑都能双击打开）。
 * 已经有 `soul.txt` 就不动；否则把 `.md` 改名过来。
 *
 * @param memoryDir - `bots/<id>/memory`。
 * @returns 是否改名了。
 */
export async function adoptSoulFile(memoryDir) {
  const md = join(memoryDir, 'soul.md')
  const txt = join(memoryDir, 'soul.txt')
  try {
    await stat(txt)
    return false
  } catch {
    // 还没有 .txt，看老的 .md
  }
  let text
  try {
    text = await readFile(md, 'utf8')
  } catch {
    return false
  }
  await writeFile(txt, text, 'utf8')
  try {
    const { rm } = await import('node:fs/promises')
    await rm(md)
  } catch {
    // 删不掉就留着，反正以后只读 .txt
  }
  return true
}

/**
 * One-time migration: move an old JSON `persona` into `memory/soul.txt`.
 *
 * The file wins when it already has real content — a hand-edited soul is never
 * overwritten. Either way the JSON field is dropped afterwards, so there is
 * only one source of truth from then on.
 *
 * @param root - package directory.
 * @param bot - the bot as loaded from JSON.
 * @returns `{ migrated, soulWritten }`.
 */
export async function migratePersona(root, bot) {
  const id = String(bot?.id ?? '')
  const persona = String(bot?.persona ?? '').trim()
  if (id === '' || persona === '') return { migrated: false, soulWritten: false }
  const memoryDir = join(root, 'bots', id, 'memory')
  const soul = join(memoryDir, 'soul.txt')
  let existing = ''
  try {
    existing = await readFile(soul, 'utf8')
  } catch {
    existing = ''
  }
  const blank = existing.trim() === '' || existing.includes(SOUL_PLACEHOLDER)
  let soulWritten = false
  if (blank) {
    await mkdir(memoryDir, { recursive: true })
    await writeFile(soul, `# ${bot.name ?? id} · 灵魂\n\n${persona}\n`, 'utf8')
    soulWritten = true
  }
  const { persona: _dropped, ...rest } = bot
  await writeFile(join(root, 'bots', `${id}.json`), `${JSON.stringify(rest, null, 2)}\n`, 'utf8')
  return { migrated: true, soulWritten }
}

/**
 * Remove a bot from the roster but keep its memory directory.
 * @param root - package directory.
 * @param id - bot id.
 */
/**
 * 彻底删掉一个 Bot：定义文件 + 整个目录（记忆、头像、背景图）一起删。
 * 这条不可恢复，调用方要先让用户确认。
 * @param root - package directory.
 * @param id - bot id.
 */
export async function deleteBot(root, id) {
  const { rm } = await import('node:fs/promises')
  const target = String(id ?? '').trim()
  if (!BOT_ID.test(target)) return { ok: false, error: 'id 不合法' }
  try {
    await rm(join(root, 'bots', `${target}.json`), { force: true })
    await rm(join(root, 'bots', target), { recursive: true, force: true })
    return { ok: true, id: target }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Extensions we accept for a bot avatar, in preference order. */
export const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg']

/** Content type per avatar extension. */
export const AVATAR_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * Find a bot's avatar file.
 * @param root - package directory.
 * @param id - bot id.
 * @returns `{ path, ext, type }` or null.
 */
export async function findAvatar(root, id) {
  if (!BOT_ID.test(String(id ?? ''))) return null
  for (const ext of AVATAR_EXTS) {
    const file = join(root, 'bots', id, `avatar.${ext}`)
    try {
      await stat(file)
      return { path: file, ext, type: AVATAR_TYPES[ext] }
    } catch {
      // try the next extension
    }
  }
  return null
}

/**
 * Store one avatar, replacing any previous one.
 * @param root - package directory.
 * @param id - bot id.
 * @param bytes - raw image bytes.
 * @param ext - one of {@link AVATAR_EXTS}.
 */
export async function saveAvatar(root, id, bytes, ext) {
  if (!BOT_ID.test(String(id ?? ''))) return { ok: false, error: 'id 不合法' }
  if (!AVATAR_EXTS.includes(ext)) return { ok: false, error: `不支持的图片格式：${ext}` }
  if (!bytes || bytes.length === 0) return { ok: false, error: '图片是空的' }
  if (bytes.length > 1024 * 1024) return { ok: false, error: '头像不能超过 1 MB' }
  const dir = join(root, 'bots', id)
  await mkdir(dir, { recursive: true })
  const { rm } = await import('node:fs/promises')
  for (const other of AVATAR_EXTS) {
    if (other === ext) continue
    try {
      await rm(join(dir, `avatar.${other}`))
    } catch {
      // nothing to remove
    }
  }
  await writeFile(join(dir, `avatar.${ext}`), bytes)
  return { ok: true, id, ext }
}

/** 卡片背景允许的格式（不比头像，不用 svg）。 */
export const BACKGROUND_EXTS = ['png', 'jpg', 'jpeg', 'webp']

/**
 * Find a bot's card background.
 * @param root - package directory.
 * @param id - bot id.
 * @returns `{ path, ext, type, at }` or null.
 */
export async function findBackground(root, id) {
  if (!BOT_ID.test(String(id ?? ''))) return null
  for (const ext of BACKGROUND_EXTS) {
    const file = join(root, 'bots', id, `background.${ext}`)
    try {
      const info = await stat(file)
      return { path: file, ext, type: AVATAR_TYPES[ext], at: info.mtimeMs }
    } catch {
      // try the next extension
    }
  }
  return null
}

/**
 * Store one card background, replacing any previous one.
 * @param root - package directory.
 * @param id - bot id.
 * @param bytes - raw image bytes.
 * @param ext - png / jpg / jpeg / webp.
 */
export async function saveBackground(root, id, bytes, ext) {
  if (!BOT_ID.test(String(id ?? ''))) return { ok: false, error: 'id 不合法' }
  if (!BACKGROUND_EXTS.includes(ext)) return { ok: false, error: `不支持的图片格式：${ext}` }
  if (!bytes || bytes.length === 0) return { ok: false, error: '图片是空的' }
  if (bytes.length > 3 * 1024 * 1024) return { ok: false, error: '背景图不能超过 3 MB' }
  const dir = join(root, 'bots', id)
  await mkdir(dir, { recursive: true })
  const { rm } = await import('node:fs/promises')
  for (const other of BACKGROUND_EXTS) {
    if (other === ext) continue
    try {
      await rm(join(dir, `background.${other}`))
    } catch {
      // nothing to remove
    }
  }
  await writeFile(join(dir, `background.${ext}`), bytes)
  return { ok: true, id, ext }
}

/**
 * Remove a bot's card background.
 * @param root - package directory.
 * @param id - bot id.
 */
export async function clearBackground(root, id) {
  if (!BOT_ID.test(String(id ?? ''))) return { ok: false, error: 'id 不合法' }
  const { rm } = await import('node:fs/promises')
  for (const ext of BACKGROUND_EXTS) {
    try {
      await rm(join(root, 'bots', id, `background.${ext}`))
    } catch {
      // nothing to remove
    }
  }
  return { ok: true, id }
}

/**
 * Rename one bot: the id is also its directory name, so both move together.
 * @param root - package directory.
 * @param from - current id.
 * @param to - next id.
 */
export async function renameBot(root, from, to) {
  const fromId = String(from ?? '').trim()
  const toId = String(to ?? '').trim().toLowerCase()
  if (!BOT_ID.test(fromId) || !BOT_ID.test(toId)) return { ok: false, error: 'id 不合法' }
  if (fromId === toId) return { ok: true, id: toId, unchanged: true }

  const { rename } = await import('node:fs/promises')
  const fromJson = join(root, 'bots', `${fromId}.json`)
  const toJson = join(root, 'bots', `${toId}.json`)
  try {
    await stat(toJson)
    return { ok: false, error: `已经有叫 ${toId} 的成员了` }
  } catch {
    // Target is free.
  }

  let bot
  try {
    bot = JSON.parse(await readFile(fromJson, 'utf8'))
  } catch {
    return { ok: false, error: `找不到 ${fromId}` }
  }

  await writeFile(toJson, `${JSON.stringify({ ...bot, id: toId }, null, 2)}\n`, 'utf8')
  const { rm } = await import('node:fs/promises')
  await rm(fromJson)
  try {
    await rename(join(root, 'bots', fromId), join(root, 'bots', toId))
  } catch {
    // No memory directory yet: the definition still moved.
  }
  return { ok: true, id: toId }
}
