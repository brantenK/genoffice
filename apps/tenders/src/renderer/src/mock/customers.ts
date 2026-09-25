// Mock customers for the demonstration workspace.
//
// The DATA now lives in `shared/demo-seed.ts`, so `main` can read it without
// importing the renderer (see the note there). This module stays as the
// renderer's import path and re-exports the same frozen value.
export { MOCK_CUSTOMERS } from '../../../shared/demo-seed'
