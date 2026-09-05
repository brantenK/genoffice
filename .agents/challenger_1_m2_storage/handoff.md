# Empirical Challenger Report: Milestone 2 — Persistent Disk Storage for RFP Documents & Vault Returnables (R2)

**Challenger:** `challenger_1_m2_storage`  
**Milestone:** Milestone 2 (R2)  
**Date:** 2026-09-04  
**Target File:** `c:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\challenger_1_m2_storage\handoff.md`  
**Certification Status:** **APPROVE** (All 483 adversarial security, concurrency, edge-case, and idempotence assertions passed)

---

## 1. Observation

Direct empirical observations from source analysis, adversarial stress tests, and monorepo regression suites:

### 1.1 Source Code Inspection
- **`apps/tenders/src/main/tenders-main.ts`**:
  - Storage path helpers (lines 312–334): `getTendersBaseDir`, `getTendersDocumentsDir`, and `getTendersVaultDir` resolve subdirectories under `userData/tenders/`.
  - Path traversal guard `resolveSafeTendersPath` (lines 336–361):
    ```typescript
    if (!storedPath || typeof storedPath !== 'string') {
      return { safe: false, fullPath: '', error: 'Stored path is required' }
    }
    if (storedPath.includes('\0')) {
      return { safe: false, fullPath: '', error: 'Null byte detected in path' }
    }
    const root = resolve(getTendersBaseDir(overrideUserData))
    const resolved = resolve(root, storedPath)
    const docsDir = resolve(getTendersDocumentsDir(overrideUserData))
    const docsDirWithSep = docsDir.endsWith(sep) ? docsDir : docsDir + sep
    const vaultDir = resolve(getTendersVaultDir(overrideUserData))
    const vaultDirWithSep = vaultDir.endsWith(sep) ? vaultDir : vaultDir + sep

    // Must strictly be inside either documents/ or vault/ subdirectories
    const isInsideDocs = resolved.startsWith(docsDirWithSep) && resolved !== docsDir
    const isInsideVault = resolved.startsWith(vaultDirWithSep) && resolved !== vaultDir

    if (!isInsideDocs && !isInsideVault) {
      return { safe: false, fullPath: '', error: 'Directory traversal detected' }
    }
    return { safe: true, fullPath: resolved }
    ```
  - Atomic writing routine `atomicWriteDocumentFile` (lines 363–397):
    - Temporary file pattern: `${targetPath}.${Date.now()}.${randomUUID().slice(0, 6)}.tmp`
    - Retry loop: 3 attempts on Windows `EBUSY` / `EPERM` with spin-wait backoff, ensuring `.tmp` deletion on fatal failure.
  - Handlers:
    - `saveDocumentFile` (lines 399–442): Sanitizes filenames using `basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')`, preventing path separator injection, NTFS Alternate Data Streams (ADS) colon injection, and reserved characters.
    - `readDocumentFile` (lines 444–466): Strictly checks `resolveSafeTendersPath`, existence check, and returns raw `ArrayBuffer` slice.
    - `openDocumentFile` (lines 468–492): Validates path safety, checks existence, and delegates to `shell.openPath`.
    - `deleteDocumentFile` (lines 494–514): Validates path safety, executes `unlinkSync` idempotently if file exists, returning `{ ok: true }`.

### 1.2 Empirical Challenger Test Execution Results
- Created test harness `tools/test-challenger-m2-storage-security.ts`.
- Execution command: `npx tsx tools/test-challenger-m2-storage-security.ts`
  ```
  Duration: 1.02s
  Total Assertions: 483
  Passed: 483
  Failed: 0
  ```
- **Security Metrics:**
  - Malicious escaping attack vectors tested: 40 (all blocked across 160 operations: path resolution, read, open, delete).
  - Traversal vectors tested: `../../etc/passwd`, `..\..\Windows\System32\drivers\etc\hosts`, `documents/../../tenders-data.json`, `vault/../../tenders-data.json`, `documents/..`, `vault/..`, `documents/.`, `vault/.`, `.`, `..`, `/`, `\`, `documents/`, `vault/`, `C:\Windows\System32\cmd.exe`, `\\localhost\c$\secret.txt`, `//evil-server/share/payload.exe`, `\\?\C:\Windows\System32\cmd.exe`, null byte poisoning (`\0`), NTFS ADS (`:stream`, `::$DATA`).
  - Filename sanitization in `saveDocumentFile`: 19 adversarial filenames stripped to safe alphanumeric basenames, strictly confined within `documents/` or `vault/`.
  - Canonical directory casing: Uppercase directory paths (e.g. `DOCUMENTS/file.pdf`) rejected by strict string prefix matching.
  - Sensitive store protection: `tenders-data.json` remained 100% intact and uncorrupted despite multiple adversarial deletion attempts.
- **Concurrency & Race Condition Metrics:**
  - 50 simultaneous parallel writes completed in 122ms (throughput: 410 ops/sec).
  - 100% of files (50/50) verified on disk with matching SHA-256 hashes.
  - 20 same-millisecond identical-filename uploads (`duplicate-stress.pdf`) executed concurrently via `Promise.all` with zero crashes, unhandled rejections, or lock errors.
  - Concurrent read-during-write stress: 10 concurrent reads alongside 10 concurrent 1 MB writes completed with zero data corruption and byte-for-byte SHA-256 verification.
  - Concurrent read & delete race: 10 parallel races handled without uncaught exceptions, returning valid boolean envelopes.
- **Boundary & Edge-Case Files:**
  - 0-byte file: Saved successfully, read back with `byteLength === 0`, deleted cleanly.
  - 10 MB buffer (large scanned municipal RFP PDF): Saved in 10ms, read in 23ms, SHA-256 matched byte-for-byte.
  - 25 MB buffer (heavy engineering blueprint payload): Saved in 157ms, read back with identical SHA-256 hash.
  - Raw binary payloads: 64 KB buffer containing all byte values 0x00 to 0xFF preserved without encoding corruption; ZIP archive header bytes (`PK\x03\x04...`) verified intact.
  - Boundary filenames: Handled filenames with spaces, unicode (`招标文件_2026年_水务工程.pdf`, `Müntz_Straße_Angebote.pdf`, `Tender_🇿🇦_Water_Infrastructure.pdf`), punctuation (`!@#$%^&*()_+={}[]|;<>?,~.pdf`), Windows reserved device names (`CON.pdf`, `PRN.txt`, `AUX.bin`, `NUL.pdf`, `COM1.dat`, `LPT1.pdf`), and dots-only fallbacks (`"   "`, `"."`, `".."`, `"..."` cleanly default to `tender.pdf`).
  - Long filenames: 300-character filename caught gracefully by filesystem boundary without unhandled crashes.
- **Idempotence & Fuzzing:**
  - Deleting non-existent file: returned `ok: true`.
  - Double/triple deletion: subsequent deletes of deleted files returned `ok: true`.
  - Missing file handling: `readDocumentFile` and `openDocumentFile` returned `ok: false` with descriptive error `'File not found on disk'`.
  - Malformed payload fuzzing: `null`, `undefined`, empty objects, non-string paths, invalid categories (`'invoices'`, `'taxes'`) rejected safely with descriptive error envelopes.

### 1.3 Monorepo Regression Suite Results
- `npm run check:brand`: **Zero unauthorized upstream brand occurrences found** (exit code 0).
- `npm run typecheck`: **Clean pass across all 22 monorepo packages** (exit code 0).
- `node tools/verify-suite-workflows.mjs`: **56 passed, 0 failed** (exit code 0).
- `npx tsx tools/verify-tenders-sync.ts`: **40 passed, 0 failed** (exit code 0).
- `npx tsx tools/verify-tenders-storage.ts`: **72 passed, 0 failed** (exit code 0).

---

## 2. Logic Chain

1. **Path Traversal Defense Robustness:**
   - Observably, `resolveSafeTendersPath` resolves relative inputs against `userData/tenders/` and enforces that the fully resolved path strictly starts with `userData/tenders/documents/` or `userData/tenders/vault/`.
   - Any attempt to escape via `..`, drive letters (`C:\`), root slashes (`/`), UNC network shares (`\\`), or null bytes (`\0`) results in a path that fails the prefix check and returns `{ safe: false, error: 'Directory traversal detected' }`.
   - Empirically verified: across 40 attack vectors and 160 attempted operations, zero traversals escaped the sandbox, and the core database `tenders-data.json` remained unaffected.
2. **Atomic Write & Concurrency Isolation:**
   - `atomicWriteDocumentFile` writes to a unique `.tmp` file combining `Date.now()` and a 6-character random UUID before invoking `renameSync`.
   - Under stress of 50 concurrent writes and 20 identical-filename same-tick writes, no file lock deadlocks occurred. All written files maintained 100% SHA-256 hash fidelity.
3. **Binary & Edge-Case Integrity:**
   - By operating directly on `Buffer` and slicing underlying `ArrayBuffer` instances rather than converting to UTF-8 strings, binary data containing arbitrary bytes (including 0x00 and non-printable control characters) is not mutated.
   - 0-byte and 25 MB files are handled within normal memory limits and sub-second execution times.
4. **Idempotent Lifecycle:**
   - The deletion routine checks existence before unlinking, making delete operations idempotent and safe to retry during network or IPC disconnections.

---

## 3. Caveats

- **Operating System File Name Limits:** On Windows systems where Win32 long path support (`\\?\` or `LongPathsEnabled`) is disabled, filenames exceeding 260 characters will be rejected by the OS filesystem layer (`ENOENT` / `ENAMETOOLONG`). As verified in Test 3.5, this is safely caught by `saveDocumentFile` and returns `{ ok: false, error: ... }` without crashing the application.
- **Client-Side Dev Fallback:** In web-only browser development without Electron IPC (`window.tendersApi` undefined), the application falls back to ephemeral `blob:` URLs. Persistent disk storage is active and verified in Electron desktop runtime environments.

---

## 4. Conclusion

**FINAL ASSESSMENT: APPROVE**

Milestone 2 (Persistent Disk Storage for RFP Documents & Vault Returnables - R2) has been empirically stressed and verified:
1. Malicious path traversal and sandbox escape vulnerabilities are thoroughly mitigated.
2. High-concurrency read/write workloads operate with zero corruption and high throughput (410 ops/sec).
3. Edge-case buffers (0-byte, 25MB, arbitrary binary) and edge-case filenames (unicode, spaces, Windows device names) are preserved and sanitized.
4. Missing file handling and deletion are safe, descriptive, and idempotent.
5. Zero regressions observed across the monorepo: `npm run typecheck`, `check:brand`, and workflow test suites pass 100%.

---

## 5. Verification Method

To independently reproduce the empirical challenger verification:

1. **Run the Adversarial Security & Concurrency Challenger Test Suite:**
   ```bash
   npx tsx tools/test-challenger-m2-storage-security.ts
   ```
   *Expected outcome:* 483 passed, 0 failed, exit code 0.

2. **Run the Milestone 2 Storage Verification Suite:**
   ```bash
   npx tsx tools/verify-tenders-storage.ts
   ```
   *Expected outcome:* 72 passed, 0 failed, exit code 0.

3. **Run the Milestone 1 State Sync Suite:**
   ```bash
   npx tsx tools/verify-tenders-sync.ts
   ```
   *Expected outcome:* 40 passed, 0 failed, exit code 0.

4. **Run Cross-App E2E Workflows:**
   ```bash
   node tools/verify-suite-workflows.mjs
   ```
   *Expected outcome:* 56 passed, 0 failed, exit code 0.

5. **Run Full Monorepo Typecheck & Brand Check:**
   ```bash
   npm run check:brand
   npm run typecheck
   ```
   *Expected outcome:* Zero brand violations, zero TypeScript errors across all 22 packages.

---

## Adversarial Challenge Report Summary

**Overall risk assessment:** **LOW**

### Challenge 1: Path Traversal via Relative Segments and Drive Letters
- **Assumption challenged:** Path resolution might permit stepping outside `userData/tenders/` via `..` or absolute Windows root paths (`C:\Windows\System32`).
- **Attack scenario:** Calling `readDocument`, `openDocument`, and `deleteDocument` with `../../tenders-data.json`, `..\\..\\Windows\\System32\\drivers\\etc\\hosts`, UNC shares, and null bytes.
- **Empirical result:** All 40 vectors (160 operations) were safely blocked by `resolveSafeTendersPath`. `tenders-data.json` remained unmodified.

### Challenge 2: Filename Injection in `saveDocument`
- **Assumption challenged:** Malicious `fileName` parameters could introduce path traversal tokens or Windows device names (`CON`, `PRN`, `AUX`, `NUL`).
- **Attack scenario:** Calling `saveDocument` with filenames such as `../../../../malicious.exe`, `CON.pdf`, `test.pdf:malicious.exe` (NTFS ADS), and `payload.pdf.exe`.
- **Empirical result:** Filenames were sanitized to safe alphanumeric basenames with timestamps prepended, stripping traversal tokens and NTFS stream colons. Files were strictly written to `documents/` or `vault/`.

### Challenge 3: Concurrency and Race Condition Integrity
- **Assumption challenged:** Simultaneous writes to the document store or duplicate filenames in the same tick could trigger file write collisions or unhandled Windows `EBUSY`/`EPERM` crashes.
- **Attack scenario:** 50 simultaneous parallel writes; 20 same-millisecond identical-filename saves; concurrent read-during-write of 1 MB files; simultaneous read/delete races.
- **Empirical result:** Handled with atomic `.tmp` writes and Windows retry backoff. All 50 parallel files verified on disk with matching SHA-256 hashes at 410 ops/sec throughput.

### Challenge 4: Extreme Buffer Sizes and Binary Formats
- **Assumption challenged:** 0-byte or large 25 MB buffers might fail memory bounds or corrupt binary byte streams.
- **Attack scenario:** 0-byte empty buffer; 10 MB and 25 MB random binary buffers; 64 KB buffer spanning 0x00 to 0xFF byte values; ZIP archive headers.
- **Empirical result:** All buffers saved and retrieved with 100% SHA-256 byte matching without UTF-8 re-encoding degradation.
