# Test baseline

Recorded at `7297633f` on 2026-09-28 (unit + e2e), 2 runs each.

These are the tests that already fail, so `npm run check:baseline` can tell a
regression from the background noise. Refresh with
`node fork/tools/baseline.mjs --write --with-e2e` once a fix has landed, and read
this as "known-bad", not as "accepted".

## @genoffice/books

630 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/crm

24 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/docs

2571 passed, 1 failed, 0 skipped

- tests/protect-dialog.test.ts > ProtectDialog > setting a modify password produces verifiable writeProtection credentials

## @genoffice/html

193 passed, 0 failed, 1 skipped

- (nothing failing)


## @genoffice/markdown

564 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/pdf

807 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/sheets

2835 passed, 2 failed, 3 skipped

- (nothing failing)


## @genoffice/sheets (flaky)

Failed in some runs but not all — not treated as a known failure.

- tests/xlsx-borders.test.ts > sidecar read side keeps styled blanks > returns value-less bordered/filled cells with their style index
- tests/xlsx-save-edits.test.ts > text rotation and double underline save > clears a rotation with textRotation 0

## @genoffice/shell

582 passed, 6 failed, 0 skipped

- tests/cloud-projects.test.ts > cloud projects store account binding > rejects and deletes another account's store
- tests/cloud-projects.test.ts > cloud projects store account binding > serves the store back to the same account
- tests/cloud-projects.test.ts > cloud projects sync account isolation > aborts without touching the store when the account switches mid-sync
- tests/cloud-projects.test.ts > cloud projects sync account isolation > does not share an in-flight sync across accounts
- tests/cloud-projects.test.ts > cloud projects sync account isolation > writes the store bound to the account that synced
- tests/cloud-projects.test.ts > cloud projects sync account isolation > refreshes later pages when the first page is unchanged

(The sixth entry is hand-added after the 2026-09-28 sync, not tool-measured: the
test is new in that sync's upstream range and fails on Windows for the same
store-file-delete-does-not-take-effect-on-win32 root cause as the five above —
both the test and `apps/shell/src/main/cloud-projects.ts` are byte-identical to
upstream. Hand-added per the runbook's hand-edit precedent.)

## @genoffice/slides

1221 passed, 1 failed, 14 skipped

- tests/slide-qc.test.ts > vision capability fallback > does not send screenshots to text-only models under a vision-capable provider

## @genoffice/tenders

1929 passed, 0 failed, 7 skipped

- (nothing failing)


## @genoffice/agent-core

104 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/ai-provider

278 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/ai-search

98 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/cli

291 passed, 0 failed, 7 skipped

- (nothing failing)


## @genoffice/docx-engine

1445 passed, 0 failed, 1 skipped

- (nothing failing)


## @genoffice/electron-utils

197 passed, 0 failed, 1 skipped

- (nothing failing)


## @genoffice/file-parse

75 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/font-metrics

16 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/html2docx

90 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/i18n

19 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/pdf2docx

757 passed, 0 failed, 7 skipped

- (nothing failing)


## @genoffice/pipelines

54 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/pptx-engine

1057 passed, 0 failed, 17 skipped

- (nothing failing)


## @genoffice/pptx-ops

49 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/pptx-render

348 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/project-store

79 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/ui

32 passed, 0 failed, 0 skipped

- (nothing failing)


## @genoffice/xlsx-gateway

82 passed, 0 failed, 0 skipped

- (nothing failing)


## e2e

0 passed, 5 failed, 0 skipped

- e2e\docs-spellcheck-reenable.spec.ts:51:5 › re-enabling spellcheck respells existing text without user input
- e2e\html-tab.spec.ts:166:7 › html editor › saving without edits keeps BOM, CRLF and the missing trailing newline byte-identical
- e2e\html-tab.spec.ts:276:7 › html editor › preview inspector: click selects, double-click edits text, toolbar deletes, Ask AI drafts
- e2e\tenders-a11y-theme.spec.ts:1170:7 › Tenders a11y + theme (Phase 5 / WP-13) › 3: no critical/serious axe violations on core pages and overlays

## e2e (flaky)

Failed in some runs but not all — not treated as a known failure.

- e2e\html-tab.spec.ts:46:7 › html editor › opens an .html file from argv, renders it in the preview, edits and saves it back
