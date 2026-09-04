# GenOffice

**The world's first full-featured open-source AI Office suite — now with integrated business apps.**

[![License: Apache-2.0](https://img.shields.io/github/license/genspark-ai/genoffice)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/genspark-ai/genoffice)](https://github.com/genspark-ai/genoffice/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/genspark-ai/genoffice/total)](https://github.com/genspark-ai/genoffice/releases)

[Website](https://genoffice.ai/) · [Download](https://github.com/genspark-ai/genoffice/releases/latest) · [Privacy](PRIVACY.md) · [Demo](https://www.youtube.com/watch?v=B2pLdMX95v4)

GenOffice is a free, open-source alternative to Microsoft Office for macOS,
Windows, and Linux, built around AI editing as a first-class workflow rather
than a bolted-on chat box. It opens and saves the real Microsoft Office
formats — Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`) — and edits
PDF and Markdown too. The suite now also ships three integrated business
applications — **Zanostack CRM**, **Zanostack Tenders**, and **Zano Books** —
that share a cross-app workflow layer so won deals, tender milestones, and bank
reconciliations all flow together automatically.

[![Meet GenOffice — the world's first full-featured open-source AI Office (video)](https://img.youtube.com/vi/B2pLdMX95v4/maxresdefault.jpg)](https://www.youtube.com/watch?v=B2pLdMX95v4)

[Watch the demo video on YouTube](https://www.youtube.com/watch?v=B2pLdMX95v4)

---

## Features

### Office Suite
- **Real PDF editing** — retype text and edit images in the page itself, original fonts preserved.
- **Local PDF → Word / PowerPoint / Excel conversion** — turn a PDF into an editable `.docx`, `.pptx`, or `.xlsx` entirely on your machine: no cloud, no upload.
- **Scanned PDFs too** — on macOS and Windows scanned pages are read with the system OCR, so they convert to editable text.
- **Microsoft Word–compatible, byte-preserving `.docx` editing** — only what you touched changes; Word never notices.
- **Word-faithful pagination** — page breaks land where Word puts them.
- **Excel-compatible spreadsheets** — in-house engine with a Rust `.xlsx` sidecar, own charts, pivot tables, slicers.
- **PowerPoint-compatible presentations** — in-house `.pptx` engine with masters, layouts, smart guides, non-destructive crop.
- **Markdown to Word, fully local** — the same OOXML engine, no Pandoc, no cloud.
- **AI that edits documents** — block-level edits with snapshots and diffs, document-aware agents.
- **Bring your own key (BYOK)** — run the AI on your own API key: Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Qwen, Doubao, MiniMax, Grok, Mistral, OpenRouter, or any OpenAI-compatible endpoint — or sign in with Genspark and skip keys entirely.
- **Agent tools built in** — web/image search, image generation, media analysis.
- **Light / dark / system themes.**
- **macOS, Windows, Linux.**
- **Free & open-source (Apache-2.0).**

### Business Apps (Zanostack)
- **Zanostack CRM** — sales pipeline, contacts, companies, and deal tracking with 1-click invoicing into Zano Books.
- **Zanostack Tenders** — public and private sector RFP management, compliance matrices, company vault, and contract milestone billing into Zano Books.
- **Zano Books** — local-first double-entry accounting: chart of accounts, sales invoices, purchase bills, bank statement CSV import, AI-assisted settlement matching, and 1-click reconciliation.
- **CRM → Books invoicing bridge** — marking a deal won and clicking "Create Invoice in Zano Books" generates a VAT-split sales invoice, posts the double-entry journal entry, and switches you straight to Books.
- **Tenders → Books milestone billing** — billing a reached contract milestone creates a tax invoice with the RFP reference number attached, updates the milestone status to `BILLED`, and opens Books.
- **Bank statement reconciliation** — import any standard bank CSV, get AI-confidence settlement suggestions (HIGH confidence on invoice number, RFP reference, or party name match), and settle open invoices with one click.
- **Resilient data sync** — atomic file writes, schema versioning with v0→v1 migration, corruption backup (`.corrupted.bak`), and safe cross-app merge without data loss.

---

## Download

| Platform                             | Requirements                                          | Download                                                                            |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **macOS** — Apple Silicon (arm64)    | macOS 11+                                             | [Latest `.dmg` (arm64)](https://github.com/genspark-ai/genoffice/releases/latest)   |
| **macOS** — Intel (x64)              | macOS 11+                                             | [Latest `.dmg` (x64)](https://github.com/genspark-ai/genoffice/releases/latest)     |
| **Windows** (x64)                    | Windows 10+                                           | [Latest `.exe` installer](https://github.com/genspark-ai/genoffice/releases/latest) |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 or newer)           | [Latest `.deb`](https://github.com/genspark-ai/genoffice/releases/latest)           |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | [Latest `.rpm`](https://github.com/genspark-ai/genoffice/releases/latest)           |
| **Linux** — other distributions      | x86_64, glibc 2.34+, FUSE 2                           | [Latest `.AppImage`](https://github.com/genspark-ai/genoffice/releases/latest)      |

All builds come from `main`; the macOS and Windows installers are signed.
Older versions are on the [Releases](https://github.com/genspark-ai/genoffice/releases) page.

### Installing on Linux

The deb installs with apt — it pulls in the dependencies and adds GenOffice
to the applications menu:

```bash
sudo apt install ./genoffice_<version>_amd64.deb
```

On Fedora / RHEL-family / openSUSE, install the rpm instead:

```bash
sudo dnf install ./genoffice-<version>.x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./genoffice-<version>.x86_64.rpm  # openSUSE
```

The AppImage instead runs in place: install the FUSE 2 runtime
(`sudo apt install libfuse2`; on Ubuntu 24.04 the package is `libfuse2t64`),
make the file executable, then run it:

```bash
chmod +x GenOffice-<version>.AppImage
./GenOffice-<version>.AppImage
```

---

## Apps

### Office Apps

| App             | Product                | What it is |
| --------------- | ---------------------- | ---------- |
| `apps/docs`     | **GenOffice Docs**     | `.docx` word processor. Byte-preserving round trip: only dirty paragraphs are regenerated (paragraph patch), everything else in the original file is kept byte-for-byte, so opening and saving never breaks layout in Word. Paginated view whose line metrics reproduce the original document's layout, tracked changes, comments, styles, equations, ink. |
| `apps/sheets`   | **GenOffice Sheets**   | `.xlsx` spreadsheet. UI built on the open-source [Univer](https://github.com/dream-num/univer) core (Apache-2.0) with a large layer of in-house extensions; `.xlsx` import/export runs through an in-house Rust sidecar (calamine + IronCalc), charts are rendered in-house (Konva), plus pivot tables, slicers, conditional formatting, and formula tracing. |
| `apps/slides`   | **GenOffice Slides**   | `.pptx` presentations. In-house `.pptx` parse/render/edit engine with masters, charts, cropping, ink, and text shaping (HarfBuzz metrics). |
| `apps/pdf`      | **GenOffice PDF**      | `.pdf` viewer/editor on [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) + [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT): annotations, forms, outlines, stamps, signatures, page operations, and printing support. True text editing — paragraph selection with in-block reflow, alignment restoration, original-font preservation — and content-stream image insert/edit, all rewriting page content streams through [PDFium](https://pdfium.googlesource.com/pdfium/) wasm (BSD-3-Clause) with subset-embedded fonts — no cover-up annotations. Converts PDFs into editable Word, PowerPoint, and Excel files fully locally (`packages/pdf2docx`), with OCR support for scanned pages (system OCR on macOS and Windows). |
| `apps/markdown` | **GenOffice Markdown** | `.md` / `.markdown` editor: Tiptap block editor over plain Markdown files — headings, lists, tables, images, code blocks — saved back as plain Markdown, hosted in shell tabs. |
| `apps/shell`    | **GenOffice**          | The suite shell: home screen, tabbed hosting of all apps, light/dark/system theme, auto-update. |

### Business Apps (Zanostack)

| App             | Product                  | What it is |
| --------------- | ------------------------ | ---------- |
| `apps/crm`      | **Zanostack CRM**        | Sales pipeline, contacts, companies, and deal management. Deals are tracked through stages (lead → qualified → proposal → negotiation → won/lost). Won deals can be invoiced directly into Zano Books with one click — the invoice is created, the double-entry ledger is updated, and the deal stores the invoice back-reference. Data stored in `userData/crm/deals.json` with schema versioning and atomic persistence. |
| `apps/tenders`  | **Zanostack Tenders**    | Public and private sector RFP tracking and contract delivery. Manages compliance matrices, company vault returnables, AI-assisted readiness scoring, and contract milestones. Reached milestones can be billed into Zano Books with one click — a VAT tax invoice is created linked to the RFP reference number (e.g. `RFP-WTR-2026-04`), the milestone is marked `BILLED`, and Books is activated. Data stored in `userData/tenders/tenders-data.json`. |
| `apps/books`    | **Zano Books**           | Local-first double-entry accounting. Chart of Accounts (`acc-bank`, `acc-ar`, `acc-ap`, `acc-sales`, `acc-vat`), parties, sales invoices, purchase bills, and journal entries. Banking view supports standard bank statement CSV import with deduplication, AI-confidence settlement suggestions (HIGH on invoice number / RFP reference / party name match), and 1-click reconciliation that settles open invoices and posts balanced journal entries. Data stored in `userData/books/books-data.json`. |

### Cross-App Integration

The three business apps share a live IPC integration layer:

```
CRM Deal (Won)
    └─ crm:create-invoice-in-books ──► Books: INV-YYYY-NNN
                                          ├─ acc-ar ↑ grandTotal
                                          ├─ acc-sales ↑ subtotal (÷1.15)
                                          ├─ acc-vat ↑ VAT portion
                                          └─ Balanced journal entry posted

Tenders Milestone (REACHED)
    └─ tenders:bill-milestone-in-books ► Books: INV-YYYY-NNN (with RFP ref)
                                          ├─ acc-ar ↑ grandTotal
                                          └─ Milestone → BILLED

Bank CSV Import
    └─ books:import-bank-statement-csv ► bankTransactions[] + acc-bank adjusted

1-Click Reconciliation
    └─ books:reconcile-transaction ─────► Invoice → Paid, acc-ar/ap reduced,
                                          Settlement journal entry posted (D=C)
```

All three stores use **atomic writes** (write to `.tmp`, rename), **schema versioning** with v0→v1 migration, and **corruption recovery** (`.corrupted.bak` fallback).

---

## Engine packages

All pure TypeScript, no Electron dependency, unit-tested (except the UI kit):

- `packages/docx-engine` — docx parsing → block tree (with `docxIndex`
  anchors and passthrough), OOXML fragment generation, byte-level paragraph
  patching.
- `packages/pptx-engine` / `packages/pptx-render` — pptx model and rendering.
- `packages/pdf2docx` — local PDF → DOCX conversion: PDFium character-level
  extraction, pure-geometry layout analysis, rebuild through `docx-engine`;
  the same analysis drives the PDF app's PowerPoint and Excel exports.
- `packages/file-parse` — text extraction for AI attachments (office formats,
  text formats).
- `packages/agent-core` — the AI agent loop and skill composition shared by
  every app.
- `packages/ai-provider` — provider abstraction and streaming for the model
  backends.
- `packages/ai-search` — Genspark auth + web/image search tools.
- `packages/i18n`, `packages/ui`, `packages/project-store`,
  `packages/electron-utils` — shared i18n core, React UI kit, recent-files
  store, and Electron main-process helpers.

---

## Development

```bash
npm install
npm run fixtures     # generate test .docx fixtures
npm test             # engine + app unit tests (docs/sheets/slides need no display)
npm run typecheck    # tsc --noEmit across every workspace (9 apps + 13 packages)
npm run check:brand  # verify no unauthorized upstream brand occurrences
npm run dev          # all 9 apps + shell against Vite dev servers
npm run dev:docs     # a single app (same pattern works per workspace)
npm run dist:mac     # package macOS dmg (regenerates third-party notices)
npm run dist:win     # package Windows nsis installer
npm run dist:linux   # package Linux AppImage + deb + rpm
```

The sheets app additionally needs a Rust toolchain for its xlsx sidecar
(`cargo` on PATH); `npm run build -w @genoffice/sheets` compiles it
automatically.

### Running the business apps

```bash
# Run all 9 apps + shell together
npm run dev

# Run individual business apps
npm run dev -w @genoffice/crm
npm run dev -w @genoffice/tenders
npm run dev -w @genoffice/books
```

### Workflow E2E verification

```bash
# 56-test E2E suite covering all 4 requirements (Tiers 1–4)
node tools/verify-suite-workflows.mjs

# Adversarial commercial lifecycle harness (Tier 5, 78 tests)
node tools/test-challenger-1-m5-hardening.mjs

# Concurrency & resilience stress tests (Tier 5, 30 tests)
node tools/test-challenger-2-m5-resilience.mjs
```

---

## Architecture notes (docx round trip)

```
open docx ─► archive original by hash (never touched)
          ─► docx-engine parses word/document.xml top-level elements (w:p / w:tbl / …)
          ─► Block tree, each block anchored by docxIndex + original XML slice
          ─► Tiptap streaming editor (manual + AI editing, dirty tracking)
save      ─► dirty blocks → OOXML fragments (referencing existing styles only)
          ─► splice into original document.xml (untouched blocks keep original bytes)
          ─► repack zip; all other entries copied byte-for-byte
```

The same philosophy holds in sheets and slides: the original file is the
source of truth, edits are applied as narrow patches, and everything the
editor didn't touch survives the round trip untouched.

The business apps follow the same principle for their JSON stores: a versioned
envelope is written atomically, unknown extension fields are preserved across
read-write cycles, and a `.corrupted.bak` file is written before falling back
to safe defaults on any parse failure.

---

## FAQ

**Is GenOffice free?**
Yes. GenOffice is free and open-source under the Apache-2.0 license — no
trial, no paid tier for the apps themselves.

**Can GenOffice open Microsoft Word, Excel, and PowerPoint files?**
Yes. GenOffice opens and saves native `.docx`, `.xlsx`, and `.pptx` files.
Saving is byte-preserving: parts of the file you didn't touch are written
back byte-for-byte, so documents keep working in Microsoft Office.

**Does GenOffice work offline?**
Document editing is fully local — files never leave your machine to be
opened, edited, or saved. The AI features (agents, search, image tools) need
a network connection, with either a Genspark sign-in or your own model API
key (BYOK). The three business apps (CRM, Tenders, Books) store all data
locally and work fully offline.

**Can GenOffice edit PDF files?**
Yes — real PDF text and image editing that rewrites the page content stream
with the original fonts preserved, not cover-up annotations.

**Can GenOffice convert PDF to Word, Excel, or PowerPoint?**
Yes — GenOffice converts PDFs into editable `.docx`, `.xlsx`, and `.pptx`
files entirely on-device: PDFium character-level extraction plus
geometry-based layout analysis, no cloud service, no upload. Scanned pages are
covered too — on macOS and Windows the system OCR reads them, so they convert
to editable text rather than a page image.

**Can I use my own AI model or API key?**
Yes. Besides the keyless Genspark sign-in, GenOffice supports bring your own
key (BYOK) for Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Qwen, Doubao,
MiniMax, Grok, Mistral, and OpenRouter, plus any OpenAI-compatible endpoint
— including local model servers.

**Does GenOffice collect any data?**
Official packaged builds send limited usage analytics by default, and you can
disable reporting at any time under Settings → General. Analytics never sends
document content, file names, file paths, account identity, or email addresses.
See [GenOffice Privacy](PRIVACY.md) for the complete event and data disclosures.

**What is Zanostack CRM?**
Zanostack CRM is the sales pipeline app bundled with GenOffice. It manages
contacts, companies, and deals through configurable stages. Won deals can be
invoiced into Zano Books with a single click — no copy-paste, no re-entry.

**What is Zanostack Tenders?**
Zanostack Tenders is the RFP and contract management app. It tracks public and
private sector tender opportunities, compliance matrices, and delivery milestones.
When a contract milestone is reached, it can be billed directly into Zano Books,
with the RFP reference number automatically attached to the invoice.

**What is Zano Books?**
Zano Books is a local-first double-entry accounting app. It manages a chart of
accounts, issues sales invoices and purchase bills, imports bank statement CSVs,
and reconciles open transactions. It receives invoices from both CRM (won deals)
and Tenders (milestone billing) automatically.

**How does the cross-app invoicing work?**
When you mark a CRM deal as won and click "Create Invoice in Zano Books", an
`IPC` call fires from the CRM main process to the Books main process. Books
creates a sales invoice, posts a balanced double-entry journal entry
(DR acc-ar / CR acc-sales + acc-vat), updates the CRM deal with the invoice
reference, and switches the shell tab to Zano Books — all without leaving the
app. The Tenders milestone billing works the same way.

**How does bank reconciliation work?**
Import any standard bank CSV (Date, Description, Amount columns — or
Debit/Credit) in the Banking view. Books deduplicates by fingerprint, updates
the `acc-bank` ledger balance, and shows settlement suggestions with confidence
scores (HIGH when the bank reference matches an invoice number, RFP reference,
or party name). Click Reconcile to mark the invoice Paid, reduce Accounts
Receivable, and post a balanced settlement journal entry.

---

## Security

See [SECURITY.md](SECURITY.md) for the process security posture (renderer
sandboxing, IPC validation, external-link gating) and the threat models for
AI-generated content.

---

## Acknowledgements

GenOffice would not be possible without these open-source projects:

- [Electron](https://www.electronjs.org/) — the desktop runtime for every app.
- [Univer](https://github.com/dream-num/univer) (Apache-2.0) — the spreadsheet
  UI core that Sheets extends.
- [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause, bundled via
  [@embedpdf/pdfium](https://github.com/embedpdf/embed-pdf-viewer)) — the
  content-stream engine behind true PDF text and image editing.
- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) and
  [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) — PDF rendering and
  document assembly.
- [Tiptap](https://tiptap.dev/) / [ProseMirror](https://prosemirror.net/) —
  the block editors in Docs and Markdown.
- [Konva](https://konvajs.org/) — canvas rendering for Slides and Sheets
  charts.
- [HarfBuzz](https://github.com/harfbuzz/harfbuzz) (wasm) — text-shaping
  metrics for complex scripts.
- [calamine](https://github.com/tafia/calamine) and
  [IronCalc](https://github.com/ironcalc/IronCalc) — the read and calc layers
  of the Rust xlsx sidecar.
- Liberation, Carlito, Caladea, and Noto CJK fonts (OFL/Apache-2.0) — bundled
  document fonts.

---

## Third-party notices

`npm run notices` regenerates the bundled third-party license summary
(`tools/gen-third-party-notices.mjs`); all runtime dependencies are
MIT/Apache-2.0/BSD-3-Clause/OFL, and the bundled fonts (Liberation, Carlito,
Caladea, Noto CJK subsets) are OFL/Apache.

---

## License

GenOffice is licensed under the [Apache License 2.0](LICENSE), with one
exception: the `ee/` directory is reserved for future enterprise modules and
is covered by the [GenOffice Enterprise License](ee/LICENSE).

The GenOffice and Genspark names and logos are trademarks of Mainfunc, Inc.
The Apache-2.0 license does not grant permission to use them (see section 6);
forks should use their own branding.
