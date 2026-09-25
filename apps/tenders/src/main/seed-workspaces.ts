// The v1 demo seed: the company, its customers and the seeded RFP the retired
// legacy reader used to synthesize.
//
// Split out of `main/tenders-main.ts` with no behaviour change, and — importantly
// — this is NOT the source of demo data any more. The legacy reader deliberately
// no longer answers an empty payload with these values (see `legacy-store.ts`).
// What stays is `createDefaultSeedWorkspaces` for the tests that pin its
// independent behaviour, and the one seeded tender they compare against.
//
// The data itself comes from `shared/demo-seed.ts`, which a main process may
// import: this module does not reach into the renderer for it.
import type { CompanyWorkspace, TenderRecord } from '../shared/types'
import { MOCK_COMPANY, MOCK_CUSTOMERS, MOCK_VAULT } from '../shared/demo-seed'
import { CURRENT_TENDERS_SCHEMA_VERSION } from './legacy-store'

export const SEED_COMPANY_ID = 'co-thabo'

export const SEED_TENDER_WTR_04: TenderRecord = {
  id: 'tender-wtr-04',
  title: 'Bulk Water Metering & Valve Refurbishment',
  referenceNumber: 'RFP-WTR-2026-04',
  issuingBody: 'City of Ekurhuleni Water Dept',
  closingDate: '2026-10-31',
  submissionMethod: 'PHYSICAL',
  submissionAddress: 'Civic Centre, Kempton Park, Ekurhuleni',
  signatureChecks: {},
  status: 'IN_PROGRESS',
  createdAt: '2026-08-01T08:00:00Z',
  fileName: 'RFP-WTR-2026-04.pdf',
  fileUrl: '',
  numPages: 24,
  ocrPages: 0,
  estimatedValue: 243000,
  milestones: [
    {
      id: 'ms-01',
      name: 'Phase 1 Reservoir Valve Refurbishment',
      title: 'Phase 1 Reservoir Valve Refurbishment',
      description: 'Complete overhaul of high-pressure control valves per tender specification',
      amount: 145000,
      status: 'REACHED',
      dueDate: '2026-08-30',
      completedDate: '2026-08-28',
    },
    {
      id: 'ms-02',
      name: 'Phase 2 Ultrasonic Flow Meter Installation',
      title: 'Phase 2 Ultrasonic Flow Meter Installation',
      description: 'Install and calibrate digital flow sensors across metering points',
      amount: 98000,
      status: 'PENDING',
      dueDate: '2026-11-15',
    },
  ],
  requirements: [],
}

export function createDefaultSeedWorkspaces(): CompanyWorkspace[] {
  return [
    {
      id: SEED_COMPANY_ID,
      name: 'Thabo Engineering (Pty) Ltd',
      company: { ...MOCK_COMPANY },
      customers: [...MOCK_CUSTOMERS],
      vault: [...MOCK_VAULT],
      tenders: [SEED_TENDER_WTR_04],
    },
  ]
}
