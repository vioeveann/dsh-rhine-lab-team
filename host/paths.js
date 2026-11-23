/**
 * 插件的数据目录。
 *
 * 插件本体是 npm 包：升级、重装、pnpm 换版本都会把包目录整个换掉。所以运行期
 * 数据（Bot 名册、记忆、头像、任务账本、团队知识库）一律不能放在包目录里——
 * 0.5.0 升级时就这么丢过用户自己建的 Bot。
 *
 * 数据目录：`$DSH_TEAM_HOME`，没设就是 `$DSH_HOME/rhine-lab-team`
 * （`DSH_HOME` 没设就是 `~/.dsh/rhine-lab-team`）。
 * 包目录里还留着旧数据的（0.4.x 及更早），启动时搬一次，只搬目标不存在的。
 */
import { cp, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 包目录里可能残留的运行期数据；按这个顺序搬。
 *
 * 只要用户在面板里能改的东西，都在这几样里，升级一律不许丢：
 *  - `bots/`        名册、人设（soul.txt）、项目记忆、头像、卡片背景、团队知识库（`bots/_team`）
 *  - `.state/`      设置、自定义分组、会话级队伍、任务账本、用量、自带 Bot 的种植记录
 *  - `.team-work/`  单聊与任务的工作目录
 *  - `.debug/`      运行日志（不是用户内容，但一起搬过去省得两处翻）
 */
export const LEGACY_ENTRIES = ['bots', '.state', '.team-work', '.debug']

/**
 * 解析数据目录。
 * @returns 数据目录的绝对路径。
 */
export function resolveDataRoot() {
  const override = String(process.env.DSH_TEAM_HOME ?? '').trim()
  if (override !== '') return override
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'rhine-lab-team')
}

/**
 * 判断一个路径存不存在（不跟随符号链接的细节，只回答「有没有东西」）。
 * @param path - 目标路径。
 * @returns 存在为 true。
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 把包目录里的旧数据搬到数据目录。只搬目标不存在的条目，搬过的不覆盖。
 *
 * 搬完不删旧目录：删用户数据这种决定不该由一次升级自动做，旧目录下次装新版本
 * 时自然会被替换掉。日志里记一条，用户想清理自己去清。
 *
 * @param packageRoot - 插件包目录。
 * @param dataRoot - 解析好的数据目录。
 * @returns 实际搬过去的条目名。
 */
export async function migrateDataRoot(packageRoot, dataRoot) {
  if (!packageRoot || !dataRoot || packageRoot === dataRoot) return []
  const moved = []
  for (const entry of LEGACY_ENTRIES) {
    const from = join(packageRoot, entry)
    const to = join(dataRoot, entry)
    if (!(await exists(from))) continue
    if (await exists(to)) continue
    await mkdir(dataRoot, { recursive: true })
    await cp(from, to, { recursive: true, force: false, errorOnExist: false })
    moved.push(entry)
  }
  return moved
}
