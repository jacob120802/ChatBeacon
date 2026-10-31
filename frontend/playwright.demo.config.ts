import config from './playwright.config'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  ...config,
  testMatch: 'product.demo.ts',
  timeout: 240_000,
  outputDir: '../demo-output/recording',
  reporter: 'list',
  use: { ...config.use, viewport: { width: 1920, height: 1080 }, video: { mode: 'on', size: { width: 1920, height: 1080 } } },
})
