/**
 * Team settings: one small JSON file the panel and the tools share.
 *
 * `host/runtime.js` loads it once and hands the same object around, so a save
 * from the panel takes effect on the next dispatch without reloading anything.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** 用户默认交付目录；不放在插件目录里，升级/重装不会丢。 */
export const DEFAULT_DELIVERABLE_DIR = join(homedir(), 'Documents', 'dsh-team-deliverables')

/** Defaults; also the whitelist of known keys. */
export const DEFAULT_SETTINGS = {
  /** Where `team_collect` puts deliverables. Empty means `DEFAULT_DELIVERABLE_DIR`. */
  deliverableRoot: '',
  /** 怎么称呼用户。默认「你」，不替用户决定被叫什么。 */
  address: '你',
  /** Tasks one session may run at the same time. */
  maxConcurrent: 4,
  /** One task's hard timeout, in seconds. */
  taskTimeoutSec: 3600,
  /** 子会话多久没有新事件就提醒一次，单位秒。 */
  stallWarnSec: 180,
  /** 子会话多久没有新事件就判定卡住、提前释放父会话，单位秒。 */
  stallHardSec: 300,
  /** 问过一次后，等它回话的宽限；超时才再问或停掉，单位秒。 */
  stallGraceSec: 120,
}

/**
 * Coerce a saved value onto the defaults.
 * @param raw - parsed JSON (may be anything).
 * @returns a complete settings object with sane types.
 */
export function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) }
  // null / 空串是「没填」，不是 0；只有真数字才进范围裁剪。
  const toNumber = (value) => {
    if (value === null || value === undefined || value === '') return NaN
    const number = Number(value)
    return Number.isFinite(number) ? number : NaN
  }
  const clamp = (value, min, max, fallback) => {
    const number = toNumber(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }
  return {
    deliverableRoot: String(merged.deliverableRoot ?? '').trim(),
    // 空串就是「没填」，退回「你」。
    address: String(merged.address ?? '').trim() || DEFAULT_SETTINGS.address,
    maxConcurrent: clamp(merged.maxConcurrent, 1, 8, DEFAULT_SETTINGS.maxConcurrent),
    taskTimeoutSec: clamp(merged.taskTimeoutSec, 30, 3600, DEFAULT_SETTINGS.taskTimeoutSec),
    stallWarnSec: clamp(merged.stallWarnSec, 15, 1800, DEFAULT_SETTINGS.stallWarnSec),
    stallHardSec: clamp(merged.stallHardSec, 30, 3600, DEFAULT_SETTINGS.stallHardSec),
    stallGraceSec: clamp(merged.stallGraceSec, 10, 600, DEFAULT_SETTINGS.stallGraceSec),
  }
}

/**
 * Resolve the deliverable directory for the current settings.
 * @param root - package directory.
 * @param settings - live settings object.
 * @param envRoot - environment override.
 */
export function resolveDeliverableRoot(root, settings, envRoot) {
  const fromEnv = String(envRoot ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const configured = String(settings?.deliverableRoot ?? '').trim()
  if (configured === '') return DEFAULT_DELIVERABLE_DIR
  return isAbsolute(configured) ? configured : join(root, configured)
}

/**
 * Load settings from disk, merging over the defaults.
 * @param root - package directory.
 */
export async function loadSettings(root) {
  const file = join(root, '.state', 'config.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return normalizeSettings(parsed)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Write settings back to disk.
 * @param root - package directory.
 * @param settings - settings object to persist (normalized on the way).
 */
export async function saveSettings(root, settings) {
  const normalized = normalizeSettings(settings)
  const file = join(root, '.state', 'config.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}
