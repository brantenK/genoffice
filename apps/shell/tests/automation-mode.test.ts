import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAutomationMode, sanitizeAutomationEnvironment } from '../src/main/automation-mode'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'genoffice-session-'))
  const sessionRoot = join(base, '0123456789abcdef0123456789abcdef')
  mkdirSync(sessionRoot)
  const paths = {
    sessionRoot,
    userDataPath: join(sessionRoot, 'user-data'),
    inputRoot: join(sessionRoot, 'input'),
    outputRoot: join(sessionRoot, 'output'),
    rendezvousPath: join(sessionRoot, 'launch.json'),
  }
  mkdirSync(paths.userDataPath)
  mkdirSync(paths.inputRoot)
  mkdirSync(paths.outputRoot)
  writeFileSync(join(sessionRoot, 'session.lock'), '')
  writeFileSync(
    paths.rendezvousPath,
    JSON.stringify({
      protocolVersion: 1,
      sessionId: '0123456789abcdef0123456789abcdef',
      nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
      ...paths,
    }),
  )
  return paths
}

const args = (rendezvousPath: string) => [
  '--genoffice-automation',
  `--genoffice-automation-rendezvous=${rendezvousPath}`,
]
const options = { now: 1_700_000_010_000 }

describe('final automation launch contract', () => {
  it('distinguishes normal, valid, and invalid explicit launches', () => {
    expect(parseAutomationMode([], options).disposition).toBe('normal')
    const valid = fixture()
    expect(parseAutomationMode(args(valid.rendezvousPath), options).disposition).toBe('automation')
    const invalid = fixture()
    writeFileSync(invalid.rendezvousPath, '{"protocolVersion":1}')
    expect(parseAutomationMode(args(invalid.rendezvousPath), options).disposition).toBe('invalid')
  })

  it('requires exact hex identities, integer millisecond timestamps, exact layout, and absent reserved state', () => {
    const valid = fixture()
    expect(parseAutomationMode(args(valid.rendezvousPath), options)).toMatchObject({
      disposition: 'automation',
      sessionRoot: valid.sessionRoot,
      inputRoot: valid.inputRoot,
      outputRoot: valid.outputRoot,
    })
    const badId = fixture()
    writeFileSync(
      badId.rendezvousPath,
      JSON.stringify({
        protocolVersion: 1,
        sessionId: '-bad',
        nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        createdAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
        ...badId,
      }),
    )
    expect(parseAutomationMode(args(badId.rendezvousPath), options).disposition).toBe('invalid')
    const endpoint = fixture()
    writeFileSync(join(endpoint.sessionRoot, 'endpoint.json'), '{}')
    expect(parseAutomationMode(args(endpoint.rendezvousPath), options).disposition).toBe('invalid')
    const noLock = fixture()
    rmSync(join(noLock.sessionRoot, 'session.lock'))
    expect(parseAutomationMode(args(noLock.rendezvousPath), options).disposition).toBe('invalid')
    const fractional = fixture()
    writeFileSync(
      fractional.rendezvousPath,
      JSON.stringify({
        protocolVersion: 1,
        sessionId: '0123456789abcdef0123456789abcdef',
        nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        createdAt: 1_700_000_000_000.5,
        expiresAt: 1_700_000_060_000,
        ...fractional,
      }),
    )
    expect(parseAutomationMode(args(fractional.rendezvousPath), options).disposition).toBe(
      'invalid',
    )
  })

  it('rejects replay, stale records, lexical traversal/UNC/device paths, and poisoned controls', () => {
    const replay = fixture()
    expect(parseAutomationMode(args(replay.rendezvousPath), options).disposition).toBe('automation')
    expect(parseAutomationMode(args(replay.rendezvousPath), options).disposition).toBe('invalid')
    const stale = fixture()
    writeFileSync(
      stale.rendezvousPath,
      JSON.stringify({
        protocolVersion: 1,
        sessionId: '0123456789abcdef0123456789abcdef',
        nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        createdAt: 1_699_999_000_000,
        expiresAt: 1_699_999_060_000,
        ...stale,
      }),
    )
    expect(parseAutomationMode(args(stale.rendezvousPath), options).disposition).toBe('invalid')
    expect(
      parseAutomationMode(
        [
          '--genoffice-automation',
          '--genoffice-automation-rendezvous=\\\\server\\share\\launch.json',
        ],
        options,
      ).disposition,
    ).toBe('invalid')
    expect(
      sanitizeAutomationEnvironment({
        DOCS_RENDERER_URL: 'x',
        ELECTRON_RENDERER_URL: 'x',
        GENOFFICE_SCREENSHOT_PATH: 'x',
        OPEN_CRM_ON_START: '1',
        XLSX_DEBUG_PORT: '9',
        NODE_OPTIONS: '--inspect',
        KEEP: 'no',
      }),
    ).toEqual({})
  })

  it('parses a valid record with poisoned Windows tool variables and has no system-tool requirement', () => {
    const previousSystemRoot = process.env.SystemRoot
    const previousWindir = process.env.WINDIR
    process.env.SystemRoot = 'C:\\poisoned-system-root'
    process.env.WINDIR = 'C:\\poisoned-windir'
    try {
      const valid = fixture()
      expect(parseAutomationMode(args(valid.rendezvousPath), options).disposition).toBe(
        'automation',
      )
      const source = readFileSync(
        new URL('../src/main/automation-mode.ts', import.meta.url),
        'utf8',
      )
      expect(source).not.toMatch(/icacls|whoami|spawnSync/)
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = previousSystemRoot
      if (previousWindir === undefined) delete process.env.WINDIR
      else process.env.WINDIR = previousWindir
    }
  })
})
