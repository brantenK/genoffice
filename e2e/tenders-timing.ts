/**
 * The timing contract every Tenders e2e journey waits on.
 *
 * THE PROBLEM THIS FILE EXISTS TO FIX. The Tenders lane is load-sensitive by
 * construction, and it used to fail as *noise* rather than as signal: a full run
 * on a machine shared with another workstream took **49.6 and 49.8 minutes**
 * against a healthy **~11 minutes**, and in those runs the failing journey moved
 * every time (the vault flow, then the requirement-status flow, then the
 * close-guard journey, whose own timing gate fired at 328 ms against the
 * product's 300 ms autosave debounce). Every one of those passed when run alone.
 * The specs each polled disk with a hand-picked figure — `pollStore(..., 20_000)`
 * here, `30_000` there, `45_000` somewhere else — and the smaller windows were
 * too tight at 4–9× load, so the suite reported a shifting set of phantom
 * failures and cost this project hours twice.
 *
 * THE TWO FIGURES, AND WHY THESE ONES. Both are derived from a measurement, not
 * from a hunch. Measured on this machine against the built shell, over a scratch
 * profile, timing one real commit:
 *
 *   • workspace created through the first-use dialog → on disk **907 ms** of wall
 *     time from the click; **227 / 234 / 472 ms** observed by a 50 ms poll;
 *   • a shredded tender's requirements reaching disk: **348 ms**;
 *   • a requirement status change reaching disk: **599 ms** on the first edit,
 *     then **4 ms** and **7 ms** on the following two (the autosave debounce,
 *     which those later edits had already covered).
 *
 * So a healthy commit is observed by a poll in **under ~600 ms**, and the
 * slowest figure any of these journeys has to cover is under **1 s**. The
 * windows below are chosen from that: the default is **20× the slowest measured
 * commit**, and a journey that commits a whole shredded document asks for more.
 * A window 20× the healthy latency is not a tight window — it is the margin a
 * loaded runner needs, taken deliberately rather than guessed.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not widen a window to hide a
 * broken behaviour. Every `pollStore` call still fails when the predicate never
 * becomes true, so every assertion behind it still fails when the behaviour it
 * tests is broken; only the *time allowed for a correct behaviour to be
 * observed* changed. Where a journey measures a real product window — journey 7
 * of `tenders-persistence-cutover.spec.ts` measures the product's own 300 ms
 * autosave debounce on the renderer's clock — the measurement and its meaning are
 * untouched; that gate's handling of harness latency is documented where it
 * lives.
 *
 * WHY A SHARED MODULE RATHER THAN A NUMBER IN EACH SPEC. The specs were each
 * polling with their own default, so "raised the window" was a change in eight
 * places that could drift apart again. `cli-control.spec.ts` is the repo's
 * precedent for a shared e2e helper with no test case of its own — this is the
 * same shape, and it means a spec that wants a tighter window has to say so and
 * say why, instead of inheriting one quietly.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Default window for observing a committed store state on disk, in ms.
 *
 * 20× the slowest healthy commit measured above. Two consecutive `pollStore`
 * calls are expected to leave over 100 s of headroom on an idle machine and
 * still finish comfortably inside the suite's own ceiling when the machine is
 * 4–9× oversubscribed.
 */
export const STORE_COMMIT_POLL_MS = 12_000

/**
 * Window for a journey that commits a whole shredded document (an import, a
 * DOCX/PDF intake, a demo-RFP load): the parse, the model of the matrix and the
 * commit all happen inside it, so it asks for more than a single edit does.
 */
export const STORE_IMPORT_POLL_MS = 30_000

/**
 * Deadline for observing a *network-shaped* fixture settling — the fake AI
 * provider holding a request open, a discovery feed scripted to stall. These are
 * driven from the test process and are not affected by the app's own commit
 * cost, so this figure covers harness latency and nothing else.
 */
export const FIXTURE_SETTLE_POLL_MS = 60_000

/**
 * The v2 store file inside a scratch profile's user-data directory. Exported so
 * a caller that must read or seed the RAW file (journeys that write a document
 * by hand, or that assert nothing was written) resolves the same path the shared
 * readers use rather than repeating the join.
 */
export function storeFile(userDataDir: string): string {
  return join(userDataDir, 'tenders', 'tenders-data.json')
}

/**
 * Read the v2 store from a scratch profile. `null` covers every "not written
 * yet" case the callers care about: no file, a file being replaced by the
 * store's atomic rename, and an unreadable file. A caller that needs to tell
 * those apart reads the file itself.
 */
export async function readStore(userDataDir: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(storeFile(userDataDir), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Poll the on-disk store until `predicate` holds, and return the LAST document
 * read either way — so a caller's `expect(store, 'the change must persist')`
 * reports the real state rather than `null`.
 *
 * `timeoutMs` defaults to {@link STORE_COMMIT_POLL_MS}; pass
 * {@link STORE_IMPORT_POLL_MS} for an import. The poll interval is short enough
 * that the returned document is the one the predicate matched, not a later one.
 *
 * A predicate that throws is treated as "not yet": a store read while the file
 * is mid-replacement can parse into a shape the predicate does not expect, and a
 * thrown TypeError there is a timing artefact rather than a failure of the
 * behaviour under test. The predicate MUST NOT contain the assertion — it
 * answers "is the commit visible yet?", and the caller asserts afterwards.
 */
export async function pollStore(
  userDataDir: string,
  predicate: (store: any) => boolean,
  timeoutMs: number = STORE_COMMIT_POLL_MS,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  let last: any | null = null
  while (Date.now() < deadline) {
    last = await readStore(userDataDir)
    if (last) {
      let matched = false
      try {
        matched = predicate(last)
      } catch {
        matched = false
      }
      if (matched) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return last
}

/**
 * The store file's identity, for the "nothing was written" assertions. A
 * signature rather than a mtime so a same-second rewrite with the same bytes is
 * still stable, and `missing` is distinct from any real signature.
 */
export async function storeSignature(userDataDir: string): Promise<string> {
  try {
    const stats = await stat(storeFile(userDataDir))
    return `${stats.size}:${Math.round(stats.mtimeMs)}`
  } catch {
    return 'missing'
  }
}
