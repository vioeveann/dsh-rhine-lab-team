import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const root = join(here, '..', '..')

test('quickstart dialog scrolls with the wheel', async ({ page }) => {
  const longText = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：这是一段用来撑开使用说明的内容。`).join('\n')
  await page.route('http://dsh-team.test/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    if (path === '/dsh-team/roster') return route.fulfill({ json: { members: [] } })
    if (path === '/dsh-team/tasks') return route.fulfill({ json: { tasks: [], recent: [] } })
    if (path === '/dsh-team/config') return route.fulfill({ json: { config: {} } })
    if (path === '/dsh-team/quickstart') return route.fulfill({ json: { ok: true, text: longText } })
    if (path === '/dsh-team/diag') return route.fulfill({ json: { ok: true } })
    if (path === '/dsh-team/avatar') return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto('http://dsh-team.test/')

  const reactPath = join(dirname(require.resolve('react/package.json')), 'umd', 'react.development.js')
  const reactDomPath = join(dirname(require.resolve('react-dom/package.json')), 'umd', 'react-dom.development.js')
  await page.addScriptTag({ path: reactPath })
  await page.addScriptTag({ path: reactDomPath })
  await page.addScriptTag({
    content: `
      window.__ModuleLoader__ = {
        load(payload) {
          window.__dshTeamModule = payload.factory((name) => {
            if (name === 'react') return window.React
            throw new Error('unexpected module: ' + name)
          })
        },
      }
    `,
  })
  await page.addScriptTag({ path: join(root, 'client.js') })

  await page.evaluate(() => {
    const noop = () => {}
    const service = {
      slots: {
        inject(name, callback) { const result = callback(); return typeof result === 'function' ? result : noop },
        register() { return noop },
      },
      sidebarRightTabs: { register: () => noop },
      sidebarRight: { openTab: noop },
    }
    const ctx = {
      ...service,
      get(name) { return service[name] },
      effect(run) { const result = run(); return typeof result === 'function' ? result : noop },
    }
    window.__dshTeamModule.apply(ctx)
    const { Panel } = window.__dshTeamModule.internals.createMembersPanel(window.React, ctx)
    window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(Panel, {}))
  })

  const help = page.getByRole('button', { name: '使用说明' })
  await expect(help).toBeVisible({ timeout: 10000 })
  await help.click()

  const dialog = page.locator('[role="dialog"]')
  const pre = dialog.locator('pre')
  await expect(pre).toBeVisible()
  await expect(pre).toContainText('第 120 行')
  const box = await pre.boundingBox()
  expect(box.height).toBeLessThan(700)
  const scrolled = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"] pre')
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top: el.scrollTop }
  })
  expect(scrolled.scrollHeight).toBeGreaterThan(scrolled.clientHeight)
  await pre.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => page.evaluate(() => document.querySelector('[role="dialog"] pre').scrollTop)).toBeGreaterThan(0)
})
