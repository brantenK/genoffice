import React, { useState } from 'react'
import { Landmark, ShieldCheck, Building2, Wallet, ArrowRight } from 'lucide-react'
import { useBooksStore } from '../store'
import { EMPTY_ACCOUNTS, DEFAULT_BOOK_SETTINGS } from '../../../shared/chart'
import { createOpeningJournal } from '../../../shared/accounting'
import type { BooksData, CompanySettings } from '../../../shared/types'

const CURRENCIES: { code: string; symbol: string }[] = [
  { code: 'ZAR', symbol: 'R' },
  { code: 'USD', symbol: '$' },
  { code: 'GBP', symbol: '£' },
  { code: 'EUR', symbol: '€' },
]

/** Accounts offered in the opening-balances step (leaf accounts only). */
const OPENING_BALANCE_FIELDS: { accountId: string; label: string }[] = [
  { accountId: 'acc-bank', label: 'Business bank account' },
  { accountId: 'acc-cash', label: 'Petty cash' },
  { accountId: 'acc-ar', label: 'Accounts receivable (customers owe you)' },
  { accountId: 'acc-ap', label: 'Accounts payable (you owe suppliers)' },
  { accountId: 'acc-vat', label: 'VAT output payable to SARS' },
  { accountId: 'acc-capital', label: 'Owner / share capital contribution' },
]

export function SetupWizard() {
  const completeSetup = useBooksStore((s) => s.completeSetup)
  const [step, setStep] = useState<1 | 2>(1)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [companyName, setCompanyName] = useState('')
  const [taxNumber, setTaxNumber] = useState('')
  const [currency, setCurrency] = useState('ZAR')
  const [financialYearStart, setFinancialYearStart] = useState('2026-03-01')
  const [address, setAddress] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [opening, setOpening] = useState<Record<string, string>>({})

  const currencySymbol =
    CURRENCIES.find((c) => c.code === currency)?.symbol || DEFAULT_BOOK_SETTINGS.currencySymbol

  const parseAmount = (raw: string): number => {
    const n = Number(String(raw).replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : 0
  }

  const handleFinish = async () => {
    setError(null)
    if (!companyName.trim()) {
      setError('Company name is required to set up your books.')
      return
    }

    const accounts = EMPTY_ACCOUNTS.map((a) => {
      if (OPENING_BALANCE_FIELDS.some((f) => f.accountId === a.id)) {
        return { ...a, balance: parseAmount(opening[a.id] || '') }
      }
      return { ...a, balance: 0 }
    })

    const settings: CompanySettings = {
      companyName: companyName.trim(),
      taxNumber: taxNumber.trim(),
      currency,
      currencySymbol,
      financialYearStart,
      address: address.trim(),
      email: email.trim(),
      phone: phone.trim(),
    }

    // Opening balances become a balanced journal entry; the ledger derives
    // every balance from journals from day one.
    const openingJournal = createOpeningJournal(accounts, {
      date: financialYearStart,
      entryNumber: `JE-OPENING-${new Date(financialYearStart).getFullYear() || new Date().getFullYear()}`,
      remarks: 'Opening balances entered at setup',
    })

    const ledger: BooksData = {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings,
      accounts,
      parties: [],
      invoices: [],
      journalEntries: [openingJournal],
      bankTransactions: [],
    }

    setSaving(true)
    try {
      await completeSetup(ledger)
    } catch (err: any) {
      setError(err?.message || 'Failed to save your company setup.')
      setSaving(false)
    }
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-[#E2E8F0] bg-white text-sm text-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]'

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[#F6F7F8] p-6">
      <div className="w-full max-w-xl bg-white rounded-2xl border border-[#EDEDED] shadow-lg overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-[#EDEDED] flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-[#0F766E] text-white flex items-center justify-center">
            <Landmark className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[#1E293B] tracking-tight">Set up Zano Books</h1>
            <p className="text-xs text-[#7C7C7C] mt-0.5">
              Your data stays on this machine. Nothing is sent to the cloud.
            </p>
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-[#FFF7F7] border border-[#FCD7D7] text-xs font-medium text-[#E03636]">
            {error}
          </div>
        )}

        <div className="p-6">
          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#525252] mb-1.5">
                  Company name <span className="text-[#E03636]">*</span>
                </label>
                <input
                  className={inputCls}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="e.g. Thabo Engineering (Pty) Ltd"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-[#525252] mb-1.5">
                    Tax / VAT number
                  </label>
                  <input
                    className={inputCls}
                    value={taxNumber}
                    onChange={(e) => setTaxNumber(e.target.value)}
                    placeholder="e.g. 4920198273"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#525252] mb-1.5">
                    Financial year starts
                  </label>
                  <input
                    type="date"
                    className={inputCls}
                    value={financialYearStart}
                    onChange={(e) => setFinancialYearStart(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#525252] mb-1.5">Currency</label>
                <div className="grid grid-cols-4 gap-2">
                  {CURRENCIES.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => setCurrency(c.code)}
                      className={`px-3 py-2 rounded-lg border text-xs font-semibold transition-colors ${
                        currency === c.code
                          ? 'border-[#0F766E] bg-[#F0FDFA] text-[#0F766E]'
                          : 'border-[#E2E8F0] text-[#525252] hover:bg-[#F8F8F8]'
                      }`}
                    >
                      {c.symbol} {c.code}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#525252] mb-1.5">
                  Registered address
                </label>
                <input
                  className={inputCls}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Street, city, postal code"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-[#525252] mb-1.5">Email</label>
                  <input
                    className={inputCls}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="accounts@company.co.za"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#525252] mb-1.5">Phone</label>
                  <input
                    className={inputCls}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+27 ..."
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-[#F0FDFA] border border-[#BAE8E1]">
                <ShieldCheck className="w-5 h-5 text-[#0F766E] flex-shrink-0 mt-0.5" />
                <p className="text-xs text-[#0F766E] leading-relaxed">
                  Enter the balances of your accounts{' '}
                  <strong>as of the start of this financial year</strong>. Everything you enter
                  becomes a balanced opening journal entry — you can leave everything at zero and
                  start fresh.
                </p>
              </div>

              <div className="space-y-3">
                {OPENING_BALANCE_FIELDS.map((field) => (
                  <div key={field.accountId}>
                    <label className="block text-xs font-bold text-[#525252] mb-1.5">
                      {field.label}
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#7C7C7C]">
                        {currencySymbol}
                      </span>
                      <input
                        className={`${inputCls} pl-8`}
                        value={opening[field.accountId] || ''}
                        onChange={(e) =>
                          setOpening((prev) => ({ ...prev, [field.accountId]: e.target.value }))
                        }
                        placeholder="0.00"
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#EDEDED] bg-[#FAFAFA] flex items-center justify-between">
          {step === 2 ? (
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-[#525252] hover:bg-[#EDEDED] transition-colors"
            >
              Back
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs text-[#999999]">
              <Building2 className="w-4 h-4" />
              <span>Step 1 of 2 · Company details</span>
            </div>
          )}

          {step === 1 ? (
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] transition-colors"
            >
              Continue <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinish}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-50 transition-colors"
            >
              <Wallet className="w-3.5 h-3.5" />
              {saving ? 'Saving…' : 'Start using Zano Books'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
