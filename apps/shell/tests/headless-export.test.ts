import { describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'

import {
  runHeadlessExport,
  validateHeadlessPaths,
  type HeadlessExporters,
} from '../src/main/headless-export'
import type { HeadlessExportRequest } from '@genoffice/electron-utils'

/**
 * The `--headless-export` host (src/main/headless-export.ts): input checks,
 * extension routing and the exit-code mapping. The per-module exporters are
 * injected, so no Electron window is ever created here.
 *
 * The host normalises every caller-supplied path through `node:path.resolve`,
 * which on win32 turns `/out/a.pdf` into `\out\a.pdf`, so the expectations and
 * the fake filesystem below are derived through `node:path` too instead of
 * hardcoding POSIX separators (same fix as the electron-utils dialog-memory
 * tests). The behaviour under test — which exit code each rejection maps to —
 * is unchanged.
 */

const posixRequest = (
  input: string,
  outPath = '/out/a.pdf',
  targetFormat: HeadlessExportRequest['targetFormat'] = 'pdf',
): HeadlessExportRequest => ({
  input,
  targetFormat,
  outPath,
  json: false,
})

/**
 * Stands in for the host's filesystem probes. The host normalises every path
 * before probing it, and on win32 `resolve('/docs/a.docx')` is
 * `C:\docs\a.docx`, so a fixture path is stored under — and probed by — that
 * same normalised form rather than compared as a POSIX literal (same fix as
 * the electron-utils dialog-memory tests). The behaviour under test — which
 * exit code each rejection maps to — is unchanged.
 */
const fsWith = (present: readonly string[], isFile = true) => {
  const known = new Set(present.map(fsPath))
  return {
    exists: (path: string) => known.has(path),
    isFile: () => isFile,
  }
}

/**
 * The POSIX fixture, mapped to the form `node:fs` probes resolve it to on the
 * host platform (`C:\docs\a.docx` on win32, `/docs/a.docx` elsewhere).
 */
const fsPath = (path: string) => resolve(path.replace(/^\//, '/'))

/** The same string, for use in expectations. */
const p = fsPath

function stubExporters(): { exporters: HeadlessExporters; calls: string[] } {
  const calls: string[] = []
  const make = (name: string) => async (input: string, outPath: string, format: string) => {
    calls.push(`${name}:${input}->${outPath}:${format}`)
  }
  return {
    calls,
    exporters: {
      docs: make('docs'),
      sheets: make('sheets'),
      slides: make('slides'),
      markdown: make('markdown'),
      html: make('html'),
    },
  }
}

describe('validateHeadlessPaths', () => {
  it('routes a readable input to its module', () => {
    const result = validateHeadlessPaths(
      posixRequest('/docs/a.docx'),
      fsWith(['/docs/a.docx', '/out']),
    )
    expect(result).toEqual({
      ok: true,
      input: p('/docs/a.docx'),
      outPath: p('/out/a.pdf'),
      module: 'docs',
    })
  })

  it('rejects a target the input module does not render as bad args (exit 1)', () => {
    const fs = fsWith(['/docs/a.docx', '/decks/a.pptx', '/out'])
    expect(
      validateHeadlessPaths(posixRequest('/decks/a.pptx', '/out/a.docx', 'docx'), fs),
    ).toMatchObject({ ok: false, code: 1, message: expect.stringContaining('pdf') })
    expect(
      validateHeadlessPaths(posixRequest('/docs/a.docx', '/out/a.html', 'html'), fs),
    ).toMatchObject({ ok: true, module: 'docs' })
  })

  it('reports a missing input as an input-file error (exit 2)', () => {
    expect(validateHeadlessPaths(posixRequest('/nope.docx'), fsWith([]))).toEqual({
      ok: false,
      code: 2,
      message: expect.stringContaining(p('/nope.docx')),
    })
  })

  it('rejects a directory handed in as the input', () => {
    const result = validateHeadlessPaths(
      posixRequest('/docs/a.docx'),
      fsWith(['/docs/a.docx', '/out'], false),
    )
    expect(result).toMatchObject({ ok: false, code: 2, message: expect.stringContaining('file') })
  })

  it('rejects an extension no module can render', () => {
    const result = validateHeadlessPaths(
      posixRequest('/docs/a.pdf'),
      fsWith(['/docs/a.pdf', '/out']),
    )
    expect(result).toMatchObject({ ok: false, code: 2 })
  })

  it('treats a missing output directory as a bad argument (exit 1)', () => {
    const result = validateHeadlessPaths(
      posixRequest('/docs/a.docx', '/gone/a.pdf'),
      fsWith(['/docs/a.docx']),
    )
    expect(result).toMatchObject({
      ok: false,
      code: 1,
      message: expect.stringContaining(dirname(p('/gone/a.pdf'))),
    })
  })
})

describe('runHeadlessExport', () => {
  it('calls the module that owns the extension and reports success', async () => {
    const { exporters, calls } = stubExporters()
    const outcome = await runHeadlessExport(
      posixRequest('/decks/a.pptx'),
      exporters,
      fsWith(['/decks/a.pptx', '/out', '/out/a.pdf']),
    )
    expect(calls).toEqual([`slides:${p('/decks/a.pptx')}->${p('/out/a.pdf')}:pdf`])
    expect(outcome).toEqual({
      ok: true,
      input: p('/decks/a.pptx'),
      outPath: p('/out/a.pdf'),
    })
  })

  it.each([
    ['/a.docx', 'docs'],
    ['/a.xlsx', 'sheets'],
    ['/a.pptx', 'slides'],
    ['/a.md', 'markdown'],
    ['/a.html', 'html'],
  ])('routes %s to the %s exporter', async (input, module) => {
    const { exporters, calls } = stubExporters()
    await runHeadlessExport(posixRequest(input), exporters, fsWith([input, '/out', '/out/a.pdf']))
    expect(calls[0]?.startsWith(`${module}:`)).toBe(true)
  })

  it('turns a thrown exporter error into a conversion failure (exit 3)', async () => {
    const { exporters } = stubExporters()
    exporters.docs = vi.fn(() => Promise.reject(new Error('renderer stopped')))
    const outcome = await runHeadlessExport(
      posixRequest('/a.docx'),
      exporters,
      fsWith(['/a.docx', '/out']),
    )
    expect(outcome).toEqual({ ok: false, code: 3, message: 'renderer stopped' })
  })

  it('fails when the exporter resolves but wrote nothing', async () => {
    const { exporters } = stubExporters()
    const outcome = await runHeadlessExport(
      posixRequest('/a.docx'),
      exporters,
      fsWith(['/a.docx', '/out']),
    )
    expect(outcome).toMatchObject({
      ok: false,
      code: 3,
      message: expect.stringContaining(p('/out/a.pdf')),
    })
  })

  it('never reaches an exporter when the input is unusable', async () => {
    const { exporters, calls } = stubExporters()
    const outcome = await runHeadlessExport(posixRequest('/gone.docx'), exporters, fsWith([]))
    expect(calls).toEqual([])
    expect(outcome).toMatchObject({ ok: false, code: 2 })
  })
})
