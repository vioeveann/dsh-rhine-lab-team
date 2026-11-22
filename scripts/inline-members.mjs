/**
 * DEPRECATED — do not run.
 *
 * 客户端现在以 client.js 为唯一来源（面板直接写在里面）。
 * src/client/members.js 已落后，跑这个脚本会把面板写回旧版。
 * 保留此文件只为历史参考。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const panelPath = join(root, 'src', 'client', 'members.js')
const clientPath = join(root, 'client.js')

let panel = readFileSync(panelPath, 'utf8')
panel = panel.replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ')

let client = readFileSync(clientPath, 'utf8')
if (client.includes('function createMembersPanel')) {
  console.log('client.js already contains the panel; nothing to do')
  process.exit(0)
}

const importMarker = '    return {\n      inject:'
if (!client.includes(importMarker)) {
  throw new Error('client.js: cannot find the module return block')
}
client = client.replace(importMarker, `${panel}\n${importMarker}`)
client = client.replace("      inject: ['slots'],", "      inject: ['slots', 'sidebarRightTabs'],")
client = client.replace('      apply(ctx) {', '      apply(ctx) {\n        createMembersPanel(React).register(ctx)')

writeFileSync(clientPath, client, 'utf8')
console.log('inlined members panel into client.js')
