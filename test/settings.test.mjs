/**
 * Settings: normalization, persistence and deliverable-root resolution.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DELIVERABLE_DIR,
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  resolveDeliverableRoot,
  saveSettings,
} from '../host/settings.js'

test('an empty or broken file yields defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-settings-'))
  try {
    assert.deepEqual(await loadSettings(root), DEFAULT_SETTINGS)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('numbers are clamped into a workable range', () => {
  const settings = normalizeSettings({ maxConcurrent: 99, taskTimeoutSec: 1 })
  assert.equal(settings.maxConcurrent, 8)
  assert.equal(settings.taskTimeoutSec, 30)
})

test('junk values fall back instead of corrupting the object', () => {
  const settings = normalizeSettings({ maxConcurrent: 'abc', taskTimeoutSec: null })
  assert.equal(settings.maxConcurrent, DEFAULT_SETTINGS.maxConcurrent)
  assert.equal(settings.taskTimeoutSec, DEFAULT_SETTINGS.taskTimeoutSec)
})

test('a retired key is dropped instead of carried around', () => {
  const settings = normalizeSettings({ maxConcurrent: 3, charsPerHour: 160_000 })
  assert.equal(settings.maxConcurrent, 3)
  assert.equal('charsPerHour' in settings, false)
})

test('saving normalizes and round-trips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-settings-save-'))
  try {
    const saved = await saveSettings(root, { maxConcurrent: 3, deliverableRoot: 'out' })
    assert.equal(saved.maxConcurrent, 3)
    const raw = JSON.parse(await readFile(join(root, '.state', 'config.json'), 'utf8'))
    assert.equal(raw.deliverableRoot, 'out')
    assert.deepEqual(await loadSettings(root), saved)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the deliverable root prefers env, then settings, then the default', () => {
  const root = join(tmpdir(), 'repo')
  const absolute = process.platform === 'win32' ? 'D:/abs' : '/abs'
  assert.equal(resolveDeliverableRoot(root, { deliverableRoot: '' }, ''), DEFAULT_DELIVERABLE_DIR)
  assert.equal(resolveDeliverableRoot(root, { deliverableRoot: 'out' }, ''), join(root, 'out'))
  assert.equal(resolveDeliverableRoot(root, { deliverableRoot: 'out' }, join(tmpdir(), 'deliver')), join(tmpdir(), 'deliver'))
  assert.equal(resolveDeliverableRoot(root, { deliverableRoot: absolute }, ''), absolute)
})

test('称谓默认「你」，可以改成别的，空串回落', async () => {
  const { normalizeSettings } = await import('../host/settings.js')
  assert.equal(normalizeSettings({}).address, '你')
  assert.equal(normalizeSettings({ address: '博士' }).address, '博士')
  assert.equal(normalizeSettings({ address: '   ' }).address, '你')
})
