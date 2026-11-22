/**
 * 晋升感言：人设里写了就抄原文，没写就用固定一句。不再让模型现编。
 */

/** 人设里写了晋升感言时的上限。 */
export const SPEECH_MAX = 160

/** 人设里没写晋升感言时的固定文案：不叫 AI 现编，统一这一句。 */
export const DEFAULT_SPEECH = '感谢您的支持与鼓励，我会继续努力做得更好！'

/**
 * 人设里是不是已经规定了晋升感言怎么写/说什么。
 * 认「晋升感言」这四个字就够：写的是这个，就照它来，不再限 40 字。
 * @param soul - memory/soul.txt 的正文。
 */
export function personaHasSpeech(soul) {
  return String(soul ?? '').includes('晋升感言')
}

/**
 * Compose the prompt that asks a bot for its promotion speech.
 * 只在「人设里写了晋升感言」时才会走到这里。
 * @param spec - `{ bot, fromLabel, toLabel, level, teaches, teachTags, tasks, goodRate }`.
 * @returns the prompt text; never empty.
 */

/**
 * 从人设里抠出晋升感言的原文。
 *
 * 约定：人设里写一行「晋升感言：<要说的那句>」；也可以写一个小标题
 * 「## 晋升感言」下面跟一两行。抄的是原文，一个字不改。
 * @param soul - memory/soul.txt 的正文。
 * @returns 感言原文；人设里没有就返回空串。
 */
const STAGES = [
  { rank: 1, label: '普通晋升到精英化一阶', re: /普通\s*晋升到\s*精英化一阶/ },
  { rank: 2, label: '精英化一阶晋升到精英化二阶', re: /精英化一阶\s*晋升到\s*精英化二阶/ },
]

/**
 * 去掉整体包裹的引号、收一下空白；这些是排版符号，不是要念出来的字。
 * @param raw - 原始文字。
 */
function tidy(raw) {
  const text = String(raw ?? '').trim()
  return text.replace(/^["'“”「『\s]+/, '').replace(/["'“”」』\s]+$/, '').trim()
}

/**
 * 这条内容看起来是说明而不是感言？（模板抬头括号里那句就是说明。）
 * @param text - 冒号后面的内容。
 */
function looksLikeHint(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return false
  if (/^[（(]/.test(raw)) return true
  return /填写|会体现|留空/.test(raw)
}

/**
 * 取「标签：内容」里冒号后面的部分；没有冒号就当作没有内容。
 * @param line - 一行文字。
 */
function afterColon(line) {
  const match = /^[^：:]*[：:]([\s\S]*)$/.exec(String(line ?? ''))
  // 没有冒号就说明这不是「标签：内容」，返回空串——标题行不能被当成感言。
  return match ? match[1].trim() : ''
}

/**
 * 从人设里抠出这一阶的晋升感言原文。
 *
 * 人设里的写法（建议照抄模板）：
 *   晋升感言：
 *   普通晋升到精英化一阶：<这一阶要说的那句>
 *   精英化一阶晋升到精英化二阶：<这一阶要说的那句>
 *
 * 这次升到哪一阶就抄哪一条，标签本身不算内容。只写了一行、没有阶段标注的，
 * 就在任意阶段都用它。没有可用的内容时返回空串，调用方会退回固定文案。
 * @param soul - memory/soul.txt 的正文。
 * @param toRank - 这次要升到的段位（1 或 2）。
 * @returns 感言原文；没有就返回空串。
 */
export function extractPersonaSpeech(soul, toRank = 1) {
  const lines = String(soul ?? '').replace(/\r\n?/g, '\n').split('\n')
  const head = lines.findIndex((line) => line.includes('晋升感言'))
  if (head < 0) return ''

  const rank = Number(toRank) === 2 ? 2 : 1
  const stage = STAGES.find((entry) => entry.rank === rank)

  // 先找对应阶段那一行。
  const stageIndex = lines.findIndex((line) => stage.re.test(line))
  if (stageIndex >= 0) {
    const inline = tidy(afterColon(lines[stageIndex]))
    if (inline !== '' && !looksLikeHint(inline)) return inline.slice(0, SPEECH_MAX)
    // 标签后面空着：看下面几行，遇到空行/标题/另一个阶段标签就停。
    const collected = []
    for (let i = stageIndex + 1; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (line === '' || line.startsWith('#') || STAGES.some((entry) => entry.re.test(line))) break
      collected.push(line)
    }
    const block = tidy(collected.join(' '))
    if (block !== '') return block.slice(0, SPEECH_MAX)
    return ''
  }

  // 没有阶段标注：直接用「晋升感言：」后面的内容（任意阶段通用）。
  const inline = tidy(afterColon(lines[head]))
  if (inline !== '' && !looksLikeHint(inline)) return inline.slice(0, SPEECH_MAX)
  const collected = []
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) break
    collected.push(line)
  }
  return tidy(collected.join(' ')).slice(0, SPEECH_MAX)
}
