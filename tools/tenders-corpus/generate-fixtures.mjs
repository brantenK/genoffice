// Regenerate the committed gold annotations (and, with --pdf, the PDF bytes)
// for the synthetic Tenders intake corpus.
//
//   node tools/tenders-corpus/generate-fixtures.mjs          # gold JSON only
//   node tools/tenders-corpus/generate-fixtures.mjs --pdf    # also write PDFs
//
// The test harness builds the same PDFs in memory, so the committed PDFs are
// only for human inspection; the committed gold JSON (with a content hash) is
// what proves the fixtures are stable and reproducible.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import prettier from 'prettier'
import { CORPUS } from './corpus.mjs'
import { buildFixturePdf } from './generate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, '..', '..', 'apps', 'tenders', 'tests', 'fixtures', 'tenders-corpus')
const goldDir = join(corpusDir, 'gold')
const pdfDir = join(corpusDir, 'pdf')

const writePdf = process.argv.includes('--pdf')

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/** Write Prettier-formatted JSON so generated fixtures stay format-clean. */
async function writeJson(targetPath, value) {
  const options = (await prettier.resolveConfig(targetPath)) ?? {}
  const formatted = await prettier.format(JSON.stringify(value), {
    ...options,
    filepath: targetPath,
  })
  await writeFile(targetPath, formatted, 'utf8')
}

async function main() {
  await mkdir(goldDir, { recursive: true })
  if (writePdf) await mkdir(pdfDir, { recursive: true })

  const manifest = {
    corpusKind: 'synthetic',
    fixtureCount: CORPUS.length,
    fixtures: [],
  }

  for (const fixture of CORPUS) {
    const id = fixture.gold.id
    const bytes = await buildFixturePdf(fixture)
    const hash = sha256(bytes)
    const gold = {
      ...fixture.gold,
      pdfSha256: hash,
      pdfBytes: bytes.length,
    }
    await writeJson(join(goldDir, `${id}.json`), gold)
    if (writePdf) {
      await writeFile(join(pdfDir, `${id}.pdf`), Buffer.from(bytes))
    }
    manifest.fixtures.push({
      id,
      sector: fixture.gold.sector,
      issuerType: fixture.gold.issuerType,
      tags: fixture.gold.tags,
      pageCount: fixture.pages.length,
      scannedPages: fixture.gold.scannedPages,
      pdfSha256: hash,
    })
  }

  await writeJson(join(corpusDir, 'manifest.json'), manifest)
  // eslint-disable-next-line no-console
  console.log(`Wrote ${CORPUS.length} gold annotations to ${goldDir}`)
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
