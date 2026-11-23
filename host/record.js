/**
 * 一件任务的 Markdown 记录。
 *
 * 只是排版：账本里有什么就写什么，缺的字段整段不写，不编造没有的信息。
 * 文件列表由调用方读好传进来，这里不碰文件系统，方便直接测。
 */

/** 输出摘要最多留这么多字，多了截断并注明。 */
export const RECORD_OUTPUT_MAX = 1000

/** 任务单字段的排版顺序，跟派活时读的顺序一致。 */
const BRIEF_FIELDS = [
  ['goal', '目标'],
  ['deliverable', '交付物'],
  ['accept', '验收标准'],
  ['redlines', '红线'],
  ['materials', '材料'],
]

const pad = (value) => String(value).padStart(2, '0')

/**
 * 本地时间，`YYYY-MM-DD HH:mm`；团队规矩里日期就是这个格式。
 * @param at - timestamp.
 * @returns the formatted time, or '' when the timestamp is missing.
 */
export function stamp(at) {
  const ts = Number(at)
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 用时写成「3 分 12 秒」这种。
 * @param from - start timestamp.
 * @param to - end timestamp.
 */
export function duration(from, to) {
  const start = Number(from)
  const end = Number(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  const seconds = Math.round((end - start) / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/**
 * 文件大小写成 KB / MB。
 * @param bytes - size in bytes.
 */
export function sizeText(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Build the record.
 * @param entry - one ledger row.
 * @param options - `{ botName, files: [{ name, size }], now }`.
 * @returns Markdown text.
 */
export function buildTaskRecord(entry, options = {}) {
  const taskId = String(entry?.taskId ?? '').trim() || 'unknown'
  const bot = String(entry?.bot ?? '').trim()
  const botName = String(options.botName ?? '').trim()
  const lines = [`# 任务记录 ${taskId}`, '']

  lines.push(`- Bot：${botName === '' || botName === bot ? bot : `${botName}（${bot}）`}`)
  const status = String(entry?.status ?? '').trim()
  const verdict = String(entry?.verdict ?? '').trim()
  if (status !== '') {
    // 状态和验收结论一样时不重复写（accepted / accepted 很蠢）。
    const suffix = verdict !== '' && verdict !== status ? ` / ${verdict}` : ''
    lines.push(`- 状态：${status}${suffix}`)
  }
  const started = stamp(entry?.startedAt)
  if (started !== '') {
    const ended = stamp(entry?.doneAt)
    const elapsed = duration(entry?.startedAt, entry?.doneAt)
    lines.push(`- 开始：${started}`)
    if (ended !== '') lines.push(`- 结束：${ended}${elapsed === '' ? '' : `（用时 ${elapsed}）`}`)
  }
  const tokens = Number(entry?.tokens?.total)
  if (Number.isFinite(tokens) && tokens > 0) {
    const parts = [`输入 ${Number(entry.tokens.input) || 0}`, `输出 ${Number(entry.tokens.output) || 0}`]
    if (Number(entry.tokens.cacheRead) > 0) parts.push(`缓存读 ${Number(entry.tokens.cacheRead)}`)
    lines.push(`- token：${tokens}（${parts.join(' / ')}）`)
  }
  const cwd = String(entry?.cwd ?? '').trim()
  if (cwd !== '') lines.push(`- 任务目录：${cwd}`)
  const parent = String(entry?.parentSession ?? '').trim()
  if (parent !== '') lines.push(`- 父会话：${parent}`)
  const session = String(entry?.sessionId ?? '').trim()
  if (session !== '') lines.push(`- 子会话：${session}`)
  if (Array.isArray(entry?.dependsOn) && entry.dependsOn.length > 0) {
    const mode = entry.dependsOnMode === 'accepted' ? '（验收后放行）' : ''
    lines.push(`- 依赖${mode}：${entry.dependsOn.join('、')}`)
  }
  const blockedBy = String(entry?.blockedBy ?? '').trim()
  if (blockedBy !== '') lines.push(`- 阻塞：${blockedBy}`)
  if (entry?.review === true) {
    const audit = entry.reviewTaskId ? `（审计任务 ${entry.reviewTaskId}）` : ''
    lines.push(`- 审查：需要审计通过后才能验收${audit}`)
  }

  const brief = entry?.brief ?? {}
  const task = String(brief.task ?? '').trim()
  const fields = BRIEF_FIELDS
    .map(([key, label]) => [label, String(brief[key] ?? '').trim()])
    .filter(([, value]) => value !== '')
  if (task !== '' || fields.length > 0) {
    lines.push('', '## 任务单', '')
    if (task !== '') lines.push(task, '')
    for (const [label, value] of fields) lines.push(`- ${label}：${value}`)
  }

  if (entry?.verdict || entry?.note || entry?.evidence) {
    lines.push('', '## 验收', '')
    if (entry?.verdict) lines.push(`- 结论：${entry.verdict}`)
    const reviewed = stamp(entry?.reviewedAt)
    if (reviewed !== '') lines.push(`- 时间：${reviewed}`)
    const note = String(entry?.note ?? '').trim()
    if (note !== '') lines.push(`- 意见：${note}`)
    const evidence = String(entry?.evidence ?? '').trim()
    if (evidence !== '') lines.push(`- 依据：${evidence}`)
  }

  const files = Array.isArray(options.files) ? options.files : []
  lines.push('', '## 产物', '')
  if (files.length === 0) {
    lines.push('（任务目录里没有文件）')
  } else {
    for (const file of files) {
      const name = String(file?.name ?? '').trim()
      if (name === '') continue
      const size = sizeText(file?.size)
      lines.push(`- ${name}${size === '' ? '' : `（${size}）`}`)
    }
  }

  const output = String(entry?.output ?? '').trim()
  if (output !== '') {
    lines.push('', '## 输出摘要', '')
    const cut = output.length > RECORD_OUTPUT_MAX
    const body = cut ? `${output.slice(0, RECORD_OUTPUT_MAX)}…` : output
    lines.push(...body.split('\n').map((line) => `> ${line}`))
    if (cut) lines.push('', `（原文 ${output.length} 字，这里只留前 ${RECORD_OUTPUT_MAX} 字）`)
  }

  lines.push('', '---', `导出时间：${stamp(options.now ?? Date.now())}`, '')
  return lines.join('\n')
}
