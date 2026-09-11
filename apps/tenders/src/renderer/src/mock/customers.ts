import type { Customer } from '../../shared/types'

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
    notes: 'Main contractor on the Vaal River road rehabilitation project. Requires annual compliance pack renewal each March.',
    requiredDocs: [
      { docCategory: 'COMPLIANCE', label: 'SARS Tax Clearance (TCS PIN)', fulfilled: true, linkedVaultDocId: 'vd-tax' },
      { docCategory: 'COMPLIANCE', label: 'COIDA Letter of Good Standing', fulfilled: false, linkedVaultDocId: 'vd-coida' },
      { docCategory: 'COMPLIANCE', label: 'B-BBEE Affidavit / Certificate', fulfilled: true, linkedVaultDocId: 'vd-bbbee' },
      { docCategory: 'GOVERNANCE', label: 'CIPC Certificate of Incorporation', fulfilled: true, linkedVaultDocId: 'vd-cipc' },
      { docCategory: 'COMPLIANCE', label: 'Certified Director ID Copies', fulfilled: true, linkedVaultDocId: 'vd-directors' },
    ]
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
    notes: 'National government client. Strict SCM compliance required. Annual CSD verification mandatory.',
    requiredDocs: [
      { docCategory: 'COMPLIANCE', label: 'SARS Tax Clearance (TCS PIN)', fulfilled: true, linkedVaultDocId: 'vd-tax' },
      { docCategory: 'COMPLIANCE', label: 'COIDA Letter of Good Standing', fulfilled: false, linkedVaultDocId: 'vd-coida' },
      { docCategory: 'COMPLIANCE', label: 'B-BBEE Affidavit / Certificate', fulfilled: true, linkedVaultDocId: 'vd-bbbee' },
      { docCategory: 'GOVERNANCE', label: 'CIPC Certificate of Incorporation', fulfilled: true, linkedVaultDocId: 'vd-cipc' },
      { docCategory: 'COMPLIANCE', label: 'CSD Supplier Registration', fulfilled: true, linkedVaultDocId: 'vd-csd' },
      { docCategory: 'GOVERNANCE', label: 'SBD 4 Preference Points Form', fulfilled: true, linkedVaultDocId: 'vd-sbd' },
    ]
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
    notes: 'Electrical infrastructure upgrade programme. Requires proof of professional indemnity insurance.',
    requiredDocs: [
      { docCategory: 'COMPLIANCE', label: 'SARS Tax Clearance (TCS PIN)', fulfilled: true, linkedVaultDocId: 'vd-tax' },
      { docCategory: 'COMPLIANCE', label: 'COIDA Letter of Good Standing', fulfilled: false, linkedVaultDocId: 'vd-coida' },
      { docCategory: 'COMPLIANCE', label: 'B-BBEE Affidavit / Certificate', fulfilled: true, linkedVaultDocId: 'vd-bbbee' },
      { docCategory: 'GOVERNANCE', label: 'CIPC Certificate of Incorporation', fulfilled: true, linkedVaultDocId: 'vd-cipc' },
      { docCategory: 'COMPLIANCE', label: 'Certified Director ID Copies', fulfilled: true, linkedVaultDocId: 'vd-directors' },
      { docCategory: 'FINANCIAL', label: 'Professional Indemnity Insurance', fulfilled: false, linkedVaultDocId: null },
    ]
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
    notes: 'Potential contract for port equipment maintenance. Vendor registration not yet submitted.',
    requiredDocs: [
      { docCategory: 'COMPLIANCE', label: 'SARS Tax Clearance (TCS PIN)', fulfilled: true, linkedVaultDocId: 'vd-tax' },
      { docCategory: 'COMPLIANCE', label: 'COIDA Letter of Good Standing', fulfilled: false, linkedVaultDocId: 'vd-coida' },
      { docCategory: 'COMPLIANCE', label: 'B-BBEE Affidavit / Certificate', fulfilled: true, linkedVaultDocId: 'vd-bbbee' },
      { docCategory: 'GOVERNANCE', label: 'CIPC Certificate of Incorporation', fulfilled: true, linkedVaultDocId: 'vd-cipc' },
    ]
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
    notes: 'Previous electrical subcontracting work. Contract ended 2023. Keep on record for re-engagement.',
    requiredDocs: [
      { docCategory: 'COMPLIANCE', label: 'SARS Tax Clearance (TCS PIN)', fulfilled: true, linkedVaultDocId: 'vd-tax' },
      { docCategory: 'COMPLIANCE', label: 'B-BBEE Affidavit / Certificate', fulfilled: true, linkedVaultDocId: 'vd-bbbee' },
      { docCategory: 'GOVERNANCE', label: 'CIPC Certificate of Incorporation', fulfilled: true, linkedVaultDocId: 'vd-cipc' },
    ]
  }
]
