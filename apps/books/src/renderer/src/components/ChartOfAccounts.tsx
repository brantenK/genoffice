import React, { useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FileText, Plus } from 'lucide-react'
import { useBooksStore } from '../store'
import type { Account, AccountRoot } from '../../../shared/types'

export function ChartOfAccounts() {
  const { data } = useBooksStore()
  const { accounts, settings } = data

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    'acc-asset': true,
    'acc-curr-asset': true,
    'acc-fixed-asset': true,
    'acc-liab': true,
    'acc-curr-liab': true,
    'acc-equity': true,
    'acc-income': true,
    'acc-expense': true,
  })

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const renderTree = (parentId: string | null = null, depth = 0) => {
    if (depth > 20) return null
    const isRoot = parentId === null || parentId === undefined
    const children = accounts.filter((a) => {
      if (isRoot) {
        return (
          a.parentId === null ||
          a.parentId === undefined ||
          (depth === 0 && !accounts.some((parent) => parent.id === a.parentId))
        )
      }
      return a.parentId === parentId
    })
    if (children.length === 0) return null

    return (
      <div className="space-y-1">
        {children.map((acc) => {
          const isExp = !!expanded[acc.id]
          const hasChildren = accounts.some((a) => a.parentId === acc.id)

          return (
            <div key={acc.id}>
              <div
                onClick={() => hasChildren && toggle(acc.id)}
                style={{ paddingLeft: `${depth * 20 + 12}px` }}
                className={`flex items-center justify-between py-2 pr-4 rounded-lg cursor-pointer transition-colors ${
                  acc.isGroup ? 'hover:bg-[#F3F3F3] text-[#1E293B] font-semibold text-xs' : 'hover:bg-[#F8F8F8] text-[#525252] text-xs'
                }`}
              >
                <div className="flex items-center gap-2">
                  {hasChildren ? (
                    <button className="text-[#7C7C7C] hover:text-[#1E293B]">
                      {isExp ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  ) : (
                    <span className="w-3.5" />
                  )}

                  {acc.isGroup ? (
                    <Folder className="w-4 h-4 text-[#DB7706]" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-[#7C7C7C]" />
                  )}

                  <span className={acc.isGroup ? 'font-bold' : ''}>{acc.name}</span>
                  <span className="text-[10px] text-[#7C7C7C] font-mono uppercase px-1.5 py-0.5 rounded bg-[#EDEDED]">
                    {acc.accountType}
                  </span>
                </div>

                <div className="flex items-center gap-6">
                  <span className={`font-mono text-xs ${acc.balance > 0 ? 'font-bold text-[#1E293B]' : 'text-[#7C7C7C]'}`}>
                    {formatMoney(acc.balance)}
                  </span>
                </div>
              </div>

              {hasChildren && isExp && renderTree(acc.id, depth + 1)}
            </div>
          )
        })}
      </div>
    )
  }

  const rootGroups: AccountRoot[] = ['Asset', 'Liability', 'Equity', 'Income', 'Expense']

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#EDEDED]">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Chart of Accounts</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Double-entry ledger structure for {settings.companyName}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const all: Record<string, boolean> = {}
              accounts.forEach((a) => {
                if (a.isGroup) all[a.id] = true
              })
              setExpanded(all)
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F8F8F8]"
          >
            Expand All
          </button>
          <button
            onClick={() => setExpanded({})}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-[#1E293B] bg-white border border-[#EDEDED] hover:bg-[#F8F8F8]"
          >
            Collapse All
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-[#EDEDED] p-6 shadow-xs">
        <div className="text-xs font-bold text-[#7C7C7C] uppercase tracking-wider mb-4 pb-2 border-b border-[#EDEDED] flex justify-between">
          <span>Account Title / Hierarchy</span>
          <span>Balance ({settings.currency})</span>
        </div>

        {renderTree(null, 0)}
      </div>
    </div>
  )
}
