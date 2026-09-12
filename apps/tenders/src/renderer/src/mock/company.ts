import type { CompanyProfile } from '../../shared/types'

export const MOCK_COMPANY: CompanyProfile = {
  name: 'Thabo Engineering (Pty) Ltd',
  tradingName: 'Thabo Engineering',
  registrationNumber: 'CK2014/1234567/07',
  vatNumber: '4220189034',
  taxPin: 'CITX-2026-884-0192',
  bbbeeLevel: 'Level 1 (EME)',
  bbbeeBlackOwnership: '100%',
  csdSupplierNumber: 'MAZE-4451902',
  founded: '2014',
  employees: '42',
  industry: 'Civil & Electrical Engineering',
  description:
    'Thabo Engineering (Pty) Ltd is a 100% black-owned South African engineering firm specialising in civil infrastructure, electrical installation, and water reticulation projects. Founded in 2014, the company has grown from a small sub-contractor into a recognised prime contractor delivering government and private-sector projects across Gauteng, Limpopo, and the North West.',
  address: '14 Diesel Road, Sebenza Industrial Park, Edenvale, Gauteng 1610',
  phone: '+27 11 452 9900',
  email: 'info@thaboengineering.co.za',
  website: 'www.thaboengineering.co.za',
  directors: [
    { name: 'Thabo Mokoena', role: 'Managing Director', idNumber: '7801015263083' },
    { name: 'Lindiwe Naidoo', role: 'Finance Director', idNumber: '8302240091085' },
    { name: 'Sibusiso Sithole', role: 'Technical Director', idNumber: '7912155037082' },
  ],
  projects: [
    {
      id: 'p-1',
      title: 'Vaal River Road Rehabilitation — Phase 2',
      client: 'Lethabo Infrastructure (Pty) Ltd / SANRAL',
      value: 'R 18.4 million',
      period: '2023–2024',
      status: 'COMPLETED',
      description: 'Full road rehabilitation of 12.6 km of provincial road including stormwater upgrades, guardrails, and line marking. Project delivered on-time and within budget.',
      sector: 'Civil'
    },
    {
      id: 'p-2',
      title: 'Ekurhuleni Zone 4 Electrical Infrastructure Upgrade',
      client: 'Ekurhuleni Metro Municipality',
      value: 'R 6.7 million',
      period: '2024–2025',
      status: 'COMPLETED',
      description: 'Replacement of ageing MV/LV distribution network across Zone 4 residential area. Installed 38 new mini-substations and 14 km of underground cabling.',
      sector: 'Electrical'
    },
    {
      id: 'p-3',
      title: 'Sekhukhune Water Reticulation Project',
      client: 'Department of Water and Sanitation',
      value: 'R 24.1 million',
      period: '2024–2026',
      status: 'IN_PROGRESS',
      description: 'Design and construction of bulk water supply infrastructure serving 4 200 households in the Sekhukhune District. Currently at 68% completion.',
      sector: 'Water'
    },
    {
      id: 'p-4',
      title: 'Tembisa Clinic Access Road and Parking',
      client: 'Ekurhuleni Metro Municipality',
      value: 'R 3.2 million',
      period: '2022–2023',
      status: 'COMPLETED',
      description: 'New access road, perimeter fencing, and 120-bay parking facility for the Tembisa Community Health Centre.',
      sector: 'Civil'
    },
    {
      id: 'p-5',
      title: 'Eskom Sub-transmission Line Maintenance — Limpopo East',
      client: 'Eskom Holdings SOC Ltd',
      value: 'R 9.8 million',
      period: '2021–2023',
      status: 'COMPLETED',
      description: 'Annual maintenance contract for 220 km of 132 kV transmission line including tower inspections, stringing repairs, and vegetation clearing.',
      sector: 'Electrical'
    },
    {
      id: 'p-6',
      title: 'DWS/RFP-2026/0034 — Olifants River Bulk Water',
      client: 'Department of Water and Sanitation',
      value: 'TBD (bid in preparation)',
      period: '2026–',
      status: 'BIDDING',
      description: 'Tender currently in preparation. Scope includes bulk raw water pipeline (42 km), pump station, and telemetry system for the Olifants River system.',
      sector: 'Water'
    }
  ]
}
