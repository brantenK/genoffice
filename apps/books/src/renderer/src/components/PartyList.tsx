import React, { useState } from 'react'
import { Plus, Search, Mail, Phone, Building } from 'lucide-react'
import { useBooksStore } from '../store'
import type { Party, PartyType } from '../../../shared/types'

export function PartyList() {
  const { data, addParty, setActiveTab, setActiveInvoiceId } = useBooksStore()
  const { parties, settings } = data

  const [activeType, setActiveType] = useState<PartyType | 'All'>('All')
  const [searchTerm, setSearchTerm] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)

  const [name, setName] = useState('')
  const [type, setType] = useState<PartyType>('Customer')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [taxId, setTaxId] = useState('')
  const [address, setAddress] = useState('')

  const filtered = parties.filter((p) => {
    const matchesType = activeType === 'All' || p.type === activeType
    const matchesSearch =
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.email && p.email.toLowerCase().includes(searchTerm.toLowerCase()))
    return matchesType && matchesSearch
  })

  const formatMoney = (val: number) => {
    return `${settings.currencySymbol} ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    await addParty({
      name: name.trim(),
      type,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      taxId: taxId.trim() || undefined,
      address: address.trim() || undefined,
    })
    setName('')
    setEmail('')
    setPhone('')
    setTaxId('')
    setAddress('')
    setShowAddModal(false)
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-8 bg-[#FBFBFB]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B] tracking-tight">Customers & Suppliers</h1>
          <p className="text-sm text-[#7C7C7C] mt-0.5">
            Directory of commercial counterparties for {settings.companyName}
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A] shadow-xs transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Contact
        </button>
      </div>

      {/* Filter and Search */}
      <div className="flex items-center justify-between gap-4 mb-6 bg-white p-3 rounded-xl border border-[#EDEDED] shadow-xs">
        <div className="flex items-center gap-1">
          {(['All', 'Customer', 'Supplier'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveType(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                activeType === t
                  ? 'bg-[#1E293B] text-white'
                  : 'text-[#7C7C7C] hover:text-[#1E293B] hover:bg-[#F3F3F3]'
              }`}
            >
              {t === 'All' ? 'All Contacts' : `${t}s`}
            </button>
          ))}
        </div>

        <div className="relative w-72">
          <Search className="w-4 h-4 text-[#7C7C7C] absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search by name, email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
          />
        </div>
      </div>

      {/* Grid of Parties */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filtered.map((party) => (
          <div key={party.id} className="bg-white rounded-xl border border-[#EDEDED] p-5 shadow-xs flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between mb-2">
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                    party.type === 'Customer'
                      ? 'bg-[#F0FDFA] text-[#0F766E]'
                      : 'bg-[#FFF9F5] text-[#D45A08]'
                  }`}
                >
                  {party.type}
                </span>
                <span className="text-xs font-mono font-semibold text-[#1E293B]">
                  {formatMoney(party.outstandingBalance)} due
                </span>
              </div>

              <h2 className="text-sm font-bold text-[#1E293B] mb-2">{party.name}</h2>

              <div className="space-y-1.5 text-xs text-[#7C7C7C]">
                {party.taxId && (
                  <div className="flex items-center gap-2">
                    <Building className="w-3.5 h-3.5 text-[#94A3B8]" />
                    <span>Tax ID: {party.taxId}</span>
                  </div>
                )}
                {party.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-[#94A3B8]" />
                    <span className="truncate">{party.email}</span>
                  </div>
                )}
                {party.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-[#94A3B8]" />
                    <span>{party.phone}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-[#EDEDED] flex justify-end">
              <button
                onClick={() => {
                  if (party.type === 'Customer') {
                    setActiveTab('invoices')
                  } else {
                    setActiveTab('purchases')
                  }
                  setActiveInvoiceId('new')
                }}
                className="text-xs font-semibold text-[#007BE0] hover:underline"
              >
                + New {party.type === 'Customer' ? 'Invoice' : 'Bill'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-[#EDEDED]">
            <h2 className="text-lg font-bold text-[#1E293B] mb-4">Add Contact (Customer / Supplier)</h2>
            <form onSubmit={handleCreate} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-[#525252] mb-1">Contact Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. City Power Johannesburg"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">Classification</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as PartyType)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  >
                    <option value="Customer">Customer</option>
                    <option value="Supplier">Supplier</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">VAT / Tax ID</label>
                  <input
                    type="text"
                    placeholder="e.g. 4920198273"
                    value={taxId}
                    onChange={(e) => setTaxId(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">Email</label>
                  <input
                    type="email"
                    placeholder="billing@domain.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-[#525252] mb-1">Phone</label>
                  <input
                    type="tel"
                    placeholder="+27 ..."
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-[#525252] mb-1">Physical / Billing Address</label>
                <input
                  type="text"
                  placeholder="Street, City, Postal Code"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 bg-[#F8F8F8] border border-[#EDEDED] rounded-lg focus:outline-none focus:border-[#1E293B]"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-lg font-semibold text-[#525252] bg-[#F3F3F3] hover:bg-[#E2E2E2]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg font-semibold text-white bg-[#1E293B] hover:bg-[#0F172A]"
                >
                  Save Contact
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
