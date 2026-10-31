import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setupDashboard } from './fixtures'
import { POLL_OVERLAY_HTML } from '../../backend/src/pollOverlay'

test('record a clearly labelled synthetic product walkthrough', async ({ page }) => {
  const output = resolve('../demo-output')
  await mkdir(output, { recursive: true })
  const state = await setupDashboard(page)
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div')
      label.textContent = 'PRODUCT DEMONSTRATION · Synthetic chat, votes and AI responses · No live Twitch connection'
      label.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:12px;text-align:center;font:600 17px system-ui;background:#27213e;color:#f0eaff;border-top:1px solid #9e85df'
      document.body.append(label)
    })
  })
  const sceneTimes: { name: string; startMs: number; durationMs: number }[] = []
  const beginning = Date.now()
  async function scene(name: string, durationMs: number, action: () => Promise<void>) {
    const start = Date.now()
    await action()
    await page.screenshot({ path: resolve(output, `${name}.png`) })
    await page.waitForTimeout(Math.max(0, durationMs - (Date.now() - start)))
    sceneTimes.push({ name, startMs: start - beginning, durationMs: Date.now() - start })
  }
  await scene('01-introduction', 20_000, async () => {
    await page.goto('/')
    await expect(page.getByText('Live', { exact: true })).toBeVisible()
  })
  await scene('02-getting-started', 20_000, async () => {
    await page.getByRole('button', { name: 'Dark theme' }).click()
    await page.waitForTimeout(3000)
    await page.getByRole('button', { name: 'Dark theme' }).click()
    await page.getByRole('link', { name: 'Chat Tracker', exact: true }).click()
  })
  await scene('03-questions', 25_000, async () => {
    const queue = page.locator('.questions-panel')
    const card = queue.locator('article').first()
    await card.getByRole('button', { name: /Set priority:/ }).click()
    await card.getByRole('button', { name: 'Mark question for follow-up' }).click()
    await queue.getByRole('button', { name: /^Follow up/ }).click()
    await page.waitForTimeout(2500)
    await card.getByRole('button', { name: 'Mark follow-up question answered' }).click()
    await queue.getByRole('button', { name: /^All/ }).click()
  })
  await scene('04-community', 20_000, async () => {
    await page.getByRole('link', { name: 'Community Pulse', exact: true }).click()
    await page.getByRole('button', { name: 'Analyze chat' }).click()
    await expect(page.getByText('Supporting messages')).toBeVisible()
  })
  await scene('05-poll-review', 25_000, async () => {
    const pulse = page.locator('#community-pulse')
    await pulse.getByRole('button', { name: 'Suggest a poll' }).click()
    await pulse.getByLabel('Poll question', { exact: true }).fill('Which challenge should we play next stream?')
    await pulse.getByLabel('Poll answer option 2').fill('Solo speed run')
    await page.waitForTimeout(3000)
    await pulse.getByRole('button', { name: 'Start this poll' }).click()
    await page.getByRole('link', { name: 'Beacon Pulse', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Close poll' })).toBeVisible()
  })
  await scene('06-votes-overlay', 20_000, async () => {
    state.poll!.totalVotes = 4
    state.poll!.options[0]!.votes = 3
    state.poll!.options[1]!.votes = 1
    await expect(page.getByText('4 total votes', { exact: true })).toBeVisible()
    await page.waitForTimeout(3000)
    await page.route('**/overlay/poll', route => route.fulfill({ json: state.poll }))
    await page.route('**/poll-overlay', route => route.fulfill({ contentType: 'text/html', body: POLL_OVERLAY_HTML }))
    await page.goto('/poll-overlay')
    await expect(page.locator('#state')).toHaveText('LIVE POLL')
  })
  await scene('07-recap', 20_000, async () => {
    state.poll!.status = 'closed'
    state.poll!.endedAt = '2026-10-31T10:30:00Z'
    state.completed = true
    await page.goto('/')
    await page.getByRole('link', { name: 'Stream Recap', exact: true }).click()
    await page.getByRole('button', { name: 'Generate recap' }).click()
    await expect(page.getByText('The recorded discussion focused on next-stream choices.')).toBeVisible()
  })
  await scene('08-closing', 15_000, async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).click()
    await page.screenshot({ path: resolve(output, 'ChatBeacon_Demo_Thumbnail.png') })
  })
  await writeFile(resolve(output, 'scene-timing.json'), JSON.stringify(sceneTimes, null, 2))
})
