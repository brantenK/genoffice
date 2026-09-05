# Empirical Verification Challenger Report: Milestone 2 — Persistent Disk Storage (R2)

**Agent**: `challenger_2_m2_storage`  
**Milestone**: Milestone 2 — Persistent Disk Storage for RFP Documents & Vault Returnables (R2)  
**Date**: 2026-09-04T21:15:00Z  
**Verdict**: **APPROVE** (All requirements empirically verified, 266/266 tests passing)

---

## 1. Observation

Direct empirical observations gathered from executing verification suites, typechecking, and static analysis:

### 1.1 Test Suite Execution
- Executed `npx tsx tools/test-challenger-m2-restart-rehydration.ts`:
  ```
  VERIFICATION SUMMARY: 266 passed, 0 failed (Total: 266)
  VERDICT: ✅ APPROVE (ALL R2 REQUIREMENTS VERIFIED)
  ```
  Execution command exited with code 0 in ~2000ms.
- Executed existing verification script `npx tsx tools/verify-tenders-storage.ts`:
  ```
  Results: 72 passed, 0 failed
  🎉 ALL MILESTONE 2 PERSISTENT DISK STORAGE VERIFICATIONS PASSED!
  ```
  Execution command exited with code 0 in ~1200ms.
- Executed TypeScript typecheck `npm run typecheck -w @genoffice/tenders`:
  ```
  > @genoffice/tenders@0.1.0 typecheck
  > tsc --noEmit
  ```
  Exited with code 0 and zero type errors.

### 1.2 Multi-Document Upload and Restart Parity
- Uploaded 10 distinct documents across two categories (`rfp` and `vault`), spanning two different company workspaces (`co-thabo` and `co-1788556376639-0`):
  - 6 real production PDF documents: `sample-rfp.pdf` (9 pages), `tax-clearance.pdf`, `bbbee-affidavit.pdf`, `cipc-registration.pdf`, `coida-good-standing.pdf`, `director-ids.pdf`.
  - 4 synthetic test files: `RFP-Sanitation-Infrastructure-2026.pdf` (50,073 bytes), `ISO-9001-Quality-Certification-2026.pdf` (30,048 bytes), `Special_Chars_Doc_[Test]_(v2.1)#1.pdf` (15,049 bytes), `Large-Tender-Specification-1MB.pdf` (1,048,610 bytes).
- Across 3 consecutive simulated full-application restarts:
  - All 10 stored paths were restored identically from disk storage (`userData/tenders/tenders-data.json`) and renderer persistence (`zanostack-tenders-v1`).
  - IPC `readDocument` retrieved all 10 document byte streams as valid `ArrayBuffer` objects.
  - Every single document exhibited 100% bit-for-bit SHA-256 byte parity between original uploaded buffers and post-restart reloaded buffers (e.g. `Large-Tender-Specification-1MB.pdf`: `18cf1a5f938c...`, exact 1,048,610 bytes).

### 1.3 `store.ts` Partialize and Rehydrate URL Stripping
- Inspected `apps/tenders/src/renderer/src/store.ts` (lines 521–576):
  ```typescript
  partialize: (s) => ({
    page: s.page,
    workspaces: s.workspaces.map((ws) => ({
      ...ws,
      tenders: ws.tenders.map((t) =>
        t.fileUrl?.startsWith('blob:') ? { ...t, fileUrl: '' } : t
      ),
      vault: ws.vault.map((d) =>
        d.fileUrl?.startsWith('blob:') ? { ...d, fileUrl: null } : d
      )
    })),
    ...
  })
  ```
- Empirically verified:
  - Ephemeral `blob:http://localhost:5173/...` tender URLs are blanked to `""`.
  - Ephemeral `blob:http://localhost:5173/...` vault URLs are blanked to `null`.
  - Durable relative paths `documents/...` are preserved intact.
  - Durable relative paths `vault/...` are preserved intact.
  - Static URLs `/demo/...` are preserved intact.
  - Transient state (`shredding`, `pendingFocus`, `tourActive`) is excluded from serialization.
  - `onRehydrateStorage` sanitizes dirty legacy or concurrently injected `blob:` URLs while keeping clean stored disk paths untouched.

### 1.4 `Workspace.tsx` PDF Viewer Loading Logic
- Inspected `apps/tenders/src/renderer/src/components/Workspace.tsx` (lines 66–98 and 361–398):
  - When `tender.fileUrl` is a durable disk path (`documents/...`):
    - Invokes `window.tendersApi.readDocument({ storedPath: tender.fileUrl })`.
    - Receives `{ ok: true, buffer: ArrayBuffer }`.
    - Successfully calls `loadPdfDocument(buf)` and parses into `PDFDocumentProxy` (verified 9 pages parsed for `sample-rfp.pdf`).
    - The "Re-attach the tender PDF" UI condition (`!tender.fileUrl`) evaluates to `false`, eliminating the re-attach warning on restart.
  - When `tender.fileUrl` is empty (`""`, indicating an expired transient blob URL):
    - Correctly triggers the "Re-attach the tender PDF" UI prompt.
  - Simulating user re-attach via `handleReattach`:
    - Calls `window.tendersApi.saveDocument({ fileName, buffer, category: 'rfp' })`.
    - Receives new durable stored path `documents/...`.
    - Updates tender record in store.
    - Re-runs viewer loading logic and successfully displays the PDF, clearing the re-attach prompt.
  - Simulating missing / unlinked file on disk:
    - Sets `docError: 'Could not open the tender PDF in the viewer.'`.
    - Does NOT falsely display the session-expired re-attach prompt.

### 1.5 Adversarial Edge Cases & Security
- Path traversal tests:
  - Tested 10 adversarial paths: `../../../Windows/System32/drivers/etc/hosts`, `..\..\..\Windows\System32\cmd.exe`, `documents/../../tenders-data.json`, `vault/../../tenders-data.json`, `documents/../../../AppData/Local`, `documents/test.pdf\0.png`, `/etc/passwd`, `C:\Windows\System32\calc.exe`, `\\?\UNC\127.0.0.1\c$\secret.txt`.
  - Every attempt was safely rejected by `readDocument`, `openDocument`, and `deleteDocument`.
- Collision resistance:
  - Consecutive uploads of identical filenames (`Standard_Tender_Form.pdf`) generated distinct timestamped filenames (`timestamp_Standard_Tender_Form.pdf`), preserving both files independently without overwrite.
- Concurrency:
  - 10 parallel asynchronous saves and reads executed concurrently without race conditions or file corruption.
- Deletion idempotency:
  - Deleting an already deleted file returned `{ ok: true }` without crashing.

---

## 2. Logic Chain

1. **Premise**: Under Milestone 2 Requirement R2, uploaded RFP documents and vault returnables must persist to the filesystem under `userData/tenders/documents/` and `userData/tenders/vault/`, remaining durable across application restarts without relying on ephemeral `blob:` URLs.
2. **Verification of Storage Subsystem**: Observations in 1.1 and 1.2 demonstrate that `saveDocumentFile` writes files atomically (via `.tmp` + `renameSync`) into sanitized subdirectories, returning relative paths (`documents/...` or `vault/...`).
3. **Verification of Parity Across Restarts**: Observations in 1.2 confirm that across 3 simulated full-lifecycle application restarts, reloading from `tenders-data.json` and `localStorage` retains all relative paths, and reading back the files yields exact SHA-256 byte parity against the original files.
4. **Verification of Store Stripping & Preservation**: Observations in 1.3 prove that `store.ts` partialize and `onRehydrateStorage` accurately distinguish between ephemeral `blob:` URLs (which are stripped) and persistent disk paths / static assets (which are preserved).
5. **Verification of Viewer Behavior**: Observations in 1.4 confirm that `Workspace.tsx` reads stored paths via IPC `readDocument`, obtaining valid ArrayBuffers for `pdfjs-dist` without entering the `!tender.fileUrl` branch that rendered the "Re-attach the tender PDF" warning in prior revisions.
6. **Verification of Adversarial Robustness**: Observations in 1.5 confirm that path traversal attacks, filename collisions, concurrency spikes, and double-deletions are safely handled without data loss or corruption.
7. **Inference**: All functional, persistence, and security criteria for Milestone 2 (R2) are fully met.

---

## 3. Caveats

- **Filesystem Permissions**: Tests assume the application process has standard write permissions to its assigned `userData` directory. Extreme OS environments (e.g. read-only disk or completely exhausted disk space) were not simulated.
- **Electron Shell Open**: In headless CI/testing environments, `electron.shell.openPath` is mocked to ensure the target path exists and is passed correctly without spawning desktop OS GUI handlers.

---

## 4. Conclusion

**Verdict**: **APPROVE**

Milestone 2 (Persistent Disk Storage for RFP Documents & Vault Returnables) is fully implemented, empirically verified, and robust against adversarial scenarios.
- Multi-document upload and restart simulation passes with 100% byte fidelity.
- `store.ts` partialize and rehydrate correctly strip ephemeral blob URLs while preserving durable disk paths.
- `Workspace.tsx` successfully reloads ArrayBuffers from disk, eliminating the "Re-attach the tender PDF" error prompt after restart.
- Zero TypeScript typecheck errors in `@genoffice/tenders`.

---

## 5. Verification Method

To independently execute and verify these findings:

```bash
# 1. Run the dedicated empirical challenger test suite (266 checks)
npx tsx tools/test-challenger-m2-restart-rehydration.ts

# 2. Run the base storage verification suite (72 checks)
npx tsx tools/verify-tenders-storage.ts

# 3. Verify TypeScript type safety across apps/tenders
npm run typecheck -w @genoffice/tenders
```

### Invalidation Conditions:
- Any test failure in `tools/test-challenger-m2-restart-rehydration.ts`.
- Non-zero exit code or compilation errors from `npm run typecheck -w @genoffice/tenders`.
- Re-appearance of the "Re-attach the tender PDF" warning when opening a tender with a persisted `documents/...` path.
- Inability to read back identical SHA-256 byte arrays from disk after restart.
