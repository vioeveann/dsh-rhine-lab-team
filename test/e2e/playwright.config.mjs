import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    headless: true,
    viewport: { width: 900, height: 700 },
    channel: process.env.PW_CHANNEL || undefined,
  },
})
