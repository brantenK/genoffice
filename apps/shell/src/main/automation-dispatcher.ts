import { existsSync, lstatSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AutomationAdapters,
  AutomationCommand,
  AutomationCommandName,
  AutomationFailure,
  AutomationResponse,
  AutomationSuccess,
} from '../shared/automation-api'
import { AUTOMATION_PROTOCOL_VERSION } from '../shared/automation-api'

const COMMANDS = new Set<AutomationCommandName>([
  'app.status',
  'tabs.list',
  'tabs.activate',
  'files.open',
  'files.recent',
])
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface AutomationDispatcherOptions {
  sessionRoot: string
  inputRoot: string
}

function failure(
  code: AutomationFailure['error']['code'],
  message: string,
  requestId?: string,
): AutomationFailure {
  return { ok: false, ...(requestId ? { requestId } : {}), error: { code, message } }
}

function success(requestId: string, result: unknown): AutomationSuccess {
  return { ok: true, requestId, result }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function safeDocx(path: unknown, inputRoot: string): path is string {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes('\u0000')
  )
    return false
  const canonical = resolve(path)
  if (!isUnder(inputRoot, canonical) || !/\.docx$/i.test(canonical) || !existsSync(canonical))
    return false
  try {
    const stat = lstatSync(canonical)
    return stat.isFile() && !stat.isSymbolicLink() && statSync(canonical).isFile()
  } catch {
    return false
  }
}

function validate(
  raw: unknown,
  inputRoot: string,
): { command: AutomationCommand } | { error: AutomationFailure } {
  if (!object(raw) || Object.keys(raw).sort().join(',') !== 'command,payload,requestId,version')
    return { error: failure('INVALID_REQUEST', 'invalid command envelope') }
  const requestId = raw.requestId
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))
    return { error: failure('INVALID_REQUEST', 'invalid request id') }
  if (
    raw.version !== AUTOMATION_PROTOCOL_VERSION ||
    typeof raw.command !== 'string' ||
    !COMMANDS.has(raw.command as AutomationCommandName)
  )
    return { error: failure('COMMAND_NOT_ALLOWED', 'command is not allowed', requestId) }
  if (!object(raw.payload))
    return { error: failure('INVALID_REQUEST', 'invalid payload', requestId) }
  const command = raw.command as AutomationCommandName
  const payload = raw.payload
  if (
    ['app.status', 'tabs.list', 'files.recent'].includes(command) &&
    Object.keys(payload).length !== 0
  )
    return { error: failure('INVALID_REQUEST', 'payload is not allowed', requestId) }
  if (command === 'tabs.activate') {
    if (
      !exact(payload, ['tabId']) ||
      typeof payload.tabId !== 'string' ||
      !TAB_ID.test(payload.tabId)
    )
      return { error: failure('INVALID_REQUEST', 'invalid tab payload', requestId) }
  }
  if (command === 'files.open' && (!exact(payload, ['path']) || !safeDocx(payload.path, inputRoot)))
    return { error: failure('INVALID_REQUEST', 'invalid input document path', requestId) }
  return { command: raw as unknown as AutomationCommand }
}

export class AutomationDispatcher {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly adapters: AutomationAdapters,
    private readonly options: AutomationDispatcherOptions,
  ) {}

  dispatch(raw: unknown): Promise<AutomationResponse> {
    const run = this.queue.then(() => this.execute(raw))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async execute(raw: unknown): Promise<AutomationResponse> {
    const parsed = validate(raw, this.options.inputRoot)
    if ('error' in parsed) return parsed.error
    const { requestId, command, payload } = parsed.command
    try {
      switch (command) {
        case 'app.status':
          return success(requestId, await this.adapters.getStatus())
        case 'tabs.list':
          return success(requestId, { tabs: this.adapters.listTabs() })
        case 'tabs.activate':
          return (await this.adapters.activateTab(payload.tabId as string))
            ? success(requestId, { activated: true })
            : failure('NOT_FOUND', 'tab not found', requestId)
        case 'files.open': {
          const path = payload.path as string
          if (!safeDocx(path, this.options.inputRoot))
            return failure('INVALID_REQUEST', 'input document is no longer safe', requestId)
          return (await this.adapters.openFile(path))
            ? success(requestId, { opened: true })
            : failure('NOT_FOUND', 'file could not be opened', requestId)
        }
        case 'files.recent': {
          const files = this.adapters.recentFiles().filter((path) => {
            try {
              if (!isAbsolute(path)) return false
              const canonical = resolve(path)
              return (
                isUnder(this.options.sessionRoot, canonical) &&
                lstatSync(canonical).isFile() &&
                !lstatSync(canonical).isSymbolicLink()
              )
            } catch {
              return false
            }
          })
          return success(requestId, { files })
        }
      }
    } catch {
      return failure('INTERNAL_ERROR', 'command failed', requestId)
    }
  }
}
