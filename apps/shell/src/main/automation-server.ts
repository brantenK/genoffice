import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import {
  AUTOMATION_HOST,
  AUTOMATION_MAX_BODY_BYTES,
  AUTOMATION_PROTOCOL_VERSION,
  AUTOMATION_REQUEST_TIMEOUT_MS,
  type AutomationCommand,
  type AutomationEndpointMetadata,
  type AutomationResponse,
} from '../shared/automation-api'

export interface AutomationServerOptions {
  token: string
  sessionId: string
  pid: number
  metadataPath: string
  dispatch(command: AutomationCommand): Promise<AutomationResponse>
}

export interface AutomationEndpoint {
  host: typeof AUTOMATION_HOST
  port: number
  metadata: AutomationEndpointMetadata
}

function json(
  res: ServerResponse,
  status: number,
  body:
    | AutomationResponse
    | { ok: false; requestId?: string; error: { code: string; message: string } },
): void {
  const encoded = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(encoded))
  res.end(encoded)
}

function authorized(value: string | undefined, token: string): boolean {
  if (!value || !/^Bearer [^\s]+$/.test(value)) return false
  const expected = createHash('sha256').update(token).digest()
  const actual = createHash('sha256').update(value.slice(7)).digest()
  return timingSafeEqual(expected, actual) && value.slice(7) === token
}

function requestIdFrom(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return typeof value?.requestId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.requestId)
      ? value.requestId
      : undefined
  } catch {
    return undefined
  }
}

async function bodyOf(req: IncomingMessage): Promise<{ body?: string; tooLarge: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.length
    if (size > AUTOMATION_MAX_BODY_BYTES) return { tooLarge: true }
    chunks.push(data)
  }
  return { body: Buffer.concat(chunks).toString('utf8'), tooLarge: false }
}

export class AutomationServer {
  private server: Server | null = null
  private terminalClosed = false

  constructor(private readonly options: AutomationServerOptions) {}

  async start(): Promise<AutomationEndpoint> {
    if (this.server) throw new Error('automation server already started')
    if (
      !Number.isSafeInteger(this.options.pid) ||
      this.options.pid !== process.pid ||
      !/^[a-f0-9]{32}$/.test(this.options.sessionId) ||
      basename(this.options.metadataPath) !== 'endpoint.json' ||
      this.options.token.length < 43
    )
      throw new Error('automation identity is invalid')
    const metadataStat = lstatSync(this.options.metadataPath, { throwIfNoEntry: false })
    const parentStat = lstatSync(dirname(this.options.metadataPath), { throwIfNoEntry: false })
    if (metadataStat || !parentStat?.isDirectory() || parentStat.isSymbolicLink())
      throw new Error('automation metadata path is not available')
    const server = createServer((req, res) => void this.handle(req, res))
    server.requestTimeout = AUTOMATION_REQUEST_TIMEOUT_MS
    server.headersTimeout = AUTOMATION_REQUEST_TIMEOUT_MS
    server.keepAliveTimeout = AUTOMATION_REQUEST_TIMEOUT_MS
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, AUTOMATION_HOST)
      })
      const address = server.address()
      if (
        !address ||
        typeof address === 'string' ||
        address.address !== AUTOMATION_HOST ||
        address.port <= 0
      )
        throw new Error('automation listener did not bind privately')
      const metadata: AutomationEndpointMetadata = {
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
        host: AUTOMATION_HOST,
        port: address.port,
        sessionId: this.options.sessionId,
        pid: this.options.pid,
        token: this.options.token,
      }
      this.publish(metadata)
      return { host: AUTOMATION_HOST, port: address.port, metadata }
    } catch (error) {
      await this.abortStartup()
      throw error
    }
  }

  private publish(metadata: AutomationEndpointMetadata): void {
    const parent = dirname(this.options.metadataPath)
    const temp = join(parent, `.${metadata.sessionId}.endpoint.tmp`)
    if (existsSync(temp) || lstatSync(temp, { throwIfNoEntry: false }))
      throw new Error('automation metadata temporary path is not available')
    writeFileSync(temp, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      chmodSync(temp, 0o600)
      renameSync(temp, this.options.metadataPath)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        /* best effort */
      }
      throw error
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const length = Number(req.headers['content-length'] ?? 0)
    if (!Number.isFinite(length) || length < 0 || length > AUTOMATION_MAX_BODY_BYTES) {
      req.resume()
      json(res, 413, {
        ok: false,
        error: { code: 'BODY_TOO_LARGE', message: 'request body is too large' },
      })
      return
    }
    let parsedRequestId: string | undefined
    try {
      const read = await bodyOf(req)
      if (read.tooLarge) {
        json(res, 413, {
          ok: false,
          error: { code: 'BODY_TOO_LARGE', message: 'request body is too large' },
        })
        return
      }
      const body = read.body ?? ''
      const requestId = requestIdFrom(body)
      parsedRequestId = requestId
      if (req.method !== 'POST') {
        json(res, 405, {
          ok: false,
          ...(requestId ? { requestId } : {}),
          error: { code: 'METHOD_NOT_ALLOWED', message: 'method is not allowed' },
        })
        return
      }
      if (req.url !== '/v1/command') {
        json(res, 404, {
          ok: false,
          ...(requestId ? { requestId } : {}),
          error: { code: 'NOT_FOUND_ROUTE', message: 'route is not found' },
        })
        return
      }
      if (
        typeof req.headers['content-type'] !== 'string' ||
        !/^application\/json(?:;|$)/i.test(req.headers['content-type'])
      ) {
        json(res, 400, {
          ok: false,
          ...(requestId ? { requestId } : {}),
          error: { code: 'INVALID_REQUEST', message: 'content type must be JSON' },
        })
        return
      }
      if (
        !authorized(
          typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          this.options.token,
        )
      ) {
        json(res, 401, {
          ok: false,
          ...(requestId ? { requestId } : {}),
          error: { code: 'UNAUTHORIZED', message: 'unauthorized' },
        })
        return
      }
      const raw = JSON.parse(body) as AutomationCommand
      const response = await this.options.dispatch(raw)
      json(res, response.ok ? 200 : 400, response)
    } catch {
      json(res, 400, {
        ok: false,
        ...(parsedRequestId ? { requestId: parsedRequestId } : {}),
        error: { code: 'INVALID_REQUEST', message: 'invalid request' },
      })
    }
  }

  /** Startup failure cleanup is not a normal lifecycle teardown. */
  async abortStartup(): Promise<void> {
    this.removeMetadata()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Only call this after Electron has emitted its terminal quit event. */
  async closeAtTerminal(): Promise<void> {
    if (this.terminalClosed) return
    this.terminalClosed = true
    this.removeMetadata()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private removeMetadata(): void {
    try {
      if (existsSync(this.options.metadataPath)) unlinkSync(this.options.metadataPath)
    } catch {
      /* best effort */
    }
  }
}

export { authorized as isAutomationAuthorizationValid }
