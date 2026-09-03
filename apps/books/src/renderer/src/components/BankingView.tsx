import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Landmark,
  Upload,
  Zap,
  CheckCircle2,
  Clock,
  Search,
  ArrowDownLeft,
  ArrowUpRight,
  Sparkles,
  FileSpreadsheet,
  AlertCircle,
  Tag,
  Check,
} from 'lucide-react'
import { useBooksStore } from '../store'
import type { BankTransaction, SettlementSuggestion } from '../../../shared/types'

export function BankingView() {
  const { data, importBankStatementCsv, reconcileTransaction } = useBooksStore()
  const { accounts, settings, invoices } = data
  const bankTransactions = data.bankTransactions || []

  const [activeFilter, setActiveFilter] = useState<'all' | 'unreconciled' | 'reconciled'>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Current ledger account for acc-bank
  const bankAccount = accounts.find((a) => a.id === 'acc-bank')
  const currentBalance = bankAccount ? bankAccount.balance : 485250

  // Compute settlement suggestions from current store state
  const suggestions: SettlementSuggestion[] = useMemo(() => {
    const unreconciledTx = bankTransactions.filter((t) => !t.reconciled)
    const openInvoices = invoices.filter((i) => i.status !== 'Paid' && i.outstandingAmount > 0)
    const res: SettlementSuggestion[] = []

    for (const tx of unreconciledTx) {
      const isDeposit = tx.amount > 0
      const targetType = isDeposit ? 'Sales' : 'Purchase'
      const targetAmount = Math.abs(tx.amount)

      const candidates = openInvoices.filter((i) => i.type === targetType)

      for (const inv of candidates) {
        const amountMatches = Math.abs(inv.outstandingAmount - targetAmount) < 0.01
        if (!amountMatches) continue

        const textToSearch = `${tx.description} ${tx.reference || ''}`.toLowerCase()
        const invNoMatch = Boolean(inv.invoiceNumber && textToSearch.includes(inv.invoiceNumber.toLowerCase()))
        const tenderMatch = Boolean(inv.tenderReference && textToSearch.includes(inv.tenderReference.toLowerCase()))

        const stopWords = new Set(['city', 'of', 'the', 'and', 'dept', 'ltd', 'pty', 'inc', 'corp', 'co'])
        const partyTokens = (inv.partyName || '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 4 && !stopWords.has(t))

        const partyMatch =
          Boolean(inv.partyName && textToSearch.includes(inv.partyName.toLowerCase())) ||
          (partyTokens.length > 0 && partyTokens.some((t) => textToSearch.includes(t)))

        let confidence: 'HIGH' | 'MEDIUM' = 'MEDIUM'
        let reason = 'Exact amount matches outstanding invoice'

        if (invNoMatch) {
          confidence = 'HIGH'
          reason = `Exact amount match and contains invoice number: ${inv.invoiceNumber}`
        } else if (tenderMatch) {
          confidence = 'HIGH'
          reason = `Exact amount match and contains tender reference: ${inv.tenderReference}`
        } else if (partyMatch) {
          confidence = 'HIGH'
          reason = `Exact amount match and contains counterparty name: ${inv.partyName}`
        }

        res.push({
          transactionId: tx.id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          partyName: inv.partyName,
          invoiceType: inv.type,
          amount: targetAmount,
          confidence,
          reason,
        })
      }
    }

    return res
  }, [bankTransactions, invoices])

  const unreconciledCount = bankTransactions.filter((t) => !t.reconciled).length
  const reconciledCount = bankTransactions.filter((t) => t.reconciled).length

  // Filtered transactions
  const filteredTransactions = useMemo(() => {
    return bankTransactions.filter((tx) => {
      if (activeFilter === 'unreconciled' && tx.reconciled) return false
      if (activeFilter === 'reconciled' && !tx.reconciled) return false

      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase()
        const desc = (tx.description || '').toLowerCase()
        const ref = (tx.reference || '').toLowerCase()
        const amt = tx.amount.toString()
        const dt = (tx.date || '').toLowerCase()
        return desc.includes(q) || ref.includes(q) || amt.includes(q) || dt.includes(q)
      }
      return true
    })
  }, [bankTransactions, activeFilter, searchTerm])

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol || 'R'} ${val.toLocaleString('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev))
    }, 4500)
  }

  // Handle CSV file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    const reader = new FileReader()
    reader.onload = async (event) => {
      const content = event.target?.result as string
      if (content) {
        try {
          const res = await importBankStatementCsv(content)
          if (res.ok) {
            showToast(`Successfully imported ${res.importedCount || 0} statement transactions (${res.skippedDuplicates || 0} duplicates skipped).`)
          } else {
            showToast(`Import failed: ${res.error || 'Unknown error'}`)
          }
        } catch (err: any) {
          showToast(`Import error: ${err.message}`)
        }
      }
      setIsImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    reader.readAsText(file)
  }

  // Helper button: Load standard sample FNB statement
  const handleLoadSampleStatement = async () => {
    setIsImporting(true)
    // Find open invoices to craft matched realistic transactions
    const wonDealInv = invoices.find((i) => i.crmDealId || i.partyName.toLowerCase().includes('helios'))
    const tenderInv = invoices.find((i) => i.tenderReference || i.partyName.toLowerCase().includes('ekurhuleni'))

    const wonAmount = wonDealInv ? wonDealInv.outstandingAmount : 115000
    const wonRef = wonDealInv ? wonDealInv.invoiceNumber : 'INV-2026-001'
    const tenderAmount = tenderInv ? tenderInv.outstandingAmount : 145000
    const tenderRef = tenderInv ? (tenderInv.tenderReference || tenderInv.invoiceNumber) : 'RFP-WTR-2026-04'

    const sampleCsv = `Date,Description,Reference,Amount
2026-09-02,EFT Deposit Helios Clean Energy Corporate Rollout,${wonRef},${wonAmount.toFixed(2)}
2026-09-03,EFT Deposit City of Ekurhuleni Water Dept,${tenderRef},${tenderAmount.toFixed(2)}
2026-09-04,EFT Settlement Safintra Steel Building Materials,BILL-2026-001,-42000.00
2026-09-05,Monthly Business Cheque Account Maintenance Fee,FEE-SEP26,-450.00`

    try {
      const res = await importBankStatementCsv(sampleCsv)
      if (res.ok) {
        showToast(`Loaded sample FNB statement: ${res.importedCount} transactions imported (${res.skippedDuplicates} duplicates skipped).`)
      } else {
        showToast(`Sample load failed: ${res.error}`)
      }
    } catch (err: any) {
      showToast(`Sample error: ${err.message}`)
    }
    setIsImporting(false)
  }

  // Execute 1-click reconciliation
  const handleReconcile = async (txId: string, invId: string, invNum: string) => {
    try {
      const res = await reconcileTransaction(txId, invId)
      if (res.ok) {
        showToast(`Reconciled transaction with Invoice ${invNum}. Invoice marked Paid and Journal Entry posted.`)
      } else {
        showToast(`Reconciliation failed: ${res.error || 'Unknown error'}`)
      }
    } catch (err: any) {
      showToast(`Reconciliation error: ${err.message}`)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 bg-[#1E293B] text-white text-xs rounded-xl shadow-lg border border-[#334155] animate-in fade-in slide-in-from-top-2 duration-200">
          <CheckCircle2 className="w-4 h-4 text-[#30A66D] flex-shrink-0" />
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="ml-2 text-white/60 hover:text-white text-xs font-semibold"
          >
            ×
          </button>
        </div>
      )}

      {/* ── HEADER BANNER ── */}
      <div className="bg-white border border-[#EDEDED] rounded-xl p-6 mb-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-[#0F766E]/10 text-[#0F766E] flex items-center justify-center flex-shrink-0">
              <Landmark className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-[#1E293B] tracking-tight">
                  FNB Business Cheque Account
                </h1>
                <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#F1F5F9] text-[#475569] border border-[#E2E8F0]">
                  acc-bank
                </span>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]">
                  {settings.currency || 'ZAR'}
                </span>
              </div>
              <p className="text-xs text-[#7C7C7C] mt-1">
                Designated operational liquid cash account · Sovereign double-entry ledger
              </p>
            </div>
          </div>

          <div className="flex items-baseline gap-6 border-t md:border-t-0 md:border-l border-[#EDEDED] pt-4 md:pt-0 md:pl-6">
            <div>
              <div className="text-[11px] font-medium text-[#7C7C7C] uppercase tracking-wider">
                Current Ledger Balance
              </div>
              <div className="text-2xl font-bold text-[#1E293B] mt-0.5">
                {formatMoney(currentBalance)}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#FDFAED] text-[#DB7706] border border-[#FCE6D5]">
                <Clock className="w-3.5 h-3.5" />
                {unreconciledCount} Unreconciled
              </span>

              {suggestions.length > 0 && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0] animate-pulse">
                  <Sparkles className="w-3.5 h-3.5" />
                  {suggestions.length} Matches Found
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── ACTION STRIP ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2.5">
          <input
            type="file"
            ref={fileInputRef}
            accept=".csv"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#0D655E] disabled:opacity-50 transition-colors shadow-xs"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{isImporting ? 'Importing...' : 'Import Bank Statement (CSV)'}</span>
          </button>

          <button
            onClick={handleLoadSampleStatement}
            disabled={isImporting}
            title="Inject realistic FNB statement matching CRM won deals and Tenders milestones"
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#1E293B] bg-white border border-[#CBD5E1] hover:bg-[#F8FAFC] disabled:opacity-50 transition-colors shadow-xs"
          >
            <Zap className="w-3.5 h-3.5 text-[#DB7706]" />
            <span>Load Sample FNB Statement</span>
          </button>
        </div>

        <div className="text-xs text-[#7C7C7C]">
          Supports CSV headers: <code className="font-mono bg-[#EDEDED] px-1 py-0.5 rounded text-[11px]">Date, Description, Reference, Amount</code>
        </div>
      </div>

      {/* ── SETTLEMENT SUGGESTIONS CARD SECTION ── */}
      {suggestions.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#059669]" />
              <h2 className="text-sm font-bold text-[#1E293B] uppercase tracking-wider">
                Automated Settlement Suggestions ({suggestions.length})
              </h2>
            </div>
            <span className="text-xs text-[#7C7C7C]">
              Matches computed between bank deposits/withdrawals and open invoices
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {suggestions.map((sug) => {
              const isHigh = sug.confidence === 'HIGH'
              return (
                <div
                  key={`${sug.transactionId}-${sug.invoiceId}`}
                  className="bg-white border border-[#E2E8F0] hover:border-[#CBD5E1] rounded-xl p-4 shadow-xs transition-all flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-[#1E293B]">
                            {sug.partyName}
                          </span>
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                              sug.invoiceType === 'Sales'
                                ? 'bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]'
                                : 'bg-[#EFF6FF] text-[#2563EB] border-[#BFDBFE]'
                            }`}
                          >
                            {sug.invoiceType}
                          </span>
                        </div>
                        <div className="text-xs text-[#64748B] font-mono mt-0.5">
                          Invoice: {sug.invoiceNumber}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-base font-bold text-[#1E293B]">
                          {formatMoney(sug.amount)}
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            isHigh
                              ? 'bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]'
                              : 'bg-[#FFFBEB] text-[#D97706] border border-[#FDE68A]'
                          }`}
                        >
                          {isHigh ? 'HIGH CONFIDENCE' : 'MEDIUM MATCH'}
                        </span>
                      </div>
                    </div>

                    <div className="text-xs text-[#64748B] bg-[#F8FAFC] border border-[#F1F5F9] rounded-lg p-2 mb-3">
                      <span className="font-medium text-[#475569]">Match Reason: </span>
                      {sug.reason}
                    </div>
                  </div>

                  <button
                    onClick={() => handleReconcile(sug.transactionId, sug.invoiceId, sug.invoiceNumber)}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#0D655E] transition-colors shadow-xs"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-300" />
                    <span>Reconcile with 1-Click</span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── TRANSACTIONS LEDGER TABLE ── */}
      <div className="bg-white border border-[#EDEDED] rounded-xl overflow-hidden shadow-xs">
        {/* Table Toolbar */}
        <div className="p-4 border-b border-[#EDEDED] flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#FAFAFA]">
          {/* Tabs */}
          <div className="flex items-center gap-1 bg-[#EDEDED] p-1 rounded-lg text-xs font-medium">
            <button
              onClick={() => setActiveFilter('all')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                activeFilter === 'all'
                  ? 'bg-white text-[#1E293B] font-semibold shadow-xs'
                  : 'text-[#525252] hover:text-[#1E293B]'
              }`}
            >
              All Transactions ({bankTransactions.length})
            </button>
            <button
              onClick={() => setActiveFilter('unreconciled')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                activeFilter === 'unreconciled'
                  ? 'bg-white text-[#1E293B] font-semibold shadow-xs'
                  : 'text-[#525252] hover:text-[#1E293B]'
              }`}
            >
              Unreconciled ({unreconciledCount})
            </button>
            <button
              onClick={() => setActiveFilter('reconciled')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                activeFilter === 'reconciled'
                  ? 'bg-white text-[#1E293B] font-semibold shadow-xs'
                  : 'text-[#525252] hover:text-[#1E293B]'
              }`}
            >
              Reconciled ({reconciledCount})
            </button>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#999999] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search description, reference..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs bg-white border border-[#CBD5E1] rounded-lg focus:outline-none focus:border-[#0F766E] w-64 text-[#1E293B]"
            />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#EDEDED] bg-[#F8F8F8] text-[#7C7C7C] font-semibold">
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Description</th>
                <th className="py-3 px-4">Reference</th>
                <th className="py-3 px-4 text-right">Amount</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-right">Matched Invoice / Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDEDED]">
              {filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-[#7C7C7C]">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <FileSpreadsheet className="w-8 h-8 text-[#CBD5E1]" />
                      <div className="font-semibold text-sm text-[#475569]">
                        No bank transactions found
                      </div>
                      <p className="text-xs text-[#94A3B8] max-w-sm">
                        Import a bank statement CSV or click "Load Sample FNB Statement" to see transactions and automated settlement suggestions.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((tx) => {
                  const isDeposit = tx.amount > 0
                  const matchedInv = tx.matchedInvoiceId
                    ? invoices.find((i) => i.id === tx.matchedInvoiceId)
                    : null
                  const sug = suggestions.find((s) => s.transactionId === tx.id)

                  return (
                    <tr key={tx.id} className="hover:bg-[#FBFBFB] transition-colors">
                      <td className="py-3 px-4 font-mono text-[#525252] whitespace-nowrap">
                        {tx.date}
                      </td>
                      <td className="py-3 px-4 font-medium text-[#1E293B]">
                        <div className="flex items-center gap-2">
                          {isDeposit ? (
                            <ArrowDownLeft className="w-3.5 h-3.5 text-[#059669] flex-shrink-0" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5 text-[#64748B] flex-shrink-0" />
                          )}
                          <span>{tx.description}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-[#64748B] whitespace-nowrap">
                        {tx.reference || '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-semibold whitespace-nowrap">
                        <span
                          className={
                            isDeposit
                              ? 'text-[#059669] font-bold'
                              : 'text-[#1E293B]'
                          }
                        >
                          {isDeposit ? `+${formatMoney(tx.amount)}` : formatMoney(tx.amount)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {tx.reconciled ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#ECFDF5] text-[#059669] border border-[#A7F3D0]">
                            <CheckCircle2 className="w-3 h-3" /> Reconciled
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FFFBEB] text-[#D97706] border border-[#FDE68A]">
                            <Clock className="w-3 h-3" /> Unreconciled
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {tx.reconciled ? (
                          <span className="text-xs text-[#64748B] font-mono">
                            {matchedInv ? (
                              <span title={`Matched with ${matchedInv.partyName}`}>
                                {matchedInv.invoiceNumber}
                              </span>
                            ) : tx.matchedInvoiceId ? (
                              <span>Matched: {tx.matchedInvoiceId}</span>
                            ) : (
                              <span>Settled</span>
                            )}
                          </span>
                        ) : sug ? (
                          <button
                            onClick={() => handleReconcile(tx.id, sug.invoiceId, sug.invoiceNumber)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#0D655E] transition-colors"
                          >
                            <Zap className="w-3 h-3 text-amber-300" />
                            Match {sug.invoiceNumber}
                          </button>
                        ) : (
                          <span className="text-xs text-[#94A3B8]">Unmatched</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
