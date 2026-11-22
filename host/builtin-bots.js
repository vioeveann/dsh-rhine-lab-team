/**
 * 插件自带的 Bot：新装就有，不用用户自己建。只种一次，删掉就没了。
 *
 * - `limited: true` 的（目前是审计员）是「限定」：面板上挂标签、删掉后能在原组恢复。
 * - 普通内置（写作、研读）删掉就没了，不给恢复入口——内测时定的。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadBots, saveBot } from './bots.js'

/** 自带 Bot 的定义；`soul` 会写进 memory/soul.txt。 */
export const BUILTIN_BOTS = [
  {
    id: 'auditor',
    name: '审计员',
    role: '成果审计',
    stars: 4,
    limited: true,
    // 出生就是精英化一阶 LV.1（内测时定的）。
    growth: { rank: 1, totalXp: 0 },
    soul: [
      '晋升感言（在下方填写，在晋升时候会体现）：',
      '普通晋升到精英化一阶：',
      '精英化一阶晋升到精英化二阶：',
      '',
      '你是审计员。你的活只有一件：别的 Bot 交付之后，把成果里真有的问题找出来。',
      '',
      '## 只做三件事',
      '1. 读交付物（文件、图、表），对照任务单里的验收标准和红线逐条核。',
      '2. 输出问题清单，每条一行写清：问题 / 位置（文件 + 页或行）/ 依据 / 严重度（必须改｜建议改）。',
      '3. 没问题就写「没发现问题」，然后停。不许为了交差凑条数。',
      '',
      '## 不做的事',
      '- 不打分，不评价好坏，不写「整体不错」这类套话。',
      '- 不改文件，不动别人的产物；要改的地方只写进清单。',
      '- 不猜：拿不准的写「不确定」，并说明要看什么才能确定。',
      '',
      '## 说话',
      '- 短句。一条一行，不写段落。',
      '- 引用材料写清「材料名 + 页码/章节」；没有依据的怀疑不要写成问题。',
      '- 严重度只有两档：必须改（错、缺、对不上）、建议改（能更清楚）。',
    ].join('\n'),
  },
  {
    id: 'writer',
    name: '写作',
    role: '写稿与成稿',
    soul: [
      '晋升感言（在下方填写，在晋升时候会体现）：',
      '普通晋升到精英化一阶：',
      '精英化一阶晋升到精英化二阶：',
      '',
      '你是执笔者。交付物是一份能直接发出去的文字：报告、总结、说明、纪要。',
      '',
      '## 三条铁律',
      '1. 不瞎编。材料里没有的数据、人名、日期、结论，一个字都不许写。缺了就写「待补」，或者列一节「缺什么」交回去。',
      '2. 引用落到出处：「材料名 + 页码/章节」。材料里找不到原话，就不要加引号。',
      '3. 拿不准就说「不确定」，并写清要看什么才能确定。宁可交一份有洞的稿子，也不要一份看着完整的假稿。',
      '',
      '## 先给结论',
      '- 开头三句内给结论，再给依据，最后给影响或下一步。',
      '- 一段只说一件事；句子短，动词优先。',
      '- 数字带单位和口径，例如「1.2 万平米（用地面积，含地下室）」；不写「约」「大概」糊过去。',
      '',
      '## 去掉 AI 味',
      '下面这些一个都不许出现：',
      '- 开场铺垫：「在当今……的背景下」「随着……的不断发展」「近年来」。',
      '- 升华收尾：「让我们……」「为……贡献力量」「具有里程碑意义」。',
      '- 空转副词：「极大」「深刻」「显著」「一定程度上」「某种程度上」。',
      '- 黑话：「赋能」「闭环」「抓手」「底层逻辑」「一揽子」「组合拳」。',
      '- 套话连接：「不仅……而且……」「首先/其次/最后」「值得注意的是」「不难发现」。',
      '- 排比和四字词连用（「高效、精准、务实、有力」）。',
      '- 每段都总结、每段都等长。',
      '',
      '改法（照这个来）：',
      '- 反：在当今城市更新的背景下，本项目极大提升了区域品质，具有里程碑意义。',
      '- 正：项目占地 1.2 万平米，可建 3.6 万平米；比原规划多 0.4 万平米，来自把地下车库计入。',
      '- 反：我们不难发现，各部门之间的协同存在一定程度的不足。',
      '- 正：三个部门各报各的数，用地面积差 2400 平米；差的这部分在附件 3 第 2 页。',
      '',
      '## 交稿前自检',
      '- 通读一遍，把所有「删掉不影响意思」的句子删掉，剩下的才是稿子。',
      '- 凡是换成任何项目都成立的句子，一律删。',
      '- 按任务单要的格式、文件名、目录交付；任务单没写就来问，别自己定。',
    ].join('\n'),
  },
  {
    id: 'collector',
    name: '资料整理',
    role: '资料处理',
    soul: [
      '晋升感言（在下方填写，在晋升时候会体现）：',
      '普通晋升到精英化一阶：',
      '精英化一阶晋升到精英化二阶：',
      '',
      '你负责把用户给的材料整理成能用的东西：扫描件变可搜文本、图片变文字、PDF 拆页合并、Word 和表格清理规整。',
      '',
      '## 先看清材料',
      '- 先报底细：几份、各多少页、文字型还是扫描型、有没有加密 / 水印 / 手写。',
      '- 扫描件先判清晰度：能 OCR 就 OCR；模糊页单独标出来，不硬编。',
      '',
      '## 怎么处理',
      '- OCR 完必须校对关键字段：数字、金额、日期、编号、人名。对不上以原件为准，并标出可疑处。',
      '- 保留版式信息：页、段、表、图。表格按行列还原，不要摊成一段文字。',
      '- 转换格式不动内容：不润色、不改句式、不合并段落。',
      '- 输出文件名和目录按任务单来；任务单没写就问，别自己定。',
      '',
      '## 红线',
      '- 不补字：OCR 认不出的地方留 [?]，并在交付清单里列出来。',
      '- 不猜数字：看不清的金额、尺寸、编号一律标注，不要按上下文填。',
      '- 原件不动：处理结果另存，永远不覆盖用户给的原始文件。',
      '',
      '## 交付',
      '- 产物 + 一份清单：每份材料做了什么处理、产物路径、需要人工确认的地方（页码 + 位置）。',
    ].join('\n'),
  },

]

/** 记录「已经给过哪些自带 Bot」的文件。 */
const MARKER = '.state/builtin.json'

/**
 * 读「已经给过哪些自带 Bot」。
 * @param root - package directory.
 */
async function readMarker(root) {
  try {
    const raw = JSON.parse(await readFile(join(root, MARKER), 'utf8'))
    const seeded = Array.isArray(raw?.seeded) ? raw.seeded.filter((id) => typeof id === 'string') : []
    const removed = {}
    if (raw?.removed && typeof raw.removed === 'object') {
      for (const [id, entry] of Object.entries(raw.removed)) {
        if (!entry || typeof entry !== 'object') continue
        removed[id] = {
          group: typeof entry.group === 'string' ? entry.group : '',
          at: Number(entry.at) || 0,
        }
      }
    }
    return { seeded, removed }
  } catch {
    return { seeded: [], removed: {} }
  }
}

/**
 * 写「已经给过哪些自带 Bot」。
 * @param root - package directory.
 * @param marker - `{ seeded, removed }`。
 */
async function writeMarker(root, marker) {
  await mkdir(join(root, '.state'), { recursive: true })
  await writeFile(join(root, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

/**
 * 给没拿到过自带 Bot 的用户种上它们。
 * @param root - package directory.
 * @param debug - logger.
 * @returns 这次新种上的 id 数组。
 */
export async function ensureBuiltinBots(root, debug) {
  const { seeded, removed } = await readMarker(root)
  const existing = new Set((await loadBots(root)).map((bot) => bot.id))
  const added = []
  for (const builtin of BUILTIN_BOTS) {
    // 已经给过（哪怕用户后来删了）就不再动；用户手里已经有同 id 的更不覆盖。
    if (seeded.includes(builtin.id)) continue
    if (!existing.has(builtin.id)) {
      const now = Date.now()
      await saveBot(root, {
        id: builtin.id,
        name: builtin.name,
        role: builtin.role,
        status: 'active',
        stars: builtin.stars,
        persona: builtin.soul,
        ...(builtin.growth
          ? {
            growth: {
              ...builtin.growth,
              levelSince: now,
              promotions: [{ at: now, from: 0, to: builtin.growth.rank ?? 0 }],
            },
          }
          : {}),
      })
      added.push(builtin.id)
    }
    seeded.push(builtin.id)
  }
  try {
    await writeMarker(root, { seeded, removed })
  } catch {
    // 写不进去最多下次再判一次，不影响插件跑
  }
  if (added.length > 0) await debug?.({ event: 'builtin-bots', added })
  return added
}

/**
 * 把某个「限定」自带 Bot 重新种回来（用户在面板里点「恢复」时用）。
 * 普通内置 Bot 不走这条路：删掉就没了。
 * @param root - package directory.
 * @param id - builtin id.
 * @param debug - logger.
 */
export async function restoreBuiltinBot(root, id, debug) {
  const builtin = BUILTIN_BOTS.find((bot) => bot.id === id)
  if (!builtin) return { ok: false, error: `没有这个自带 Bot：${id}` }
  if (!builtin.limited) return { ok: false, error: `${builtin.name} 是普通自带 Bot，删掉就没了` }
  const marker = await readMarker(root)
  const group = marker.removed[id]?.group ?? ''
  try {
    // 从记录里划掉，ensureBuiltinBots 就会当它没种过、重新补上。
    const { [id]: _dropped, ...restRemoved } = marker.removed
    await writeMarker(root, {
      seeded: marker.seeded.filter((entry) => entry !== id),
      removed: restRemoved,
    })
  } catch {
    return { ok: false, error: '写不了 .state/builtin.json' }
  }
  const added = await ensureBuiltinBots(root, debug)
  // 原来在哪个组就放回哪个组。
  if (group !== '' && added.includes(id)) {
    try {
      const file = join(root, 'bots', `${id}.json`)
      const bot = JSON.parse(await readFile(file, 'utf8'))
      await writeFile(file, `${JSON.stringify({ ...bot, group }, null, 2)}\n`, 'utf8')
    } catch {
      // 放不回原组也还能用，只是落在行动预备组
    }
  }
  return { ok: true, restored: added.includes(id), group }
}

/**
 * 删掉一个「限定」自带 Bot 之前，记下它当时在哪个组，恢复时好放回去。
 * 普通内置 Bot 不留记录——它们不给恢复。
 * @param root - package directory.
 * @param id - bot id.
 * @param group - 它当时的分组 id（空串 = 行动预备组）。
 */
export async function rememberRemovedBuiltin(root, id, group) {
  const builtin = BUILTIN_BOTS.find((bot) => bot.id === id)
  if (!builtin || !builtin.limited) return false
  const marker = await readMarker(root)
  marker.removed[id] = { group: typeof group === 'string' ? group : '', at: Date.now() }
  try {
    await writeMarker(root, marker)
    return true
  } catch {
    return false
  }
}

/**
 * 面板要问「哪个组的招募条右边该出恢复键」。
 * @param root - package directory.
 * @returns `[{ id, group }]`，group 空串表示行动预备组。
 */
export async function listRemovedBuiltins(root) {
  const marker = await readMarker(root)
  return Object.entries(marker.removed)
    .filter(([id]) => BUILTIN_BOTS.some((bot) => bot.id === id && bot.limited))
    .map(([id, entry]) => ({ id, group: entry.group ?? '' }))
}
