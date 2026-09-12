import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { AutomationLaunchRecord } from '../shared/automation-api'
import { AUTOMATION_PROTOCOL_VERSION } from '../shared/automation-api'

const MAX_RECORD_BYTES = 16 * 1024
const MAX_RECORD_LIFETIME_MS = 2 * 60 * 1000
const SESSION_ID = /^[a-f0-9]{32}$/
const NONCE = /^[a-f0-9]{64}$/
const AUTOMATION_FLAG = '--genoffice-automation'
const RENDEZVOUS_PREFIX = '--genoffice-automation-rendezvous='
const PATH_NAMES = [
  'sessionRoot',
  'userDataPath',
  'inputRoot',
  'outputRoot',
  'rendezvousPath',
] as const

export interface NormalAutomationMode {
  disposition: 'normal'
  enabled: false
}
export interface InvalidAutomationMode {
  disposition: 'invalid'
  enabled: false
  error: string
  safeUserDataPath: string
}
export interface EnabledAutomationMode {
  disposition: 'automation'
  enabled: true
  rendezvousPath: string
  metadataPath: string
  sessionRoot: string
  userDataPath: string
  inputRoot: string
  outputRoot: string
  sessionId: string
  record: AutomationLaunchRecord
}
export type AutomationMode = NormalAutomationMode | InvalidAutomationMode | EnabledAutomationMode
export interface AutomationModeOptions {
  now?: number
}

function invalid(error: string): InvalidAutomationMode {
  return {
    disposition: 'invalid',
    enabled: false,
    error,
    safeUserDataPath: join(tmpdir(), `.genoffice-invalid-${process.pid}`),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function equalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Reject lexical traversal before resolve/realpath can hide it. */
function hasUnsafeLexicalComponent(value: string): boolean {
  return value.split(/[\\/]/).some((component) => component === '.' || component === '..')
}

function localCanonicalPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\u0000') ||
    hasUnsafeLexicalComponent(value)
  )
    return false
  if (/^(?:\\\\|\/\/|\\\\[?.]\\|[A-Za-z]:[^\\/])/.test(value)) return false
  return isAbsolute(value) && equalPath(resolve(value), value)
}

/** Electron-side lexical/reparse check; Python remains the stronger ACL authority. */
function safeExistingPath(path: string, kind: 'file' | 'directory'): boolean {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let cursor = absolute
  while (cursor !== root) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) return false
    cursor = dirname(cursor)
  }
  const leaf = lstatSync(absolute, { throwIfNoEntry: false })
  if (!leaf || leaf.isSymbolicLink() || (kind === 'file' ? !leaf.isFile() : !leaf.isDirectory()))
    return false
  try {
    return equalPath(realpathSync.native(absolute), absolute)
  } catch {
    return false
  }
}

export function sanitizeAutomationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'Path',
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'COMSPEC',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
  ])
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key)))
}

function parseLaunchRecord(
  value: unknown,
  paths: Record<(typeof PATH_NAMES)[number], string>,
  now: number,
): AutomationLaunchRecord | null {
  if (!isObject(value)) return null
  const keys = [
    'createdAt',
    'expiresAt',
    'inputRoot',
    'nonce',
    'outputRoot',
    'protocolVersion',
    'rendezvousPath',
    'sessionId',
    'sessionRoot',
    'userDataPath',
  ]
  if (Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) return null
  if (
    value.protocolVersion !== AUTOMATION_PROTOCOL_VERSION ||
    typeof value.sessionId !== 'string' ||
    !SESSION_ID.test(value.sessionId) ||
    typeof value.nonce !== 'string' ||
    !NONCE.test(value.nonce) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.createdAt > now + 30_000 ||
    value.expiresAt <= now ||
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > MAX_RECORD_LIFETIME_MS
  )
    return null
  if (
    !equalPath(value.sessionRoot as string, paths.sessionRoot) ||
    basename(paths.sessionRoot) !== value.sessionId
  )
    return null
  for (const name of PATH_NAMES) {
    if (!localCanonicalPath(value[name]) || !equalPath(resolve(value[name]), paths[name]))
      return null
  }
  return value as unknown as AutomationLaunchRecord
}

export function parseAutomationMode(
  argv: readonly string[],
  options: AutomationModeOptions = {},
): AutomationMode {
  const now = options.now ?? Date.now()
  const flags = argv.filter((arg) => arg === AUTOMATION_FLAG)
  const rendezvousFlags = argv.filter((arg) => arg.startsWith(RENDEZVOUS_PREFIX))
  if (flags.length === 0 && rendezvousFlags.length === 0)
    return { disposition: 'normal', enabled: false }
  if (flags.length !== 1 || rendezvousFlags.length !== 1) return invalid('invalid automation flags')
  const rawRendezvous = rendezvousFlags[0].slice(RENDEZVOUS_PREFIX.length)
  if (!localCanonicalPath(rawRendezvous)) return invalid('invalid rendezvous path')
  const rendezvousPath = resolve(rawRendezvous)
  const sessionRoot = dirname(rendezvousPath)
  try {
    const recordStat = lstatSync(rendezvousPath, { throwIfNoEntry: false })
    if (
      !safeExistingPath(sessionRoot, 'directory') ||
      !recordStat?.isFile() ||
      recordStat.isSymbolicLink() ||
      recordStat.size <= 0 ||
      recordStat.size > MAX_RECORD_BYTES ||
      !safeExistingPath(rendezvousPath, 'file')
    )
      return invalid('invalid launch record')
    const paths = {
      sessionRoot,
      userDataPath: resolve(join(sessionRoot, 'user-data')),
      inputRoot: resolve(join(sessionRoot, 'input')),
      outputRoot: resolve(join(sessionRoot, 'output')),
      rendezvousPath,
    }
    if (
      lstatSync(join(sessionRoot, 'endpoint.json'), { throwIfNoEntry: false }) ||
      lstatSync(join(sessionRoot, 'session.json'), { throwIfNoEntry: false }) ||
      lstatSync(`${rendezvousPath}.consumed`, { throwIfNoEntry: false })
    )
      return invalid('stale session state')
    const record = parseLaunchRecord(
      JSON.parse(readFileSync(rendezvousPath, 'utf8')) as unknown,
      paths,
      now,
    )
    if (!record) return invalid('invalid launch record')
    const sessionLock = join(sessionRoot, 'session.lock')
    if (
      !safeExistingPath(sessionLock, 'file') ||
      !safeExistingPath(paths.userDataPath, 'directory') ||
      !safeExistingPath(paths.inputRoot, 'directory') ||
      !safeExistingPath(paths.outputRoot, 'directory')
    )
      return invalid('invalid session layout')
    if (readdirSync(paths.userDataPath).length !== 0) return invalid('user data is not fresh')
    renameSync(rendezvousPath, `${rendezvousPath}.consumed`)
    return {
      disposition: 'automation',
      enabled: true,
      metadataPath: join(sessionRoot, 'endpoint.json'),
      ...paths,
      sessionId: record.sessionId,
      record,
    }
  } catch {
    return invalid('invalid launch record')
  }
}
