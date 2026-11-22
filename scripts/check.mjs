#!/usr/bin/env node
// 跨平台语法检查：node --check 不认 shell 通配符（Windows npm 下 host/*.js 不会展开）。
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = ['client.js', 'index.js']
for (const name of readdirSync(join(root, 'host'))) {
  if (name.endsWith('.js')) files.push(join('host', name))
}

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}
if (failed > 0) process.exit(1)
console.log(`syntax ok: ${files.length} files`)
