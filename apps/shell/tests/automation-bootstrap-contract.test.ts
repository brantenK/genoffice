import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  parseBootstrapArguments,
  runAutomationBootstrap,
} from './helpers/automation-bootstrap-preflight'

describe('bootstrap preflight driver contract', () => {
  it('accepts only --rendezvous followed by an absolute path', () => {
    expect(parseBootstrapArguments(['--rendezvous', 'C:\\session\\launch.json'])).toEqual(
      'C:\\session\\launch.json',
    )
    expect(() => parseBootstrapArguments([])).toThrow()
    expect(() => parseBootstrapArguments(['--rendezvous', 'relative.json'])).toThrow()
    expect(() =>
      parseBootstrapArguments(['--rendezvous', 'C:\\session\\launch.json', 'extra']),
    ).toThrow()
  })

  it('uses the real parser and server, emits one redacted ready line, and cleans terminal metadata', async () => {
    const base = mkdtempSync(join(tmpdir(), 'genoffice-bootstrap-'))
    const root = join(base, '0123456789abcdef0123456789abcdef')
    mkdirSync(root)
    const inputRoot = join(root, 'input')
    const outputRoot = join(root, 'output')
    const userDataPath = join(root, 'user-data')
    mkdirSync(inputRoot)
    mkdirSync(outputRoot)
    mkdirSync(userDataPath)
    writeFileSync(join(root, 'session.lock'), '')
    const launch = join(root, 'launch.json')
    writeFileSync(
      launch,
      JSON.stringify({
        protocolVersion: 1,
        sessionId: '0123456789abcdef0123456789abcdef',
        nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        sessionRoot: root,
        userDataPath,
        inputRoot,
        outputRoot,
        rendezvousPath: launch,
      }),
    )
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk) => {
      text += chunk.toString()
    })
    const readyLine = new Promise<string>((resolve) =>
      output.once('data', (chunk) => resolve(chunk.toString())),
    )
    const running = runAutomationBootstrap(['--rendezvous', launch], output, input)
    await readyLine
    expect(JSON.parse(text)).toMatchObject({
      ready: true,
      sessionId: '0123456789abcdef0123456789abcdef',
      pid: process.pid,
      host: '127.0.0.1',
    })
    expect(text).not.toContain('token')
    expect(existsSync(join(root, 'endpoint.json'))).toBe(true)
    input.end()
    await running
    expect(existsSync(join(root, 'endpoint.json'))).toBe(false)
  })
})
