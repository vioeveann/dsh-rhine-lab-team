/**
 * 任务记录导出：排版对不对、缺字段会不会写成空的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECORD_OUTPUT_MAX, buildTaskRecord, duration, sizeText, stamp } from '../host/record.js'

const entry = {
  taskId: 't-abc',
  bot: 'nova',
  status: 'ready',
  startedAt: 1_700_000_000_000,
  doneAt: 1_700_000_192_000,
  chars: 1234,
  cwd: 'F:\\工作区\\.team-work\\nova\\t-abc',
  parentSession: 'session-parent',
  sessionId: 'session-child',
  brief: {
    task: '核对这份材料的退线',
    goal: '确认容积率没错',
    deliverable: '一张对照表',
    accept: '每个数字都有出处',
    redlines: '不许改原文件',
    materials: 'D:/材料/方案.pdf',
  },
  verdict: 'accepted',
  reviewedAt: 1_700_000_200_000,
  note: '引用了页码，通过',
  evidence: '方案.pdf 第 3 章',
  output: '结论：退线满足要求。',
}

test('a full record has the task, the review and the files', () => {
  const md = buildTaskRecord(entry, {
    botName: 'Nova',
    files: [{ name: 'report.md', size: 2048 }, { name: 'from-previous-x', size: 10 }],
    now: 1_700_000_300_000,
  })
  assert.match(md, /^# 任务记录 t-abc/m)
  assert.match(md, /Bot：Nova（nova）/)
  assert.match(md, /状态：ready \/ accepted/)
  assert.match(md, /核对这份材料的退线/)
  // 任务单字段按固定顺序
  const order = ['目标：确认容积率没错', '交付物：一张对照表', '验收标准：每个数字都有出处', '红线：不许改原文件', '材料：D:/材料/方案.pdf']
  const positions = order.map((needle) => md.indexOf(needle))
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1], `${order[index]} 应该排在 ${order[index - 1]} 后面`)
  }
  assert.match(md, /## 验收/)
  assert.match(md, /结论：accepted/)
  assert.match(md, /意见：引用了页码，通过/)
  assert.match(md, /依据：方案.pdf 第 3 章/)
  assert.match(md, /## 产物/)
  assert.match(md, /report\.md（2\.0 KB）/)
  assert.match(md, /## 输出摘要/)
  assert.match(md, /导出时间：/)
})

test('a bare record does not print empty sections as blanks', () => {
  const md = buildTaskRecord({ taskId: 't-empty', bot: 'forge', status: 'failed' }, { now: 1 })
  assert.match(md, /# 任务记录 t-empty/)
  assert.ok(!md.includes('## 任务单'), '没有任务单就不该写标题')
  assert.ok(!md.includes('## 验收'), '没验收就不该写标题')
  assert.match(md, /（任务目录里没有文件）/)
  assert.ok(!md.includes('## 输出摘要'))
})

test('状态和验收结论相同时不重复写', () => {
  const md = buildTaskRecord({ taskId: 't-dup', bot: 'x', status: 'accepted', verdict: 'accepted' }, { now: 1 })
  assert.match(md, /状态：accepted\n/)
  assert.ok(!md.includes('accepted / accepted'))
})

test('a long output is quoted, capped and marked', () => {
  const md = buildTaskRecord(
    { taskId: 't-long', bot: 'x', output: '字'.repeat(RECORD_OUTPUT_MAX + 50) },
    { now: 1 },
  )
  assert.match(md, /^> 字/m)
  assert.match(md, new RegExp(`只留前 ${RECORD_OUTPUT_MAX} 字`))
})

test('time and size helpers read like Chinese', () => {
  assert.match(stamp(1_700_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(stamp(0), '')
  assert.equal(duration(0, 3_000), '3 秒')
  assert.equal(duration(0, 192_000), '3 分 12 秒')
  assert.equal(duration(0, 7_200_000), '2 小时 0 分')
  assert.equal(duration(10, 5), '')
  assert.equal(sizeText(900), '900 B')
  assert.equal(sizeText(2048), '2.0 KB')
  assert.equal(sizeText(3 * 1024 * 1024), '3.0 MB')
  assert.equal(sizeText(-1), '')
})
