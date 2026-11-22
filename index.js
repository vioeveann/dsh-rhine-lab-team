/**
 * Host half loader.
 *
 * The real implementation lives in `host/runtime.js` and is imported with a
 * cache-busting query on every activation, so editing it and toggling the
 * bundle takes effect without restarting the whole app. Only a change to this
 * file itself needs a restart.
 */
export async function apply(ctx, config = {}) {
  const url = new URL(`./host/runtime.js?t=${Date.now()}`, import.meta.url).href
  const mod = await import(url)
  return mod.apply(ctx, config)
}
