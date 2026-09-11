import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const builderConfig = readFileSync(join(__dirname, '../electron-builder.cjs'), 'utf8')

const MODULES = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'crm', 'tenders', 'books']

function between(start: string, end: string): string {
  const startIndex = builderConfig.indexOf(start)
  const endIndex = builderConfig.indexOf(end, startIndex)
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing config section: ${start}`)
  return builderConfig.slice(startIndex, endIndex)
}

describe('packaged module trees', () => {
  const validation = between('function assertModuleTreesPresent()', '/** @type')
  const resources = between('extraResources: [', '// PDF text editing engines')

  it.each(MODULES)('validates the %s module output before packaging', (name) => {
    expect(validation).toContain(`'../${name}/out'`)
  })

  it.each(MODULES)('copies the %s module output into the package', (name) => {
    expect(resources).toContain(`from: '../${name}/out'`)
    expect(resources).toContain(`to: 'modules/${name}'`)
  })
})
