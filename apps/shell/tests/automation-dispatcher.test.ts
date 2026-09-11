import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationDispatcher } from '../src/main/automation-dispatcher'

function request(command: string, payload: Record<string, unknown> = {}) {
  return { version: 1, requestId: 'req-1', command, payload }
}

function fixture() {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'genoffice-dispatch-'))
  const inputRoot = join(sessionRoot, 'input')
  mkdirSync(inputRoot)
  const docx = join(inputRoot, 'input.docx')
  writeFileSync(docx, 'not a real docx, dispatcher only checks the real router boundary')
  return { sessionRoot, inputRoot, docx }
}

function adapters(f: ReturnType<typeof fixture>) {
  return {
    getStatus: vi.fn(() => ({ version: '1.0.0', automation: true, platform: process.platform })),
    listTabs: vi.fn(() => [
      { id: 'home', kind: 'home', title: 'Zanostack', closable: false, active: true },
    ]),
    activateTab: vi.fn(async () => true),
    openFile: vi.fn(async () => true),
    recentFiles: vi.fn(() => ['/normal/recent.docx', join(f.sessionRoot, 'input', 'input.docx')]),
  }
}

describe('reduced automation dispatcher', () => {
  it('exposes only the frozen V1 commands', async () => {
    const f = fixture()
    const a = adapters(f)
    const dispatcher = new AutomationDispatcher(a, {
      sessionRoot: f.sessionRoot,
      inputRoot: f.inputRoot,
    })
    for (const command of [
      'app.status',
      'tabs.list',
      'tabs.activate',
      'files.open',
      'files.recent',
    ]) {
      const payload =
        command === 'tabs.activate'
          ? { tabId: 'home' }
          : command === 'files.open'
            ? { path: f.docx }
            : {}
      await expect(dispatcher.dispatch(request(command, payload))).resolves.toMatchObject({
        requestId: 'req-1',
      })
    }
    for (const command of ['unknown.command', 'files.write', 'ipc.invoke']) {
      await expect(dispatcher.dispatch(request(command))).resolves.toMatchObject({
        ok: false,
        error: { code: 'COMMAND_NOT_ALLOWED' },
      })
    }
  })

  it('opens only an existing canonical DOCX beneath inputRoot and filters recents', async () => {
    const f = fixture()
    const a = adapters(f)
    const dispatcher = new AutomationDispatcher(a, {
      sessionRoot: f.sessionRoot,
      inputRoot: f.inputRoot,
    })
    await expect(
      dispatcher.dispatch(request('files.open', { path: f.docx })),
    ).resolves.toMatchObject({ ok: true })
    a.openFile.mockResolvedValue(false)
    await expect(
      dispatcher.dispatch(request('files.open', { path: f.docx })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await expect(
      dispatcher.dispatch(request('files.open', { path: join(f.sessionRoot, 'outside.docx') })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await expect(
      dispatcher.dispatch(request('files.open', { path: f.inputRoot })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    const recent = await dispatcher.dispatch(request('files.recent'))
    expect(recent).toMatchObject({ ok: true, result: { files: [f.docx] } })
  })

  it('serializes commands', async () => {
    const f = fixture()
    const a = adapters(f)
    const dispatcher = new AutomationDispatcher(a, {
      sessionRoot: f.sessionRoot,
      inputRoot: f.inputRoot,
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    a.getStatus.mockImplementationOnce(async () => {
      await gate
      return { version: '1', automation: true, platform: process.platform }
    })
    const one = dispatcher.dispatch(request('app.status', {}))
    const two = dispatcher.dispatch(request('tabs.list'))
    await Promise.resolve()
    expect(a.listTabs).not.toHaveBeenCalled()
    release()
    await Promise.all([one, two])
    expect(a.listTabs).toHaveBeenCalledTimes(1)
  })
})
