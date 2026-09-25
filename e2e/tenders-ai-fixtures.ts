/**
 * Fixtures for the AI-extraction end-to-end journey
 * (`tenders-ai-extraction.spec.ts`).
 *
 * The AI extraction pass reaches a model through the suite's shared plumbing
 * only: the renderer's `window.tendersApi.aiStream` bridge → the shell's
 * `ai:stream` handler → `streamForProvider` in `@genoffice/ai-provider` →
 * an HTTP request. The only place a test can stand is therefore a real HTTP
 * server speaking the provider's own wire format, and that is what this module
 * provides:
 *
 *  * `startFakeProvider()` — a `127.0.0.1` server on an EPHEMERAL port that
 *    speaks the OpenAI-compatible chat-completions SSE wire format
 *    (`packages/ai-provider/src/protocols/openai-compatible.ts` posts to
 *    `${baseUrl}/chat/completions` with `stream: true` and reads `data:` frames).
 *    It records every request it receives, so "AI is off" can be proven as
 *    "the server saw nothing" rather than inferred. It never reaches the public
 *    internet and it is closed by the caller.
 *  * `writeAiSettings()` — an `ai-settings.json` in the scratch profile selecting
 *    the `custom` provider (the catalogue's `needsBaseUrl` provider, i.e. the one
 *    `AI_BASE_URL_PROVIDERS` names) pointed at that server. This is the same file
 *    the shell's `ai:get-settings` handler reads, so the renderer sees a genuinely
 *    configured model with no test-only code path.
 *  * `generateTenderPdf()` — a one-page text PDF built at runtime, so the journey
 *    controls exactly which rules the local engine finds.
 *  * store readers/pollers and `aiMarkedPaths()` — the durable proof surface.
 *    The review UI's own "AI-suggested" marker (`AI_SUGGESTION_MARKER` below,
 *    which `ExtractionReview.tsx` owns as `AI_SUGGESTION_LABEL`) is asserted in
 *    the spec as well, and the honest-provenance invariant is asserted where the
 *    feature durably records it: `suggestedBy: 'ai'` in the authoritative v2
 *    document, which `tenders-schema.ts` validates.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ── the model-provenance marker ───────────────────────────────────────────────

/**
 * The user-visible marker a model-suggested value wears.
 *
 * `AI_SUGGESTION_LABEL` in `apps/tenders/src/renderer/src/components/ExtractionReview.tsx`
 * owns this string (`ProvenanceChip`, and the badge `RequirementList.tsx` puts on
 * a requirement row). It is restated here so the spec pins the marker the way the
 * other Tenders specs pin their user-facing strings, and
 * `apps/tenders/tests/ai-e2e-contract.test.ts` asserts the two are equal — so a
 * rename of the label fails a fast unit test rather than only the e2e.
 */
export const AI_SUGGESTION_MARKER = 'AI-suggested'

// ── the model the fake provider stands in for ─────────────────────────────────

/** Model id the settings select and the request must carry. */
export const AI_FAKE_MODEL = 'e2e-fake-model'

/** Dummy BYOK key; the request's `Authorization` header must carry exactly this. */
export const AI_FAKE_KEY = 'e2e-fake-key'

/** The provider slot used: `custom`, the catalogue's `needsBaseUrl` provider. */
export const AI_FAKE_PROVIDER = 'custom'

// ── the suggestion the fake provider returns ──────────────────────────────────

/** Closing-date value only the model suggests — the fixture document has none. */
export const AI_SUGGESTED_CLOSING_DATE = '30 November 2026 at 11:00'

/** Rule key only the model suggests: the fixture text never mentions it. */
export const AI_ONLY_RULE_KEY = 'joint_venture'

/** Title the model gives that requirement (a label, not the catalogue's). */
export const AI_SUGGESTED_REQUIREMENT_TITLE = 'Joint Venture / Consortium Agreement'

/** Verbatim clause the model quotes for it. */
export const AI_SOURCE_CLAUSE = 'Bidders must submit a signed joint venture agreement.'

/** The requirement id the core synthesises when the model supplies none. */
export const AI_SUGGESTED_REQUIREMENT_ID = `ai-req-${AI_ONLY_RULE_KEY}`

/**
 * The reply body, in the strict-JSON shape `buildExtractionPrompt` asks for.
 * Built as an object so the journey can assert against the same values it serves.
 */
export function aiReplyPayload(): Record<string, unknown> {
  return {
    metadata: [
      {
        field: 'closingDate',
        value: AI_SUGGESTED_CLOSING_DATE,
        pageNumber: 1,
        sourceClause: `Closing date: ${AI_SUGGESTED_CLOSING_DATE}`,
        confidence: 0.7,
      },
    ],
    requirements: [
      {
        ruleKey: AI_ONLY_RULE_KEY,
        title: AI_SUGGESTED_REQUIREMENT_TITLE,
        verbatimClause: AI_SOURCE_CLAUSE,
        pageNumber: 1,
        boundingBox: { top: 0.12, left: 0.1, width: 0.78, height: 0.04 },
        confidence: 0.82,
      },
    ],
    warnings: [],
  }
}

/** The reply as the model would emit it: one JSON object, no prose around it. */
export function aiReplyText(): string {
  return JSON.stringify(aiReplyPayload())
}

// ── the fake provider ─────────────────────────────────────────────────────────

/**
 * How the server answers.
 *
 *  - `sse-ok` — a real OpenAI-compatible SSE stream carrying the JSON reply.
 *  - `http-500` — an HTTP error, the provider-unavailable case.
 *  - `malformed` — HTTP 200 with a well-formed stream whose content is prose,
 *    not the JSON the prompt asked for.
 *  - `hold` — SSE headers plus a first fragment, then the connection is held
 *    open, so a run can be observed (and interrupted) while it is in flight.
 */
export type FakeProviderMode = 'sse-ok' | 'http-500' | 'malformed' | 'hold'

export interface CapturedAiRequest {
  method: string
  path: string
  authorization: string | null
  contentType: string | null
  /** parsed JSON body, or null when the body was not JSON */
  body: any
  /** the raw body, kept so a malformed request is diagnosable */
  raw: string
}

export interface FakeProviderOptions {
  mode?: FakeProviderMode
  /** Reply text for `sse-ok`; defaults to `aiReplyText()`. */
  reply?: string
  /** How long `hold` keeps the connection open before ending it. */
  holdMs?: number
}

export interface FakeProvider {
  /** `http://127.0.0.1:<port>` — the base URL a `custom` provider is configured with. */
  origin: string
  port: number
  /** Every request received so far, in arrival order. */
  requests: CapturedAiRequest[]
  requestCount(): number
  /** Change the answer for SUBSEQUENT requests (already-sent ones are unaffected). */
  setMode(mode: FakeProviderMode): void
  /** Stop listening and drop any connection still being held open. */
  close(): Promise<void>
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
} as const

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseContent(text: string): string {
  return sseFrame({ choices: [{ delta: { content: text } }] })
}

/** Split a reply into several deltas, so accumulation across frames is exercised. */
function chunkText(text: string, size: number): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length; index += size) {
    out.push(text.slice(index, index + size))
  }
  return out.length > 0 ? out : ['']
}

/**
 * Start the fake provider on an ephemeral `127.0.0.1` port.
 *
 * Binding `127.0.0.1` with port `0` means no fixed port to collide with and no
 * reachability from off-machine. The caller must `close()` it (the spec does so
 * in a `finally`), so no handle outlives the run.
 */
export function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const requests: CapturedAiRequest[] = []
  let mode: FakeProviderMode = options.mode ?? 'sse-ok'
  const holdMs = options.holdMs ?? 30_000

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization:
          typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        contentType:
          typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
        body: parsed,
        raw,
      })

      if (mode === 'http-500') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('E2E fake provider: forced failure')
        return
      }

      if (mode === 'malformed') {
        res.writeHead(200, SSE_HEADERS)
        res.write(sseContent('I am sorry, I cannot help with that request.'))
        res.write(sseFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (mode === 'hold') {
        res.writeHead(200, SSE_HEADERS)
        // A first fragment, so the run is visibly in flight (the transport
        // accumulates it) and the reply never completes.
        res.write(sseContent('{"metadata":['))
        const timer = setTimeout(() => {
          try {
            res.end()
          } catch {
            // the client is already gone
          }
        }, holdMs)
        res.on('close', () => clearTimeout(timer))
        return
      }

      res.writeHead(200, SSE_HEADERS)
      for (const piece of chunkText(options.reply ?? aiReplyText(), 200)) {
        res.write(sseContent(piece))
      }
      res.write(sseFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  return new Promise<FakeProvider>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        requestCount: () => requests.length,
        setMode: (next) => {
          mode = next
        },
        close: () =>
          new Promise<void>((done) => {
            // A connection held open in `hold` mode would keep `close()` pending
            // forever; drop them first (Node >= 18.2).
            ;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

// ── settings ──────────────────────────────────────────────────────────────────

/**
 * The stored settings object, exactly as the shell's `ai-settings.json` holds it.
 *
 * `custom` is chosen deliberately: it is the catalogue's only `needsBaseUrl`
 * provider, so it is the only selection that can be pointed at a local server
 * without patching anything. `resolveAiSettings` merges this over the package
 * defaults and `activeProvider` keeps `custom` because the config carries a
 * model, a base URL and a key — the same three conditions
 * `aiExtractionAvailability` checks.
 *
 * Exported (and used by `writeAiSettings` below) so
 * `apps/tenders/tests/ai-e2e-contract.test.ts` can run the REAL shell
 * resolution and the REAL availability helper over the very object the journey
 * writes to disk — the one link in this chain that cannot be observed from a
 * unit test is the file's location, which is why the spec also asserts the
 * toggle is offered at runtime.
 */
export interface AiSettingsFile {
  provider: string
  providers: Record<string, { apiKey: string; model: string; baseUrl?: string }>
}

export function aiSettingsFile(providerOrigin: string): AiSettingsFile {
  return {
    provider: AI_FAKE_PROVIDER,
    providers: {
      [AI_FAKE_PROVIDER]: {
        apiKey: AI_FAKE_KEY,
        model: AI_FAKE_MODEL,
        baseUrl: `${providerOrigin}/v1`,
      },
    },
  }
}

/** Where the shell reads its AI settings from: `<userData>/ai-settings.json`. */
export const AI_SETTINGS_FILE_NAME = 'ai-settings.json'

/**
 * Write `ai-settings.json` into the scratch profile so the shell's own
 * `ai:get-settings` handler resolves a usable model.
 *
 * The scratch profile IS the shell's `userData` directory: `launchShell` passes
 * it as `GENOFFICE_USER_DATA`, which the shell's main process hands to
 * `app.setPath('userData', …)`, and `SETTINGS_PATH()` in the shell is
 * `userDataPath('ai-settings.json')`. The same directory carries the
 * `app-settings.json` the launcher writes, so this file lands where the shell
 * reads it. It is written before `launchShell`, so the first `ai:get-settings`
 * call already sees it.
 */
export async function writeAiSettings(
  userDataDir: string,
  providerOrigin: string,
): Promise<string> {
  await mkdir(userDataDir, { recursive: true })
  const path = join(userDataDir, AI_SETTINGS_FILE_NAME)
  await writeFile(path, JSON.stringify(aiSettingsFile(providerOrigin), null, 2), 'utf8')
  return path
}

// ── the fixture document ──────────────────────────────────────────────────────

/** Reference the fixture's own text carries, and the parser therefore reads. */
export const TENDER_FIXTURE_REF = 'E2E/AI/2026/01'

/** A second reference, so a journey can import twice without colliding. */
export const TENDER_FIXTURE_REF_TWO = 'E2E/AI/2026/02'

/**
 * The fixture's lines — the single source of truth for both the e2e journey and
 * the unit contract test that verifies what the local engine reads from them.
 *
 * Deliberately free of any closing-date, submission-method/destination and
 * joint-venture wording:
 *
 *  * no closing-date line, so `closingDate` is null from the parser and the
 *    model's suggestion is the only thing that can fill it;
 *  * `joint_venture` is the one rule key only the model ever reports, so the
 *    model's requirement is genuinely additive;
 *  * `tax_pin` and `coida` are the local engine's own finds, so "the local
 *    result survives alongside the model's" has something concrete to check.
 */
export function tenderFixtureLines(reference: string): string[] {
  return [
    'E2E AI WATER AUTHORITY',
    'REQUEST FOR PROPOSAL',
    'Supply of Water Metering Equipment',
    `Reference Number: ${reference}`,
    'A valid SARS tax clearance certificate must accompany the proposal.',
    'A valid COIDA letter of good standing must accompany the proposal.',
  ]
}

/**
 * One-page text PDF built at runtime, so the journey controls exactly what the
 * local rule engine reads.
 */
export async function generateTenderPdf(targetPath: string, lines: string[]): Promise<void> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  let y = 780
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 24
  }
  const bytes = await doc.save()
  await writeFile(targetPath, Buffer.from(bytes))
}

// ── the authoritative store ───────────────────────────────────────────────────

// `storeFile`, `readStore` and `pollStore` all live in `./tenders-timing`, which
// owns and justifies the lane's poll windows. Re-exported here so this module's
// existing consumers keep importing them from the fixture module they use, and
// so there is exactly one `pollStore` implementation in the lane.
export { storeFile, readStore, pollStore } from './tenders-timing'

export function allTenders(store: any): any[] {
  const out: any[] = []
  for (const workspace of store?.workspaces ?? []) {
    for (const tender of workspace?.tenders ?? []) out.push(tender)
  }
  return out
}

export function findTenderByReference(store: any, reference: string): any | undefined {
  return allTenders(store).find((tender) => tender?.referenceNumber === reference)
}

/** One place the authoritative document records model provenance. */
export interface AiMarkedValue {
  /** JSON path inside the v2 document, e.g. `$.workspaces[0].tenders[0].requirements[3]` */
  path: string
  ruleKey?: string
  value?: string
}

/**
 * Every `suggestedBy: 'ai'` marker in the document, with its path.
 *
 * A whole-document scan, not a targeted lookup: "no model value was written"
 * has to mean *nowhere* in the document, or a marker could survive in a place
 * nobody thought to check.
 */
export function aiMarkedPaths(store: unknown): AiMarkedValue[] {
  const found: AiMarkedValue[] = []
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (record.suggestedBy === 'ai') {
      found.push({
        path,
        ...(typeof record.ruleKey === 'string' ? { ruleKey: record.ruleKey } : {}),
        ...(typeof record.value === 'string' ? { value: record.value } : {}),
      })
    }
    for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`)
  }
  walk(store, '$')
  return found
}

/** Review states a machine suggestion may never produce. */
export const HUMAN_DECIDED_FIELD_STATES = ['confirmed', 'corrected', 'not_stated'] as const
