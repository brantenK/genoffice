import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import type { Writable, Readable } from 'node:stream'
import { AutomationServer } from '../../src/main/automation-server'
import { parseAutomationMode } from '../../src/main/automation-mode'
import type { AutomationCommand, AutomationResponse } from '../../src/shared/automation-api'

export function parseBootstrapArguments(argv: readonly string[]): string {
  const path = argv[1]
  const lexicalTraversal =
    typeof path === 'string' &&
    path.split(/[\\/]/).some((component) => component === '.' || component === '..')
  const unsafeNamespace =
    typeof path === 'string' && /^(?:\\\\|\/\/|\\\\[?.]\\|[A-Za-z]:[^\\/])/.test(path)
  if (
    argv.length !== 2 ||
    argv[0] !== '--rendezvous' ||
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    lexicalTraversal ||
    unsafeNamespace
  ) {
    throw new Error('usage: --rendezvous <absolute path>')
  }
  return path
}

function statusResponse(command: AutomationCommand): AutomationResponse {
  if (command.command !== 'app.status' || Object.keys(command.payload).length !== 0) {
    return {
      ok: false,
      requestId: command.requestId,
      error: { code: 'COMMAND_NOT_ALLOWED', message: 'bootstrap driver only supports app.status' },
    }
  }
  return {
    ok: true,
    requestId: command.requestId,
    result: {
      version: 'bootstrap-preflight',
      automation: true,
      platform: process.platform,
      pid: process.pid,
    },
  }
}

async function waitForTerminalInput(input: Readable): Promise<void> {
  await new Promise<void>((resolveInput) => {
    const finish = () => {
      input.removeListener('end', finish)
      input.removeListener('close', finish)
      process.removeListener('SIGINT', finish)
      process.removeListener('SIGTERM', finish)
      resolveInput()
    }
    input.once('end', finish)
    input.once('close', finish)
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    input.resume()
  })
}

export async function runAutomationBootstrap(
  argv: readonly string[],
  output: Pick<Writable, 'write'> = process.stdout,
  input: Readable = process.stdin,
): Promise<void> {
  const rendezvousPath = parseBootstrapArguments(argv)
  const mode = parseAutomationMode([
    '--genoffice-automation',
    `--genoffice-automation-rendezvous=${rendezvousPath}`,
  ])
  if (!mode.enabled) throw new Error('launch record rejected')
  const token = randomBytes(32).toString('base64url')
  const server = new AutomationServer({
    token,
    sessionId: mode.sessionId,
    pid: process.pid,
    metadataPath: mode.metadataPath,
    dispatch: async (command) => statusResponse(command),
  })
  const endpoint = await server.start()
  // Deliberately exclude token and request/record contents from this line.
  // The returned endpoint is used only for redacted readiness reporting; the
  // server itself performed the real atomic metadata publication.
  output.write(
    `${JSON.stringify({ ready: true, sessionId: mode.sessionId, pid: process.pid, host: endpoint.host, port: endpoint.port })}\n`,
  )
  try {
    await waitForTerminalInput(input)
  } finally {
    await server.closeAtTerminal()
  }
}

async function main(): Promise<void> {
  await runAutomationBootstrap(process.argv.slice(2))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch(() => {
    process.stderr.write('automation bootstrap preflight failed\n')
    process.exitCode = 1
  })
}
