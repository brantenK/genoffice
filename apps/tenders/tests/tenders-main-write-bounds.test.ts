import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two pre-write ceilings `tenders-main.ts` owns:
 *
 *   - `exportMatrixToSheets` is bounded by its own `MAX_TENDERS_MATRIX_EXPORT_BYTES`,
 *     not by the `saveStoreV2` IPC envelope (`MAX_TENDERS_IPC_PAYLOAD_BYTES`), so
 *     raising the envelope for envelope reasons cannot loosen the export;
 *   - `writeTendersStore` refuses a pretty-printed document above
 *     `MAX_TENDERS_STORE_FILE_BYTES` before it writes anything, so it can never
 *     leave a primary file that the store loader rejects.
 *
 * Electron and the filesystem are real enough to observe: the export is asserted
 * against the temp files it does (and does not) create, and the store write
 * against the bytes left on disk.
 */

const testDir = join(tmpdir(), `tenders-main-bounds-${randomUUID().slice(0, 8)}`)

const { ipcHandlers, generated } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => any>(),
  generated: [] as string[],
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? testDir : testDir),
    isReady: () => true,
  },
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
  shell: { openPath: vi.fn(async () => '') },
  dialog: { showMessageBox: async () => ({ response: 1, checkboxChecked: false }) },
  WebContentsView: class MockWebContentsView {
    webContents = { isDestroyed: () => false, send: () => {}, once: vi.fn() }
  },
}))

import {
  configureTendersRuntime,
  readTendersStore,
  registerTendersIpc,
  registerTendersWebContents,
  unregisterTendersWebContents,
  writeTendersStore,
} from '../src/main/tenders-main'
import {
  MAX_TENDERS_MATRIX_EXPORT_BYTES,
  MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS,
  MAX_TENDERS_MATRIX_EXPORT_ROWS,
  TENDERS_CHANNELS,
} from '../src/shared/ipc'
import {
  MAX_TENDERS_DOCUMENT_BYTES,
  MAX_TENDERS_IPC_PAYLOAD_BYTES,
  MAX_TENDERS_STORE_FILE_BYTES,
} from '../src/shared/tenders-persistence'

const TRUSTED_RENDERER_URL = 'http://localhost:5179/'
const registeredTestWebContents: any[] = []

function registeredWebContents(): any {
  const webContents: any = {
    isDestroyed: () => false,
    getURL: () => TRUSTED_RENDERER_URL,
    send: vi.fn(),
    once: vi.fn(),
  }
  registerTendersWebContents(webContents)
  registeredTestWebContents.push(webContents)
  return webContents
}

function event(sender: any): { sender: any; senderFrame: any } {
  return { sender, senderFrame: { url: TRUSTED_RENDERER_URL, parent: null } }
}

/** Compliance-matrix CSVs the handler would have written for one export title. */
function matrixCsvFiles(tenderTitle: string): string[] {
  const prefix = `${tenderTitle.replace(/[^a-zA-Z0-9_-]/g, '_')}_Compliance_Matrix_`
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true })
  generated.length = 0
  configureTendersRuntime({
    preloadPath: '',
    rendererFile: '',
    rendererUrl: TRUSTED_RENDERER_URL,
    openGeneratedPath: (path: string) => {
      generated.push(path)
      return true
    },
  })
  registerTendersIpc()
})

afterAll(() => {
  for (const webContents of registeredTestWebContents.splice(0)) {
    unregisterTendersWebContents(webContents)
  }
  rmSync(testDir, { recursive: true, force: true })
})

describe('compliance-matrix export byte ceiling', () => {
  it('is the export’s own bound, held below the saveStoreV2 IPC envelope', () => {
    // Two relationships, both deliberate and both worth a failure if they move:
    // the export may not be loosened by an envelope raise (it is below the
    // envelope), and it stays at the document ceiling its payload is a subset of
    // (so raising the document ceiling forces a decision about the export too).
    expect(MAX_TENDERS_MATRIX_EXPORT_BYTES).toBe(MAX_TENDERS_DOCUMENT_BYTES)
    expect(MAX_TENDERS_MATRIX_EXPORT_BYTES).toBeLessThan(MAX_TENDERS_IPC_PAYLOAD_BYTES)
  })

  it('refuses a payload that is inside the IPC envelope, before any CSV work', async () => {
    const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!
    const sender = registeredWebContents()

    // Sized between the two ceilings: the envelope would accept this payload, so
    // a refusal here can only come from the export's own bound.
    const perCell = MAX_TENDERS_MATRIX_EXPORT_CELL_CHARS - 1
    const rowCount = Math.ceil(MAX_TENDERS_MATRIX_EXPORT_BYTES / perCell) + 2
    const rows = Array.from({ length: rowCount }, () => ({ notes: 'y'.repeat(perCell) }))
    const payloadBytes = Buffer.byteLength(
      JSON.stringify({ tenderTitle: 'Over bound', matrixRows: rows }),
      'utf8',
    )
    expect(rowCount).toBeLessThanOrEqual(MAX_TENDERS_MATRIX_EXPORT_ROWS)
    expect(payloadBytes).toBeGreaterThan(MAX_TENDERS_MATRIX_EXPORT_BYTES)
    expect(payloadBytes).toBeLessThan(MAX_TENDERS_IPC_PAYLOAD_BYTES)

    const csvBefore = matrixCsvFiles('Over bound')
    const res = await exportHandler(event(sender), 't-1', 'Over bound', rows)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/exceeds \d+ bytes/i)
    expect(res.error).toContain(String(MAX_TENDERS_MATRIX_EXPORT_BYTES))
    expect(res.error).not.toContain(String(MAX_TENDERS_IPC_PAYLOAD_BYTES))
    // Refused before the CSV exists: no temp file, nothing handed to the OS.
    expect(matrixCsvFiles('Over bound')).toEqual(csvBefore)
    expect(matrixCsvFiles('Over bound')).toEqual([])
    expect(generated).toHaveLength(0)
  })

  it('accepts a payload inside its own ceiling and writes the CSV', async () => {
    const exportHandler = ipcHandlers.get(TENDERS_CHANNELS.exportMatrixToSheets)!
    const sender = registeredWebContents()

    const res = await exportHandler(event(sender), 't-1', 'Inside bound', [
      { id: 'REQ-1', category: 'MANDATORY_STAGE_1', title: 'Tax clearance', notes: 'ok' },
    ])

    expect(res.ok).toBe(true)
    expect(generated).toEqual([res.path])
    expect(readFileSync(res.path, 'utf8').startsWith('\uFEFFRequirement ID,')).toBe(true)
  })
})

describe('writeTendersStore pre-write ceiling', () => {
  const storeFile = join(testDir, 'bounded-write', 'tenders-data.json')

  function documentWithTitleChars(chars: number): unknown {
    return {
      version: 1,
      activeCompanyId: 'co-bounds',
      workspaces: [
        {
          id: 'co-bounds',
          name: 'Bounded Workspace',
          company: { name: 'Bounded Workspace' },
          customers: [],
          vault: [],
          tenders: [{ id: 'tender-bounds', title: 'x'.repeat(chars) }],
        },
      ],
    }
  }

  it('writes a document inside the ceiling and reads it back', () => {
    writeTendersStore(storeFile, documentWithTitleChars(64))
    expect(existsSync(storeFile)).toBe(true)
    expect(readTendersStore(storeFile).activeCompanyId).toBe('co-bounds')
  })

  it('refuses an over-ceiling document before writing, leaving the previous file intact', () => {
    writeTendersStore(storeFile, documentWithTitleChars(64))
    const before = readFileSync(storeFile, 'utf8')

    // Pretty-printed, this document is above the store-file ceiling the loader
    // enforces — the shape that used to be written and then refused on read.
    const oversize = documentWithTitleChars(MAX_TENDERS_STORE_FILE_BYTES + 1024 * 1024)
    expect(() => writeTendersStore(storeFile, oversize)).toThrow(/store file limit/)

    expect(readFileSync(storeFile, 'utf8')).toBe(before)
    expect(readdirSync(join(testDir, 'bounded-write')).filter((n) => n.endsWith('.tmp'))).toEqual(
      [],
    )
  })

  it('keeps the store-file ceiling above the document ceiling it must accept', () => {
    expect(MAX_TENDERS_STORE_FILE_BYTES).toBeGreaterThan(MAX_TENDERS_DOCUMENT_BYTES)
  })
})
