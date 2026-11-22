/**
 * 整包导出：复制成员目录 + 设置 + manifest，不带走运行时垃圾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBot, exportFolderName, exportPack, importBot, importBotFiles } from '../host/export.js'

test('exportBot rejects an unsafe id', async () => {
  const root = await fakeRoot()
  const into = await mkdtemp(join(tmpdir(), 'dsh-out-'))
  const result = await exportBot(root, into, '../../evil')
  assert.equal(result.ok, false)
  assert.match(result.error, /id/)
})

test('importBot rejects a bot.json whose id can escape the bots directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  const src = await mkdtemp(join(tmpdir(), 'dsh-bot-src-'))
  await writeFile(join(src, 'bot.json'), JSON.stringify({ id: '../../evil', name: 'Evil' }), 'utf8')
  const result = await importBot(root, src, 'g-1')
  assert.equal(result.ok, false)
  assert.match(result.error, /id/)
  await assert.rejects(() => readFile(join(root, '..', 'evil.json'), 'utf8'))
})

test('importBotFiles rejects a bot.json whose id can escape the bots directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  const encode = (text) => Buffer.from(text, 'utf8').toString('base64')
  const result = await importBotFiles(root, 'g-1', {
    files: [{ path: 'bot.json', data: encode(JSON.stringify({ id: '../../evil' })) }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /id/)
})

/** 造一个假的插件目录：两个成员、一份人设、一份团队知识、一个设置文件。 */
async function fakeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-export-'))
  await mkdir(join(root, 'bots', 'nova', 'memory'), { recursive: true })
  await mkdir(join(root, 'bots', '_team'), { recursive: true })
  await writeFile(join(root, 'bots', 'nova.json'), '{"id":"nova","name":"Nova"}\n', 'utf8')
  await writeFile(join(root, 'bots', 'nova', 'memory', 'soul.txt'), '我是 Nova。\n', 'utf8')
  await writeFile(join(root, 'bots', '_team', 'knowledge.md'), '# 团队知识库\n', 'utf8')
  await writeFile(join(root, 'settings.json'), '{"maxConcurrent":4}\n', 'utf8')
  // 运行时垃圾：不该出现在导出包里
  await mkdir(join(root, '.state'), { recursive: true })
  await writeFile(join(root, '.state', 'builtin.json'), '{}\n', 'utf8')
  return root
}

test('导出包目录名带时间戳', () => {
  const name = exportFolderName(new Date('2026-11-22T03:04:05').getTime())
  assert.equal(name, 'dsh-team-export-20261122-0304')
})

test('导出会带走成员、人设、团队知识库和设置，不带走运行时状态', async () => {
  const root = await fakeRoot()
  const into = await mkdtemp(join(tmpdir(), 'dsh-out-'))
  const result = await exportPack(root, into, { version: '1.2.3', at: new Date('2026-11-22T03:04:05').getTime() })

  assert.equal(result.ok, true)
  assert.equal(result.bots, 1, '只算真成员，不算 _team')
  assert.ok(result.path.startsWith(into), '导出目录要在指定的父目录下')

  const manifest = JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8'))
  assert.equal(manifest.kind, 'dsh-team-export')
  assert.equal(manifest.version, '1.2.3')
  assert.deepEqual(manifest.bots, ['nova'])
  // nova.json + soul.txt + _team/knowledge.md
  assert.equal(manifest.files, 3)
  assert.deepEqual(manifest.excludes.includes('.state/'), true)

  const soul = await readFile(join(result.path, 'bots', 'nova', 'memory', 'soul.txt'), 'utf8')
  assert.match(soul, /我是 Nova/)
  const team = await readFile(join(result.path, 'bots', '_team', 'knowledge.md'), 'utf8')
  assert.match(team, /团队知识库/)
  const settings = JSON.parse(await readFile(join(result.path, 'settings.json'), 'utf8'))
  assert.equal(settings.maxConcurrent, 4)

  const top = await readdir(result.path)
  assert.equal(top.includes('.state'), false, '运行时状态不该被打包')
})

test('单成员导出不带分组，导入到指定组并处理同名', async () => {
  const root = await fakeRoot()
  await writeFile(join(root, 'bots', 'nova.json'), '{"id":"nova","name":"Nova","group":"g-1"}\n', 'utf8')
  const into = await mkdtemp(join(tmpdir(), 'dsh-out-'))

  const exported = await exportBot(root, into, 'nova', { at: new Date('2026-11-22T03:04:05').getTime() })
  assert.equal(exported.ok, true)
  const record = JSON.parse(await readFile(join(exported.path, 'bot.json'), 'utf8'))
  assert.equal('group' in record, false, '导出不该带分组')

  const first = await importBot(root, exported.path, 'g-2')
  assert.equal(first.ok, true)
  assert.equal(first.id, 'nova-2', '同名要改 id')
  const saved = JSON.parse(await readFile(join(root, 'bots', 'nova-2.json'), 'utf8'))
  assert.equal(saved.group, 'g-2', '导入到哪个组就归哪个组')
  assert.equal(saved.name, 'Nova')
})

test('从浏览器选的目录导入：只认白名单路径，并归到指定组', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-'))
  await mkdir(join(root, 'bots'), { recursive: true })
  const bot = { id: 'nova', name: 'Nova', group: 'g-old' }
  const encode = (text) => Buffer.from(text, 'utf8').toString('base64')

  const result = await importBotFiles(root, 'g-new', {
    files: [
      { path: 'bot.json', data: encode(JSON.stringify(bot)) },
      { path: 'memory/project.md', data: encode('# 记忆\n') },
      { path: '../../evil.txt', data: encode('nope') },
      { path: 'memory/../../evil.md', data: encode('nope') },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.id, 'nova')
  const saved = JSON.parse(await readFile(join(root, 'bots', 'nova.json'), 'utf8'))
  assert.equal(saved.group, 'g-new', '导入到哪个组就归哪个组')
  const memory = await readFile(join(root, 'bots', 'nova', 'memory', 'project.md'), 'utf8')
  assert.match(memory, /记忆/)
  // 穿越路径不该落地
  await assert.rejects(() => readFile(join(root, 'evil.txt'), 'utf8'))
})
