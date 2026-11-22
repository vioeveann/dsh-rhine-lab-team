/**
 * Per-session team assignment: normalization and filtering.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botsForSession, explicitTeamBots, loadTeams, normalizeTeams, saveTeams, setSessionTeam } from '../host/teams.js'

test('junk data normalizes to an empty map', () => {
  assert.deepEqual(normalizeTeams(null), {})
  assert.deepEqual(normalizeTeams([]), {})
  assert.deepEqual(normalizeTeams('text'), {})
  assert.deepEqual(normalizeTeams({ a: 'not-array' }), {})
  assert.deepEqual(normalizeTeams({ '': ['x'] }), {})
})

test('duplicates collapse and empty lists are dropped', () => {
  assert.deepEqual(normalizeTeams({ s1: ['a', 'a', 'b'], s2: [] }), { s1: ['a', 'b'] })
})

test('a session without an assignment sees the whole roster', () => {
  assert.deepEqual(botsForSession({}, 's1', ['a', 'b']), ['a', 'b'])
  assert.deepEqual(botsForSession({ s2: ['a'] }, 's1', ['a', 'b']), ['a', 'b'])
})

test('an assignment filters and keeps roster order', () => {
  assert.deepEqual(botsForSession({ s1: ['b'] }, 's1', ['a', 'b', 'c']), ['b'])
})

test('setting an empty list removes the assignment', () => {
  const teams = setSessionTeam({ s1: ['a'] }, 's1', [])
  assert.deepEqual(teams, {})
  const added = setSessionTeam({}, 's2', ['a', 'b', 'a'])
  assert.deepEqual(added, { s2: ['a', 'b'] })
})

test('saving round-trips through disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-teams-'))
  try {
    assert.deepEqual(await loadTeams(root), {})
    const saved = await saveTeams(root, { s1: ['a'] })
    assert.deepEqual(saved, { s1: ['a'] })
    assert.deepEqual(await loadTeams(root), { s1: ['a'] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit team membership is empty until a team is set', () => {
  assert.equal(explicitTeamBots({}, 's1').size, 0)
  assert.equal(explicitTeamBots({ s2: ['a'] }, 's1').size, 0)
  assert.deepEqual([...explicitTeamBots({ s1: ['a', 'b'] }, 's1')], ['a', 'b'])
})
