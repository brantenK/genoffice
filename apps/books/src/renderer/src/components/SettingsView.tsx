import React, { useCallback, useEffect, useState } from 'react'
import {
  Save,
  Building2,
  Settings,
  CheckCircle,
  Download,
  DatabaseBackup,
  ArchiveRestore,
  Lock,
} from 'lucide-react'
import { useBooksStore } from '../store'
import { DEFAULT_BOOK_SETTINGS } from '../../../shared/chart'
import type { CompanySettings } from '../../../shared/types'
import type { BackupFileInfo, BackupResult } from '../../../shared/ipc'

const CURRENCIES: { code: string; symbol: string }[] = [
  { code: 'ZAR', symbol: 'R' },
  { code: 'USD', symbol: '$' },
  { code: 'GBP', symbol: '£' },
  { code: 'EUR', symbol: '€' },
]

export function SettingsView() {
  const data = useBooksStore((s) => s.data)
  const settings = data.settings || DEFAULT_BOOK_SETTINGS

  const [companyName, setCompanyName] = useState(settings.companyName || '')
  const [taxNumber, setTaxNumber] = useState(settings.taxNumber || '')
  const [address, setAddress] = useState(settings.address || '')
  const [email, setEmail] = useState(settings.email || '')
  const [phone, setPhone] = useState(settings.phone || '')
  const [defaultTaxRate, setDefaultTaxRate] = useState(
    settings.defaultTaxRate !== undefined ? String(settings.defaultTaxRate) : '15',
  )
  const [taxInclusive, setTaxInclusive] = useState(
    settings.taxInclusive !== undefined ? Boolean(settings.taxInclusive) : true,
  )
  const [currency, setCurrency] = useState(settings.currency || 'ZAR')
  const [financialYearStart, setFinancialYearStart] = useState(
    settings.financialYearStart || '2026-03-01',
  )

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [backingUp, setBackingUp] = useState(false)
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null)
  const [backups, setBackups] = useState<BackupFileInfo[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const [closeThrough, setCloseThrough] = useState(new Date().toISOString().split('T')[0])
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [closeResult, setCloseResult] = useState(false)

  const handleClosePeriod = async () => {
    if (!closeThrough) return
    setClosing(true)
    setCloseError(null)
    setCloseResult(false)
    try {
      const res = await useBooksStore.getState().closeFinancialYear(closeThrough)
      if (res.ok) {
        setCloseResult(true)
      } else {
        setCloseError(res.error || 'Unable to close the financial year')
      }
    } catch (err: any) {
      setCloseError(err?.message || 'Unable to close the financial year')
    } finally {
      setClosing(false)
    }
  }

  const currencySymbol =
    CURRENCIES.find((c) => c.code === currency)?.symbol || DEFAULT_BOOK_SETTINGS.currencySymbol

  const handleCurrencyChange = (code: string) => {
    setCurrency(code)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!companyName.trim()) {
      setError('Company name is required to save settings.')
      return
    }

    const patch: Partial<CompanySettings> = {
      companyName: companyName.trim(),
      taxNumber: taxNumber.trim(),
      address: address.trim(),
      email: email.trim(),
      phone: phone.trim(),
      defaultTaxRate: Number(defaultTaxRate),
      taxInclusive,
      currency,
      currencySymbol,
      financialYearStart,
    }

    setSaving(true)
    try {
      await useBooksStore.getState().updateSettings(patch)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err?.message || 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  const refreshBackups = useCallback(async () => {
    try {
      const list = await window.booksApi?.listBackups?.()
      setBackups(list || [])
    } catch {
      setBackups([])
    }
  }, [])

  useEffect(() => {
    void refreshBackups()
  }, [refreshBackups])

  const handleBackupNow = async () => {
    if (!window.booksApi) return
    setBackingUp(true)
    setBackupResult(null)
    try {
      const result = await window.booksApi.backupNow()
      setBackupResult(result)
      if (result.ok) {
        void refreshBackups()
      }
    } catch (err: any) {
      setBackupResult({ ok: false, error: err?.message || 'Failed to create backup.' })
    } finally {
      setBackingUp(false)
    }
  }

  const handleRestore = async (name: string) => {
    if (!window.booksApi) return
    const confirmed = window.confirm(
      `Restore "${name}"?\n\nYour current books data will be replaced by this backup. A pre-restore safety copy of the current data is created automatically before restoring.`,
    )
    if (!confirmed) return
    setRestoring(name)
    setRestoreResult(null)
    try {
      const result = await window.booksApi.restoreBackup(name)
      setRestoreResult(result)
      if (result.ok) {
        void refreshBackups()
      }
    } catch (err: any) {
      setRestoreResult({ ok: false, error: err?.message || 'Failed to restore backup.' })
    } finally {
      setRestoring(null)
    }
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-[#E2E8F0] bg-white text-sm text-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]'
  const labelCls = 'block text-xs font-bold text-[#525252] mb-1.5'

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Company Settings</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Business details, tax defaults and accounting preferences for Zano Books
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-[#0F766E] text-white flex items-center justify-center">
            <Settings className="w-5 h-5" />
          </div>
        </div>
      </div>

      {saved && (
        <div className="mb-5 flex items-center gap-2 px-4 py-3 rounded-lg bg-[#F0FDFA] border border-[#99F6E4] text-xs font-semibold text-[#0F766E]">
          <CheckCircle className="w-4 h-4" />
          Settings saved successfully.
        </div>
      )}
      {error && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-[#FFF7F7] border border-[#FCD7D7] text-xs font-medium text-[#E03636]">
          {error}
        </div>
      )}

      <form onSubmit={handleSave} className="max-w-2xl space-y-6">
        {/* Company */}
        <section className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs">
          <div className="flex items-center gap-2 mb-5">
            <Building2 className="w-4 h-4 text-[#0F766E]" />
            <h2 className="text-sm font-bold text-[#1E293B] tracking-tight">Company</h2>
          </div>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>
                Company name <span className="text-[#E03636]">*</span>
              </label>
              <input
                type="text"
                className={inputCls}
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Zano Consulting & Engineering (Pty) Ltd"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Tax / VAT number</label>
                <input
                  type="text"
                  className={inputCls}
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  placeholder="e.g. 4920198273"
                />
              </div>
              <div>
                <label className={labelCls}>Phone</label>
                <input
                  type="tel"
                  className={inputCls}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+27 11 555 0192"
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input
                type="email"
                className={inputCls}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="accounts@company.co.za"
              />
            </div>
            <div>
              <label className={labelCls}>Address</label>
              <input
                type="text"
                className={inputCls}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, City, Postal Code"
              />
            </div>
          </div>
        </section>

        {/* Accounting defaults */}
        <section className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs">
          <h2 className="text-sm font-bold text-[#1E293B] tracking-tight mb-5">
            Accounting Defaults
          </h2>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Default VAT rate (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  className={inputCls}
                  value={defaultTaxRate}
                  onChange={(e) => setDefaultTaxRate(e.target.value)}
                  placeholder="15"
                />
              </div>
              <div>
                <label className={labelCls}>Currency</label>
                <select
                  className={inputCls}
                  value={currency}
                  onChange={(e) => handleCurrencyChange(e.target.value)}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} ({c.symbol})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={taxInclusive}
                onChange={(e) => setTaxInclusive(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#0F766E]"
              />
              <span>
                <span className="block text-xs font-bold text-[#525252]">
                  Prices are VAT-inclusive
                </span>
                <span className="block text-[11px] text-[#7C7C7C] mt-0.5">
                  Rates entered on invoices include VAT
                </span>
              </span>
            </label>

            <div>
              <label className={labelCls}>Financial year start</label>
              <input
                type="date"
                className={inputCls}
                value={financialYearStart}
                onChange={(e) => setFinancialYearStart(e.target.value)}
              />
            </div>
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* Financial Year Close */}
      <section className="max-w-2xl mt-6 bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs">
        <div className="flex items-center gap-2 mb-1">
          <Lock className="w-4 h-4 text-[#0F766E]" />
          <h2 className="text-sm font-bold text-[#1E293B] tracking-tight">Financial Year Close</h2>
        </div>
        <p className="text-xs text-[#7C7C7C] mb-5">
          Closing a period moves all income and expenses into retained earnings and locks that
          period: no new or edited invoices can post into it afterwards.
        </p>

        {data.settings.closedThrough ? (
          <div className="mb-4 px-4 py-3 rounded-lg bg-[#F0FDFA] border border-[#BAE8E1] text-xs font-medium text-[#0F766E]">
            Periods locked through <span className="font-mono">{data.settings.closedThrough}</span>.
          </div>
        ) : (
          <div className="mb-4 px-4 py-3 rounded-lg bg-[#F8F8F8] border border-[#EDEDED] text-xs text-[#7C7C7C]">
            No period has been closed yet.
          </div>
        )}

        <div className="flex items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-[#525252] mb-1">
              Close through date
            </label>
            <input
              type="date"
              value={closeThrough}
              onChange={(e) => setCloseThrough(e.target.value)}
              className="px-3 py-2 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
            />
          </div>
          <button
            onClick={handleClosePeriod}
            disabled={closing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            {closing ? 'Closing…' : 'Close Period'}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-[#7C7C7C]">
          Requires all invoices on or before the close date to be paid or cancelled.
        </p>

        {closeError && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#FFF7F7] border border-[#FCD7D7] text-xs font-medium text-[#E03636]">
            {closeError}
          </div>
        )}
        {closeResult && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#F0FDFA] border border-[#BAE8E1] text-xs font-medium text-[#0F766E]">
            Period closed through {closeThrough} — income and expenses moved to retained earnings.
          </div>
        )}
      </section>

      {/* Backup & Restore */}
      <section className="max-w-2xl mt-6 bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs">
        <div className="flex items-center gap-2 mb-1">
          <DatabaseBackup className="w-4 h-4 text-[#0F766E]" />
          <h2 className="text-sm font-bold text-[#1E293B] tracking-tight">Backup & Restore</h2>
        </div>
        <p className="text-xs text-[#7C7C7C] mb-5">
          Back up your books data file and restore from an earlier backup at any time.
        </p>

        <button
          type="button"
          onClick={() => void handleBackupNow()}
          disabled={backingUp}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#0F766E] hover:bg-[#0B5D57] shadow-xs transition-colors disabled:opacity-60"
        >
          <Download className="w-4 h-4" />
          {backingUp ? 'Backing up…' : 'Backup now'}
        </button>

        {backupResult && backupResult.ok && backupResult.path && (
          <div className="mt-4 flex items-start gap-2 px-4 py-3 rounded-lg bg-[#F0FDFA] border border-[#99F6E4] text-xs font-semibold text-[#0F766E]">
            <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Backup created:
              <span className="block font-normal text-[#525252] break-all">
                {backupResult.path}
              </span>
            </span>
          </div>
        )}
        {backupResult && !backupResult.ok && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#FFF7F7] border border-[#FCD7D7] text-xs font-medium text-[#E03636]">
            {backupResult.error || 'Failed to create backup.'}
          </div>
        )}

        <div className="mt-6">
          <h3 className="text-xs font-bold text-[#525252] mb-2">Available backups</h3>
          {backups.length === 0 ? (
            <p className="text-xs text-[#7C7C7C]">No backups yet. Create one with “Backup now”.</p>
          ) : (
            <ul className="divide-y divide-[#EDEDED] border border-[#EDEDED] rounded-lg">
              {backups.map((b) => (
                <li key={b.name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#1E293B] truncate">{b.name}</p>
                    <p className="text-[11px] text-[#7C7C7C]">
                      {new Date(b.modifiedAt).toLocaleString()} · {formatSize(b.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={restoring === b.name}
                    onClick={() => void handleRestore(b.name)}
                    className="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-[#0F766E] border border-[#99F6E4] hover:bg-[#F0FDFA] transition-colors disabled:opacity-60"
                  >
                    <ArchiveRestore className="w-3.5 h-3.5" />
                    {restoring === b.name ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {restoreResult && restoreResult.ok && (
          <div className="mt-4 flex items-start gap-2 px-4 py-3 rounded-lg bg-[#F0FDFA] border border-[#99F6E4] text-xs font-semibold text-[#0F766E]">
            <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Backup restored — your data has been refreshed. Reload the app window to make sure
              every view reflects the restored data.
            </span>
          </div>
        )}
        {restoreResult && !restoreResult.ok && (
          <div className="mt-4 px-4 py-3 rounded-lg bg-[#FFF7F7] border border-[#FCD7D7] text-xs font-medium text-[#E03636]">
            {restoreResult.error || 'Failed to restore backup.'}
          </div>
        )}

        {backups.length > 10 && (
          <p className="mt-4 text-[11px] text-[#7C7C7C]">
            You have {backups.length} backups. Oldest backups beyond the latest 10 are pruned
            automatically on the next backup.
          </p>
        )}
      </section>
    </div>
  )
}
