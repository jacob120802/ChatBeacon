import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { setupDashboard, makePoll } from './fixtures'
import { POLL_OVERLAY_HTML } from '../../backend/src/pollOverlay'

test('custom poll, optional saved draft, reload, activation, results, closure, and another poll', async ({ page }) => {
  const state = await setupDashboard(page, { poll: makePoll('closed') })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const beacon = page.locator('#beacon-pulse')
  await beacon.getByRole('button', { name: 'Create another poll' }).click()
  await beacon.getByLabel('Poll question', { exact: true }).fill('Which challenge should we play tonight?')
  await beacon.getByLabel('Poll answer option 1').fill('Co-op campaign')
  await beacon.getByLabel('Poll answer option 2').fill('Solo challenge')
  await page.waitForTimeout(1200)
  await expect(beacon.getByLabel('Poll question', { exact: true })).toHaveValue('Which challenge should we play tonight?')
  state.saveFailed = true
  await beacon.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(beacon.getByRole('alert')).toHaveText('Draft could not be written.')
  state.saveFailed = false
  await beacon.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(beacon.getByRole('button', { name: 'Save edits' })).toBeVisible()
  await page.reload()
  await expect(beacon.getByLabel('Poll question', { exact: true })).toHaveValue('Which challenge should we play tonight?')
  await beacon.getByLabel('Poll question', { exact: true }).fill('Which challenge should we play tomorrow?')
  await beacon.getByRole('button', { name: 'Approve and activate' }).click()
  await expect(beacon.getByRole('button', { name: 'Close poll' })).toBeVisible()
  await expect(beacon.getByLabel('Poll question', { exact: true })).toBeDisabled()
  state.poll!.totalVotes = 3
  state.poll!.options[0]!.votes = 2
  state.poll!.options[1]!.votes = 1
  await expect(beacon.getByText('3 total votes', { exact: true })).toBeVisible()
  await beacon.getByRole('button', { name: 'Close poll' }).click()
  await expect(beacon.getByText('Poll closed. New votes are ignored.')).toBeVisible()
  await beacon.getByRole('button', { name: 'Create another poll' }).click()
  await beacon.getByLabel('Poll question', { exact: true }).fill('Which map should we explore?')
  await beacon.getByLabel('Poll answer option 1').fill('Forest')
  await beacon.getByLabel('Poll answer option 2').fill('Desert')
  await beacon.getByRole('button', { name: 'Start poll', exact: true }).click()
  await expect(beacon.getByRole('button', { name: 'Close poll' })).toBeVisible()
  expect(errors).toEqual([])
})

test('question status and priority persist across reload, AI failure recovers, suggestion starts explicitly', async ({ page }) => {
  const state = await setupDashboard(page)
  await page.goto('/')
  await expect(page.getByText('A stream session is in progress')).toBeVisible()
  const queue = page.locator('.questions-panel')
  let card = queue.locator('article').filter({ has: page.getByText('What should we play next?', { exact: true }) }).first()
  await card.getByRole('button', { name: 'Mark question for follow-up' }).click()
  await card.getByRole('button', { name: /Set priority:/ }).click()
  await page.reload()
  await expect(page.getByText('A stream session is in progress')).toBeVisible()
  await queue.getByRole('button', { name: /^Follow up/ }).click()
  card = queue.locator('article').filter({ has: page.getByText('What should we play next?', { exact: true }) }).first()
  await expect(card.getByText('Raised', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Mark follow-up question answered' }).click()
  await expect(queue.getByText('All caught up')).toBeVisible()
  const pulse = page.locator('#community-pulse')
  state.aiFailed = true
  await pulse.getByRole('button', { name: 'Analyze chat' }).click()
  await expect(pulse.getByRole('alert')).toContainText('temporarily unavailable')
  state.aiFailed = false
  await pulse.getByRole('button', { name: 'Try again' }).click()
  await pulse.getByRole('button', { name: 'Suggest a poll' }).click()
  await expect(pulse.getByText('Supporting messages')).toBeVisible()
  await pulse.getByLabel('Poll question', { exact: true }).fill('Which game format sounds best?')
  await pulse.getByRole('button', { name: 'Start this poll' }).click()
  await expect(page.locator('#beacon-pulse').getByRole('button', { name: 'Close poll' })).toBeVisible()
  expect(state.poll?.question).toBe('Which game format sounds best?')
  expect(state.mutations.filter(item => item.path.endsWith('/activate'))).toHaveLength(1)
})

test('connection recovery, persistence warning, recap, theme and local sign out', async ({ page }) => {
  const state = await setupDashboard(page)
  await page.goto('/')
  await expect(page.getByText('Live', { exact: true })).toBeVisible()
  state.reconnecting = true
  await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible()
  await expect(page.getByText('Twitch chat · capture paused')).toBeVisible()
  state.reconnecting = false
  state.persistenceFailed = true
  await expect(page.getByText(/Chat is still being tracked, but session storage is degraded/)).toBeVisible()
  state.completed = true
  await page.reload()
  const recap = page.locator('#stream-recap')
  await expect(recap.getByText('Incomplete', { exact: true })).toBeVisible()
  await recap.getByRole('button', { name: 'Generate recap' }).click()
  await expect(recap.getByText('The recorded discussion focused on next-stream choices.')).toBeVisible()
  await page.getByRole('button', { name: 'Dark theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Sign in with Twitch' })).toBeVisible()
  await expect(page.locator('.demo-badge')).toContainText('Demo mode')
})

for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768], [768, 1024], [390, 844], [360, 800]]) {
  test(`responsive ${width}x${height}, keyboard navigation and light/dark accessibility`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height })
    await setupDashboard(page)
    await page.goto('/')
    await expect(page.getByText('Live', { exact: true })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to dashboard content' })).toBeFocused()
    await page.keyboard.press('Enter')
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Dark theme' }).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const scan = await new AxeBuilder({ page }).analyze()
      expect(scan.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`), fullPage: true })
    }
  })
}

test('actual overlay HTML displays updates, stale failures, recovery and closure', async ({ page }, testInfo) => {
  let fail = false
  const poll = makePoll('active')
  poll.options[0]!.text = 'A longer option that should wrap cleanly at narrow browser-source dimensions'
  await page.route('**/overlay/poll', route => fail ? route.abort() : route.fulfill({ json: poll }))
  await page.route('**/poll-overlay', route => route.fulfill({ contentType: 'text/html', body: POLL_OVERLAY_HTML }))
  await page.setViewportSize({ width: 640, height: 480 })
  await page.goto('/poll-overlay')
  await expect(page.locator('#state')).toHaveText('LIVE POLL')
  fail = true
  await expect(page.locator('#state')).toContainText('STALE')
  fail = false
  poll.totalVotes = 2; poll.options[0]!.votes = 2
  await expect(page.locator('#state')).toHaveText('LIVE POLL')
  await expect(page.locator('#total')).toContainText('2')
  poll.status = 'closed'
  await expect(page.locator('#state')).toHaveText('POLL CLOSED')
  await page.screenshot({ path: testInfo.outputPath('overlay-closed.png') })
})
