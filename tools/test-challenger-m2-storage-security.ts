#!/usr/bin/env node
/**
 * tools/test-challenger-m2-storage-security.ts
 *
 * Empirical Adversarial Challenger Test Suite for Milestone 2:
 * Persistent Disk Storage for RFP Documents & Vault Returnables (R2)
 *
 * Scope & Attack Dimensions:
 * 1. Malicious path traversal attacks (relative `..`, absolute Windows paths,
 *    UNC shares, null bytes `\0`, directory escape via fileName and storedPath,
 *    NTFS ADS, double extensions, case variations).
 * 2. High-concurrency read/write stress, race condition resilience,
 *    same-millisecond duplicate filename collision behavior, and read-during-write integrity.
 * 3. Boundary & edge-case files: 0-byte empty files, large buffers (10MB-25MB),
 *    non-PDF binary payloads, filenames with spaces, unicode, Windows reserved device names.
 * 4. Idempotent deletion, missing file handling, and malformed payload fuzzing.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import Module from 'node:module'

// ----------------------------------------------------------------------------
// Test Reporting & Metrics Infrastructure
// ----------------------------------------------------------------------------
interface TestMetric {
  category: string
  metric: string
  value: string | number
  passed: boolean
}

let totalTests = 0
let passedTests = 0
let failedTests = 0
const failureDetails: Array<{ name: string; error: string }> = []
const metricsList: TestMetric[] = []

function assert(condition: any, testName: string, detail?: string) {
  totalTests++
  if (!condition) {
    failedTests++
    const msg = detail ? `${testName} — ${detail}` : testName
    failureDetails.push({ name: testName, error: detail || 'Assertion failed' })
    console.error(`  ❌ FAIL: ${msg}`)
  } else {
    passedTests++
    console.log(`  ✅ PASS: ${testName}`)
  }
}

function recordMetric(category: string, metric: string, value: string | number, passed: boolean = true) {
  metricsList.push({ category, metric, value, passed })
  console.log(`     📊 METRIC [${category}]: ${metric} = ${value}`)
}

// ----------------------------------------------------------------------------
// Sandbox Setup & Electron Mocking
// ----------------------------------------------------------------------------
const testSandboxDir = join(tmpdir(), `challenger-m2-storage-${randomUUID().slice(0, 8)}`)
mkdirSync(testSandboxDir, { recursive: true })

const openedPaths: string[] = []
const ipcHandlers: Record<string, (...args: any[]) => any> = {}

const mockApp = {
  getPath: (name: string) => {
    if (name === 'userData') return testSandboxDir
    return testSandboxDir
  },
  isReady: () => true,
}

const mockShell = {
  openPath: async (targetPath: string) => {
    openedPaths.push(targetPath)
    if (existsSync(targetPath)) return ''
    return 'Failed to open file: does not exist'
  },
}

const mockIpcMain = {
  handle: (channel: string, listener: (...args: any[]) => any) => {
    ipcHandlers[channel] = listener
  },
}

class MockWebContentsView {
  webContents = {
    isDestroyed: () => false,
    send: (_channel: string, ..._args: any[]) => {},
    loadURL: async () => {},
    loadFile: async () => {},
    once: (_event: string, _fn: () => void) => {},
  }
}

// Intercept 'electron' require
const origRequire = (Module.prototype as any).require
;(Module.prototype as any).require = function (id: string) {
  if (id === 'electron') {
    return {
      app: mockApp,
      shell: mockShell,
      ipcMain: mockIpcMain,
      WebContentsView: MockWebContentsView,
    }
  }
  return origRequire.apply(this, arguments)
}

// ----------------------------------------------------------------------------
// Load Tenders Modules
// ----------------------------------------------------------------------------
const tendersMain = require('../apps/tenders/src/main/tenders-main.ts')
const {
  getTendersBaseDir,
  getTendersDocumentsDir,
  getTendersVaultDir,
  resolveSafeTendersPath,
  saveDocumentFile,
  readDocumentFile,
  openDocumentFile,
  deleteDocumentFile,
  registerTendersIpc,
  stopTendersStoreWatcher,
  writeTendersStore,
  readTendersStore,
} = tendersMain

const tendersIpc = require('../apps/tenders/src/shared/ipc.ts')
const { TENDERS_CHANNELS } = tendersIpc

function sha256(buf: Buffer | ArrayBuffer): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return createHash('sha256').update(b).digest('hex')
}

// ----------------------------------------------------------------------------
// Test Execution Runner
// ----------------------------------------------------------------------------
async function runChallengerTestSuite() {
  const startTime = Date.now()
  console.log('======================================================================')
  console.log('   EMPIRICAL ADVERSARIAL CHALLENGER: M2 STORAGE SECURITY & STRESS    ')
  console.log('======================================================================')
  console.log(`Sandbox directory: ${testSandboxDir}\n`)

  try {
    // Register IPC handlers
    registerTendersIpc()

    const baseDir = getTendersBaseDir()
    const docsDir = getTendersDocumentsDir()
    const vaultDir = getTendersVaultDir()

    // Create a mock tenders-data.json so we can test attempts to overwrite or delete it
    const sensitiveStorePath = join(baseDir, 'tenders-data.json')
    writeTendersStore(baseDir, {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeCompanyId: 'seed-co',
      workspaces: [],
    })
    assert(existsSync(sensitiveStorePath), 'Sensitive database file initialized for tamper testing')

    // ========================================================================
    // SECTION 1: Malicious Path Traversal Attacks & Sandbox Escapes
    // ========================================================================
    console.log('\n--- SECTION 1: Malicious Path Traversal Attacks & Sandbox Escapes ---')

    // 1.1 Sandbox Escape Paths: Paths attempting to navigate outside documents/ or vault/
    const escapingStoredPaths = [
      // Relative traversal
      '../../etc/passwd',
      '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
      'documents/../../tenders-data.json',
      'vault/../../tenders-data.json',
      'documents/../tenders-data.json',
      'vault/../tenders-data.json',
      'documents/..\\tenders-data.json',
      'vault/..\\tenders-data.json',
      'documents/nested/../../tenders-data.json',
      'documents/nested/../../../../etc/passwd',
      'documents/../../../secret.txt',
      'vault/../../../etc/shadow',
      'documents/..',
      'vault/..',
      'documents/.',
      'vault/.',
      '.',
      '..',
      '/',
      '\\',
      'documents/',
      'vault/',
      'documents\\',
      'vault\\',
      'documents/sub/../../..',
      // Absolute Windows paths
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'C:/Windows/System32/calc.exe',
      'D:\\sensitive\\keys.pem',
      '\\Windows\\System32\\cmd.exe',
      '/Windows/System32/cmd.exe',
      '/etc/passwd',
      // UNC paths
      '\\\\localhost\\c$\\Windows\\System32\\cmd.exe',
      '\\\\127.0.0.1\\c$\\secret.txt',
      '//evil-server/share/payload.exe',
      '\\\\?\\C:\\Windows\\System32\\cmd.exe',
      // Null byte injection
      'documents/valid.pdf\0../../etc/passwd',
      'vault/doc.pdf\0.exe',
      '\0documents/test.pdf',
      'documents/\0/test.pdf',
    ]

    let traversalBlocks = 0
    for (const badPath of escapingStoredPaths) {
      // 1. Check resolveSafeTendersPath directly
      const resolved = resolveSafeTendersPath(badPath)
      assert(resolved.safe === false, `resolveSafeTendersPath rejected: "${badPath.replace(/\0/g, '\\0')}"`)

      // 2. Check readDocumentFile rejection
      const readRes = await readDocumentFile({ storedPath: badPath })
      assert(readRes.ok === false, `readDocumentFile rejected traversal: "${badPath.replace(/\0/g, '\\0')}"`)

      // 3. Check openDocumentFile rejection
      const openRes = await openDocumentFile({ storedPath: badPath })
      assert(openRes.ok === false, `openDocumentFile rejected traversal: "${badPath.replace(/\0/g, '\\0')}"`)

      // 4. Check deleteDocumentFile rejection
      const delRes = await deleteDocumentFile({ storedPath: badPath })
      assert(delRes.ok === false, `deleteDocumentFile rejected traversal: "${badPath.replace(/\0/g, '\\0')}"`)

      traversalBlocks += 4
    }
    recordMetric('Security', 'Malicious escaping attack vectors tested', escapingStoredPaths.length)
    recordMetric('Security', 'Total traversal operations blocked', traversalBlocks)

    // Ensure sensitive store was never deleted or corrupted by any traversal delete attempt
    assert(existsSync(sensitiveStorePath), 'Sensitive database file remains untouched and safe')

    // 1.2 In-Sandbox Pseudo-Traversal: verify they CANNOT read external system files
    console.log('\n--- Pseudo-Traversal Testing (Cannot Reach External Files) ---')
    const pseudoTraversalPaths = [
      'documents/....//....//etc/passwd',
      'documents/.. /test.pdf',
      'documents/.../.../passwd',
    ]
    for (const pseudoPath of pseudoTraversalPaths) {
      const readRes = await readDocumentFile({ storedPath: pseudoPath })
      assert(readRes.ok === false, `readDocumentFile prevented reading external file via "${pseudoPath}"`)
      assert(readRes.error === 'File not found on disk', `Error explicitly states file not found: "${readRes.error}"`)
      const openRes = await openDocumentFile({ storedPath: pseudoPath })
      assert(openRes.ok === false, `openDocumentFile prevented opening external file via "${pseudoPath}"`)
    }

    // 1.3 Traversal attempts via fileName in saveDocumentFile
    console.log('\n--- Traversal Attempts in saveDocumentFile Filename ---')
    const maliciousFileNames = [
      '../../../../malicious.exe',
      '..\\..\\tenders-data.json',
      'C:\\Windows\\System32\\cmd.exe',
      '\\\\attacker-share\\evil.pdf',
      'documents/nested/sub.pdf',
      'vault/nested/sub.pdf',
      'documents\\nested\\sub.pdf',
      'evil.pdf\0.exe',
      'CON.pdf',
      'PRN.pdf',
      'AUX.pdf',
      'NUL.pdf',
      'COM1.pdf',
      'LPT1.pdf',
      'payload.pdf.exe',
      'exploit.pdf.bat',
      'script.pdf.ps1',
      'test.pdf:malicious.exe',
      'test.pdf::$DATA',
    ]

    let safeSaveSucceeded = 0
    for (const badFileName of maliciousFileNames) {
      const payloadBuf = Buffer.from(`Adversarial content for ${badFileName}`)
      const saveRes = await saveDocumentFile({
        fileName: badFileName,
        buffer: payloadBuf,
        category: 'rfp',
      })

      assert(saveRes.ok === true, `saveDocumentFile safely handled adversarial filename: "${badFileName.replace(/\0/g, '\\0')}"`)
      if (saveRes.ok && saveRes.storedPath) {
        safeSaveSucceeded++
        // Stored path must strictly start with "documents/"
        assert(saveRes.storedPath.startsWith('documents/'), `Stored path strictly confined to documents/: ${saveRes.storedPath}`)
        assert(!saveRes.storedPath.includes('..'), `Stored path contains no parent traversal tokens: ${saveRes.storedPath}`)
        assert(!saveRes.storedPath.includes('/nested/'), `Stored path contains no directory nesting: ${saveRes.storedPath}`)
        assert(!saveRes.storedPath.includes(':'), `Stored path stripped NTFS ADS colon: ${saveRes.storedPath}`)

        // File must physically exist inside docsDir
        const diskFile = join(baseDir, saveRes.storedPath)
        assert(existsSync(diskFile), `Sanitized file exists physically on disk: ${basename(diskFile)}`)
        assert(diskFile.startsWith(docsDir), `Sanitized file is strictly inside docsDir`)
      }
    }
    recordMetric('Security', 'Adversarial saveDocumentFile names sanitized', safeSaveSucceeded)

    // 1.4 Canonical Directory Casing Restrictions
    console.log('\n--- Canonical Directory Casing Restrictions ---')
    const caseDoc = await saveDocumentFile({
      fileName: 'case-test.pdf',
      buffer: Buffer.from('case sensitivity test content'),
      category: 'rfp',
    })
    assert(caseDoc.ok === true && !!caseDoc.storedPath, 'Base document saved for case testing')
    if (caseDoc.storedPath) {
      const upperPath = caseDoc.storedPath.replace('documents/', 'DOCUMENTS/')
      const mixedPath = caseDoc.storedPath.replace('documents/', 'Documents/')
      const upperCheck = resolveSafeTendersPath(upperPath)
      const mixedCheck = resolveSafeTendersPath(mixedPath)
      // Canonical prefix requires lowercase 'documents/'
      assert(upperCheck.safe === false, 'Uppercase directory storedPath rejected by strict canonical check')
      assert(mixedCheck.safe === false, 'Mixed-case directory storedPath rejected by strict canonical check')
      recordMetric('Security', 'Strict canonical lowercase directory enforced', true)
    }

    // ========================================================================
    // SECTION 2: Concurrent Read/Write & Race Condition Stress
    // ========================================================================
    console.log('\n--- SECTION 2: Concurrent Read/Write & Race Condition Stress ---')

    // 2.1 High-concurrency simultaneous writes (50 parallel saves)
    console.log('\n* Test 2.1: 50 Simultaneous Parallel Writes (Unique Files)')
    const CONCURRENT_WRITES = 50
    const writePromises: Array<Promise<any>> = []
    const writeStart = Date.now()

    for (let i = 0; i < CONCURRENT_WRITES; i++) {
      const buf = randomBytes(1024 * 16) // 16 KB random binary
      writePromises.push(
        saveDocumentFile({
          fileName: `parallel-doc-${i}.pdf`,
          buffer: buf,
          category: i % 2 === 0 ? 'rfp' : 'vault',
        }).then((res) => ({ index: i, res, hash: sha256(buf) }))
      )
    }

    const writeResults = await Promise.all(writePromises)
    const writeElapsed = Date.now() - writeStart
    const allWritesOk = writeResults.every((r) => r.res.ok === true && typeof r.res.storedPath === 'string')
    assert(allWritesOk, `All ${CONCURRENT_WRITES} parallel writes succeeded without errors`)
    recordMetric('Concurrency', '50 Parallel Writes Time (ms)', writeElapsed)
    recordMetric('Concurrency', 'Parallel Write Throughput (ops/sec)', Math.round((CONCURRENT_WRITES / (writeElapsed / 1000))))

    // Verify all 50 files physically exist with intact SHA-256 hashes
    let hashVerifications = 0
    for (const item of writeResults) {
      const diskPath = join(baseDir, item.res.storedPath)
      if (existsSync(diskPath)) {
        const diskBytes = readFileSync(diskPath)
        if (sha256(diskBytes) === item.hash) {
          hashVerifications++
        }
      }
    }
    assert(hashVerifications === CONCURRENT_WRITES, `100% of parallel files (${hashVerifications}/${CONCURRENT_WRITES}) verified with matching SHA-256`)

    // 2.2 Same-millisecond identical-filename stress (20 parallel saves of SAME filename)
    console.log('\n* Test 2.2: Same-Millisecond Identical-Filename Stress (20 calls)')
    const DUPLICATE_COUNT = 20
    const dupPromises: Array<Promise<any>> = []
    for (let i = 0; i < DUPLICATE_COUNT; i++) {
      const buf = Buffer.from(`Duplicate buffer payload index ${i}`)
      dupPromises.push(
        saveDocumentFile({
          fileName: 'duplicate-stress.pdf',
          buffer: buf,
          category: 'rfp',
        })
      )
    }
    const dupResults = await Promise.all(dupPromises)
    const dupSuccesses = dupResults.filter((r) => r.ok === true)
    assert(dupSuccesses.length === DUPLICATE_COUNT, `All ${DUPLICATE_COUNT} concurrent duplicate saves succeeded without unhandled crash`)
    const distinctPaths = new Set(dupResults.map((r) => r.storedPath))
    recordMetric('Concurrency', 'Duplicate saves total count', DUPLICATE_COUNT)
    recordMetric('Concurrency', 'Distinct timestamped paths generated', distinctPaths.size)

    // 2.3 Concurrent Read-During-Write Stress
    console.log('\n* Test 2.3: Concurrent Read-During-Write Stress')
    // Pick 10 files from writeResults to read while saving 10 new heavy files
    const targetsToRead = writeResults.slice(0, 10).map((w) => ({ path: w.res.storedPath, hash: w.hash }))
    const mixedOps: Array<Promise<any>> = []

    // 10 concurrent reads
    for (const target of targetsToRead) {
      mixedOps.push(
        readDocumentFile({ storedPath: target.path }).then((r) => {
          assert(r.ok === true && !!r.buffer, `Concurrent read succeeded for ${basename(target.path)}`)
          if (r.buffer) {
            assert(sha256(r.buffer) === target.hash, `Data integrity verified during concurrent read for ${basename(target.path)}`)
          }
          return r
        })
      )
    }

    // 10 concurrent writes of 1 MB files
    for (let j = 0; j < 10; j++) {
      const heavyBuf = randomBytes(1024 * 1024) // 1 MB
      mixedOps.push(
        saveDocumentFile({
          fileName: `heavy-concurrent-${j}.pdf`,
          buffer: heavyBuf,
          category: 'vault',
        }).then((r) => {
          assert(r.ok === true, `Concurrent heavy write #${j} succeeded`)
          return r
        })
      )
    }

    await Promise.all(mixedOps)
    recordMetric('Concurrency', 'Concurrent read/write mixed ops count', mixedOps.length)

    // 2.4 Concurrent Read & Delete Race
    console.log('\n* Test 2.4: Concurrent Read & Delete Race on 10 Files')
    for (let k = 0; k < 10; k++) {
      const tmpDoc = await saveDocumentFile({
        fileName: `race-${k}.pdf`,
        buffer: Buffer.from(`Race content ${k}`),
        category: 'rfp',
      })
      const p = tmpDoc.storedPath!
      // Concurrently read and delete the exact same file
      const [readOutcome, deleteOutcome] = await Promise.all([
        readDocumentFile({ storedPath: p }),
        deleteDocumentFile({ storedPath: p }),
      ])
      // Neither should throw an unhandled exception
      assert(typeof readOutcome.ok === 'boolean', `Race read returned valid boolean ok (${readOutcome.ok})`)
      assert(typeof deleteOutcome.ok === 'boolean', `Race delete returned valid boolean ok (${deleteOutcome.ok})`)
      // File should eventually not exist
      assert(!existsSync(join(baseDir, p)), `File cleanly removed after race delete: ${basename(p)}`)
    }

    // ========================================================================
    // SECTION 3: Boundary & Edge-Case Files
    // ========================================================================
    console.log('\n--- SECTION 3: Boundary & Edge-Case Files ---')

    // 3.1 0-Byte (Empty) File
    console.log('\n* Test 3.1: 0-Byte Empty File')
    const zeroByteBuf = Buffer.alloc(0)
    const zeroByteSave = await saveDocumentFile({
      fileName: 'zero-byte-document.pdf',
      buffer: zeroByteBuf,
      category: 'rfp',
    })
    assert(zeroByteSave.ok === true && !!zeroByteSave.storedPath, '0-byte file saved successfully')
    if (zeroByteSave.storedPath) {
      const zeroRead = await readDocumentFile({ storedPath: zeroByteSave.storedPath })
      assert(zeroRead.ok === true, '0-byte file read back successfully')
      assert(zeroRead.buffer !== undefined && zeroRead.buffer.byteLength === 0, '0-byte file byteLength is exactly 0')
      const zeroDel = await deleteDocumentFile({ storedPath: zeroByteSave.storedPath })
      assert(zeroDel.ok === true, '0-byte file deleted cleanly')
    }

    // 3.2 Very Large Buffers (10 MB and 25 MB)
    console.log('\n* Test 3.2: Large Buffers (10 MB and 25 MB)')
    const tenMbSize = 10 * 1024 * 1024 // 10 MB
    console.log('     Generating 10 MB buffer...')
    const tenMbBuf = randomBytes(tenMbSize)
    const tenMbHash = sha256(tenMbBuf)

    const tenMbStart = Date.now()
    const tenMbSave = await saveDocumentFile({
      fileName: 'municipal-tender-10mb.pdf',
      buffer: tenMbBuf,
      category: 'rfp',
    })
    const tenMbSaveElapsed = Date.now() - tenMbStart
    assert(tenMbSave.ok === true && !!tenMbSave.storedPath, '10 MB file saved successfully')
    recordMetric('Performance', '10 MB Save Time (ms)', tenMbSaveElapsed)

    if (tenMbSave.storedPath) {
      const tenMbReadStart = Date.now()
      const tenMbRead = await readDocumentFile({ storedPath: tenMbSave.storedPath })
      const tenMbReadElapsed = Date.now() - tenMbReadStart
      assert(tenMbRead.ok === true && !!tenMbRead.buffer, '10 MB file read back successfully')
      assert(tenMbRead.buffer?.byteLength === tenMbSize, '10 MB file byteLength matches exactly 10,485,760 bytes')
      assert(sha256(tenMbRead.buffer!) === tenMbHash, '10 MB file SHA-256 matches byte-for-byte')
      recordMetric('Performance', '10 MB Read Time (ms)', tenMbReadElapsed)

      // Clean up 10 MB file
      await deleteDocumentFile({ storedPath: tenMbSave.storedPath })
    }

    // 25 MB file stress
    console.log('     Generating 25 MB buffer...')
    const twentyFiveMbSize = 25 * 1024 * 1024 // 25 MB
    const twentyFiveMbBuf = randomBytes(twentyFiveMbSize)
    const twentyFiveMbHash = sha256(twentyFiveMbBuf)

    const twentyFiveStart = Date.now()
    const twentyFiveSave = await saveDocumentFile({
      fileName: 'large-blueprint-25mb.pdf',
      buffer: twentyFiveMbBuf,
      category: 'rfp',
    })
    const twentyFiveSaveElapsed = Date.now() - twentyFiveStart
    assert(twentyFiveSave.ok === true && !!twentyFiveSave.storedPath, '25 MB large buffer saved successfully')
    recordMetric('Performance', '25 MB Save Time (ms)', twentyFiveSaveElapsed)

    if (twentyFiveSave.storedPath) {
      const twentyFiveRead = await readDocumentFile({ storedPath: twentyFiveSave.storedPath })
      assert(twentyFiveRead.ok === true && !!twentyFiveRead.buffer, '25 MB file read successfully')
      assert(twentyFiveRead.buffer?.byteLength === twentyFiveMbSize, '25 MB file byteLength matches 26,214,400 bytes')
      assert(sha256(twentyFiveRead.buffer!) === twentyFiveMbHash, '25 MB file SHA-256 matches byte-for-byte')
      await deleteDocumentFile({ storedPath: twentyFiveSave.storedPath })
    }

    // 3.3 Raw Binary Non-PDF Files (All byte values 0x00 to 0xFF, ZIP, PNG)
    console.log('\n* Test 3.3: Raw Binary Non-PDF Files (All byte values, ZIP, PNG)')
    const allBytes = Buffer.alloc(256 * 256)
    for (let i = 0; i < allBytes.length; i++) {
      allBytes[i] = i % 256
    }
    const allBytesHash = sha256(allBytes)
    const binSave = await saveDocumentFile({
      fileName: 'raw-binary-test.bin',
      buffer: allBytes,
      category: 'vault',
    })
    assert(binSave.ok === true && !!binSave.storedPath, 'Raw binary file saved successfully')
    if (binSave.storedPath) {
      const binRead = await readDocumentFile({ storedPath: binSave.storedPath })
      assert(binRead.ok === true && !!binRead.buffer, 'Raw binary file read back successfully')
      assert(sha256(binRead.buffer!) === allBytesHash, 'Raw binary file byte integrity preserved across 0x00..0xFF values')
      await deleteDocumentFile({ storedPath: binSave.storedPath })
    }

    // Emulated ZIP file header
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])
    const zipSave = await saveDocumentFile({
      fileName: 'specifications.zip',
      buffer: zipHeader,
      category: 'vault',
    })
    assert(zipSave.ok === true && !!zipSave.storedPath, 'ZIP archive binary saved successfully')
    if (zipSave.storedPath) {
      const zipRead = await readDocumentFile({ storedPath: zipSave.storedPath })
      assert(zipRead.ok === true && Buffer.from(zipRead.buffer!).equals(zipHeader), 'ZIP header preserved intact')
      await deleteDocumentFile({ storedPath: zipSave.storedPath })
    }

    // 3.4 Filenames with Spaces, Unicode, Reserved Characters, and Punctuation
    console.log('\n* Test 3.4: Filenames with Spaces, Unicode, and Reserved Characters')
    const edgeFilenames = [
      'Final Tender Evaluation 2026 (Rev 2).pdf',
      '招标文件_2026年_水务工程.pdf',
      'Müntz_Straße_Angebote.pdf',
      'Tender_🇿🇦_Water_Infrastructure.pdf',
      'Document with multiple      spaces.pdf',
      '!@#$%^&*()_+={}[]|;<>?,~.pdf',
      'CON.pdf',
      'PRN.txt',
      'AUX.bin',
      'NUL.pdf',
      'COM1.dat',
      'LPT1.pdf',
      '   ', // Whitespace only -> should fallback to safe default
      '.',     // Dot only -> fallback
      '..',    // Dots only -> fallback
      '...',   // Triple dots -> fallback
    ]

    for (const name of edgeFilenames) {
      const testContent = Buffer.from(`Content for edge filename: ${name}`)
      const res = await saveDocumentFile({
        fileName: name,
        buffer: testContent,
        category: 'rfp',
      })
      assert(res.ok === true && typeof res.storedPath === 'string', `Handled edge filename safely: "${name}"`)
      if (res.ok && res.storedPath) {
        assert(res.storedPath.startsWith('documents/'), `Stored path is inside documents/: ${res.storedPath}`)
        const readBack = await readDocumentFile({ storedPath: res.storedPath })
        assert(readBack.ok === true && Buffer.from(readBack.buffer!).equals(testContent), `Read back matches for edge filename: "${name}"`)
        await deleteDocumentFile({ storedPath: res.storedPath })
      }
    }

    // Extremely long filename (300 chars)
    console.log('\n* Test 3.5: Extremely Long Filename (300 characters)')
    const longName = 'A'.repeat(290) + '.pdf'
    const longRes = await saveDocumentFile({
      fileName: longName,
      buffer: Buffer.from('long name test'),
      category: 'rfp',
    })
    assert(typeof longRes.ok === 'boolean', `Long filename returned valid response envelope (ok: ${longRes.ok})`)
    if (longRes.ok && longRes.storedPath) {
      await deleteDocumentFile({ storedPath: longRes.storedPath })
    }

    // ========================================================================
    // SECTION 4: Idempotent Deletion, Missing File Handling & Input Fuzzing
    // ========================================================================
    console.log('\n--- SECTION 4: Idempotent Deletion, Missing File Handling & Input Fuzzing ---')

    // 4.1 Idempotent Deletion
    console.log('\n* Test 4.1: Idempotent Deletion')
    const nonexistentPath = 'documents/1799999999999_nonexistent_file.pdf'
    const nonDelRes = await deleteDocumentFile({ storedPath: nonexistentPath })
    assert(nonDelRes.ok === true, 'Deleting non-existent file returns ok: true (idempotent)')

    // Double and triple deletion
    const multiDelDoc = await saveDocumentFile({
      fileName: 'multi-del.pdf',
      buffer: Buffer.from('multi delete test'),
      category: 'vault',
    })
    assert(multiDelDoc.ok === true && !!multiDelDoc.storedPath, 'Doc saved for multi-delete test')
    if (multiDelDoc.storedPath) {
      const del1 = await deleteDocumentFile({ storedPath: multiDelDoc.storedPath })
      assert(del1.ok === true, 'First deletion returns ok: true')
      const del2 = await deleteDocumentFile({ storedPath: multiDelDoc.storedPath })
      assert(del2.ok === true, 'Second deletion on already-deleted file returns ok: true (idempotent)')
      const del3 = await deleteDocumentFile({ storedPath: multiDelDoc.storedPath })
      assert(del3.ok === true, 'Third deletion on already-deleted file returns ok: true (idempotent)')
    }

    // 4.2 Missing File Handling in readDocumentFile and openDocumentFile
    console.log('\n* Test 4.2: Missing File Handling in Read & Open')
    const missingRead = await readDocumentFile({ storedPath: 'documents/1799999999999_ghost.pdf' })
    assert(missingRead.ok === false, 'Reading missing file returns ok: false')
    assert(missingRead.error === 'File not found on disk', `Descriptive error returned: "${missingRead.error}"`)

    const missingOpen = await openDocumentFile({ storedPath: 'documents/1799999999999_ghost.pdf' })
    assert(missingOpen.ok === false, 'Opening missing file returns ok: false')
    assert(missingOpen.error === 'File not found on disk', `Descriptive error returned: "${missingOpen.error}"`)

    // 4.3 Malformed Payload Fuzzing
    console.log('\n* Test 4.3: Malformed Payload Fuzzing')
    const malformedPayloads: any[] = [
      null,
      undefined,
      {},
      { fileName: 12345 },
      { fileName: '' },
      { fileName: 'valid.pdf' }, // missing buffer
      { fileName: 'valid.pdf', buffer: Buffer.from('x') }, // missing category
      { fileName: 'valid.pdf', buffer: Buffer.from('x'), category: 'invalidCategory' },
      { fileName: 'valid.pdf', buffer: Buffer.from('x'), category: 'invoices' },
      { fileName: 'valid.pdf', buffer: Buffer.from('x'), category: 'taxes' },
    ]

    for (const badPayload of malformedPayloads) {
      const res = await saveDocumentFile(badPayload)
      assert(res.ok === false, `Malformed saveDocument payload safely rejected: ${JSON.stringify(badPayload)}`)
      assert(typeof res.error === 'string' && res.error.length > 0, `Error message provided: "${res.error}"`)
    }

    const malformedReadPayloads: any[] = [
      null,
      undefined,
      {},
      { storedPath: '' },
      { storedPath: 99999 },
      { storedPath: null },
    ]

    for (const badRead of malformedReadPayloads) {
      const res = await readDocumentFile(badRead)
      assert(res.ok === false, `Malformed readDocument payload safely rejected: ${JSON.stringify(badRead)}`)
    }

    for (const badOpen of malformedReadPayloads) {
      const res = await openDocumentFile(badOpen)
      assert(res.ok === false, `Malformed openDocument payload safely rejected: ${JSON.stringify(badOpen)}`)
    }

    for (const badDel of malformedReadPayloads) {
      const res = await deleteDocumentFile(badDel)
      assert(res.ok === false, `Malformed deleteDocument payload safely rejected: ${JSON.stringify(badDel)}`)
    }

  } finally {
    // Teardown and cleanup
    stopTendersStoreWatcher()
    try {
      if (existsSync(testSandboxDir)) {
        rmSync(testSandboxDir, { recursive: true, force: true })
      }
    } catch {}
  }

  // --------------------------------------------------------------------------
  // Summary & Certification
  // --------------------------------------------------------------------------
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2)
  console.log('\n======================================================================')
  console.log('                     EMPIRICAL CHALLENGE REPORT                       ')
  console.log('======================================================================')
  console.log(`Duration: ${durationSec}s`)
  console.log(`Total Assertions: ${totalTests}`)
  console.log(`Passed: ${passedTests}`)
  console.log(`Failed: ${failedTests}`)
  console.log('----------------------------------------------------------------------')
  console.log('Key Empirical Metrics:')
  for (const m of metricsList) {
    console.log(`  - [${m.category}] ${m.metric}: ${m.value} (${m.passed ? 'PASSED' : 'FLAGGED'})`)
  }
  console.log('----------------------------------------------------------------------')

  if (failedTests > 0) {
    console.error(`\n🚨 CHALLENGE FAILED: ${failedTests} assertion(s) failed!`)
    for (const f of failureDetails) {
      console.error(`  - ${f.name}: ${f.error}`)
    }
    process.exit(1)
  } else {
    console.log('\n🏆 ALL ADVERSARIAL STRESS TESTS AND SECURITY CHALLENGES PASSED!')
    console.log('CERTIFICATION: APPROVE (Milestone 2 Persistent Disk Storage is resilient & secure)')
    process.exit(0)
  }
}

runChallengerTestSuite().catch((err) => {
  console.error('Fatal crash in challenger test harness:', err)
  process.exit(1)
})
