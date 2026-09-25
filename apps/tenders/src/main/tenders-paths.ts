// Every filesystem PATH decision the Tenders main process makes.
//
// Split out of `main/tenders-main.ts` with no behaviour change: `getTendersBaseDir`
// and its two subdirectories, the lexical confinement check
// (`resolveSafeTendersPath`), the filesystem-proven confinement check that
// actually holds (`resolveConfinedTendersPath`), and the atomic-write primitives
// every writer in this app shares (`atomicWriteDocumentFile`,
// `renameWithBoundedRetry`, `renameWithBoundedRetryAsync`, `getUniqueTimestamp`).
//
// This module owns the ONLY place a renderer-supplied path is validated before it
// is used, which is why it is a module rather than a corner of the IPC surface:
// the checks are load-bearing and deserve to be readable on their own.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * The portal's per-process user-data override. Set through
 * `configureTendersRuntime`; empty means "ask Electron".
 */
let runtimeUserData: string | undefined

/** Install the runtime's user-data override (see `configureTendersRuntime`). */
export function setTendersRuntimeUserData(userData: string | undefined): void {
  runtimeUserData = userData
}

function userDataDir(overrideUserData?: string): string {
  return overrideUserData || runtimeUserData || app.getPath('userData')
}
export function getTendersBaseDir(overrideUserData?: string): string {
  const dir = join(userDataDir(overrideUserData), 'tenders')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getTendersDocumentsDir(overrideUserData?: string): string {
  const dir = join(getTendersBaseDir(overrideUserData), 'documents')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getTendersVaultDir(overrideUserData?: string): string {
  const dir = join(getTendersBaseDir(overrideUserData), 'vault')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function resolveSafeTendersPath(
  storedPath: string,
  overrideUserData?: string,
): { safe: boolean; fullPath: string; error?: string } {
  if (!storedPath || typeof storedPath !== 'string') {
    return { safe: false, fullPath: '', error: 'Stored path is required' }
  }
  if (storedPath.includes('\0')) {
    return { safe: false, fullPath: '', error: 'Null byte detected in path' }
  }
  const root = resolve(getTendersBaseDir(overrideUserData))
  const resolved = resolve(root, storedPath)
  const docsDir = resolve(getTendersDocumentsDir(overrideUserData))
  const docsDirWithSep = docsDir.endsWith(sep) ? docsDir : docsDir + sep
  const vaultDir = resolve(getTendersVaultDir(overrideUserData))
  const vaultDirWithSep = vaultDir.endsWith(sep) ? vaultDir : vaultDir + sep

  // Must strictly be inside either documents/ or vault/ subdirectories
  const isInsideDocs = resolved.startsWith(docsDirWithSep) && resolved !== docsDir
  const isInsideVault = resolved.startsWith(vaultDirWithSep) && resolved !== vaultDir

  if (!isInsideDocs && !isInsideVault) {
    return { safe: false, fullPath: '', error: 'Directory traversal detected' }
  }
  return { safe: true, fullPath: resolved }
}

/**
 * The confinement check that actually holds, on top of the lexical one above.
 *
 * `resolveSafeTendersPath` validates the TEXT: no `..`, no absolute path, no
 * drive-relative form. That is not containment. A symlink or NTFS junction
 * planted at one managed leaf — or replacing `documents/` itself — passes every
 * text check and still resolves outside the Tenders directory, and this product
 * ingests untrusted third-party PDFs, so the filesystem's own answer is the one
 * that has to be asserted.
 *
 * Resolves the real root and the real path and re-asserts the `documents/` or
 * `vault/` prefix against them. A real root that is itself a link (or sits under
 * a base directory that is one) is refused outright, because `realpath` would
 * have followed it and every prefix check afterwards would then agree with the
 * escape.
 */
export function resolveConfinedTendersPath(
  storedPath: string,
  overrideUserData?: string,
): { safe: boolean; fullPath: string; error?: string } {
  const lexical = resolveSafeTendersPath(storedPath, overrideUserData)
  if (!lexical.safe) return lexical
  const directory = storedPath.replace(/\\/g, '/').split('/')[0]
  if (directory !== 'documents' && directory !== 'vault') {
    // The two directories whose real root is checked below. A path that reaches
    // them by another spelling has already been refused by the lexical check, so
    // this is a belt-and-braces guard rather than the boundary.
    return { safe: false, fullPath: '', error: 'Directory traversal detected' }
  }
  const baseDir = resolve(getTendersBaseDir(overrideUserData))
  const lexicalRoot = join(baseDir, directory)
  try {
    if (lstatSync(baseDir).isSymbolicLink() || lstatSync(lexicalRoot).isSymbolicLink()) {
      return {
        safe: false,
        fullPath: '',
        error: 'The managed document directory is a link outside the Tenders data directory',
      }
    }
  } catch {
    return { safe: false, fullPath: '', error: 'File not found on disk' }
  }
  let realRoot: string
  let realFull: string
  try {
    realRoot = realpathSync(lexicalRoot)
    realFull = realpathSync(lexical.fullPath)
  } catch {
    return { safe: false, fullPath: '', error: 'File not found on disk' }
  }
  const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  const compare = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  if (!compare(realFull).startsWith(compare(normalizedRoot))) {
    return {
      safe: false,
      fullPath: '',
      error: 'The stored path resolves outside the Tenders data directory',
    }
  }
  let leaf: ReturnType<typeof lstatSync>
  try {
    leaf = lstatSync(realFull)
  } catch {
    return { safe: false, fullPath: '', error: 'File not found on disk' }
  }
  // A link is never a document this app wrote: `saveDocumentFile` writes into a
  // name it composed, with `flag: 'wx'`.
  if (leaf.isSymbolicLink() || !leaf.isFile()) {
    return {
      safe: false,
      fullPath: '',
      error: 'The stored path is not a regular file inside the Tenders data directory',
    }
  }
  return { safe: true, fullPath: realFull }
}

export function atomicWriteDocumentFile(targetPath: string, buffer: Buffer): void {
  const dir = targetPath.replace(/[/\\][^/\\]+$/, '')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
  try {
    writeFileSync(tmp, buffer)
    renameWithBoundedRetry(tmp, targetPath)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * Atomic rename with a bounded retry for the two Windows-only transient codes.
 *
 * A reader holding the destination open (a scanner, a sync client, the app's own
 * `fs.watch` handler between two reads) makes `renameSync` fail with `EBUSY` or
 * `EPERM` on Windows even though nothing is wrong with the write.
 *
 * This file exports the retry in both forms, because the two writers that need it
 * differ in one respect that cannot be papered over: `renameWithBoundedRetry` is
 * SYNCHRONOUS and belongs to writers that run on a request that must finish
 * before it returns, while `renameWithBoundedRetryAsync` is for the
 * managed-document store, which awaits its own index writes and must not block
 * the main process's thread for a retry delay.
 *
 * They share `isTransientRenameError`, `RENAME_RETRY_ATTEMPTS` and
 * `RENAME_RETRY_DELAY_MS`, so the two paths cannot drift into different retry
 * behaviour again. That drift was the defect: the primary store retried and the
 * managed store did not, so a transient lock made a managed write fail where the
 * same operation against the primary succeeded.
 *
 * The delay SLEEPS rather than spinning: the previous implementation burned a
 * full 15 ms of CPU per attempt waiting for a lock it was not holding, on the
 * main process's thread. Attempts are capped, so a genuinely locked destination
 * still fails with its own error rather than hanging the app.
 */
const RENAME_RETRY_ATTEMPTS = 3
const RENAME_RETRY_DELAY_MS = 15

/** The two Windows-only transient codes a retry can actually help with. */
function isTransientRenameError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EBUSY' || code === 'EPERM'
}

export function renameWithBoundedRetry(from: string, to: string): void {
  let lastError: unknown = null
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error: unknown) {
      lastError = error
      if (!isTransientRenameError(error)) throw error
      if (attempt < RENAME_RETRY_ATTEMPTS - 1) sleepSync(RENAME_RETRY_DELAY_MS)
    }
  }
  throw lastError
}

/**
 * The same bounded retry, for the asynchronous writers.
 *
 * The managed-document store is asynchronous (it holds one queue and awaits its
 * own index writes), so it cannot call the synchronous helper above without
 * blocking the main process's thread. It used to call `fs/promises` `rename`
 * directly — which meant the ONE atomic write in this app that had no retry was a
 * managed document's, while the primary store and the document-file writer both
 * had one. A scanner or a sync client holding the destination open therefore
 * turned a managed write into a hard failure where the same operation against the
 * primary store succeeded.
 *
 * Same attempt count and same bounded delay as the synchronous form, so the two
 * cannot drift: this is the parity the docs claim, made true.
 */
export async function renameWithBoundedRetryAsync(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises')
  let lastError: unknown = null
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      lastError = error
      if (!isTransientRenameError(error)) throw error
      if (attempt < RENAME_RETRY_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RENAME_RETRY_DELAY_MS)
        })
      }
    }
  }
  throw lastError
}

/** Block this thread for `ms`, without spinning a core for the whole duration. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

let lastSaveTimestamp = 0
export function getUniqueTimestamp(): number {
  const now = Date.now()
  lastSaveTimestamp = now > lastSaveTimestamp ? now : lastSaveTimestamp + 1
  return lastSaveTimestamp
}
