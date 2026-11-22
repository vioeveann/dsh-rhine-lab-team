/**
 * Task brief: structured fields in, one prompt out.
 *
 * The free-form `task` string still works; the structured fields exist because
 * "验收标准" written as a separate line survives a long prompt, and a bot that
 * can quote the red lines behaves better than one that has to infer them.
 */

/** Section labels in the order a bot should read them. */
export const BRIEF_SECTIONS = [
  ['goal', '目标'],
  ['deliverable', '交付物'],
  ['accept', '验收标准'],
  ['redlines', '红线'],
  ['materials', '材料'],
]

/**
 * Compose the prompt for one dispatch.
 * @param spec - `{ task, goal, deliverable, accept, redlines, materials }`.
 * @returns the prompt text; never empty when `task` is given.
 */
export function buildTaskPrompt(spec) {
  const task = String(spec?.task ?? '').trim()
  const lines = []
  if (task) lines.push(task)
  for (const [key, label] of BRIEF_SECTIONS) {
    const value = String(spec?.[key] ?? '').trim()
    if (!value) continue
    lines.push(`${label}：${value}`)
  }
  if (lines.length === 0) return ''
  lines.push('做完直接回结论；写了文件就说明路径。')
  return lines.join('\n')
}
