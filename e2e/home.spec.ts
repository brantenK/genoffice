import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('shows hero, grouped app sidebar and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const { page } = launched
    try {
      await expect(page.locator('.home-hero')).toBeVisible()
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()

      // the app launcher lives in the sidebar, split into office vs business
      const groups = page.locator('.app-nav')
      await expect(groups).toHaveCount(2)
      await expect(groups.nth(0).locator('.app-nav-heading')).toHaveText('Office Apps')
      await expect(groups.nth(1).locator('.app-nav-heading')).toHaveText('Business Apps')

      const office = groups.nth(0).locator('.app-nav-item')
      await expect(office).toHaveCount(6)
      for (const label of ['Docs', 'Sheets', 'Slides', 'PDF', 'Markdown', 'HTML']) {
        await expect(groups.nth(0).getByRole('button', { name: label })).toBeVisible()
      }

      const business = groups.nth(1).locator('.app-nav-item')
      await expect(business).toHaveCount(3)
      for (const label of ['CRM', 'Tenders', 'Books']) {
        await expect(groups.nth(1).getByRole('button', { name: label })).toBeVisible()
      }

      // the canvas keeps a single primary action: open a local file
      await expect(page.locator('.quick-card')).toHaveCount(1)
      await expect(page.locator('.quick-card')).toContainText('Open Local File')
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when GENOFFICE_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const { page } = launched
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText('最近')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
