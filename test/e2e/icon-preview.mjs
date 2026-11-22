import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
const svg = readFileSync('../../icon.svg', 'utf8')
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;display:flex;gap:24px;align-items:center;background:#f4f1e8;font:12px sans-serif}
.dark{background:#141719;padding:24px;border-radius:8px;display:flex;gap:24px;align-items:center}
img{display:block}
</style><div><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="36"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="64"></div><div class="dark"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="36"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="64"></div>`
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 340, height: 160 }, deviceScaleFactor: 2 })
await page.setContent(html)
await page.screenshot({ path: '../../icon-preview.png' })
await browser.close()
