import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('发布元数据与 LICENSE 齐全', async () => {
  const root = join(here, '..')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.private, undefined, '开源包不能是 private')
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.repository?.url, '要有 repository')
  assert.ok(pkg.homepage, '要有 homepage')
  assert.ok(pkg.bugs?.url, '要有 bugs')
  await access(join(root, 'LICENSE'))
})

test('npm 包不带个人 / 测试 Bot、记忆与内部开发史', async () => {
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const files = pkg.files ?? []
  assert.equal(files.includes('bots'), false, 'files 不能整目录收 bots')
  assert.equal(files.includes('docs'), false, 'docs 要按文件列，避免 HANDOFF 混进去')
  assert.equal(files.includes('docs/HANDOFF.md'), false, 'HANDOFF 不进包')
  assert.equal(files.some((entry) => entry.startsWith('bots')), false)
  assert.ok(files.includes('cordis.patch.yml'), 'bundle patch 必须进包')
})

test('npm pack 实际内容不含 bots / HANDOFF', () => {
  const root = join(here, '..')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  assert.equal(result.status, 0, result.stderr)
  const pack = JSON.parse(result.stdout)[0]
  const paths = new Set(pack.files.map((file) => file.path))
  assert.ok(paths.has('cordis.patch.yml'), 'bundle patch 要在包里')
  assert.ok(paths.has('LICENSE'), 'LICENSE 要在包里')
  assert.equal([...paths].some((path) => path === 'docs/HANDOFF.md'), false)
  assert.equal([...paths].some((path) => path.startsWith('bots/')), false)
  assert.equal([...paths].some((path) => path.startsWith('test/')), false)
})

test('插件头像与介绍到位', async () => {
  const root = join(here, '..')
  const svg = await readFile(join(root, 'icon.svg'), 'utf8')
  assert.match(svg, /viewBox="0 0 64 64"/, '头像用 64 网格')
  assert.match(svg, />Rhine</, '头像中间写 Rhine')
  assert.match(svg, />Lab  Team</, '头像中间写 Lab Team')
  const zh = JSON.parse(await readFile(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(zh.meta.title, 'dsh-rhine-lab-team', '插件名用英文')
  assert.match(zh.meta.description, /工作团队/)
  assert.match(zh.meta.description, /明日方舟/, '要说明灵感受明日方舟影响')
})

test('README 有安装小节和默认交付目录', async () => {
  const readme = await readFile(join(here, '..', 'README.md'), 'utf8')
  assert.match(readme, /## 安装/)
  assert.match(readme, /dsh plugin add dsh-rhine-lab-team/)
  assert.match(readme, /dsh-team-deliverables/)
})

test('头像插件是团队插件的依赖：装团队时一并装最新版', async () => {
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const range = pkg.dependencies?.['dsh-avatar-frame']
  assert.equal(range, 'latest', 'package.json 里把 dsh-avatar-frame 声明为 latest')
})

test('安装团队插件时一并启用头像插件', async () => {
  const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: dsh-rhine-lab-team/, '要有团队插件自己的入口')
  assert.match(patch, /id: dsh-avatar-frame/, '要自动启用头像插件（子会话头像与 ID 靠它）')
})

test('README 写清与同类头像插件的冲突', async () => {
  const readme = await readFile(join(here, '..', 'README.md'), 'utf8')
  assert.match(readme, /与同类插件的冲突/, '要有冲突提示小节')
  assert.match(readme, /关掉其中一个/, '要说清怎么处理')
})
