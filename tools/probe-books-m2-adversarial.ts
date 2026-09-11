/**
 * tools/probe-books-m2-adversarial.ts
 *
 * ADVANCED ADVERSARIAL PROBE FOR BOOKS MILESTONE 2 (M2)
 * Probing corner cases, partial settlements, negative items, zero totals,
 * editing without reposting, and status cancellations.
 */

import assert from 'node:assert'
import { useBooksStore } from '../apps/books/src/renderer/src/store'
import { initialBooksData } from '../apps/books/src/renderer/src/mock/initialData'
import { round2, calculateInvoiceTotals } from '../apps/books/src/shared/accounting'
import type { Invoice, InvoiceItem } from '../apps/books/src/shared/types'

let testCount = 0
let passCount = 0
let failCount = 0

async function probe(name: string, fn: () => Promise<void>) {
  testCount++
  try {
    await fn()
    passCount++
    console.log(`  [PASS] ${name}`)
  } catch (err: any) {
    failCount++
    console.error(`  [FAIL] ${name}: ${err.message}`)
  }
}

function resetStore() {
  useBooksStore.setState({
    activeTab: 'dashboard',
    data: JSON.parse(JSON.stringify(initialBooksData)),
    activeInvoiceId: null,
    invoiceStatusFilter: 'All',
    activeReport: 'profit-loss',
    printInvoice: null,
    searchTerm: '',
  })
}

function getAcc(id: string) {
  const a = useBooksStore.getState().data.accounts.find((acc) => acc.id === id)
  if (!a) throw new Error(`Account ${id} not found`)
  return a.balance
}

async function runProbes() {
  console.log('======================================================================')
  console.log('   ADVERSARIAL DEEP PROBES FOR BOOKS M2')
  console.log('======================================================================\n')

  // Probe 1: Zero amount invoice
  await probe('P1: Zero amount Sales invoice handles 0 totals without error and maintains balance', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const initJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'inv-zero',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'z-1',
          itemCode: 'ZERO-1',
          description: 'Zero cost sample',
          accountId: 'acc-sales',
          qty: 1,
          rate: 0,
          taxRate: 15,
          amount: 0,
        },
      ],
    })

    const updated = useBooksStore.getState().data
    const inv = updated.invoices.find((i) => i.id === 'inv-zero')!
    assert.strictEqual(inv.grandTotal, 0)
    assert.strictEqual(inv.taxTotal, 0)
    assert.strictEqual(inv.subtotal, 0)

    const je = updated.journalEntries[0]
    assert.strictEqual(je.totalDebit, 0)
    assert.strictEqual(je.totalCredit, 0)
    assert.strictEqual(je.totalDebit, je.totalCredit)
  })

  // Probe 2: Negative item (credit/discount) on Sales invoice
  await probe('P2: Sales invoice with net positive total but including discount item posts balanced entries', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineAr = getAcc('acc-ar')
    const baselineSales = getAcc('acc-sales')
    const baselineVat = getAcc('acc-vat')

    await store.saveInvoice({
      id: 'inv-discount',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'd-1',
          itemCode: 'SVC-1',
          description: 'Consulting services',
          accountId: 'acc-sales',
          qty: 1,
          rate: 50000,
          taxRate: 15,
          amount: 50000,
        },
        {
          id: 'd-2',
          itemCode: 'DISC-1',
          description: 'Special concession discount',
          accountId: 'acc-sales',
          qty: 1,
          rate: -10000,
          taxRate: 15,
          amount: -10000,
        },
      ],
    })

    const state = useBooksStore.getState().data
    const inv = state.invoices.find((i) => i.id === 'inv-discount')!
    assert.strictEqual(inv.subtotal, 40000)
    assert.strictEqual(inv.taxTotal, 6000)
    assert.strictEqual(inv.grandTotal, 46000)

    const je = state.journalEntries[0]
    assert.strictEqual(je.totalDebit, je.totalCredit)
    assert.strictEqual(je.totalDebit, 46000)

    assert.strictEqual(getAcc('acc-ar'), round2(baselineAr + 46000))
    assert.strictEqual(getAcc('acc-sales'), round2(baselineSales + 40000))
    assert.strictEqual(getAcc('acc-vat'), round2(baselineVat + 6000))
  })

  // Probe 3: Editing existing Unpaid invoice without changing status does NOT double-post
  await probe('P3: Updating metadata on existing Unpaid invoice does NOT duplicate journal entries', async () => {
    resetStore()
    const store = useBooksStore.getState()

    await store.saveInvoice({
      id: 'inv-to-edit',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      notes: 'Original note',
      items: [
        {
          id: 'e-1',
          itemCode: 'SVC-E',
          description: 'Service',
          accountId: 'acc-sales',
          qty: 1,
          rate: 20000,
          taxRate: 15,
          amount: 20000,
        },
      ],
    })

    const state1 = useBooksStore.getState().data
    const journalsCount1 = state1.journalEntries.length
    const ar1 = getAcc('acc-ar')

    // Edit notes only
    await store.saveInvoice({
      id: 'inv-to-edit',
      notes: 'Updated note after review',
    })

    const state2 = useBooksStore.getState().data
    assert.strictEqual(state2.journalEntries.length, journalsCount1, 'Journal count must not increase on note update')
    assert.strictEqual(getAcc('acc-ar'), ar1, 'AR balance must not change on note update')
    const updatedInv = state2.invoices.find((i) => i.id === 'inv-to-edit')!
    assert.strictEqual(updatedInv.notes, 'Updated note after review')
  })

  // Probe 4: Transition directly from Draft to Paid in a single edit
  await probe('P4: Transitioning Draft -> Paid posts both invoice posting and settlement journals', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const baselineBank = getAcc('acc-bank')
    const baselineAr = getAcc('acc-ar')
    const baselineSales = getAcc('acc-sales')
    const baselineJournals = store.data.journalEntries.length

    await store.saveInvoice({
      id: 'draft-direct-paid',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Draft',
      items: [
        {
          id: 'dp-1',
          itemCode: 'CSH',
          description: 'Direct cash sale',
          accountId: 'acc-sales',
          qty: 1,
          rate: 10000,
          taxRate: 15,
          amount: 10000,
        },
      ],
    })

    const stateDraft = useBooksStore.getState().data
    assert.strictEqual(stateDraft.journalEntries.length, baselineJournals)

    // Now transition to Paid
    await store.saveInvoice({
      id: 'draft-direct-paid',
      status: 'Paid',
    })

    const statePaid = useBooksStore.getState().data
    const inv = statePaid.invoices.find((i) => i.id === 'draft-direct-paid')!
    assert.strictEqual(inv.status, 'Paid')
    assert.strictEqual(inv.outstandingAmount, 0)
    assert.strictEqual(statePaid.journalEntries.length, baselineJournals + 2)

    // Bank increased by 11500, Sales increased by 10000, AR net unchanged
    assert.strictEqual(getAcc('acc-bank'), round2(baselineBank + 11500))
    assert.strictEqual(getAcc('acc-sales'), round2(baselineSales + 10000))
    assert.strictEqual(getAcc('acc-ar'), baselineAr)
  })

  // Probe 5: Status 'Cancelled' is excluded from party balance
  await probe('P5: Invoices with status Cancelled are excluded from party balance', async () => {
    resetStore()
    const store = useBooksStore.getState()

    await store.saveInvoice({
      id: 'inv-to-cancel',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'c-1',
          itemCode: 'CAN',
          description: 'Will cancel',
          accountId: 'acc-sales',
          qty: 1,
          rate: 15000,
          taxRate: 15,
          amount: 15000,
        },
      ],
    })

    const state1 = useBooksStore.getState().data
    const p1Balance1 = state1.parties.find((p) => p.id === 'party-1')!.outstandingBalance

    // Transition to Cancelled
    await store.saveInvoice({
      id: 'inv-to-cancel',
      status: 'Cancelled',
    })

    const state2 = useBooksStore.getState().data
    const p1Balance2 = state2.parties.find((p) => p.id === 'party-1')!.outstandingBalance
    assert.strictEqual(p1Balance2, round2(p1Balance1 - 17250))
  })

  // Probe 6: Partial outstandingAmount followed by markInvoicePaid
  await probe('P6: Partial outstandingAmount followed by markInvoicePaid settles only remainder', async () => {
    resetStore()
    const store = useBooksStore.getState()

    await store.saveInvoice({
      id: 'inv-partial',
      type: 'Sales',
      partyId: 'party-1',
      partyName: 'City of Ekurhuleni Water Dept',
      status: 'Unpaid',
      items: [
        {
          id: 'part-1',
          itemCode: 'PART',
          description: 'Partial test',
          accountId: 'acc-sales',
          qty: 1,
          rate: 100000,
          taxRate: 15,
          amount: 100000,
        },
      ],
    })

    // Simulate partial reconciliation: outstanding reduced to 40,000
    await store.saveInvoice({
      id: 'inv-partial',
      outstandingAmount: 40000,
    })

    const stateMid = useBooksStore.getState().data
    const midBank = getAcc('acc-bank')
    const midAr = getAcc('acc-ar')

    // Mark paid now
    await store.markInvoicePaid('inv-partial')

    const stateFinal = useBooksStore.getState().data
    const settlementJe = stateFinal.journalEntries[0]
    assert.strictEqual(settlementJe.totalDebit, 40000)
    assert.strictEqual(settlementJe.totalCredit, 40000)
    assert.strictEqual(getAcc('acc-bank'), round2(midBank + 40000))
    assert.strictEqual(getAcc('acc-ar'), round2(midAr - 40000))
  })

  // Probe 7: 1,000-Iteration High-Throughput Adversarial Stress Fuzzer
  await probe('P7: 1,000-iteration high-throughput randomized fuzzing maintaining all invariants', async () => {
    resetStore()
    const store = useBooksStore.getState()
    const trackedIds: string[] = []

    for (let i = 0; i < 1000; i++) {
      const rand = Math.random()
      if (rand < 0.5 || trackedIds.length === 0) {
        const id = `hi-fuzz-${i}`
        const isSales = Math.random() > 0.5
        const statusChoice = Math.random()
        const status: any = statusChoice < 0.2 ? 'Draft' : statusChoice < 0.7 ? 'Unpaid' : 'Paid'
        const partyId = isSales ? 'party-1' : 'party-4'
        const partyName = isSales ? 'Customer 1' : 'Supplier 4'
        const items: InvoiceItem[] = [
          {
            id: `hi-item-${i}`,
            itemCode: `H-${i}`,
            description: `High fuzz item`,
            accountId: isSales ? 'acc-sales' : 'acc-materials',
            qty: Math.floor(Math.random() * 5) + 1,
            rate: Math.round((Math.random() * 500 + 1) * 100) / 100,
            taxRate: 15,
            amount: 0,
          },
        ]
        items[0].amount = round2(items[0].qty * items[0].rate)

        await store.saveInvoice({
          id,
          type: isSales ? 'Sales' : 'Purchase',
          partyId,
          partyName,
          status,
          items,
        })
        trackedIds.push(id)
      } else if (rand < 0.75) {
        const cur = useBooksStore.getState().data
        const unpaid = cur.invoices.filter((inv) => inv.status === 'Unpaid')
        if (unpaid.length > 0) {
          const pick = unpaid[Math.floor(Math.random() * unpaid.length)]
          await store.markInvoicePaid(pick.id)
        }
      } else if (rand < 0.90) {
        const cur = useBooksStore.getState().data
        const drafts = cur.invoices.filter((inv) => inv.status === 'Draft')
        if (drafts.length > 0) {
          const pick = drafts[Math.floor(Math.random() * drafts.length)]
          await store.saveInvoice({ id: pick.id, status: 'Unpaid' })
        }
      } else {
        if (trackedIds.length > 0) {
          const idx = Math.floor(Math.random() * trackedIds.length)
          const id = trackedIds[idx]
          await store.deleteInvoice(id)
          trackedIds.splice(idx, 1)
        }
      }

      if (i % 100 === 0 || i === 999) {
        const cur = useBooksStore.getState().data
        // Verify all journals
        for (const je of cur.journalEntries) {
          assert.strictEqual(je.totalDebit, je.totalCredit, `Imbalance at iteration ${i}`)
        }
        // Verify party balances
        for (const p of cur.parties) {
          const expected = cur.invoices
            .filter((inv) => inv.partyId === p.id && inv.status !== 'Paid' && inv.status !== 'Cancelled')
            .reduce((s, inv) => round2(s + (inv.outstandingAmount ?? inv.grandTotal)), 0)
          assert.strictEqual(p.outstandingBalance, round2(expected), `Party mismatch at iteration ${i}`)
        }
      }
    }
  })

  console.log('\n======================================================================')
  console.log(`PROBE SUMMARY: ${passCount} passed, ${failCount} failed out of ${testCount} probes`)
  console.log('======================================================================')

  if (failCount > 0) process.exit(1)
}

runProbes().catch((err) => {
  console.error('Fatal probe error:', err)
  process.exit(1)
})
