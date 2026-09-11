import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type RootPackage = {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}

const rootPackagePath = join(__dirname, '../../../package.json')
const booksViteConfigPath = join(__dirname, '../../books/vite.renderer.config.ts')

function readRootPackage(): RootPackage {
  return JSON.parse(readFileSync(rootPackagePath, 'utf8')) as RootPackage
}

describe('root development launcher', () => {
  it('keeps the renderer topology and launches the shell with cross-platform environment variables', () => {
    const rootPackage = readRootPackage()
    const dev = rootPackage.scripts?.dev
    const rendererCommands = [
      'npm run dev:renderer -w @genoffice/docs',
      'npm run dev:renderer -w @genoffice/sheets',
      'npm run dev:renderer -w @genoffice/slides',
      'npm run dev:renderer -w @genoffice/pdf',
      'npm run dev:renderer -w @genoffice/markdown',
      'npm run dev:renderer -w @genoffice/crm',
      'npm run dev:renderer -w @genoffice/tenders',
      'npm run dev:renderer -w @genoffice/books',
      'npm run dev:renderer -w @genoffice/html',
    ]
    const shellCommand =
      'cross-env DOCS_RENDERER_URL=http://localhost:5173 SHEETS_RENDERER_URL=http://localhost:5174 SLIDES_RENDERER_URL=http://localhost:5175 PDF_RENDERER_URL=http://localhost:5176 MARKDOWN_RENDERER_URL=http://localhost:5177 CRM_RENDERER_URL=http://localhost:5178 TENDERS_RENDERER_URL=http://localhost:5179 BOOKS_RENDERER_URL=http://localhost:5180 HTML_RENDERER_URL=http://localhost:5181 npm run dev -w @genoffice/shell'

    expect(dev).toBeDefined()
    expect(dev).toMatch(
      /^concurrently -k -n docs,sheets,slides,pdf,markdown,crm,tenders,books,html,shell -c blue,green,yellow,red,cyan,purple,orange,teal,white,magenta /,
    )

    const childCommands = [...dev!.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(childCommands).toEqual([...rendererCommands, shellCommand])
    for (const rendererCommand of rendererCommands) {
      expect(childCommands.filter((command) => command === rendererCommand)).toHaveLength(1)
    }
    expect(rootPackage.devDependencies?.['cross-env']).toEqual(expect.any(String))
  })

  it('reserves the books renderer port instead of falling back to another port', () => {
    const booksViteConfig = readFileSync(booksViteConfigPath, 'utf8')

    expect(booksViteConfig).toMatch(
      /server:\s*\{[\s\S]*?port:\s*5180\b[\s\S]*?strictPort:\s*true\b[\s\S]*?\}/,
    )
  })
})
