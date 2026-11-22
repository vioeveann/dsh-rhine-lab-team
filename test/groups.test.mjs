/**
 * Custom member groups: naming, ids, rename, delete, and bot assignment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroup, groupOf, loadGroups, normalizeGroups, removeGroup, renameGroup, saveGroups } from '../host/groups.js'

test('junk normalizes to an empty list', () => {
  assert.deepEqual(normalizeGroups(null), [])
  assert.deepEqual(normalizeGroups({}), [])
  assert.deepEqual(normalizeGroups([{ id: 'Bad Id', name: 'x' }]), [])
  assert.deepEqual(normalizeGroups([{ id: 'ok', name: '  ' }]), [])
})

test('duplicate ids collapse and names are trimmed', () => {
  const list = normalizeGroups([
    { id: 'a', name: ' 写作 ' },
    { id: 'a', name: '重复' },
    { id: 'b', name: '研究' },
  ])
  assert.deepEqual(list, [{ id: 'a', name: '写作' }, { id: 'b', name: '研究' }])
})

test('create derives an id from the name', () => {
  const result = createGroup([], '写作组')
  assert.equal(result.ok, true)
  assert.equal(result.groups.length, 1)
  assert.match(result.group.id, /^[a-z0-9-]+$/)
})

test('create rejects empty and duplicate names', () => {
  const first = createGroup([], '写作组')
  assert.equal(createGroup(first.groups, '  ').ok, false)
  assert.equal(createGroup(first.groups, '写作组').ok, false)
})

test('rename keeps the id and rejects collisions', () => {
  const a = createGroup([], '甲').groups
  const b = createGroup(a, '乙').groups
  const renamed = renameGroup(b, b[0].id, '丙')
  assert.equal(renamed.ok, true)
  assert.equal(renamed.groups[0].name, '丙')
  assert.equal(renamed.groups[0].id, b[0].id)
  assert.equal(renameGroup(b, b[1].id, '甲').ok, false)
})

test('delete removes only that group', () => {
  const list = createGroup(createGroup([], '甲').groups, '乙').groups
  const result = removeGroup(list, list[0].id)
  assert.equal(result.ok, true)
  assert.deepEqual(result.groups.map((g) => g.name), ['乙'])
  assert.equal(removeGroup(result.groups, 'missing').ok, false)
})

test('a bot keeps a group only while the id resolves', () => {
  const list = createGroup([], '写作组').groups
  const id = list[0].id
  assert.equal(groupOf(list, { group: id }), id)
  assert.equal(groupOf(list, { group: 'gone' }), '')
  assert.equal(groupOf(list, {}), '')
})

test('groups round-trip through disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-groups-'))
  try {
    assert.deepEqual(await loadGroups(root), [])
    const saved = await saveGroups(root, createGroup([], '写作组').groups)
    assert.equal(saved.length, 1)
    assert.deepEqual(await loadGroups(root), saved)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
