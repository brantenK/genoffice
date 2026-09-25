/**
 * Observability for the Tenders app: the log sink, the renderer's logger, and the
 * two states that used to lie about save health.
 *
 * The findings this file pins, in order of how much they cost a user:
 *
 *  1. **There was no log sink at all.** Every diagnostic in main and in the
 *     renderer went to a `console` a packaged user cannot read, so a support
 *     request could only be answered by guesswork. `main/diagnostics-log.ts` is
 *     the sink; the tests below drive it against a real temporary directory and
 *     prove it writes, rotates at the cap, refuses document content and never
 *     throws on an unwritable directory.
 *  2. **The renderer could say "Saved" when nothing could ever be written.** With
 *     no preload bridge (`dev:renderer`, a stale build) `hydrateFromMain` set no
 *     state at all: `hydrationStatus: 'ready'` and `saveStatus: 'saved'`, an
 *     interactive workspace with a "Saved" pill over a persistence path that did
 *     not exist. The state is now set, and `tests/components/save-status.test.tsx`
 *     renders the component to show it cannot print `Saved` for it.
 *  3. **A failed reload and a failed migration commit left a healthy-looking UI.**
 *     Both set `saveStatus: 'error'` while `hydrationStatus` stayed `'ready'`, so
 *     the user got a fully interactive workspace over a document that was never
 *     obtained (reload) or never committed (migration). Both now heal honestly.
 *
 * HOW THESE TESTS WORK:
 *
 *  * The sink and the renderer logger are driven as REAL MODULES with real
 *    arguments — a temporary directory, an injected clock, a fake bridge — so
 *    every claim about them is behavioural, not textual.
 *  * The store states are driven through the real store, with
 *    `vi.resetModules()` + a dynamic import and a mocked `window.tendersApi`, the
 *    same harness `tests/renderer-store-v2.test.ts` uses (module-level state).
 *  * **`SaveStatus` is rendered, and pinned elsewhere.** This file used to carry a
 *    source guard for it — reading `components/SaveStatus.tsx` as text, because
 *    the repo then had no component harness. `tests/helpers/render.tsx` exists
 *    now (no new dependency: `react-dom/client` + `act`), so
 *    `tests/components/save-status.test.tsx` mounts the component and asserts
 *    which kind prints which label, which no file's text can show. The state the
 *    component is handed is still driven for real here, so the pairing remains
 *    "real state + that render test".
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DIAGNOSTICS_MAX_BYTES,
  DEFAULT_DIAGNOSTICS_MAX_FILES,
  DIAGNOSTICS_FILE_NAME,
  createDiagnosticsLog,
  formatDiagnosticsLine,
  recordDiagnosticsStart,
  sanitizeDiagnosticsDetail,
  type DiagnosticsEntry,
} from '../src/main/diagnostics-log'
import {
  buildDiagnosticsEntry,
  createRendererDiagnostics,
  rendererDiagnostics,
  sanitizeDiagnosticsDetail as sanitizeRendererDetail,
  tendersDiagnosticsBridge,
  type TendersDiagnosticsBridge,
} from '../src/renderer/src/diagnostics'
import type { TendersState } from '../src/renderer/src/store'
import type { TendersDataV2, TendersWorkspaceV2 } from '../src/shared/types'

// ── a real temporary directory for the sink ───────────────────────────────────

let workDir: string
let logDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tenders-diagnostics-'))
  logDir = join(workDir, 'tenders')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const FIXED_CLOCK = (): Date => new Date('2026-09-24T12:00:00.000Z')

/** Distinctive content that must never reach the log. */
const SECRET_MARKER = 'SECRET-CLIENT-CONFIDENTIAL-PARAGRAPH'

function info(message: string, detail?: Record<string, unknown>): DiagnosticsEntry {
  return { level: 'info', source: 'test', message, ...(detail ? { detail } : {}) }
}

function liveFile(): string {
  return join(logDir, DIAGNOSTICS_FILE_NAME)
}

function readLive(): string {
  return readFileSync(liveFile(), 'utf8')
}

// ── the sink: it writes ───────────────────────────────────────────────────────

describe('the diagnostic sink writes what it is given', () => {
  it('creates the directory, writes one line per entry, and reports its path', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    expect(existsSync(logDir), 'construction performs no I/O').toBe(false)
    expect(log.path()).toBe(liveFile())

    log.record(info('first thing happened'))
    log.record({ level: 'warn', source: 'store', message: 'a save was refused' })

    const lines = readLive().trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('2026-09-24T12:00:00.000Z [info] test: first thing happened')
    expect(lines[1]).toBe('2026-09-24T12:00:00.000Z [warn] store: a save was refused')
    expect(log.path()).toContain(DIAGNOSTICS_FILE_NAME)
  })

  it('appends rather than truncating, so a second log in the same directory keeps the first', async () => {
    const first = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    first.record(info('from the first session'))
    await first.flush()

    const second = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    second.record(info('from the second session'))

    const text = readLive()
    expect(text).toContain('from the first session')
    expect(text).toContain('from the second session')
    expect(text.trimEnd().split('\n')).toHaveLength(2)
  })

  it('carries structured detail as compact JSON on the same line', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    log.record({
      level: 'error',
      source: 'store',
      message: 'save refused',
      detail: { code: 'NO_IPC_BRIDGE', revision: 3, nested: { tender: SECRET_MARKER } },
    })

    const line = readLive().trimEnd()
    expect(line).toContain('"code":"NO_IPC_BRIDGE"')
    expect(line).toContain('"revision":3')
    // A nested object is refused as a VALUE, not walked — that is what makes the
    // never-log-content rule a property of the sink rather than a caller promise.
    expect(line).not.toContain('nested')
    expect(line).not.toContain(SECRET_MARKER)
    expect(line.split('\n')).toHaveLength(1)
  })

  it('keeps one entry on one line even when the message contains newlines', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    log.record(info('line one\nline two\r\nline three'))

    const text = readLive()
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(text).toContain('line one line two line three')
  })

  it('writes a startup line that says what wrote the file, and never throws on a bad directory', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    recordDiagnosticsStart(log, '1.2.3')
    expect(readLive()).toContain('Zanostack Tenders diagnostics started (version 1.2.3).')

    // The header helper swallows its own failure too.
    const broken = createDiagnosticsLog({ dir: '\u0000not-a-path', now: FIXED_CLOCK })
    expect(() => recordDiagnosticsStart(broken, '1.2.3')).not.toThrow()
  })
})

// ── the sink: bounded, with rotation ──────────────────────────────────────────

describe('the sink is bounded and rotates at the ceiling', () => {
  it('rotates at the byte cap and keeps at most `maxFiles` generations', () => {
    const maxBytes = 200
    const maxFiles = 3
    const log = createDiagnosticsLog({ dir: logDir, maxBytes, maxFiles, now: FIXED_CLOCK })

    // Each line is comfortably over a third of the cap, so this forces several
    // rotations.
    for (let index = 0; index < 12; index += 1) {
      log.record(info(`entry number ${index} ${'x'.repeat(60)}`))
    }

    const files = [
      liveFile(),
      `${liveFile()}.1`,
      `${liveFile()}.2`,
      `${liveFile()}.3`,
      `${liveFile()}.4`,
    ]
    expect(existsSync(liveFile())).toBe(true)
    expect(existsSync(`${liveFile()}.1`), 'the previous generation is kept').toBe(true)
    expect(existsSync(`${liveFile()}.2`), 'the oldest kept generation is kept').toBe(true)
    expect(existsSync(`${liveFile()}.3`), 'nothing beyond maxFiles generations exists').toBe(false)
    expect(existsSync(`${liveFile()}.4`)).toBe(false)

    const total = files
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, 'utf8').length)
      .reduce((sum, size) => sum + size, 0)
    // The directory is bounded by cap × files, so it can never grow without limit.
    expect(total).toBeLessThanOrEqual(maxBytes * maxFiles)

    // Every generation is a whole number of complete lines.
    for (const file of [liveFile(), `${liveFile()}.1`, `${liveFile()}.2`]) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      expect(text.endsWith('\n'), `${file} ends mid-line`).toBe(true)
    }
  })

  it('never lets the live file exceed the cap when the cap is smaller than one entry', () => {
    const log = createDiagnosticsLog({ dir: logDir, maxBytes: 120, maxFiles: 2, now: FIXED_CLOCK })
    for (let index = 0; index < 6; index += 1) {
      log.record(info(`a message far longer than the whole cap ${index} ${'z'.repeat(200)}`))
    }
    // A single entry bigger than the whole ceiling cannot be fixed by a rotation
    // (which would only move the over-size file aside), so the LINE is what gives:
    // the entry is still recorded, marked as cut, and the file honours its bound.
    const text = readLive()
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text).toContain('[truncated to fit the log ceiling]')
  })

  it('keeps rotation bounded when maxFiles is 1 (the live file replaces the previous one)', () => {
    const log = createDiagnosticsLog({ dir: logDir, maxBytes: 120, maxFiles: 1, now: FIXED_CLOCK })
    for (let index = 0; index < 8; index += 1) {
      log.record(info(`entry ${index} ${'y'.repeat(50)}`))
    }
    expect(existsSync(`${liveFile()}.1`), 'with maxFiles 1 nothing is kept alongside').toBe(false)
    expect(readFileSync(liveFile()).length).toBeLessThanOrEqual(120)
  })

  it('defaults the cap and the generation count to the documented bounds', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    expect(log.path()).toBe(liveFile())
    expect(DEFAULT_DIAGNOSTICS_MAX_BYTES).toBe(1024 * 1024)
    expect(DEFAULT_DIAGNOSTICS_MAX_FILES).toBe(3)
    // An unusable bound falls back to the default rather than disabling rotation.
    const zero = createDiagnosticsLog({ dir: logDir, maxBytes: 0, maxFiles: -1, now: FIXED_CLOCK })
    zero.record(info('still recorded'))
    expect(existsSync(liveFile())).toBe(true)
  })
})

// ── the sink: never throws ────────────────────────────────────────────────────

describe('the sink never throws', () => {
  it('records nothing and throws nothing when the directory is a file', () => {
    const blocking = join(workDir, 'not-a-directory')
    writeFileSync(blocking, 'this path is a file, so it cannot hold a log')
    const log = createDiagnosticsLog({ dir: blocking, now: FIXED_CLOCK })
    expect(() => log.record(info('this can never be written'))).not.toThrow()
  })

  it('throws nothing when the directory does not exist and cannot be created', () => {
    // A path under a file can never be created; `mkdirSync(recursive)` fails.
    const blocking = join(workDir, 'blocked-parent')
    writeFileSync(blocking, 'x')
    const log = createDiagnosticsLog({ dir: join(blocking, 'tenders'), now: FIXED_CLOCK })
    expect(() => log.record(info('unwritable'))).not.toThrow()
    expect(() => log.record(info('again'))).not.toThrow()
  })

  it('throws nothing when the file cannot be rotated, and stops retrying the doomed rename', () => {
    const log = createDiagnosticsLog({ dir: logDir, maxBytes: 60, maxFiles: 2, now: FIXED_CLOCK })
    log.record(info('a first entry that fills the cap completely'))
    // Replace the live file with a DIRECTORY, so `renameSync(file → file.1)` fails
    // in a way the sink cannot recover from.
    rmSync(liveFile(), { force: true })
    mkdirSync(liveFile())
    expect(() => log.record(info('rotation is now impossible'))).not.toThrow()
    expect(() => log.record(info('and again'))).not.toThrow()
  })

  it('survives a clock that throws, and still writes the entry', () => {
    const log = createDiagnosticsLog({
      dir: logDir,
      now: () => {
        throw new Error('clock exploded')
      },
    })
    expect(() => log.record(info('the clock is broken'))).not.toThrow()
    expect(readLive()).toContain('the clock is broken')
  })

  it('resolves flush even when nothing was ever written', async () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    await expect(log.flush()).resolves.toBeUndefined()
  })
})

// ── the sink: an entry is on disk when `record()` returns ─────────────────────
// The property the whole log is for, and the one the tests above never pinned:
// every one of them either calls `flush()` or reads through a helper that does.
// A crash, a SIGKILL, or a machine losing power never runs a quit hook, so a sink
// that buffered would lose exactly the entries a support request needs. These two
// cases read the file with NO flush and NO quit, which is the only state a killed
// run can be in.

describe('an entry is durable the moment it is recorded, with no flush', () => {
  it('has the entry on disk when `record()` returns, without any flush', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    // Nothing is constructed with an open handle, so the file does not exist yet.
    expect(existsSync(liveFile()), 'the log is created lazily').toBe(false)

    // No `await`, no `flush()`, no microtask drain of any kind between these two
    // lines: the read happens in the same turn as the write.
    log.record(info('recorded with no flush, and already durable'))
    const text = readFileSync(log.path(), 'utf8')

    expect(text).toContain('recorded with no flush, and already durable')
    expect(text.trimEnd().split('\n')).toHaveLength(1)
  })

  it('survives an abrupt end: the file is complete with no quit hook, flush or exit', async () => {
    // A session that is KILLED. Nothing below is a shutdown hook: no `flush()`,
    // no `process.on('exit')`, no `beforeExit` — the process simply stops. What a
    // reader after the fact can see is therefore exactly what was on disk.
    const killed = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    recordDiagnosticsStart(killed, '1.2.3')
    killed.record(info('first thing before the crash'))
    killed.record({ level: 'error', source: 'store', message: 'the save was refused' })
    killed.record(info('last thing before the crash'))

    // The process is gone. A NEW sink in the same directory — the next launch —
    // sees every line, in order, and appends to them rather than starting over.
    const nextLaunch = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    const beforeCrash = readFileSync(liveFile(), 'utf8')
    expect(beforeCrash).toContain('Zanostack Tenders diagnostics started (version 1.2.3).')
    expect(beforeCrash).toContain('the save was refused')
    expect(beforeCrash).toContain('last thing before the crash')
    expect(beforeCrash.endsWith('\n'), 'a killed run never leaves a half-written line').toBe(true)

    nextLaunch.record(info('the launch after the crash'))
    const both = readFileSync(liveFile(), 'utf8')
    expect(both.indexOf('last thing before the crash')).toBeLessThan(
      both.indexOf('the launch after the crash'),
    )
    // The file is what actually existed at the kill: `nextLaunch` only appended.
    expect(both.startsWith(beforeCrash)).toBe(true)
    await expect(
      killed.flush(),
      'flush is a resolved no-op — it was never what saved the entry',
    ).resolves.toBeUndefined()
  })
})

// ── the sink: never records document content ──────────────────────────────────

describe('the sink refuses document content', () => {
  it('drops a nested object or array passed as a detail value instead of walking it', () => {
    expect(sanitizeDiagnosticsDetail({ tender: { title: SECRET_MARKER } })).toEqual({})
    expect(sanitizeDiagnosticsDetail({ pages: [SECRET_MARKER] })).toEqual({})
    expect(sanitizeDiagnosticsDetail({ ok: true, count: 2, code: 'X', missing: null })).toEqual({
      ok: true,
      count: 2,
      code: 'X',
      missing: null,
    })
    // `undefined` is "not set" and is dropped rather than written as null.
    expect(sanitizeDiagnosticsDetail({ absent: undefined })).toEqual({})
    expect(sanitizeDiagnosticsDetail({ infinite: Number.POSITIVE_INFINITY })).toEqual({})
  })

  it('cuts a very long detail string and a very long message rather than dumping either', () => {
    const long = 'L'.repeat(5_000)
    const detail = sanitizeDiagnosticsDetail({ blob: long })
    expect(String(detail.blob).length).toBeLessThanOrEqual(501)
    expect(String(detail.blob)).toContain('L')

    const line = formatDiagnosticsLine(info(long), FIXED_CLOCK())
    expect(line).toContain('…[truncated]')
    expect(line.length).toBeLessThan(long.length)
  })

  it('bounds the number of detail keys it will write', () => {
    const wide: Record<string, number> = {}
    for (let index = 0; index < 100; index += 1) wide[`k${index}`] = index
    expect(Object.keys(sanitizeDiagnosticsDetail(wide))).toHaveLength(24)
  })

  it('never writes document text a caller passed as a message detail', () => {
    const log = createDiagnosticsLog({ dir: logDir, now: FIXED_CLOCK })
    log.record({
      level: 'error',
      source: 'store',
      message: 'a save was refused',
      detail: {
        code: 'SCHEMA_INVALID',
        fieldPath: 'workspaces.0.tenders.0.title',
        // The exact mistakes the rule exists to stop, one of each shape: the
        // document itself, and single fields whose VALUE is document text.
        document: { title: SECRET_MARKER, workspaces: [SECRET_MARKER] },
        verbatimClause: SECRET_MARKER,
        clause: [SECRET_MARKER],
        tenderTitle: SECRET_MARKER,
        text: SECRET_MARKER,
      },
    })
    const text = readLive()
    expect(text).not.toContain(SECRET_MARKER)
    expect(text).toContain('"code":"SCHEMA_INVALID"')
    expect(text).toContain('"fieldPath"')
    for (const refused of ['document', 'verbatimClause', 'clause', 'tenderTitle', 'text']) {
      expect(text, `${refused} must not be recorded`).not.toContain(`"${refused}"`)
    }
  })

  it('refuses a document-bearing key whatever its value, and keeps codes and counts', () => {
    const sanitized = sanitizeDiagnosticsDetail({
      code: 'DOCUMENT_OVER_SIZE',
      documentBytes: 5_000_000,
      tenderTitle: SECRET_MARKER,
      sourceClause: SECRET_MARKER,
      extractedValue: SECRET_MARKER,
      fieldPath: 'workspaces.0.tenders.0.title',
    })
    expect(sanitized).toEqual({
      code: 'DOCUMENT_OVER_SIZE',
      documentBytes: 5_000_000,
      fieldPath: 'workspaces.0.tenders.0.title',
    })
  })

  it('mirrors the same rule in the renderer-side sanitizer it forwards through', () => {
    expect(sanitizeRendererDetail({ tender: { title: SECRET_MARKER } })).toEqual({})
    expect(sanitizeRendererDetail({ pages: [SECRET_MARKER] })).toEqual({})
    expect(sanitizeRendererDetail({ code: 'NO_IPC_BRIDGE', count: 1 })).toEqual({
      code: 'NO_IPC_BRIDGE',
      count: 1,
    })
  })
})

// ── the renderer logger ───────────────────────────────────────────────────────

describe('the renderer logger forwards to main and falls back cleanly', () => {
  it('forwards a built entry through the bridge, with the exact payload shape', async () => {
    const sent: DiagnosticsEntry[] = []
    const bridge: TendersDiagnosticsBridge = {
      recordDiagnostics: (entry) => {
        sent.push(entry)
        return Promise.resolve(true)
      },
    }
    const log = createRendererDiagnostics({ bridge, sink: silentSink() })

    log.warn('store', 'a save was refused', { code: 'NO_IPC_BRIDGE', tenders: 2 })
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    // The channel's argument IS a `DiagnosticsEntry`: level, source, message and
    // a primitive-only detail.
    expect(sent[0]).toEqual({
      level: 'warn',
      source: 'store',
      message: 'a save was refused',
      detail: { code: 'NO_IPC_BRIDGE', tenders: 2 },
    })
  })

  it('is a no-op with no bridge at all, rather than throwing', () => {
    const log = createRendererDiagnostics({ bridge: null, sink: silentSink() })
    expect(() => log.info('store', 'nothing to forward')).not.toThrow()
    expect(() => log.error('store', 'never throws', { a: 1 })).not.toThrow()
  })

  it('swallows a bridge whose forward rejects or throws', async () => {
    const rejecting = createRendererDiagnostics({
      bridge: { recordDiagnostics: () => Promise.reject(new Error('main is gone')) },
      sink: silentSink(),
    })
    expect(() => rejecting.warn('store', 'rejected forward')).not.toThrow()

    const throwing = createRendererDiagnostics({
      bridge: {
        recordDiagnostics: () => {
          throw new Error('bridge threw synchronously')
        },
      },
      sink: silentSink(),
    })
    expect(() => throwing.warn('store', 'throwing forward')).not.toThrow()
    // Let any unhandled rejection surface: the assertions above would fail the
    // run if the sink let one through.
    await Promise.resolve()
    await Promise.resolve()
  })

  it('finds the bridge on window when one is present, and reads it per call', () => {
    const sent: DiagnosticsEntry[] = []
    ;(window as unknown as Record<string, unknown>).tendersApi = {
      recordDiagnostics: (entry: DiagnosticsEntry) => {
        sent.push(entry)
      },
    }
    try {
      expect(tendersDiagnosticsBridge()).not.toBeNull()
      // The module-level logger is built once; the bridge is read at call time,
      // so a preload that only became ready later still works.
      rendererDiagnostics.info('store', 'through the window bridge')
      expect(sent).toHaveLength(1)
      expect(sent[0]?.message).toBe('through the window bridge')
    } finally {
      ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    }
  })

  it('bounds `source` and `message` to the channel\u2019s own limits, marker included', () => {
    const built = buildDiagnosticsEntry({
      level: 'info',
      source: 's'.repeat(500),
      message: `M${'m'.repeat(5_000)}`,
    })
    // Matches `MAX_TENDERS_DIAGNOSTIC_SOURCE_CHARS` / `..._MESSAGE_CHARS` in
    // shared/ipc.ts: an entry longer than either is REFUSED by main, so the cut
    // has to include its own marker to stay inside the limit.
    expect(built.source.length).toBeLessThanOrEqual(64)
    expect(built.message.length).toBeLessThanOrEqual(2_000)
    expect(built.source).toContain('[truncated]')
    expect(built.message).toContain('[truncated]')

    // A short source is untouched.
    expect(buildDiagnosticsEntry({ level: 'info', source: 'store', message: 'short' }).source).toBe(
      'store',
    )
  })

  it('treats a partial bridge as no bridge, and never touches document content', () => {
    ;(window as unknown as Record<string, unknown>).tendersApi = { somethingElse: true }
    try {
      expect(tendersDiagnosticsBridge()).toBeNull()
    } finally {
      ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    }

    const built = buildDiagnosticsEntry({
      level: 'error',
      source: 'store',
      message: 'refused',
      detail: { document: { title: SECRET_MARKER }, clause: [SECRET_MARKER], code: 'X' },
    })
    expect(JSON.stringify(built)).not.toContain(SECRET_MARKER)
    expect(built.detail).toEqual({ code: 'X' })
  })
})

/** A console stand-in that records nothing and cannot be seen in test output. */
function silentSink(): Pick<Console, 'info' | 'warn' | 'error'> {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

// ── the store: the two states that lied ───────────────────────────────────────

type StoreApi = { getState: () => TendersState }
type StoreModule = { useTendersStore: StoreApi }

const STORE_MODULE = '../src/renderer/src/store'

interface ApiMock {
  loadStoreV2: ReturnType<typeof vi.fn>
  saveStoreV2: ReturnType<typeof vi.fn>
  onStoreChangedV2: ReturnType<typeof vi.fn>
}

let api: ApiMock
let consoleErrorSpy: { mockRestore: () => void }

function installTendersApiMock(): void {
  api = {
    loadStoreV2: vi.fn(),
    saveStoreV2: vi.fn(),
    onStoreChangedV2: vi.fn(() => () => {}),
  }
  ;(window as unknown as Record<string, unknown>).tendersApi = api
}

/**
 * Re-arm everything the store suite needs. `vi.resetModules()` because the store
 * keeps module-level state (the committed revision, the migration latch, the
 * once-per-load warning flags), exactly as `renderer-store-v2.test.ts` does.
 */
function resetStoreHarness(): void {
  vi.resetModules()
  window.localStorage.clear()
  installTendersApiMock()
}

async function importStore(): Promise<StoreApi> {
  return ((await import(STORE_MODULE)) as unknown as StoreModule).useTendersStore
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

const LOADED_AT = '2026-09-01T00:00:00.000Z'

function workspace(id: string, name: string): TendersWorkspaceV2 {
  return {
    id,
    company: {
      name,
      registrationNumber: null,
      taxNumber: null,
      vatNumber: null,
      address: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      description: null,
    },
    customers: [],
    tenders: [],
    vault: [],
    createdAt: LOADED_AT,
    updatedAt: LOADED_AT,
    archivedAt: null,
    dataOrigin: 'user',
  } as unknown as TendersWorkspaceV2
}

function documentV2(revision: number, workspaces: TendersWorkspaceV2[]): TendersDataV2 {
  return {
    version: 2,
    revision,
    updatedAt: LOADED_AT,
    activeCompanyId: workspaces[0]?.id ?? null,
    workspaces,
    issuerTemplates: [],
  } as unknown as TendersDataV2
}

function loadOk(
  status: 'loaded' | 'migrated' | 'not-found',
  data: TendersDataV2,
  needsSave = false,
): unknown {
  return { ok: true, status, data, needsSave }
}

function loadFailure(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { ok: false, error: { code, message }, ...extra }
}

describe('a build with no bridge cannot claim its work is saved', () => {
  beforeEach(() => {
    resetStoreHarness()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    window.localStorage.clear()
  })

  it('sets an observable unable-to-save state on hydrate, and never `saved`', async () => {
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    const store = await importStore()

    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    const state = store.getState()
    // The workspace is still usable — this is a degraded build, not a broken one.
    expect(state.hydrationStatus).toBe('ready')
    // But the persistence state says the truth, in three places.
    expect(state.hydrationMode).toBe('unavailable')
    expect(state.saveStatus).toBe('no-bridge')
    expect(state.saveStatus).not.toBe('saved')
    expect(state.saveError).toContain('nothing can be saved')
    expect(state.hydrationError).toContain('nothing can be saved')
    expect(state.saveSizeWarning).toBeNull()
  })

  it('flips to the same state when the bridge disappears mid-session, and never back to `saved`', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(3, [workspace('ws-1', 'Acme')])))
    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()
    expect(store.getState().saveStatus).toBe('saved')

    // The preload goes away (a reload without it, a broken build).
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    store.getState().addDemoWorkspace(workspace('ws-2', 'Sample'))

    expect(store.getState().saveStatus).toBe('no-bridge')
    expect(store.getState().saveStatus).not.toBe('saved')
    expect(store.getState().hydrationMode).toBe('unavailable')
  })

  it('answers the no-bridge reload control honestly instead of returning silently', async () => {
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    const store = await importStore()

    await store.getState().reloadCommittedFromMain()
    await flushMicrotasks()

    expect(store.getState().saveStatus).toBe('no-bridge')
    expect(store.getState().hydrationMode).toBe('unavailable')
    expect(store.getState().saveError).toContain('no saved copy to reload')
  })
})

describe('a failed reload leaves an honest UI, not a healthy one', () => {
  beforeEach(() => {
    resetStoreHarness()
  })

  afterEach(() => {
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    window.localStorage.clear()
  })

  it('sets the hydration state to error when the reload cannot read the document', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(2, [workspace('ws-1', 'Acme')])))
    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()
    expect(store.getState().hydrationStatus).toBe('ready')

    api.loadStoreV2.mockResolvedValue(
      loadFailure('STORE_UNREADABLE', 'the store file is unreadable'),
    )
    await store.getState().reloadCommittedFromMain()
    await flushMicrotasks()

    const state = store.getState()
    expect(state.hydrationStatus, 'the failure must not leave a healthy-looking workspace').toBe(
      'error',
    )
    expect(state.hydrationError).toContain('the store file is unreadable')
    expect(state.saveStatus).toBe('error')
  })

  it('heals the hydration state when a later reload succeeds', async () => {
    api.loadStoreV2.mockResolvedValue(
      loadFailure('STORE_UNREADABLE', 'the store file is unreadable'),
    )
    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()
    expect(store.getState().hydrationStatus).toBe('error')

    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(4, [workspace('ws-1', 'Acme')])))
    await store.getState().reloadCommittedFromMain()
    await flushMicrotasks()

    expect(store.getState().hydrationStatus).toBe('ready')
    expect(store.getState().hydrationError).toBeNull()
    expect(store.getState().saveStatus).toBe('saved')
  })

  it('sets the hydration state to error when the reload throws', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(2, [workspace('ws-1', 'Acme')])))
    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    api.loadStoreV2.mockRejectedValue(new Error('the IPC round trip died'))
    await store.getState().reloadCommittedFromMain()
    await flushMicrotasks()

    expect(store.getState().hydrationStatus).toBe('error')
    expect(store.getState().hydrationError).toContain('the IPC round trip died')
  })

  it('surfaces a RECOVERY_REQUIRED reload as the recovery screen rather than a usable workspace', async () => {
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(2, [workspace('ws-1', 'Acme')])))
    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    api.loadStoreV2.mockResolvedValue(
      loadFailure('RECOVERY_REQUIRED', 'the store needs explicit recovery', {
        recoveryCandidates: [{ id: 'cand-1', path: 'backup.json', savedAt: LOADED_AT }],
      }),
    )
    await store.getState().reloadCommittedFromMain()
    await flushMicrotasks()

    const state = store.getState()
    expect(state.hydrationStatus).toBe('error')
    expect(state.recoveryRequired).toBe(true)
    expect(state.recoveryCandidates).toHaveLength(1)
  })
})

describe('a failed migration commit does not leave a healthy-looking workspace', () => {
  beforeEach(() => {
    resetStoreHarness()
  })

  afterEach(() => {
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    window.localStorage.clear()
  })

  it('marks hydration as failed when the migrated document is refused by main', async () => {
    api.loadStoreV2.mockResolvedValue(
      loadOk('migrated', documentV2(0, [workspace('ws-1', 'Migrated Co')]), true),
    )
    api.saveStoreV2.mockResolvedValue({
      ok: false,
      error: { code: 'STORE_REFUSED', message: 'the commit was refused' },
    })
    const store = await importStore()

    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    const state = store.getState()
    expect(state.saveStatus).toBe('error')
    expect(state.hydrationStatus, 'the document on screen was never committed').toBe('error')
    expect(state.hydrationError).toContain('could not be written back to disk')
  })

  it('marks hydration as failed when the migration commit throws', async () => {
    api.loadStoreV2.mockResolvedValue(
      loadOk('migrated', documentV2(0, [workspace('ws-1', 'Migrated Co')]), true),
    )
    api.saveStoreV2.mockRejectedValue(new Error('the IPC round trip died mid-commit'))
    const store = await importStore()

    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    expect(store.getState().saveStatus).toBe('error')
    expect(store.getState().hydrationStatus).toBe('error')
    expect(store.getState().hydrationError).toContain('could not be written back to disk')
  })

  it('leaves hydration ready when the migration commit succeeds', async () => {
    api.loadStoreV2.mockResolvedValue(
      loadOk('migrated', documentV2(0, [workspace('ws-1', 'Migrated Co')]), true),
    )
    api.saveStoreV2.mockResolvedValue({
      ok: true,
      data: documentV2(1, [workspace('ws-1', 'Migrated Co')]),
    })
    const store = await importStore()

    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    const state = store.getState()
    expect(state.hydrationStatus).toBe('ready')
    expect(state.hydrationError).toBeNull()
    expect(state.saveStatus).toBe('saved')
    expect(api.saveStoreV2).toHaveBeenCalledTimes(1)
  })

  it('marks hydration as failed when the migrated document is over a save ceiling', async () => {
    const oversized = documentV2(0, [workspace('ws-1', 'Migrated Co')])
    // A description beyond the document ceiling makes the size pre-check refuse.
    oversized.workspaces[0]!.company.description = 'x'.repeat(4 * 1024 * 1024 + 1)
    api.loadStoreV2.mockResolvedValue(loadOk('migrated', oversized, true))
    const store = await importStore()

    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    expect(api.saveStoreV2).not.toHaveBeenCalled()
    expect(store.getState().saveStatus).toBe('error')
    expect(store.getState().hydrationStatus).toBe('error')
  })
})

// ── the refusal path also reaches the sink ────────────────────────────────────

describe('a refused save reaches the renderer log as well as the console', () => {
  let warnSpy: { mockRestore: () => void }

  beforeEach(() => {
    resetStoreHarness()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    ;(window as unknown as Record<string, unknown>).tendersApi = undefined
    window.localStorage.clear()
  })

  it('forwards the refusal to `tenders:diagnostics-record`, counts only', async () => {
    const forwarded: DiagnosticsEntry[] = []
    installTendersApiMock()
    ;(window as unknown as Record<string, unknown>).tendersApi = {
      ...api,
      saveStoreV2: vi.fn(),
      recordDiagnostics: (entry: DiagnosticsEntry) => {
        forwarded.push(entry)
      },
    }
    api.loadStoreV2.mockResolvedValue(loadOk('loaded', documentV2(5, [workspace('ws-1', 'Acme')])))

    const store = await importStore()
    await store.getState().hydrateFromMain()
    await flushMicrotasks()

    // Remove the save bridge but keep `recordDiagnostics`, so the refusal is
    // logged without the save path working.
    ;(window as unknown as Record<string, unknown>).tendersApi = {
      ...api,
      saveStoreV2: undefined,
      recordDiagnostics: (entry: DiagnosticsEntry) => {
        forwarded.push(entry)
      },
    }
    store.getState().addDemoWorkspace(workspace('ws-2', 'Sample'))
    await flushMicrotasks()

    expect(forwarded.length).toBeGreaterThan(0)
    const refusal = forwarded.find((entry) => entry.detail?.code === 'NO_IPC_BRIDGE')
    expect(refusal, 'the missing-bridge refusal must be forwarded').toBeTruthy()
    expect(refusal?.source).toBe('store')
    expect(refusal?.level).toBe('warn')
    // Counts and codes only — the never-log-content rule, as sent over the wire.
    expect(JSON.stringify(refusal)).not.toContain(SECRET_MARKER)
    expect(refusal?.detail).toMatchObject({ path: 'autosave' })
    // The counts survive the document-bearing-key refusal, because they are named
    // as counts rather than after the thing they count.
    expect(refusal?.detail).toMatchObject({
      workspaceCount: expect.any(Number),
      tenderCount: expect.any(Number),
    })
    expect(refusal?.detail?.workspaces).toBeUndefined()
  })
})
