# Test baseline

Recorded at `29491c2` on 2026-09-23 (unit + e2e), 2 runs each.

These are the tests that already fail, so `npm run check:baseline` can tell a
regression from the background noise. Refresh with
`node fork/tools/baseline.mjs --write --with-e2e` once a fix has landed, and read
this as "known-bad", not as "accepted".

## @genoffice/books

265 passed, 0 failed, 0 skipped

- (nothing failing)

## @genoffice/crm

24 passed, 0 failed, 0 skipped

- (nothing failing)

## @genoffice/docs

2572 passed, 1 failed, 0 skipped

- (nothing failing)

## @genoffice/docs (flaky)

Failed in some runs but not all — not treated as a known failure.

- tests/protect-dialog.test.ts > ProtectDialog > setting a modify password produces verifiable writeProtection credentials

## @genoffice/html

193 passed, 0 failed, 1 skipped

- (nothing failing)

## @genoffice/markdown

558 passed, 0 failed, 0 skipped

- (nothing failing)

## @genoffice/pdf

807 passed, 0 failed, 0 skipped

- (nothing failing)

## @genoffice/sheets

2835 passed, 1 failed, 3 skipped

- (nothing failing)

## @genoffice/sheets (flaky)

Failed in some runs but not all — not treated as a known failure.

- tests/xlsx-borders.test.ts > sidecar read side keeps styled blanks > returns value-less bordered/filled cells with their style index

## @genoffice/shell

571 passed, 5 failed, 0 skipped

- tests/cloud-projects.test.ts > cloud projects store account binding > rejects and deletes another account's store
- tests/cloud-projects.test.ts > cloud projects store account binding > serves the store back to the same account
- tests/cloud-projects.test.ts > cloud projects sync account isolation > aborts without touching the store when the account switches mid-sync
- tests/cloud-projects.test.ts > cloud projects sync account isolation > does not share an in-flight sync across accounts
- tests/cloud-projects.test.ts > cloud projects sync account isolation > writes the store bound to the account that synced

## @genoffice/slides

1221 passed, 1 failed, 14 skipped

- tests/slide-qc.test.ts > vision capability fallback > does not send screenshots to text-only models under a vision-capable provider

## @genoffice/tenders

829 passed, 0 failed, 7 skipped

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

0 passed, 3 failed, 0 skipped

- e2e\docs-spellcheck-reenable.spec.ts:51:5 › re-enabling spellcheck respells existing text without user input
- e2e\html-tab.spec.ts:276:7 › html editor › preview inspector: click selects, double-click edits text, toolbar deletes, Ask AI drafts

## e2e (flaky)

Failed in some runs but not all — not treated as a known failure.

- e2e\html-tab.spec.ts:448:7 › html editor › Ctrl+Z inside the preview undoes the last edit; pinch over the frame zooms the stage
