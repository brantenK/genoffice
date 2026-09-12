// Mock company vault — "Thabo Engineering (Pty) Ltd".
// Dates are fixed ISO values (deterministic demo); the app computes health
// against the real current date at runtime.
import type { VaultDoc } from '../../shared/types'

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
    metadata: { 'TCS PIN': 'CITX-2026-884-0192', Status: 'Active — compliant' }
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
    metadata: { 'Compensation Fund ref': 'CF-771902', Status: 'EXPIRED' }
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
    metadata: { Level: 'Level 1 (EME)', 'Black ownership': '100%' }
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
    metadata: { 'Registration number': 'CK2014/1234567/07', Status: 'In business' }
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
    metadata: { Directors: 'T. Mokoena, L. Naidoo, S. Sithole', 'Certified by': 'SA Police Services' }
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
    metadata: { Status: 'Signed, on file' }
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
    metadata: { 'Supplier number': 'MAZE-4451902', Status: 'Active' }
  }
]
