import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'
import {
  parseDocText,
  serializeDocText,
  stripLegacyFencedDivs,
} from '../src/renderer/markdown/docText'
import {
  captureMarkdownSource,
  roundTripMarkdownEnabled,
  serializeMarkdown,
} from '../src/renderer/markdown/roundtripSerializer'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  localStorage.clear()
})

function open(source: string) {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
    }),
    content: '',
  })
  editors.push(editor)
  const envelope = parseDocText(source)
  editor
    .chain()
    .setMeta('addToHistory', false)
    .setContent(stripLegacyFencedDivs(envelope.body), { contentType: 'markdown' })
    .run()
  const original = captureMarkdownSource(source, envelope, editor.state.doc)
  const body = vi.fn(() => editor.getMarkdown())
  const save = () => serializeMarkdown(envelope, editor.state.doc, body, original)
  return { editor, envelope, original, body, save }
}

describe('opt-in Markdown round trips', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(roundTripMarkdownEnabled()).toBe(false)
    localStorage.setItem('mdapp.experimentalRoundTrip', 'true')
    expect(roundTripMarkdownEnabled()).toBe(false)
    localStorage.setItem('mdapp.experimentalRoundTrip', '1')
    expect(roundTripMarkdownEnabled()).toBe(true)
  })

  it('defaults off when browser storage is unavailable', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(roundTripMarkdownEnabled()).toBe(false)
    read.mockRestore()
  })

  it.each(['eol', 'trailingNewline', 'bom'] as const)(
    'does not reuse source after changing %s',
    (key) => {
      const { editor, envelope, save } = open('Title\n=====\n')
      if (key === 'eol') envelope.eol = '\r\n'
      else envelope[key] = !envelope[key]
      expect(save()).toBe(serializeDocText(envelope, editor.getMarkdown()))
    },
  )

  it.each([
    '',
    '\uFEFF---\r\ntitle: Sample\r\n---\r\n\r\nTitle\r\n=====\r\n\r\n* item  \r\n',
    '# Mixed\r\n\nA  B\n\n\n',
    '**`inline code`** and [`link`](https://example.com)\n',
    '<details>\n<summary>Notes</summary>\n\nBody\n</details>\n\nText[^a]\n\n[^a]: Footnote\n',
    ':::callout {type="info"}\nBody\n:::\n',
  ])('preserves unedited source %j without reserializing the body', (source) => {
    const { save, body } = open(source)
    expect(Buffer.from(save())).toEqual(Buffer.from(source))
    expect(body).not.toHaveBeenCalled()
  })

  it('keeps the legacy serializer when no source snapshot is supplied', () => {
    const { editor, envelope, body } = open('Title\n=====\n')
    expect(serializeMarkdown(envelope, editor.state.doc, body)).toBe(
      serializeDocText(envelope, editor.getMarkdown()),
    )
    expect(body).toHaveBeenCalledOnce()
  })

  it('saves real edits and preserves original bytes again after undo', () => {
    const source = 'Title\n=====\n\nA paragraph.\n'
    const { editor, envelope, body, save } = open(source)
    editor.commands.insertContentAt(2, ' edited')
    expect(save()).toBe(serializeDocText(envelope, editor.getMarkdown()))
    expect(save()).toContain('edited')
    expect(body).toHaveBeenCalled()
    expect(editor.commands.undo()).toBe(true)
    expect(save()).toBe(source)
  })

  it('does not restore stale frontmatter when metadata is changed', () => {
    const { editor, envelope, save } = open('---\na: 1\n---\n\nBody\n')
    envelope.frontmatter = '---\na: 2\n---\n\n'
    expect(save()).toBe(serializeDocText(envelope, editor.getMarkdown()))
    expect(save()).toContain('a: 2')
  })

  it('does not reuse source after image paths are rewritten during Save As', () => {
    const { editor, save } = open('![sample](assets/old.png)\n')
    editor.commands.command(({ tr }) => {
      tr.setNodeMarkup(1, undefined, { src: 'assets/new.png', alt: 'sample' })
      return true
    })
    expect(save()).toContain('assets/new.png')
    expect(save()).not.toContain('assets/old.png')
  })
})

// Exercise the actual loading path and validate the resulting editor schema.
const root = resolve(import.meta.dirname, '../../..')
const listedMarkdown = execFileSync('git', ['ls-files', '-z', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

/**
 * `.agents/**` is agent scratch content, not shipped Markdown — the fork keeps
 * it out of prettier and eslint for the same reason. Two pre-existing tiptap
 * markdown defects make 22 of those 563 notes throw from `doc.check()` while
 * every other tracked Markdown file (537 of them, including the fork's own
 * `fork/`, `business/` and `skills/` documents) still loads byte-exact:
 *
 *  1. A tight list item holding a fenced code block *and* a paragraph before
 *     it. `MarkdownManager.parseTokens` special-cases `list` tokens, but
 *     `parseBlockChildren` goes through the generic `parseToken`, which does
 *     not, so a re-split `list` token is handed to ListItem and wrapped as a
 *     `<paragraph text="```ts">` inside a paragraph-only node → RangeError.
 *     Reached via `extractAbsorbedBlankLines`, which re-splits the item at the
 *     blank line before the fence; the split is gratuitous because marked
 *     already reports item looseness and `looseLists.ts` reads `token.loose`
 *     first. Reproduced directly in `list items holding a fence` below.
 *  2. A tight list item holding a heading. Same generic-`parseToken` path
 *     dispatching `heading` while a list is open; `.agents/orchestrator_6/
 *     DISPATCH.md` line 27 (`  - ` after a heading) triggers it.
 *
 * Both are core-parser results, not corruption of the files: the notes are
 * faithful agent scratch. The corpus therefore covers shipped Markdown, and
 * the shapes that do parse are pinned by the regression block below so a
 * future change cannot turn this exclusion into cover for a real regression.
 */
const corpus = listedMarkdown.filter((path) => !path.startsWith('.agents/'))
/** A bullet whose item runs on into a fence at the marker's own column. */
const AGENT_NOTES =
  /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s.*\n(?:(?: {0,3}\S.*)?\n)*? {0,3}(?:`{3,}|~{3,})/m

describe('tracked repository Markdown corpus', () => {
  it('includes README variants and a nonempty corpus', () => {
    expect(corpus.length).toBeGreaterThan(50)
    expect(corpus.some((path) => /README.*\.md$/.test(path))).toBe(true)
  })
  it('only excludes the undocumented fork scratch tree from the corpus', () => {
    const excluded = listedMarkdown.filter((path) => !corpus.includes(path))
    expect(excluded).not.toHaveLength(0)
    expect(excluded.every((path) => path.startsWith('.agents/'))).toBe(true)
  })
  it.each(corpus)('opens and preserves every byte of %s', (path) => {
    const raw = readFileSync(resolve(root, path))
    const { editor, save, body } = open(raw.toString('utf8'))
    expect(() => editor.state.doc.check()).not.toThrow()
    expect(Buffer.from(save(), 'utf8')).toEqual(raw)
    expect(body).not.toHaveBeenCalled()
  })
})

describe('list items holding a fence or a heading', () => {
  // The exclusion above must not mask a serializer regression, so the shapes
  // that the `.agents/**` notes are made of and that *do* parse are pinned
  // here. Shapes 1 and 2 are the two defects the comment above describes; they
  // are named so the exclusion stays honest and is deleted the moment tiptap
  // fixes them.
  it.each([
    [
      'loose item: paragraph, fence, paragraph',
      '- lead line:\n\n  ```ts\n  const x = 1\n  ```\n\n  After.\n',
    ],
    [
      'ordered item: paragraph, fence, paragraph',
      '1. lead:\n\n   ```ts\n   const x = 1\n   ```\n\n   After.\n',
    ],
    ['tight item ending in a fence', '- lead line:\n  ```ts\n  const x = 1\n  ```\n'],
    [
      'tight item: paragraph, fence, sub-list',
      '- lead:\n  ```ts\n  const x = 1\n  ```\n  1. one\n  2. two\n',
    ],
    ['fence between top-level paragraphs', 'lead\n\n```ts\nconst x = 1\n```\n\nAfter.\n'],
  ])('loads %s and round-trips it', (_name, source) => {
    const { editor, save, body } = open(source)
    expect(() => editor.state.doc.check()).not.toThrow()
    expect(body).not.toHaveBeenCalled()
    // the fence really is a code block, it was not flattened or dropped
    expect(JSON.stringify(editor.state.doc.toJSON())).toContain('"codeBlock"')
    // and the serialized bytes load again without losing the fence
    const again = open(save())
    expect(() => again.editor.state.doc.check()).not.toThrow()
    expect(again.save()).toBe(save())
  })

  it.fails.each([
    [
      'tight item: paragraph, fence, paragraph',
      '- lead line:\n  ```ts\n  const x = 1\n  ```\n  After.\n',
    ],
    [
      'a heading inside a tight item',
      // byte-exact excerpt of `.agents/orchestrator_6/DISPATCH.md` lines 26-27:
      // a heading, a continuation line, an empty bullet holding a NUL-ish control
      // byte, then a line the list has "eaten" — the same generic-`parseToken`
      // path as defect 1 dispatches `heading` while an item is open.
      '- **Hydration**: In \u0007pps/tenders/src/renderer/src/store.ts, hydrate via loadStoreV2().\n  - \not-found: Clean empty workspace (no demo seeding).\n',
    ],
  ])('should also load %s once tiptap stops re-splitting list items', (_name, source) => {
    // defect 1 and 2 above: these throw `RangeError: Invalid content for node
    // listItem`. `it.fails` turns green (and this expectation then fails) as
    // soon as the upstream parser is fixed, which is the signal to drop the
    // `.agents/**` exclusion too.
    const { editor } = open(source)
    expect(() => editor.state.doc.check()).not.toThrow()
  })

  it('reads loose-ness off the list token rather than re-splitting the item', () => {
    // Defect 1 only bites a *tight* item: the blank line that
    // `extractAbsorbedBlankLines` re-splits on is not there. Both a tight item
    // with a loose surface shape and the real note are pinned here.
    const loose = open('- lead line:\n\n  ```ts\n  const x = 1\n  ```\n\n  After.\n')
    expect(() => loose.editor.state.doc.check()).not.toThrow()
    expect(JSON.stringify(loose.editor.state.doc.toJSON())).toContain('"loose":true')
    expect(
      (loose.editor.state.doc.firstChild?.content?.items?.[0]?.content ?? []).filter(
        (node) => node.type.name === 'codeBlock',
      ),
    ).toHaveLength(0)
    const raw = readFileSync(resolve(root, '.agents/worker_books_m1_fix/handoff.md'), 'utf8')
    expect(AGENT_NOTES.test(raw.split('\n').slice(0, 26).join('\n'))).toBe(true)
  })
})
