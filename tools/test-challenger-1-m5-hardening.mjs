#!/usr/bin/env node
/**
 * tools/test-challenger-1-m5-hardening.mjs
 * Challenger 1 M5 Phase 2: White-Box Adversarial E2E Commercial Lifecycle Harness
 *
 * NOTE ON OPENING BALANCES:
 * CORE_ACCOUNTS in books-main.ts carry representative opening balances:
 *   acc-bank:  485,250
 *   acc-ar:    195,500
 *   acc-ap:     74,200
 *   acc-sales: 820,000
 *   acc-vat:    38,400
 * All assertions account for these opening balances.
 *
 * NOTE ON TENDERS DATA STRUCTURE:
 * The tenders store uses workspaces[].tenders[] nesting (not a flat tenders[]).
 * We seed the correct workspaces format for the test.
 */
import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const sandboxRoot = join(tmpdir(), `zanostack-c1-m5-${randomUUID().slice(0,8)}`)
const crmDir = join(sandboxRoot, 'crm')
const tendersDir = join(sandboxRoot, 'tenders')
const booksDir = join(sandboxRoot, 'books')
mkdirSync(crmDir, { recursive: true })
mkdirSync(tendersDir, { recursive: true })
mkdirSync(booksDir, { recursive: true })

const crmDealsPath = join(crmDir, 'deals.json')
const tendersDataPath = join(tendersDir, 'tenders-data.json')
const booksDataPath = join(booksDir, 'books-data.json')

const ipcHandlers = new Map()
require.cache[require.resolve('electron')] = {
  exports: {
    app: { getPath: (n) => n === 'userData' ? sandboxRoot : tmpdir() },
    ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn) },
    WebContentsView: class {},
  }
}

const crm = require('../apps/crm/out/main/index.js')
const tenders = require('../apps/tenders/out/main/index.js')
const booksModule = require('../apps/books/out/main/index.js')

// Opening balances from CORE_ACCOUNTS (used in assertions)
const OB = { bank: 485250, ar: 195500, ap: 74200, sales: 820000, vat: 38400 }

let booksTabFromCrm = false, booksTabFromTenders = false

crm.configureCrmRuntime({ preloadPath: '', rendererFile: '', onOpenBooks: () => { booksTabFromCrm = true } })
tenders.configureTendersRuntime({ preloadPath: '', rendererFile: '', onOpenBooks: () => { booksTabFromTenders = true } })
booksModule.configureBooksRuntime({ preloadPath: '', rendererFile: '' })
crm.registerCrmIpc()
tenders.registerTendersIpc()
booksModule.registerBooksIpc()

async function invoke(ch, ...args) {
  const h = ipcHandlers.get(ch)
  if (!h) throw new Error(`No handler: ${ch}`)
  return h({}, ...args)
}

let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail='') {
  if (cond) { console.log(`  PASS: ${name}`); pass++ }
  else { console.log(`  FAIL: ${name}${detail ? ` [${detail}]` : ''}`); fail++; failures.push(name) }
}
function section(t) { console.log(`\n== ${t} ==`) }
function readBooks() { return booksModule.readBooksStore(booksDataPath) }

// ============================================================================
// PHASE 0: SEED
// ============================================================================
section('PHASE 0 — Seed')

writeFileSync(crmDealsPath, JSON.stringify({
  version: 1, updatedAt: new Date().toISOString(),
  deals: [{
    id: 'deal-acme-001', name: 'Acme Corp Cloud Rollout', stage: 'won', amount: 1150000,
    probability: 100, companyName: 'Acme Corp (Pty) Ltd', notes: 'R1,150,000 incl VAT',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]
}, null, 2), 'utf8')

// Use correct workspaces structure with a REACHED milestone
writeFileSync(tendersDataPath, JSON.stringify({
  version: 1, updatedAt: new Date().toISOString(),
  activeCompanyId: 'ws-water-01',
  workspaces: [{
    id: 'ws-water-01',
    name: 'Municipal Water Projects',
    company: {
      name: 'Zano Consulting (Pty) Ltd', tradingName: 'Zano Consulting',
      registrationNumber: '2018/123456/07', vatNumber: '4920284719', taxPin: '9876543210',
      bbbeeLevel: 'Level 1', bbbeeBlackOwnership: '100%', csdSupplierNumber: 'MAAA0012345',
      founded: '2018', employees: '45', industry: 'Engineering', description: 'Civil engineering',
      address: '24 Sovereign Square, Sandton, 2196', phone: '+27 11 982 4000',
      email: 'info@zanostack.dev', website: 'https://zanostack.dev',
      directors: [], projects: []
    },
    customers: [], vault: [],
    tenders: [{
      id: 'tender-wtr-2026', title: 'Municipal Water Treatment Upgrade',
      referenceNumber: 'RFP-WTR-2026-04', issuingBody: 'City of Johannesburg — Water Utility',
      closingDate: '2026-10-31', submissionMethod: 'PHYSICAL', submissionAddress: 'Civic Centre, JHB',
      signatureChecks: {}, status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(), fileName: '', fileUrl: '', numPages: 0, ocrPages: 0,
      estimatedValue: 920000,
      requirements: [],
      milestones: [{
        id: 'ms-001', name: 'Phase 1 — Site Assessment', title: 'Phase 1 — Site Assessment',
        description: 'Phase 1 site survey and design', amount: 230000,
        status: 'REACHED', dueDate: '2026-09-30', completedDate: '2026-09-01',
      }]
    }]
  }],
  issuerTemplates: []
}, null, 2), 'utf8')

ok('Seeded CRM deal (R1,150,000)', existsSync(crmDealsPath))
ok('Seeded Tender with REACHED milestone (R230,000)', existsSync(tendersDataPath))

// Verify opening balances are as expected (this validates our OB constants)
const bInit = readBooks()
const arInit = bInit.accounts.find(a=>a.id==='acc-ar')?.balance || 0
const apInit = bInit.accounts.find(a=>a.id==='acc-ap')?.balance || 0
const bankInit = bInit.accounts.find(a=>a.id==='acc-bank')?.balance || 0
const salesInit = bInit.accounts.find(a=>a.id==='acc-sales')?.balance || 0
const vatInit = bInit.accounts.find(a=>a.id==='acc-vat')?.balance || 0
ok('Opening acc-ar matches OB constant', Math.abs(arInit - OB.ar) < 0.01, `got ${arInit}`)
ok('Opening acc-ap matches OB constant', Math.abs(apInit - OB.ap) < 0.01, `got ${apInit}`)
ok('Opening acc-bank matches OB constant', Math.abs(bankInit - OB.bank) < 0.01, `got ${bankInit}`)

// ============================================================================
// PHASE A: CRM -> Books
// ============================================================================
section('PHASE A — CRM to Books Invoicing')
let inv1Number, inv1Id

const r1 = await invoke('crm:create-invoice-in-books', 'deal-acme-001')
ok('A1: ok=true', r1?.ok === true, JSON.stringify(r1))
ok('A2: Invoice number (INV-YYYY-NNN)', /^INV-\d{4}-\d{3}$/.test(r1?.invoiceNumber||''), r1?.invoiceNumber)
ok('A3: Books tab opened from CRM', booksTabFromCrm)
inv1Number = r1?.invoiceNumber; inv1Id = r1?.invoiceId

const bA = readBooks()
const inv1 = bA.invoices.find(i => i.invoiceNumber === inv1Number)
ok('A4: Invoice persisted in Books', Boolean(inv1))

if (inv1) {
  const expSub1 = Math.round((1150000/1.15)*100)/100
  const expTax1 = Math.round((1150000 - expSub1)*100)/100

  ok('A5: grandTotal=1,150,000', Math.abs(inv1.grandTotal-1150000)<0.01, `${inv1.grandTotal}`)
  ok('A6: subtotal=grandTotal/1.15', Math.abs(inv1.subtotal-expSub1)<0.01, `${inv1.subtotal} vs ${expSub1}`)
  ok('A7: subtotal+tax=grandTotal (no drift)', Math.abs(inv1.subtotal+inv1.taxTotal-inv1.grandTotal)<0.02,
    `drift=${inv1.subtotal+inv1.taxTotal-inv1.grandTotal}`)
  ok('A8: type=Sales', inv1.type==='Sales')
  ok('A9: crmDealId linked', inv1.crmDealId==='deal-acme-001')
  ok('A10: status=Unpaid', inv1.status==='Unpaid')

  // Account balances = opening balance + delta from invoice
  const ar1 = bA.accounts.find(a=>a.id==='acc-ar')
  const sl1 = bA.accounts.find(a=>a.id==='acc-sales')
  const vt1 = bA.accounts.find(a=>a.id==='acc-vat')
  ok('A11: acc-ar = OB + 1,150,000', ar1 && Math.abs(ar1.balance - (OB.ar+1150000)) < 0.01, `${ar1?.balance} vs ${OB.ar+1150000}`)
  ok('A12: acc-sales = OB + subtotal', sl1 && Math.abs(sl1.balance - (OB.sales+expSub1)) < 0.01, `${sl1?.balance}`)
  ok('A13: acc-vat = OB + taxTotal', vt1 && Math.abs(vt1.balance - (OB.vat+expTax1)) < 0.01, `${vt1?.balance}`)

  const je = bA.journalEntries.find(j=>j.remarks?.includes('deal-acme-001')||j.remarks?.includes(inv1Number))
  ok('A14: JE posted', Boolean(je))
  if (je) ok('A15: JE balanced (D=C)', Math.abs(je.totalDebit-je.totalCredit)<0.01, `D=${je.totalDebit} C=${je.totalCredit}`)
}

const r1b = await invoke('crm:create-invoice-in-books', 'deal-acme-001')
ok('A16: Duplicate guard - returns same invoice', r1b?.ok===true && r1b?.invoiceNumber===inv1Number, JSON.stringify(r1b))
ok('A17: Only 1 invoice per deal', readBooks().invoices.filter(i=>i.crmDealId==='deal-acme-001').length===1)

// ============================================================================
// PHASE B: Tenders -> Books
// ============================================================================
section('PHASE B — Tenders Milestone Billing')
let inv2Number, inv2Id

const r2 = await invoke('tenders:bill-milestone-in-books', {
  tenderId: 'tender-wtr-2026', milestoneId: 'ms-001',
  tenderReference: 'RFP-WTR-2026-04', issuingAuthority: 'City of Johannesburg — Water Utility',
  milestoneTitle: 'Phase 1 — Site Assessment', amount: 230000,
  notes: 'Phase 1 progress payment'
})
ok('B1: ok=true', r2?.ok===true, JSON.stringify(r2))
ok('B2: Invoice number assigned', /^INV-\d{4}-\d{3}$/.test(r2?.invoiceNumber||''), r2?.invoiceNumber)
ok('B3: Books tab opened from Tenders', booksTabFromTenders)
inv2Number = r2?.invoiceNumber; inv2Id = r2?.invoiceId

const bB = readBooks()
const inv2 = bB.invoices.find(i=>i.invoiceNumber===inv2Number)
ok('B4: Invoice persisted', Boolean(inv2))

if (inv2) {
  const expSub2 = Math.round((230000/1.15)*100)/100
  ok('B5: grandTotal=230,000', Math.abs(inv2.grandTotal-230000)<0.01, `${inv2.grandTotal}`)
  ok('B6: tenderReference=RFP-WTR-2026-04', inv2.tenderReference==='RFP-WTR-2026-04', inv2.tenderReference)
  ok('B7: type=Sales', inv2.type==='Sales')
  ok('B8: subtotal+tax=grandTotal (no drift)', Math.abs(inv2.subtotal+inv2.taxTotal-inv2.grandTotal)<0.02)
  const ar2 = bB.accounts.find(a=>a.id==='acc-ar')
  // After A: OB.ar + 1,150,000; after B: OB.ar + 1,150,000 + 230,000
  ok('B9: acc-ar = OB + 1,380,000 (cumulative)', ar2 && Math.abs(ar2.balance - (OB.ar+1380000)) < 0.01,
    `${ar2?.balance} vs ${OB.ar+1380000}`)
}

// Check milestone updated to BILLED
const tRaw = JSON.parse(readFileSync(tendersDataPath,'utf8'))
const ms = tRaw.workspaces?.[0]?.tenders?.[0]?.milestones?.find(m=>m.id==='ms-001')
ok('B10: Milestone status=BILLED', ms?.status==='BILLED', ms?.status)

const r2b = await invoke('tenders:bill-milestone-in-books', {
  tenderId:'tender-wtr-2026', milestoneId:'ms-001', tenderReference:'RFP-WTR-2026-04',
  issuingAuthority:'CoJ Water', amount:230000
})
ok('B11: Idempotency guard - re-bill rejected', r2b?.ok===false, JSON.stringify(r2b))

// ============================================================================
// PHASE C: Bank CSV Import
// ============================================================================
section('PHASE C — Bank Statement CSV Import')

const bankCsv = `Date,Description,Reference,Amount
2026-09-10,"Payment from Acme Corp (Pty) Ltd","${inv1Number}",1150000.00
2026-09-11,"City of Johannesburg Water Utility Settlement","RFP-WTR-2026-04",230000.00
2026-09-12,"Office Supplies Incredible Connection","SUPPLIER-IC-2026",-15000.00`

const cImport = await invoke('books:import-bank-statement-csv', bankCsv)
ok('C1: ok=true', cImport?.ok===true, JSON.stringify(cImport))
ok('C2: importedCount=3', cImport?.importedCount===3, `${cImport?.importedCount}`)
ok('C3: skippedDuplicates=0', cImport?.skippedDuplicates===0, `${cImport?.skippedDuplicates}`)
// Net from CSV: 1,150,000 + 230,000 - 15,000 = 1,365,000
const csvNet = 1150000 + 230000 - 15000
ok('C4: netAdjustment=1,365,000', Math.abs((cImport?.netAdjustment||0)-csvNet)<0.01, `${cImport?.netAdjustment}`)

const bC = readBooks()
const bankAcc = bC.accounts.find(a=>a.id==='acc-bank')
// acc-bank: OB.bank + csvNet
ok('C5: acc-bank=OB+1,365,000', bankAcc && Math.abs(bankAcc.balance-(OB.bank+csvNet))<0.01,
  `${bankAcc?.balance} vs ${OB.bank+csvNet}`)
ok('C6: 3 bankTransactions stored', (bC.bankTransactions||[]).length===3, `${bC.bankTransactions?.length}`)

const cImport2 = await invoke('books:import-bank-statement-csv', bankCsv)
ok('C7: Re-import: importedCount=0', cImport2?.importedCount===0, `${cImport2?.importedCount}`)
ok('C8: Re-import: skippedDuplicates=3', cImport2?.skippedDuplicates===3, `${cImport2?.skippedDuplicates}`)

const suggs = await invoke('books:get-settlement-suggestions')
ok('C9: suggestions is array', Array.isArray(suggs), typeof suggs)
const salesSuggs = suggs.filter(s=>s.invoiceType==='Sales')
ok('C10: >=2 Sales suggestions', salesSuggs.length>=2, `${salesSuggs.length}: ${JSON.stringify(salesSuggs.map(s=>s.invoiceNumber))}`)
const acmeSugg = suggs.find(s=>s.invoiceNumber===inv1Number)
ok('C11: Acme deposit HIGH confidence (inv number in ref)', acmeSugg?.confidence==='HIGH', acmeSugg?.confidence)
const waterSugg = suggs.find(s=>s.invoiceNumber===inv2Number)
ok('C12: Water deposit HIGH confidence (RFP reference)', waterSugg?.confidence==='HIGH', waterSugg?.confidence)

// ============================================================================
// PHASE D: Reconciliation
// ============================================================================
section('PHASE D — 1-Click Reconciliation')

const bPreRec = readBooks()
ok('D1: 3 unreconciled transactions', bPreRec.bankTransactions.filter(t=>!t.reconciled).length===3)

const acmeTx = bPreRec.bankTransactions.find(t=>t.amount===1150000)
const acmeInv = bPreRec.invoices.find(i=>i.crmDealId==='deal-acme-001')
ok('D2: Acme tx found', Boolean(acmeTx))
ok('D3: Acme invoice found', Boolean(acmeInv))
if (acmeTx && acmeInv) {
  const rec1 = await invoke('books:reconcile-transaction', acmeTx.id, acmeInv.id)
  ok('D4: Reconcile Acme ok=true', rec1?.ok===true, JSON.stringify(rec1))
  ok('D5: settledAmount=1,150,000', Math.abs((rec1?.settledAmount||0)-1150000)<0.01)
  ok('D6: invoiceStatus=Paid', rec1?.invoiceStatus==='Paid')
  const bAfterR1 = readBooks()
  const ar1 = bAfterR1.accounts.find(a=>a.id==='acc-ar')
  // Before reconcile: OB.ar + 1,380,000; after settling 1,150,000: OB.ar + 230,000
  ok('D7: acc-ar reduced by 1,150,000 after Acme settlement',
    ar1 && Math.abs(ar1.balance - (OB.ar+230000)) < 0.01, `${ar1?.balance} vs ${OB.ar+230000}`)
  ok('D8: Acme tx marked reconciled', bAfterR1.bankTransactions.find(t=>t.id===acmeTx.id)?.reconciled===true)
}

const bAfterD4 = readBooks()
const waterTx = bAfterD4.bankTransactions.find(t=>!t.reconciled&&t.amount===230000)
const waterInv = bAfterD4.invoices.find(i=>i.tenderReference==='RFP-WTR-2026-04'&&i.status!=='Paid')
ok('D9: Water tx found', Boolean(waterTx))
ok('D10: Water invoice found', Boolean(waterInv))
if (waterTx && waterInv) {
  const rec2 = await invoke('books:reconcile-transaction', waterTx.id, waterInv.id)
  ok('D11: Reconcile Water ok=true', rec2?.ok===true, JSON.stringify(rec2))
  const bAfterR2 = readBooks()
  const ar2 = bAfterR2.accounts.find(a=>a.id==='acc-ar')
  // After both sales settled: OB.ar (opening balance remains; our invoices added then removed)
  ok('D12: acc-ar back to OB after both sales settled', ar2 && Math.abs(ar2.balance-OB.ar)<0.01, `${ar2?.balance}`)
}

// Seed and reconcile a Purchase bill
const bForPurch = readBooks()
const purchId = `inv-purch-${randomUUID().slice(0,8)}`
const purchSub = Math.round((15000/1.15)*100)/100
const purchTax = Math.round((15000-purchSub)*100)/100
bForPurch.invoices.unshift({
  id: purchId, invoiceNumber: `BILL-${new Date().getFullYear()}-001`, type: 'Purchase',
  partyId: 'party-supplier-001', partyName: 'Incredible Connection',
  date: '2026-09-12', dueDate: '2026-10-12',
  items:[{id:'sup-1',itemCode:'OFFICE',description:'Office supplies',accountId:'acc-expenses',
    accountName:'Expenses',qty:1,rate:purchSub,taxRate:15,amount:purchSub}],
  subtotal: purchSub, taxTotal: purchTax, grandTotal: 15000,
  outstandingAmount: 15000, status: 'Unpaid', notes: 'Supplier bill',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
})
// Adjust acc-ap to reflect new payable
const apAccForPurch = bForPurch.accounts.find(a=>a.id==='acc-ap')
if(apAccForPurch) apAccForPurch.balance = Math.round((apAccForPurch.balance+15000)*100)/100
booksModule.writeBooksStore(booksDataPath, bForPurch)

const bWithBill = readBooks()
const supplierTx = bWithBill.bankTransactions.find(t=>!t.reconciled&&t.amount<0)
const supplierInv = bWithBill.invoices.find(i=>i.id===purchId)
ok('D13: Supplier withdrawal tx found', Boolean(supplierTx))
ok('D14: Supplier bill found', Boolean(supplierInv))
if (supplierTx && supplierInv) {
  const rec3 = await invoke('books:reconcile-transaction', supplierTx.id, supplierInv.id)
  ok('D15: Reconcile supplier ok=true', rec3?.ok===true, JSON.stringify(rec3))
  const bAfterR3 = readBooks()
  const ap3 = bAfterR3.accounts.find(a=>a.id==='acc-ap')
  // After settling: OB.ap + 15000 - 15000 = OB.ap (back to opening balance)
  ok('D16: acc-ap back to OB after supplier settled', ap3 && Math.abs(ap3.balance-OB.ap)<0.01, `${ap3?.balance}`)
}

// Re-reconcile guard
const bCheck = readBooks()
const reconciledTx = bCheck.bankTransactions.find(t=>t.reconciled)
if (reconciledTx) {
  const rr = await invoke('books:reconcile-transaction', reconciledTx.id, 'any-inv')
  ok('D17: Re-reconcile rejected (ok=false)', rr?.ok===false, JSON.stringify(rr))
}

// ============================================================================
// PHASE E: Trial Balance
// ============================================================================
section('PHASE E — Trial Balance Integrity')

const finalBooks = readBooks()

// Sum all journal entry line items
let totalD=0, totalC=0
for (const je of finalBooks.journalEntries) {
  for (const item of (je.items||[])) {
    totalD = Math.round((totalD+(item.debit||0))*100)/100
    totalC = Math.round((totalC+(item.credit||0))*100)/100
  }
}
ok('E1: Trial Balance D=C (line items)', Math.abs(totalD-totalC)<0.02, `D=${totalD} C=${totalC} diff=${Math.abs(totalD-totalC)}`)
ok('E2: All JE headers balanced', finalBooks.journalEntries.every(je=>Math.abs(je.totalDebit-je.totalCredit)<0.02))

ok('E3: All bank txns reconciled', finalBooks.bankTransactions.filter(t=>!t.reconciled).length===0)

const arFinal = finalBooks.accounts.find(a=>a.id==='acc-ar')
// Final acc-ar should be OB.ar (our invoices were created and then fully settled)
ok('E4: acc-ar=OB (all new receivables settled)', arFinal && Math.abs(arFinal.balance-OB.ar)<0.01, `${arFinal?.balance}`)

const apFinal = finalBooks.accounts.find(a=>a.id==='acc-ap')
// Final acc-ap should be OB.ap (supplier bill was created and settled)
ok('E5: acc-ap=OB (all new payables settled)', apFinal && Math.abs(apFinal.balance-OB.ap)<0.01, `${apFinal?.balance}`)

// Zero rounding drift on all invoices
const roundingViolations = finalBooks.invoices.filter(i=>Math.abs(i.subtotal+i.taxTotal-i.grandTotal)>0.02)
ok('E6: Zero rounding drift on all invoices', roundingViolations.length===0,
  roundingViolations.map(i=>`${i.invoiceNumber}:drift=${i.subtotal+i.taxTotal-i.grandTotal}`).join(','))

// All 5 core accounts present
const coreIds = ['acc-bank','acc-ar','acc-ap','acc-sales','acc-vat']
ok('E7: All 5 core accounts present', coreIds.every(id=>finalBooks.accounts.some(a=>a.id===id)))

// Must have at minimum: 2 sales invoice JEs + 2 reconciliation JEs (Acme + Water) + 1 purchase reconciliation JE
ok('E8: >=5 journal entries posted', finalBooks.journalEntries.length>=5, `${finalBooks.journalEntries.length}`)

// acc-bank net verification: OB.bank + csv_net
const bankFinal = finalBooks.accounts.find(a=>a.id==='acc-bank')
ok('E9: acc-bank = OB + csv net import', bankFinal && Math.abs(bankFinal.balance-(OB.bank+csvNet))<0.01,
  `${bankFinal?.balance} vs ${OB.bank+csvNet}`)

// ============================================================================
// PHASE F: Adversarial Edge Cases
// ============================================================================
section('PHASE F — Adversarial Edge Cases')

// F1: Zero-value deal
const crmRaw = JSON.parse(readFileSync(crmDealsPath,'utf8'))
crmRaw.deals.push({ id:'deal-zero-001', name:'Zero Deal', stage:'won', amount:0, companyName:'Zero Corp',
  createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })
writeFileSync(crmDealsPath, JSON.stringify(crmRaw,null,2),'utf8')
const zeroR = await invoke('crm:create-invoice-in-books', 'deal-zero-001')
ok('F1: Zero-value deal invoiced without crash', zeroR?.ok===true, JSON.stringify(zeroR))

// F2: Non-existent deal
const noExist = await invoke('crm:create-invoice-in-books', 'deal-does-not-exist-999')
ok('F2: Non-existent deal -> ok=false', noExist?.ok===false, JSON.stringify(noExist))

// F3: Not-won deal
crmRaw.deals.push({ id:'deal-lost-001', name:'Lost Deal', stage:'lost', amount:100000, companyName:'Lost Corp',
  createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })
writeFileSync(crmDealsPath, JSON.stringify(crmRaw,null,2),'utf8')
const lostR = await invoke('crm:create-invoice-in-books', 'deal-lost-001')
ok('F3: Non-won deal -> ok=false', lostR?.ok===false, JSON.stringify(lostR))

// F4: Empty CSV
const emptyR = await invoke('books:import-bank-statement-csv', 'Date,Description,Amount\n')
ok('F4: Empty CSV -> ok=false', emptyR?.ok===false, JSON.stringify(emptyR))

// F5: Mixed valid/invalid CSV
const mixedR = await invoke('books:import-bank-statement-csv',
  'Date,Description,Amount\n2026-09-20,"Valid Tx",50000\n,,\n2026-09-21,"Another Valid",25000\nBAD,,,')
ok('F5: Mixed CSV: 2 valid imported', mixedR?.ok===true&&mixedR?.importedCount===2,
  `importedCount=${mixedR?.importedCount} error=${mixedR?.error}`)

// F6: Non-existent milestone
const noMs = await invoke('tenders:bill-milestone-in-books', {
  tenderId:'tender-wtr-2026', milestoneId:'ms-nonexistent-999',
  tenderReference:'RFP-WTR-2026-04', issuingAuthority:'Test', amount:10000
})
ok('F6: Non-existent milestone -> ok=false', noMs?.ok===false, JSON.stringify(noMs))

// F7: Reconcile against non-existent invoice
const bF = readBooks()
const anyTx = bF.bankTransactions.find(t=>!t.reconciled)
if (anyTx) {
  const badRec = await invoke('books:reconcile-transaction', anyTx.id, 'inv-nonexistent-999')
  ok('F7: Reconcile non-existent invoice -> ok=false', badRec?.ok===false, JSON.stringify(badRec))
} else {
  // Import a fresh transaction to test with
  await invoke('books:import-bank-statement-csv', 'Date,Description,Amount\n2026-09-30,"Orphan Tx",99999')
  const bF2 = readBooks()
  const orphanTx = bF2.bankTransactions.find(t=>!t.reconciled&&t.amount===99999)
  const badRec = await invoke('books:reconcile-transaction', orphanTx?.id||'tx-none', 'inv-nonexistent-999')
  ok('F7: Reconcile non-existent invoice -> ok=false', badRec?.ok===false, JSON.stringify(badRec))
}

// ============================================================================
// FINAL RESULTS
// ============================================================================
section('FINAL RESULTS')
const total = pass + fail
console.log(`\nPassed: ${pass} / ${total}`)
console.log(`Failed: ${fail} / ${total}`)
if (fail > 0) {
  console.log('\nFailed tests:')
  failures.forEach(f => console.log(`  - ${f}`))
  console.log('\nVERDICT: REQUEST_CHANGES')
  process.exit(1)
} else {
  console.log('\nVERDICT: APPROVE — All E2E Adversarial Tests Passed.')
  process.exit(0)
}
