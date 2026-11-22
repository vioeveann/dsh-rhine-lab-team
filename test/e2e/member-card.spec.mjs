/**
 * Browser smoke test: load the real client bundle, apply it to a mock DSH
 * context, and render a `member` fence. This catches broken JSX/loader/DOM
 * assumptions that the Node-side fake-React tests cannot.
 */
import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const root = join(here, '..', '..')

test('member card renders name, roster and latest status in a real browser', async ({ page }) => {
  await page.route('http://dsh-team.test/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    }
    if (path === '/dsh-team/roster') {
      return route.fulfill({
        json: {
          members: [{
            id: 'collector',
            name: '资料整理',
            role: '资料处理',
            note: '',
            stars: 3,
            label: '普通 Lv.20',
            lv: 20,
          }],
        },
      })
    }
    if (path === '/dsh-team/task') return route.fulfill({ json: { task: null } })
    if (path === '/dsh-team/avatar') return route.fulfill({ status: 404, body: '' })
    if (path === '/dsh-team/diag') return route.fulfill({ json: { ok: true } })
    return route.fulfill({ status: 404, body: '' })
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

  const loaded = await page.evaluate(async () => {
    const components = new Map()
    const noop = () => {}
    const service = {
      slots: {
        inject(name, callback) {
          const result = callback()
          return typeof result === 'function' ? result : noop
        },
        register(definition, component) {
          components.set(`${definition.name}:${definition.key ?? ''}`, component)
          return noop
        },
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
    window.__fenceComponent = components.get('conversation.chat.markdown.fence:member')
    return [...components.keys()]
  })
  expect(loaded).toContain('conversation.chat.markdown.fence:member')
  expect(await page.evaluate(() => Boolean(window.__fenceComponent))).toBe(true)

  await page.evaluate(async () => {
    const code = [
      'id: collector',
      'role: 资料处理',
      'status: ready',
      'task: t-mwrlf2rr33wv',
      'body: 简报已交付，数字都能指回 data.md。',
    ].join('\n')
    const element = window.React.createElement(window.__fenceComponent, {
      code,
      streaming: false,
      children: null,
    })
    window.ReactDOM.createRoot(document.getElementById('root')).render(element)
  })

  const card = page.locator('[data-dsh-team-card="collector"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('资料整理')
  await expect(card).toContainText('@collector')
  await expect(card).toContainText('资料处理')
  await expect(card).toContainText('等你验收')
  await expect(card).toContainText('简报已交付')
  await expect(card).toContainText('t-mwrlf2rr33wv')
})
