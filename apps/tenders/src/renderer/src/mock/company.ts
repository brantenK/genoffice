// Mock company — "Thabo Engineering (Pty) Ltd".
//
// The DATA now lives in `shared/demo-seed.ts`, so `main` can read it without
// importing the renderer (see the note there). This module stays as the
// renderer's import path — every `renderer/…` file and eight test files import
// `MOCK_COMPANY` from here — and re-exports the same frozen value, so nothing
// downstream changes.
export { MOCK_COMPANY } from '../../../shared/demo-seed'
