import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * CRM smoke test against the real built shell.
 *
 * Launches the built app once, opens the CRM from the Home sidebar, and walks
 * the critical path: pipeline board → deal detail drawer → Escape to close →
 * New Opportunity client-side validation. The CRM renders in its own
 * WebContentsView, so it surfaces as a separate Playwright page (poll for a
 * 'crm' URL, same pattern as new-file-tab.spec.ts uses for 'docs/out').
 *
 * Selective text/role-based selectors keep this resilient to class churn; the
 * class selectors used are stable structural hooks already exercised by the
 * app's own styles.
 */
test.describe('CRM smoke', () => {
  test('pipeline board, deal detail drawer, and opportunity validation', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'crm-smoke' })
    const { app, page } = launched
    try {
      // 1) Open the CRM from the shell Home sidebar (Business Apps group).
      const businessApps = page.locator('.app-nav').nth(1)
      const crmButton = businessApps.getByRole('button', { name: 'CRM' })
      await expect(crmButton).toBeVisible()
      await crmButton.click()

      // 2) Wait for the CRM WebContentsView and assert the pipeline renders.
      const crm = await waitForPageWithUrl(app, 'crm')
      await expect(crm.locator('.crm-pipeline-board')).toBeVisible()

      // 3) Stage columns (seeded board) and at least one seeded deal card.
      const stages = crm.locator('.crm-stage-column')
      await expect(stages).toHaveCount(6)
      for (const label of [
        'Lead',
        'Qualified',
        'Proposal',
        'Negotiation',
        'Closed Won',
        'Closed Lost',
      ]) {
        await expect(crm.locator('.crm-stage-name', { hasText: label })).toBeVisible()
      }
      const cards = crm.locator('.crm-deal-card')
      await expect(cards.first()).toBeVisible()
      await expect(cards).not.toHaveCount(0)
      await crm.screenshot({ path: screenshotPath('crm-pipeline') })

      // 4) Board horizontal-overflow fix: at maximum scroll the final stage
      //    column ("Closed Lost") must sit fully inside the board's viewport,
      //    not be clipped by the right edge. Verified geometrically rather than
      //    trusting the CSS trailing-filler/scroll-padding.
      const board = crm.locator('.crm-pipeline-board')
      await board.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            el.scrollLeft = el.scrollWidth
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          }),
      )
      const lastColumn = crm.locator('.crm-stage-column').last()
      await expect(lastColumn.locator('.crm-stage-name')).toHaveText('Closed Lost')
      const boardBox = await board.boundingBox()
      const lastBox = await lastColumn.boundingBox()
      expect(boardBox).not.toBeNull()
      expect(lastBox).not.toBeNull()
      const boardClientWidth = await board.evaluate((el) => el.clientWidth)
      expect(lastBox!.x + lastBox!.width).toBeLessThanOrEqual(boardBox!.x + boardClientWidth + 2)
      await crm.screenshot({ path: screenshotPath('crm-pipeline-scrolled') })

      // 5) Click a deal card's main content → detail drawer opens.
      await cards.first().locator('.crm-deal-main').click()
      const drawer = crm.locator('.crm-detail-drawer')
      await expect(drawer).toBeVisible()
      await expect(crm.locator('.crm-detail-activity')).toBeVisible()
      await expect(crm.getByRole('heading', { name: 'Log activity' })).toBeVisible()
      // Wave 7: the drawer also renders an audit-trail History section below
      // the activity timeline. On a fresh scratch store nothing has been
      // mutated yet, so the deterministic state is the empty-state copy.
      await expect(crm.getByRole('heading', { name: 'History' })).toBeVisible()
      await expect(crm.locator('.crm-detail-history')).toContainText('No history yet.')
      await crm.screenshot({ path: screenshotPath('crm-detail-drawer') })

      // 6) Escape closes the drawer. The drawer's discard confirmation only
      //    arms when the activity form has unsaved text; this smoke never types
      //    into it, so a plain Escape must close the drawer without a prompt.
      await crm.keyboard.press('Escape')
      await expect(drawer).toHaveCount(0)

      // 7) Delete-state reset regression: two consecutive deal deletions must
      //    both take effect. If the `deleting` flag were not reset after the
      //    first delete, confirmDelete() would early-return on the second
      //    confirm and the card count would stall at one removal.
      const countBeforeDeletes = await cards.count()
      const deleteFirstCard = async (expectedRemaining: number) => {
        await cards.first().locator('.crm-deal-menu-btn').click()
        await crm.getByRole('button', { name: 'Delete Deal' }).click()
        const confirm = crm.locator('.crm-confirm-dialog')
        await expect(confirm).toBeVisible()
        await confirm.getByRole('button', { name: 'Delete' }).click()
        await expect(confirm).toHaveCount(0)
        await expect(cards).toHaveCount(expectedRemaining)
      }
      await deleteFirstCard(countBeforeDeletes - 1)
      await deleteFirstCard(countBeforeDeletes - 2)
      await crm.screenshot({ path: screenshotPath('crm-delete-state-reset') })

      // 8) New Opportunity modal — client-side validation on empty submit.
      await crm.getByRole('button', { name: 'New Opportunity' }).click()
      await expect(crm.locator('.crm-modal')).toBeVisible()
      await expect(crm.getByRole('heading', { name: 'New Opportunity' })).toBeVisible()
      await crm.getByRole('button', { name: 'Create Opportunity' }).click()
      await expect(crm.getByText('Enter an opportunity name')).toBeVisible()
      await crm.screenshot({ path: screenshotPath('crm-new-opportunity-validation') })
    } finally {
      await closeAndSaveVideo(launched, 'crm-smoke')
    }
  })
})
