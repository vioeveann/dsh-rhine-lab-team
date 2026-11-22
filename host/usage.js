/**
 * Real token usage, taken from the model stream.
 *
 * Every model step publishes one `usage` chunk on the assistant stream, and the
 * amounts are per request (not cumulative across the conversation), so a
 * child session's cost is their sum. This is the only place a plugin can see
 * them: `SubagentResult` carries no usage, and a plugin cannot call the
 * provider back for a billing report.
 *
 * The numbers land in the task ledger as `entry.tokens`. Rows written before
 * this existed only kept `entry.chars` (a character count); new rows no longer
 * write it — characters were never a cost measure and the hourly character
 * gate they served has been removed.
 */

/** Legacy rows have no tokens: fall back to the old 1 token ≈ 1.3 字 rule. */
export const CHARS_PER_TOKEN = 1.3

/**
 * Turn one provider usage payload into our own shape.
 *
 * `totalTokens` is what the provider charged for that request; when it is
 * missing we add the parts up. An all-zero payload (a failed request) is not
 * worth a row, so it returns `null`.
 *
 * @param raw - `TokenUsage`-shaped object from a `usage` chunk.
 * @returns `{ input, output, cacheRead, cacheWrite, total, steps }` or null.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const input = num(raw.inputTokens ?? raw.promptTokens)
  const output = num(raw.outputTokens ?? raw.completionTokens)
  const cacheRead = num(raw.cacheReadTokens)
  const cacheWrite = num(raw.cacheWriteTokens)
  const reported = num(raw.totalTokens)
  const total = reported > 0 ? reported : input + output + cacheRead + cacheWrite
  if (total === 0) return null
  return { input, output, cacheRead, cacheWrite, total, steps: 1 }
}

/**
 * Pull usage out of one `agent/assistant-stream` payload.
 *
 * The listener receives `{ agent, frame }`, but scoped dispatch hands some
 * callers the frame itself, so both shapes are accepted.
 *
 * @param event - event payload or a bare frame.
 * @returns normalized usage, or null when this frame carries none.
 */
export function usageOfFrame(event) {
  const frame = event?.frame ?? event
  if (!frame || frame.type !== 'chunk') return null
  const chunk = frame.chunk ?? frame
  if (chunk?.type !== 'usage') return null
  return normalizeUsage(chunk.usage ?? chunk)
}

/**
 * Add two normalized usages without mutating either.
 * @param a - earlier usage or null.
 * @param b - newer usage or null.
 */
export function mergeUsage(a, b) {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    steps: a.steps + b.steps,
  }
}

/**
 * Per-session accumulator: the stream is the only writer, tasks read it once
 * when they settle.
 * @returns `{ add, get, take, clear }`.
 */
export function createUsageBook() {
  const book = new Map()
  return {
    /** @param sessionId - child session id. @param usage - normalized usage. */
    add(sessionId, usage) {
      if (!sessionId || !usage) return
      book.set(sessionId, mergeUsage(book.get(sessionId) ?? null, usage))
    },
    /** @param sessionId - child session id. @returns a copy, or null. */
    get(sessionId) {
      const hit = book.get(sessionId)
      return hit ? { ...hit } : null
    },
    /**
     * Read and forget: a settled task owns what it spent, so a later chat on
     * the same session cannot be counted twice.
     * @param sessionId - child session id. @returns a copy, or null.
     */
    take(sessionId) {
      const hit = book.get(sessionId)
      if (!hit) return null
      book.delete(sessionId)
      return { ...hit }
    },
    clear() {
      book.clear()
    },
    /** Snapshot for persistence: `{ [sessionId]: usage }`. */
    dump() {
      const out = {}
      for (const [sessionId, usage] of book) out[sessionId] = { ...usage }
      return out
    },
    /**
     * Load a previously dumped snapshot (reload keeps in-flight numbers).
     * @param raw - parsed usage.json.
     */
    restore(raw) {
      if (!raw || typeof raw !== 'object') return
      for (const [sessionId, usage] of Object.entries(raw)) {
        if (!sessionId || !usage || typeof usage !== 'object') continue
        book.set(sessionId, {
          input: Number(usage.input) || 0,
          output: Number(usage.output) || 0,
          cacheRead: Number(usage.cacheRead) || 0,
          cacheWrite: Number(usage.cacheWrite) || 0,
          total: Number(usage.total) || 0,
          steps: Number(usage.steps) || 0,
        })
      }
    },
  }
}

/**
 * Old ledger rows only kept character counts; new rows do not write `chars`,
 * so this path only ever sees history.
 * @param chars - characters of bot output.
 */
export function estimateTokensFromChars(chars) {
  const n = Math.max(0, Number(chars) || 0)
  return Math.round(n / CHARS_PER_TOKEN)
}

/**
 * Sum a bot's token spend across ledger rows.
 *
 * Rows written after this feature carry real usage; older ones fall back to the
 * character estimate, flagged as `partial` so the card can say `≈`.
 *
 * @param entries - ledger rows (already filtered by the caller).
 * @returns `{ real, estimated, partial, input, output, cacheRead }`.
 */
export function sumTaskTokens(entries) {
  let real = 0
  let estimated = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let legacy = 0
  for (const entry of entries ?? []) {
    const total = Number(entry?.tokens?.total)
    if (Number.isFinite(total) && total > 0) {
      real += total
      input += Number(entry.tokens.input) || 0
      output += Number(entry.tokens.output) || 0
      cacheRead += Number(entry.tokens.cacheRead) || 0
      continue
    }
    const chars = Number(entry?.chars)
    if (Number.isFinite(chars) && chars > 0) {
      legacy += 1
      estimated += estimateTokensFromChars(chars)
    }
  }
  return { real, estimated, partial: legacy > 0, input, output, cacheRead }
}
