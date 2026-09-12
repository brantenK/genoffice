import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { AutomationServer } from '../src/main/automation-server'

function call(
  port: number,
  token: string,
  body: string,
  options: { path?: string; method?: string; contentType?: string } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/v1/command',
        method: options.method ?? 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': options.contentType ?? 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('automation HTTP safety remediation', () => {
  it('publishes strict metadata with PID and keeps unauthenticated errors typed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genoffice-http-'))
    const metadataPath = join(root, 'endpoint.json')
    const token = randomBytes(32).toString('base64url')
    const server = new AutomationServer({
      token,
      sessionId: '0123456789abcdef0123456789abcdef',
      metadataPath,
      pid: process.pid,
      dispatch: async (command) => ({ ok: true, requestId: command.requestId, result: {} }),
    })
    const endpoint = await server.start()
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    expect(metadata).toEqual({
      protocolVersion: 1,
      host: '127.0.0.1',
      port: endpoint.port,
      sessionId: '0123456789abcdef0123456789abcdef',
      pid: process.pid,
      token,
    })
    const valid = await call(
      endpoint.port,
      token,
      JSON.stringify({ version: 1, requestId: 'ok1', command: 'app.status', payload: {} }),
    )
    expect(valid.status).toBe(200)
    const unauthorized = await call(
      endpoint.port,
      'wrong',
      JSON.stringify({ version: 1, requestId: 'r1', command: 'app.status', payload: {} }),
    )
    expect(unauthorized.status).toBe(401)
    expect(JSON.parse(unauthorized.body)).toMatchObject({
      ok: false,
      requestId: 'r1',
      error: { code: 'UNAUTHORIZED' },
    })
    const wrongRoute = await call(
      endpoint.port,
      token,
      JSON.stringify({ version: 1, requestId: 'r2', command: 'app.status', payload: {} }),
      { path: '/other' },
    )
    expect(JSON.parse(wrongRoute.body)).toMatchObject({
      ok: false,
      requestId: 'r2',
      error: { code: 'NOT_FOUND_ROUTE' },
    })
    await server.abortStartup()
  })

  it('allows cleanup only through a confirmed terminal teardown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genoffice-http-'))
    const metadataPath = join(root, 'endpoint.json')
    const server = new AutomationServer({
      token: randomBytes(32).toString('base64url'),
      sessionId: '0123456789abcdef0123456789abcdef',
      metadataPath,
      pid: process.pid,
      dispatch: async (command) => ({ ok: true, requestId: command.requestId, result: {} }),
    })
    await server.start()
    expect(existsSync(metadataPath)).toBe(true)
    await server.closeAtTerminal()
    expect(existsSync(metadataPath)).toBe(false)
  })
})
