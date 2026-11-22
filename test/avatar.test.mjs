/**
 * Avatars: one image per bot, replaced rather than accumulated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AVATAR_EXTS, findAvatar, saveAvatar } from '../host/bots.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Throwaway package root. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-avatar-'))
  return root
}

test('no avatar yields null', async () => {
  const root = await fixture()
  try {
    assert.equal(await findAvatar(root, 'nova'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('saving an avatar makes it findable with a content type', async () => {
  const root = await fixture()
  try {
    const result = await saveAvatar(root, 'nova', PNG, 'png')
    assert.equal(result.ok, true)
    const found = await findAvatar(root, 'nova')
    assert.equal(found.ext, 'png')
    assert.equal(found.type, 'image/png')
    const bytes = await readFile(found.path)
    assert.deepEqual(bytes, PNG)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a new avatar replaces the old extension', async () => {
  const root = await fixture()
  try {
    await saveAvatar(root, 'nova', PNG, 'png')
    await saveAvatar(root, 'nova', Buffer.from('<svg></svg>'), 'svg')
    const found = await findAvatar(root, 'nova')
    assert.equal(found.ext, 'svg')
    await assert.rejects(stat(join(root, 'bots', 'nova', 'avatar.png')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bad ids, formats, empty and oversized files are refused', async () => {
  const root = await fixture()
  try {
    assert.equal((await saveAvatar(root, 'Nova!', PNG, 'png')).ok, false)
    assert.equal((await saveAvatar(root, 'nova', PNG, 'gif')).ok, false)
    assert.equal((await saveAvatar(root, 'nova', Buffer.alloc(0), 'png')).ok, false)
    assert.equal((await saveAvatar(root, 'nova', Buffer.alloc(1024 * 1024 + 1), 'png')).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the accepted extension list is the documented one', () => {
  assert.deepEqual(AVATAR_EXTS, ['png', 'jpg', 'jpeg', 'webp', 'svg'])
})

test('默认头像是一张写着 BOT 的工牌：所有 Bot 一样', async () => {
  const { placeholderAvatar } = await import('../host/team-mode.js')
  const svg = placeholderAvatar()
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="128" height="128"/)
  assert.match(svg, /<rect width="128" height="128" fill="#E7DDC8"\/>/)
  // 卡套 + 卡面 + 彩条 + 色块，全是矩形
  assert.ok((svg.match(/<rect/g) ?? []).length >= 10, '工牌要有卡套、卡面和几块色')
  assert.match(svg, /fill="#F5EEDC"/, '浅色卡套')
  assert.match(svg, /fill="#C23A2B"/, '红色（LIMITED / 底部红块）')
  assert.match(svg, /fill="#E4B44C"/, '金色')
  assert.match(svg, />BOT</, '卡面上写 BOT')
  // 只有 BOT 这三个字母，不要别的字
  assert.equal((svg.match(/<text/g) ?? []).length, 1)
  assert.equal(placeholderAvatar(), svg, '默认头像对所有 Bot 一致')
})

test('审计员专用头像：卡面写「审计」，其余 Bot 还是 BOT', async () => {
  const { placeholderAvatar } = await import('../host/team-mode.js')
  assert.match(placeholderAvatar(), />BOT</)
  const audit = placeholderAvatar('审计')
  assert.match(audit, />审计</)
  assert.doesNotMatch(audit, />BOT</, '审计员那张不写 BOT')
  assert.match(audit, /font-size="22"/, '两个字字号收一点')
})

test('只有限定的审计员用「审计」头像，普通自带 Bot 还是 BOT', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../host/team-mode.js', import.meta.url), 'utf8')
  assert.match(source, /entry\.limited === true/)
  assert.doesNotMatch(source, /const builtin = BUILTIN_BOTS\.find/, '不能只按 id 命中就给审计字样')
})

test('卡片头像 URL 带版本号，默认头像不让浏览器缓存', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const host = await readFile(new URL('../host/team-mode.js', import.meta.url), 'utf8')
  assert.match(client, /avatar\?bot=\$\{encodeURIComponent\(member\.id\)\}&v=3/)
  assert.match(host, /'cache-control': 'no-store'/)
})
