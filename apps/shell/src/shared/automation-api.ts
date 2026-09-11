import type { TabSummary } from './tabs-api'

export const AUTOMATION_PROTOCOL_VERSION = 1 as const
export const AUTOMATION_HOST = '127.0.0.1' as const
export const AUTOMATION_MAX_BODY_BYTES = 64 * 1024
export const AUTOMATION_REQUEST_TIMEOUT_MS = 5_000

export type AutomationCommandName =
  'app.status' | 'tabs.list' | 'tabs.activate' | 'files.open' | 'files.recent'

export interface AutomationCommand {
  version: typeof AUTOMATION_PROTOCOL_VERSION
  requestId: string
  command: AutomationCommandName
  payload: Record<string, unknown>
}

export interface AutomationLaunchRecord {
  protocolVersion: typeof AUTOMATION_PROTOCOL_VERSION
  sessionId: string
  nonce: string
  createdAt: number
  expiresAt: number
  rendezvousPath: string
  sessionRoot: string
  userDataPath: string
  inputRoot: string
  outputRoot: string
}

export interface AutomationEndpointMetadata {
  protocolVersion: typeof AUTOMATION_PROTOCOL_VERSION
  host: typeof AUTOMATION_HOST
  port: number
  sessionId: string
  pid: number
  token: string
}

export type AutomationErrorCode =
  | 'INVALID_REQUEST'
  | 'COMMAND_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_FOUND_ROUTE'
  | 'BODY_TOO_LARGE'
  | 'INTERNAL_ERROR'

export interface AutomationError {
  code: AutomationErrorCode
  message: string
}

export interface AutomationSuccess {
  ok: true
  requestId: string
  result: unknown
}

export interface AutomationFailure {
  ok: false
  requestId?: string
  error: AutomationError
}

export type AutomationResponse = AutomationSuccess | AutomationFailure

export interface AutomationStatus {
  version: string
  automation: true
  platform: NodeJS.Platform
}

export interface AutomationAdapters {
  getStatus(): AutomationStatus | Promise<AutomationStatus>
  listTabs(): TabSummary[]
  activateTab(id: string): boolean | Promise<boolean>
  openFile(path: string): boolean | Promise<boolean>
  recentFiles(): string[]
}
