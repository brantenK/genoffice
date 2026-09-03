import { chromium } from 'playwright'
import { resolve } from 'node:path'
import { copyFileSync, existsSync } from 'node:fs'

const ARTIFACTS_DIR = 'C:/Users/brant/.gemini/antigravity/brain/be6395bf-58cc-4f29-847c-a0f4f1bc641e'
const WEBSITE_SCREENSHOTS_DIR = 'C:/Users/brant/OneDrive/Documents/ZanoStack-Website/public/assets/screenshots'

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--allow-file-access-from-files'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  const p = resolve('apps/books/out/renderer/index.html')
  const fileUrl = 'file:///' + p.replace(/\\/g, '/')
  console.log('Loading:', fileUrl)

  await page.goto(fileUrl)
  await page.waitForTimeout(1000)

  // 1. Dashboard
  console.log('1. Capturing Dashboard...')
  await page.screenshot({ path: `${ARTIFACTS_DIR}/books_dashboard.png` })

  // 2. Sales Invoices
  console.log('2. Capturing Invoices List...')
  await page.locator('nav button:has-text("Sales Invoices")').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/books_invoices.png` })

  // 3. New Invoice Form
  console.log('3. Capturing Invoice Form...')
  await page.locator('button:has-text("New Invoice")').first().click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/books_invoice_form.png` })

  // 4. Chart of Accounts
  console.log('4. Capturing Chart of Accounts...')
  await page.locator('nav button:has-text("Chart of Accounts")').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/books_chart_of_accounts.png` })

  // 5. Financial Reports (P&L)
  console.log('5. Capturing Reports (P&L)...')
  await page.locator('nav button:has-text("Financial Reports")').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/books_reports_pl.png` })

  // 6. Financial Reports (Balance Sheet)
  console.log('6. Capturing Reports (Balance Sheet)...')
  await page.locator('button:has-text("Balance Sheet")').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${ARTIFACTS_DIR}/books_reports_bs.png` })

  // 7. Invoice Print Preview Modal
  console.log('7. Capturing Invoice Print Preview...')
  await page.locator('nav button:has-text("Sales Invoices")').click()
  await page.waitForTimeout(500)
  const printBtn = page.locator('button[title="Print / Export PDF"]').first()
  if (await printBtn.count() > 0) {
    await printBtn.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${ARTIFACTS_DIR}/books_print_preview.png` })
  }

  await browser.close()
  console.log('All 7 screenshots captured successfully!')

  if (existsSync(WEBSITE_SCREENSHOTS_DIR)) {
    const files = [
      'books_dashboard.png',
      'books_invoices.png',
      'books_invoice_form.png',
      'books_chart_of_accounts.png',
      'books_reports_pl.png',
      'books_reports_bs.png',
      'books_print_preview.png',
    ]
    for (const f of files) {
      const src = `${ARTIFACTS_DIR}/${f}`
      const dst = `${WEBSITE_SCREENSHOTS_DIR}/${f}`
      if (existsSync(src)) {
        copyFileSync(src, dst)
        console.log(`Copied ${f} to website directory`)
      }
    }
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
