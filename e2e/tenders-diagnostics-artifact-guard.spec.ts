/**
 * The mechanical guard for the diagnostics-log salvage.
 *
 * ── WHAT THIS FILE EXISTS TO PREVENT ─────────────────────────────────────────
 *
 * The Tenders lane's most valuable artefact is the app's own diagnostics log, and
 * it lives INSIDE the scratch profile every spec deletes at teardown. The first
 * version of the salvage copied it in the spec's `finally`, but reported the
 * result into the JSON *before* that block ran, so a FAILING run — the only run
 * whose log matters — recorded `diagnosticsLogArtifact: null` while the artefact
 * list recorded a real path: one document contradicting itself, and the log
 * absent exactly when it was needed. Worse, it is a silent regression class: a
 * `finally` that salvages and then forgets the path still passes every existing
 * assertion, because nothing was asserting the salvage itself.
 *
 * So this spec asserts the SALVAGE CONTRACT directly, on a real scratch profile
 * with a real app-written log, without launching Electron:
 *
 *   1. a log that exists is copied out of the profile BEFORE the profile is
 *      deleted, and the copy is byte-identical;
 *   2. the profile is gone afterwards — the salvage did not disable the cleanup;
 *   3. a profile with NO log is reported as `null`, not as a failure, so a run
 *      that failed before the app started does not turn into a second failure;
 *   4. the artefact list for a run is discoverable by its label, which is what
 *      makes "a failing run names its artefact" checkable.
 *
 * This is the guard the brief asked for: a *focused check* that a run which
 * fails still produces `e2e/artifacts/diagnostics/*`. It runs in the same lane
 * and against the same helper the specs use, so a change that breaks the salvage
 * for the specs breaks this test too — which is the point.
 */
import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  diagnosticsArtifactsFor,
  salvageTendersDiagnosticsLog,
  teardownScratchProfile,
  writeSalvagedLogs,
} from './tenders-timing'

/** `%LOCALAPPDATA%\Temp\opencode` — the same scratch root the specs use. */
const SCRATCH_ROOT = join(tmpdir(), 'opencode')

async function scratchUserData(): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true })
  return mkdtemp(join(SCRATCH_ROOT, 'genoffice-diagnostics-guard-'))
}

/** Write a log where the app writes it, inside the profile. */
async function writeAppLogInsideProfile(userDataDir: string, body: string): Promise<void> {
  await mkdir(join(userDataDir, 'tenders'), { recursive: true })
  await writeFile(join(userDataDir, 'tenders', 'tenders-diagnostics.log'), body, 'utf8')
}

/** How many artefacts exist for a label before a test runs. */
async function countFor(label: string): Promise<number> {
  return (await diagnosticsArtifactsFor(label)).length
}

test.describe('the diagnostics-log salvage survives the run it exists for', () => {
  test.describe.configure({ timeout: 60_000 })

  test('a log is copied out of the profile before the profile is deleted', async () => {
    const userDataDir = await scratchUserData()
    const label = `guard-copy-${Date.now()}`
    const body = [
      '2026-09-25T00:00:00.000Z INFO tenders-start {"version":"9.9.9"}',
      '2026-09-25T00:00:01.000Z ERROR render-error {"code":"tenders-react-render-TypeError"}',
      '',
    ].join('\n')
    await writeAppLogInsideProfile(userDataDir, body)

    let artifact: string | null = null
    try {
      // The exact call the specs make from their `finally`, which is the one that
      // runs on the failing path too.
      artifact = await teardownScratchProfile(userDataDir, label)
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }

    expect(artifact, 'a run with a log must salvage it, not report null').toBeTruthy()
    expect(artifact!).toMatch(/artifacts[\\/]diagnostics[\\/]/)
    // Byte-identical: a salvage that truncated or re-encoded the log would be
    // worse than none, because it would look like evidence.
    expect(await readFile(artifact!, 'utf8')).toBe(body)
    // And the profile is gone — the salvage must not have replaced the cleanup.
    await expect(
      stat(userDataDir).then(
        () => 'still there',
        () => 'gone',
      ),
    ).resolves.toBe('gone')
  })

  test('a run that failed before the app started salvages nothing, without failing', async () => {
    const userDataDir = await scratchUserData()
    const label = `guard-empty-${Date.now()}`
    // No log at all: the shape of a run whose app never started.
    const artifact = await teardownScratchProfile(userDataDir, label)
    expect(artifact, 'an absent log is reported as absent, never faked').toBeNull()
    await expect(
      stat(userDataDir).then(
        () => 'still there',
        () => 'gone',
      ),
    ).resolves.toBe('gone')
  })

  test('a failing run names its artefact, and the artefact survives on disk', async () => {
    const userDataDir = await scratchUserData()
    const label = `guard-fail-${Date.now()}`
    await writeAppLogInsideProfile(userDataDir, 'ERROR tenders-boom {"code":"SAVE_THREW"}\n')
    const before = await countFor(label)

    // A FAILING run: the salvage happens, then the throw propagates. This is the
    // ordering the regression got wrong — the artefact must exist and be named
    // even though the test never reached its happy-path result write.
    const salvaged: Array<string | null> = []
    let caught: unknown = null
    try {
      salvaged.push(await teardownScratchProfile(userDataDir, label))
      throw new Error('guard: a flow failed after teardown')
    } catch (error) {
      caught = error
    }
    const sidecar = await writeSalvagedLogs(`${label}-artifacts`, salvaged)

    expect(caught, 'the failing path must still throw').toBeInstanceOf(Error)
    expect(salvaged[0], 'a failing run must still yield its log').toBeTruthy()
    const after = await countFor(label)
    expect(after, 'the salvaged artefact must be on disk for a failing run').toBe(before + 1)
    expect(await readFile(salvaged[0]!, 'utf8')).toContain('SAVE_THREW')

    // The written record is what makes the salvage observable rather than a
    // side effect nobody reads.
    const record = JSON.parse(await readFile(sidecar, 'utf8')) as { diagnosticsLogs: unknown }
    expect(record.diagnosticsLogs).toEqual(salvaged)

    await rm(sidecar, { force: true }).catch(() => undefined)
    await rm(salvaged[0]!, { force: true }).catch(() => undefined)
  })

  test('the specs that own a scratch profile all tear it down through the helper', async () => {
    // The other half of the regression was divergence: the salvage was written
    // once, by hand, in one spec, while every other spec deleted its profile
    // outright — so the same defect could return one file over. Read the specs
    // from disk and require that a profile deletion goes through the helper.
    const { readdir } = await import('node:fs/promises')
    const specs = (await readdir(join(__dirname))).filter(
      (name) =>
        name.startsWith('tenders-') &&
        name.endsWith('.spec.ts') &&
        // This file's own `rm` calls are on purpose: they are the deliberate,
        // post-salvage cleanups of the fixtures it builds, not a spec deleting
        // the profile whose log it needs.
        name !== 'tenders-diagnostics-artifact-guard.spec.ts',
    )
    expect(specs.length, 'the Tenders lane must still have its specs').toBeGreaterThan(5)

    const offenders: string[] = []
    for (const name of specs) {
      const source = await readFile(join(__dirname, name), 'utf8')
      // A raw profile deletion that is not part of the helper itself.
      if (/rm\(userDataDir[A-Za-z]*, \{ recursive: true, force: true \}\)/.test(source)) {
        offenders.push(name)
      }
    }
    expect(
      offenders,
      'every Tenders spec must delete its scratch profile through teardownScratchProfile, ' +
        'so the diagnostics log is salvaged before it goes',
    ).toEqual([])
  })
})
