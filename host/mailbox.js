/**
 * Bot mailbox: durable, asynchronous messages between team members.
 *
 * Storage is a single append-oriented JSONL file under the data root.  Reads
 * are cheap (the file is small), so a read-modify-write is used for the rare
 * "mark as read" path.  No message can leave the team: recipients are Bot ids
 * only; the secretary may send, and may inspect a Bot's box, but cannot be a
 * recipient.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_BODY = 4000
const MAX_SUBJECT = 120
const MAX_PER_HOUR = 20

/** @param {unknown} value */
function text(value) {
  return String(value ?? '').trim()
}

/**
 * @param {{ root: string }} options
 */
export function createMailbox({ root }) {
  const dir = join(root, 'mailbox')
  const file = join(dir, 'messages.jsonl')
  /** Serialize read-modify-write so two sends in one turn cannot lose a line. */
  let chain = Promise.resolve()
  const locked = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function readAll() {
    let raw = ''
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return []
    }
    const rows = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row?.id && row?.from && row?.to) rows.push(row)
      } catch {
        // A torn last line must not hide the rest.
      }
    }
    return rows
  }

  async function writeAll(rows) {
    await mkdir(dir, { recursive: true })
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  }

  /**
   * Send one message.  Returns `{ ok, message }` or throws a user-readable error.
   */
  function send(input) {
    return locked(async () => {
      const from = text(input?.from)
      const to = text(input?.to)
      const body = text(input?.body)
      const subject = text(input?.subject) || '(无主题)'
      if (!from || !to) throw new Error('发件人和收件人都不能为空')
      if (from === to) throw new Error('不能给自己发消息')
      if (!body) throw new Error('正文不能为空')
      if (body.length > MAX_BODY) throw new Error(`正文不能超过 ${MAX_BODY} 字`)
      if (subject.length > MAX_SUBJECT) throw new Error(`主题不能超过 ${MAX_SUBJECT} 字`)

      const rows = await readAll()
      const hourAgo = Date.now() - 60 * 60 * 1000
      const recent = rows.filter((row) => row.from === from && Number(row.createdAt) >= hourAgo).length
      if (recent >= MAX_PER_HOUR) throw new Error(`发得太频繁：每小时最多 ${MAX_PER_HOUR} 条`)

      const threadId = text(input?.threadId) || `m-${randomUUID()}`
      const message = {
        id: `m-${randomUUID()}`,
        from,
        to,
        subject,
        body,
        threadId,
        taskId: text(input?.taskId) || '',
        chainId: text(input?.chainId) || '',
        createdAt: Date.now(),
        readAt: null,
      }
      rows.push(message)
      await writeAll(rows)
      return { ok: true, message, unread: rows.filter((row) => row.to === to && !row.readAt).length }
    })
  }

  /** Messages addressed to one Bot, newest first. */
  async function inbox(botId, { unreadOnly = false, limit = 50 } = {}) {
    const id = text(botId)
    const rows = (await readAll())
      .filter((row) => row.to === id && (!unreadOnly || !row.readAt))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  /** All messages in one thread, oldest first. */
  async function thread(threadId) {
    const id = text(threadId)
    return (await readAll())
      .filter((row) => row.threadId === id)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  /** Mark messages read for one recipient.  Returns the number changed. */
  function markRead(botId, ids) {
    return locked(async () => {
      const id = text(botId)
      const wanted = new Set((Array.isArray(ids) ? ids : []).map((value) => text(value)).filter(Boolean))
      if (wanted.size === 0) return 0
      const rows = await readAll()
      let changed = 0
      const now = Date.now()
      for (const row of rows) {
        if (row.to !== id || row.readAt) continue
        if (!wanted.has(row.id)) continue
        row.readAt = now
        changed += 1
      }
      if (changed > 0) await writeAll(rows)
      return changed
    })
  }

  /** Unread messages for a bot, marked read when handed to it. */
  function takeForPrompt(botId, limit = 5) {
    return locked(async () => {
      const id = text(botId)
      const rows = (await readAll())
        .filter((row) => row.to === id && !row.readAt)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))
      if (rows.length === 0) return []
      const ids = new Set(rows.map((row) => row.id))
      const now = Date.now()
      const all = await readAll()
      for (const row of all) {
        if (row.to === id && !row.readAt && ids.has(row.id)) row.readAt = now
      }
      await writeAll(all)
      return rows
    })
  }

  /** `{ botId: unreadCount }` for the roster. */
  async function unreadCounts() {
    const rows = await readAll()
    const counts = {}
    for (const row of rows) {
      if (row.readAt) continue
      if (!row.to) continue
      counts[row.to] = (counts[row.to] ?? 0) + 1
    }
    return counts
  }

  return { file, send, inbox, thread, markRead, takeForPrompt, unreadCounts }
}

/** Format unread messages for injection into a task prompt. */
export function formatMailPrompt(messages) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) return ''
  const lines = ['', '【成员信箱】你有未读消息：']
  for (const row of list) {
    lines.push(`- 来自 ${row.from}（thread ${row.threadId}）：${row.subject}`)
    lines.push(`  ${String(row.body ?? '').replace(/\n/g, '\n  ')}`)
  }
  lines.push('要回复，用 team_reply(threadId, body)；只看不回复可以用 team_inbox。')
  return lines.join('\n')
}
