// The demonstration dataset — the seed company, its customers and its compliance
// vault — in a module both layers may import.
//
// WHY THIS FILE EXISTS. The data used to live in `renderer/src/mock/{company,
// customers,vault}.ts`, and `main/tenders-main.ts` imported it from there. That
// is a dependency-direction violation: `main` imported `renderer`, which pulled
// the renderer's browser-only code (`window.open`, `URL.createObjectURL`,
// `fetch`) into the main bundle's import graph for the sake of three constants.
// The DATA is what main needs; the browser helpers are not. So the data lives
// here — `shared/`, which imports nothing but `shared/types` — and the renderer's
// mock modules re-export from it, so every existing renderer import keeps
// working unchanged. `main` now imports `shared/` only.
//
// WHAT THIS FILE MAY NOT DO, and does not: it imports no `electron`, no
// `node:*` and nothing from `renderer/`, and it touches no browser global. It is
// a frozen literal dataset and nothing else, which is what makes it safe for a
// Node main process to import.
//
// THE VALUES ARE FROZEN. `vault`'s `fileUrl` keeps the ABSOLUTE `/demo/vault/…`
// form on purpose. These bytes are part of the historical demo domain that
// v1→v2 demo recognition compares in full (`HISTORICAL_DEMO_CANONICAL_BASE64` in
// `shared/tenders-schema.ts`, and the digest locked in
// `tests/store-migrations.test.ts`): editing one of them makes an existing
// on-disk v1 demo file classify as `user`, i.e. demo data silently promoted to
// user data. The value is therefore never used as a URL directly —
// `demoAssetRelativeUrl` in `renderer/src/mock/vault.ts` resolves it to the
// document-relative `./demo/vault/…` form, which is what `publicDir` ships next
// to `index.html` and what actually loads.
import type { CompanyProfile, Customer, VaultDoc } from './types'

// Mock company — "Thabo Engineering (Pty) Ltd".
// Dates are fixed ISO values (deterministic demo); the app computes health
// against the real current date at runtime.
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
      description:
        'Full road rehabilitation of 12.6 km of provincial road including stormwater upgrades, guardrails, and line marking. Project delivered on-time and within budget.',
      sector: 'Civil',
    },
    {
      id: 'p-2',
      title: 'Ekurhuleni Zone 4 Electrical Infrastructure Upgrade',
      client: 'Ekurhuleni Metro Municipality',
      value: 'R 6.7 million',
      period: '2024–2025',
      status: 'COMPLETED',
      description:
        'Replacement of ageing MV/LV distribution network across Zone 4 residential area. Installed 38 new mini-substations and 14 km of underground cabling.',
      sector: 'Electrical',
    },
    {
      id: 'p-3',
      title: 'Sekhukhune Water Reticulation Project',
      client: 'Department of Water and Sanitation',
      value: 'R 24.1 million',
      period: '2024–2026',
      status: 'IN_PROGRESS',
      description:
        'Design and construction of bulk water supply infrastructure serving 4 200 households in the Sekhukhune District. Currently at 68% completion.',
      sector: 'Water',
    },
    {
      id: 'p-4',
      title: 'Tembisa Clinic Access Road and Parking',
      client: 'Ekurhuleni Metro Municipality',
      value: 'R 3.2 million',
      period: '2022–2023',
      status: 'COMPLETED',
      description:
        'New access road, perimeter fencing, and 120-bay parking facility for the Tembisa Community Health Centre.',
      sector: 'Civil',
    },
    {
      id: 'p-5',
      title: 'Eskom Sub-transmission Line Maintenance — Limpopo East',
      client: 'Eskom Holdings SOC Ltd',
      value: 'R 9.8 million',
      period: '2021–2023',
      status: 'COMPLETED',
      description:
        'Annual maintenance contract for 220 km of 132 kV transmission line including tower inspections, stringing repairs, and vegetation clearing.',
      sector: 'Electrical',
    },
    {
      id: 'p-6',
      title: 'DWS/RFP-2026/0034 — Olifants River Bulk Water',
      client: 'Department of Water and Sanitation',
      value: 'TBD (bid in preparation)',
      period: '2026–',
      status: 'BIDDING',
      description:
        'Tender currently in preparation. Scope includes bulk raw water pipeline (42 km), pump station, and telemetry system for the Olifants River system.',
      sector: 'Water',
    },
  ],
}

export const MOCK_CUSTOMERS: Customer[] = [
  {
    id: 'c-1',
    name: 'Lethabo Infrastructure (Pty) Ltd',
    contactName: 'Dineo Lethabo',
    contactEmail: 'dineo@lethabo-infra.co.za',
    contactPhone: '+27 11 834 0012',
    industry: 'Civil Engineering',
    status: 'ACTIVE',
    since: '2023-03-10',
    notes:
      'Main contractor on the Vaal River road rehabilitation project. Requires annual compliance pack renewal each March.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'SARS Tax Clearance (TCS PIN)',
        fulfilled: true,
        linkedVaultDocId: 'vd-tax',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'COIDA Letter of Good Standing',
        fulfilled: false,
        linkedVaultDocId: 'vd-coida',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'B-BBEE Affidavit / Certificate',
        fulfilled: true,
        linkedVaultDocId: 'vd-bbbee',
      },
      {
        docCategory: 'GOVERNANCE',
        label: 'CIPC Certificate of Incorporation',
        fulfilled: true,
        linkedVaultDocId: 'vd-cipc',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'Certified Director ID Copies',
        fulfilled: true,
        linkedVaultDocId: 'vd-directors',
      },
    ],
  },
  {
    id: 'c-2',
    name: 'Department of Water and Sanitation',
    contactName: 'Sipho Nkosi',
    contactEmail: 'procurement@dws.gov.za',
    contactPhone: '+27 12 336 7500',
    industry: 'Government',
    status: 'ACTIVE',
    since: '2024-01-22',
    notes:
      'National government client. Strict SCM compliance required. Annual CSD verification mandatory.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'SARS Tax Clearance (TCS PIN)',
        fulfilled: true,
        linkedVaultDocId: 'vd-tax',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'COIDA Letter of Good Standing',
        fulfilled: false,
        linkedVaultDocId: 'vd-coida',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'B-BBEE Affidavit / Certificate',
        fulfilled: true,
        linkedVaultDocId: 'vd-bbbee',
      },
      {
        docCategory: 'GOVERNANCE',
        label: 'CIPC Certificate of Incorporation',
        fulfilled: true,
        linkedVaultDocId: 'vd-cipc',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'CSD Supplier Registration',
        fulfilled: true,
        linkedVaultDocId: 'vd-csd',
      },
      {
        docCategory: 'GOVERNANCE',
        label: 'SBD 4 Preference Points Form',
        fulfilled: true,
        linkedVaultDocId: 'vd-sbd',
      },
    ],
  },
  {
    id: 'c-3',
    name: 'Ekurhuleni Metro Municipality',
    contactName: 'Zanele Mokhesi',
    contactEmail: 'scm@ekurhuleni.gov.za',
    contactPhone: '+27 11 999 0000',
    industry: 'Local Government',
    status: 'ACTIVE',
    since: '2024-06-01',
    notes:
      'Electrical infrastructure upgrade programme. Requires proof of professional indemnity insurance.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'SARS Tax Clearance (TCS PIN)',
        fulfilled: true,
        linkedVaultDocId: 'vd-tax',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'COIDA Letter of Good Standing',
        fulfilled: false,
        linkedVaultDocId: 'vd-coida',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'B-BBEE Affidavit / Certificate',
        fulfilled: true,
        linkedVaultDocId: 'vd-bbbee',
      },
      {
        docCategory: 'GOVERNANCE',
        label: 'CIPC Certificate of Incorporation',
        fulfilled: true,
        linkedVaultDocId: 'vd-cipc',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'Certified Director ID Copies',
        fulfilled: true,
        linkedVaultDocId: 'vd-directors',
      },
      {
        docCategory: 'FINANCIAL',
        label: 'Professional Indemnity Insurance',
        fulfilled: false,
        linkedVaultDocId: null,
      },
    ],
  },
  {
    id: 'c-4',
    name: 'Transnet SOC Ltd',
    contactName: 'Lungelo Dlamini',
    contactEmail: 'vendor@transnet.net',
    contactPhone: '+27 11 308 3000',
    industry: 'State-Owned Entity',
    status: 'PROSPECT',
    since: '2025-02-14',
    notes:
      'Potential contract for port equipment maintenance. Vendor registration not yet submitted.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'SARS Tax Clearance (TCS PIN)',
        fulfilled: true,
        linkedVaultDocId: 'vd-tax',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'COIDA Letter of Good Standing',
        fulfilled: false,
        linkedVaultDocId: 'vd-coida',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'B-BBEE Affidavit / Certificate',
        fulfilled: true,
        linkedVaultDocId: 'vd-bbbee',
      },
      {
        docCategory: 'GOVERNANCE',
        label: 'CIPC Certificate of Incorporation',
        fulfilled: true,
        linkedVaultDocId: 'vd-cipc',
      },
    ],
  },
  {
    id: 'c-5',
    name: 'Eskom Holdings SOC Ltd',
    contactName: 'Refilwe Tau',
    contactEmail: 'supplier@eskom.co.za',
    contactPhone: '+27 11 800 8111',
    industry: 'State-Owned Entity',
    status: 'INACTIVE',
    since: '2021-09-05',
    notes:
      'Previous electrical subcontracting work. Contract ended 2023. Keep on record for re-engagement.',
    requiredDocs: [
      {
        docCategory: 'COMPLIANCE',
        label: 'SARS Tax Clearance (TCS PIN)',
        fulfilled: true,
        linkedVaultDocId: 'vd-tax',
      },
      {
        docCategory: 'COMPLIANCE',
        label: 'B-BBEE Affidavit / Certificate',
        fulfilled: true,
        linkedVaultDocId: 'vd-bbbee',
      },
      {
        docCategory: 'GOVERNANCE',
        label: 'CIPC Certificate of Incorporation',
        fulfilled: true,
        linkedVaultDocId: 'vd-cipc',
      },
    ],
  },
]

export const MOCK_VAULT: VaultDoc[] = [
  {
    id: 'vd-tax',
    title: 'SARS Tax Clearance Certificate (TCS PIN)',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/tax-clearance.pdf',
    issueDate: '2026-07-12',
    expiryDate: '2027-07-12',
    isCertified: false,
    certifiedDate: null,
    metadata: { 'TCS PIN': 'CITX-2026-884-0192', Status: 'Active — compliant' },
  },
  {
    id: 'vd-coida',
    title: 'COIDA Letter of Good Standing',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/coida-good-standing.pdf',
    issueDate: '2025-07-05',
    expiryDate: '2026-07-04',
    isCertified: false,
    certifiedDate: null,
    metadata: { 'Compensation Fund ref': 'CF-771902', Status: 'EXPIRED' },
  },
  {
    id: 'vd-bbbee',
    title: 'B-BBEE Sworn Affidavit (EME)',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/bbbee-affidavit.pdf',
    issueDate: '2026-04-10',
    expiryDate: '2027-04-09',
    isCertified: true,
    certifiedDate: '2026-04-10',
    metadata: { Level: 'Level 1 (EME)', 'Black ownership': '100%' },
  },
  {
    id: 'vd-cipc',
    title: 'CIPC Certificate of Incorporation',
    category: 'GOVERNANCE',
    fileUrl: '/demo/vault/cipc-registration.pdf',
    issueDate: '2014-03-20',
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: { 'Registration number': 'CK2014/1234567/07', Status: 'In business' },
  },
  {
    id: 'vd-directors',
    title: 'Certified ID Copies — Directors',
    category: 'COMPLIANCE',
    fileUrl: '/demo/vault/director-ids.pdf',
    issueDate: null,
    expiryDate: null,
    isCertified: true,
    certifiedDate: '2026-08-18',
    metadata: {
      Directors: 'T. Mokoena, L. Naidoo, S. Sithole',
      'Certified by': 'SA Police Services',
    },
  },
  {
    id: 'vd-sbd',
    title: 'Completed SBD 4 Returnable Form',
    category: 'GOVERNANCE',
    fileUrl: null,
    issueDate: null,
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: { Status: 'Signed, on file' },
  },
  {
    id: 'vd-csd',
    title: 'CSD Registration Report',
    category: 'COMPLIANCE',
    fileUrl: null,
    issueDate: '2026-01-15',
    expiryDate: null,
    isCertified: false,
    certifiedDate: null,
    metadata: { 'Supplier number': 'MAZE-4451902', Status: 'Active' },
  },
]
