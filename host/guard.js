/**
 * Narrow workspace guard.
 *
 * The subagent runtime gives every child its own `cwd`, but the sandbox policy
 * still inherits the parent's workspace root. This guard is the part we can
 * enforce inside the plugin: file-mutation tools may only touch the task's own
 * directory. Shell commands are still governed by the DSH sandbox (the whole
 * workspace), so this is deliberately documented as a narrow guard, not a
 * complete sandbox.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'ops_write', 'ops_edit', 'fs_write', 'fs_edit'])
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target']

function inside(base, target) {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function targetPath(args) {
  if (!args || typeof args !== 'object') return null
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * Build a ToolGuard for the team's child sessions.
 * @param {{ tasks: Map<string, any>, deliverableRoot?: string }} options
 */
export function createWorkspaceGuard({ tasks, deliverableRoot = '' }) {
  return function workspaceGuard(execution) {
    const name = String(execution?.name ?? '')
    if (!MUTATION_TOOLS.has(name) && name !== 'team_collect') return undefined

    const sessionId = execution?.agent?.session?.id
    if (!sessionId) return undefined
    const entry = [...tasks.values()].find((row) => row?.sessionId === sessionId)
    if (!entry) return undefined

    // The auditor is read-only at the sandbox layer too; this is a second lock.
    if (entry.bot === 'auditor') {
      return '审计任务只读，不能修改文件。'
    }

    if (name === 'team_collect') return undefined
    if (name === 'apply_patch') {
      return '团队任务不允许用 apply_patch 改文件；请用 write / edit 写到任务目录。'
    }

    const cwd = entry.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      return '这个任务没有记录工作目录，拒绝写入。'
    }
    const raw = targetPath(execution.arguments)
    if (!raw) return '写入工具没有给出文件路径，拒绝执行。'
    const target = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
    if (!inside(resolve(cwd), target)) {
      return `任务只能写自己的工作目录：${cwd}。要交付文件，先写到任务目录，再用 team_collect 收。`
    }
    if (deliverableRoot && inside(resolve(deliverableRoot), target)) {
      return '交付目录由 team_collect 统一收，Bot 不能直接写。'
    }
    return undefined
  }
}
