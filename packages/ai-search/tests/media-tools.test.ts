import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/gsk', () => ({
  gskGenerateImage: vi.fn(),
  gskAnalyzeMedia: vi.fn(),
  hasGskAuth: vi.fn(() => true),
}))

import { generateImageTool, GSK_RMBG_MODEL } from '../src/media-tools'
import { gskGenerateImage } from '../src/gsk'

const gskGen = vi.mocked(gskGenerateImage)
// The Genspark route is opt-in in this fork — cloud tools default OFF — so the
// fixture has to turn them on to reach it. `providers` must be present for the
// stored settings to be honoured at all: resolveAiSettings() early-returns the
// defaults when it is absent, which would drop the flag. With no BYOK media
// provider configured either, the tool still resolves to the Genspark path.
let SETTINGS: string

beforeEach(() => {
  gskGen.mockReset()
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-media-tools-'))
  SETTINGS = join(dir, 'ai-settings.json')
  writeFileSync(SETTINGS, JSON.stringify({ providers: {}, gskToolsEnabled: true }), 'utf8')
})

describe('generateImageTool transparentBackground (Genspark route)', () => {
  it('chains a fal-bria-rmbg pass over the generated image and returns the stripped URL', async () => {
    gskGen
      .mockResolvedValueOnce({ url: 'https://cdn/x/opaque.png', taskId: '1' })
      .mockResolvedValueOnce({ url: 'https://cdn/x/cutout.png', taskId: '2' })
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r).toEqual({ url: 'https://cdn/x/cutout.png' })
    expect(gskGen).toHaveBeenCalledTimes(2)
    expect(gskGen.mock.calls[1]![0]).toMatchObject({
      model: GSK_RMBG_MODEL,
      referenceImageUrls: ['https://cdn/x/opaque.png'],
    })
  })

  it('without the flag generation stays a single pass', async () => {
    gskGen.mockResolvedValueOnce({ url: 'https://cdn/x/opaque.png', taskId: '1' })
    const r = await generateImageTool(SETTINGS, { prompt: 'red podcast icon' })
    expect(r).toEqual({ url: 'https://cdn/x/opaque.png' })
    expect(gskGen).toHaveBeenCalledTimes(1)
  })

  it('does not chain when the caller already runs the background-removal model', async () => {
    gskGen.mockResolvedValueOnce({ url: 'https://cdn/x/cutout.png', taskId: '1' })
    const r = await generateImageTool(SETTINGS, {
      prompt: 'remove background',
      model: GSK_RMBG_MODEL,
      referenceImageUrls: ['https://cdn/x/src.png'],
      transparentBackground: true,
    })
    expect(r).toEqual({ url: 'https://cdn/x/cutout.png' })
    expect(gskGen).toHaveBeenCalledTimes(1)
  })

  it('falls back to the opaque image when the strip pass fails', async () => {
    gskGen
      .mockResolvedValueOnce({ url: 'https://cdn/x/opaque.png', taskId: '1' })
      .mockRejectedValueOnce(new Error('rmbg down'))
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r).toEqual({ url: 'https://cdn/x/opaque.png' })
  })

  it('a generation failure still surfaces as an error (no half-run chain)', async () => {
    gskGen.mockRejectedValueOnce(new Error('quota exceeded'))
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r).toEqual({ error: 'quota exceeded' })
    expect(gskGen).toHaveBeenCalledTimes(1)
  })
})
