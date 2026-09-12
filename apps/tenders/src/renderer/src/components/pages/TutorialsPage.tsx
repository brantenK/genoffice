// Tutorials: detailed step-by-step how-to guides for every Zanostack Tenders
// feature. Accordion-style cards grouped by theme, plus buttons to re-run
// the welcome walkthrough and the guided spotlight tour.
import { useState } from 'react'
import {
  BookOpen,
  Building2,
  CalendarClock,
  ChevronDown,
  FileSearch,
  FolderOpen,
  GraduationCap,
  HelpCircle,
  ListChecks,
  Sparkles,
  Users
} from 'lucide-react'
import { useTendersStore } from '../../store'
import { Badge } from '../ui'

interface Guide {
  id: string
  icon: React.ReactNode
  title: string
  minutes: string
  summary: string
  steps: React.ReactNode[]
}

interface Group {
  id: string
  label: string
  guides: Guide[]
}

const GROUPS: Group[] = [
  {
    id: 'getting-started',
    label: 'Getting started',
    guides: [
      {
        id: 'first-run',
        icon: <Sparkles size={16} />,
        title: 'Your first 10 minutes',
        minutes: '~10 min',
        summary:
          'The fastest path from zero to a compliance matrix: set up your company, check the vault, shred the demo RFP.',
        steps: [
          <>
            <strong>Review your company profile.</strong> Open{' '}
            <em>Company Profile</em> in the sidebar and confirm your registration
            number, VAT number, tax PIN, B-BBEE level, directors and past projects.
            These details feed the gap analysis and bid-readiness score.
          </>,
          <>
            <strong>Health-check the vault.</strong> Open <em>Documents</em> and look
            for red <em>Expired</em> or amber <em>Stale stamp</em> badges. Fix those
            first — they block tender submissions.
          </>,
          <>
            <strong>Shred the demo RFP.</strong> Open <em>Tenders</em> and press{' '}
            <em>Load demo RFP</em>. This runs the full pipeline on a sample document
            so you can explore the compliance matrix safely.
          </>,
          <>
            <strong>Explore the workspace.</strong> Click requirements in the matrix
            to jump to their source clauses in the PDF, then open the{' '}
            <em>Bid readiness</em> drawer to see your weighted score.
          </>,
          <>
            <strong>Take the guided tour.</strong> Press the <em>Help</em> button at
            the bottom of the sidebar (or the button at the top of this page) for an
            interactive spotlight tour of the live UI.
          </>
        ]
      }
    ]
  },
  {
    id: 'tenders',
    label: 'Tenders & shredding',
    guides: [
      {
        id: 'shred',
        icon: <FileSearch size={16} />,
        title: 'How to shred a tender RFP',
        minutes: '~2 min',
        summary:
          'Turn any RFP PDF into a compliance matrix — 100% in your browser, nothing is uploaded.',
        steps: [
          <>
            Open the <strong>Tenders</strong> page in the sidebar.
          </>,
          <>
            <strong>Drag &amp; drop</strong> the RFP PDF onto the dropzone, or press{' '}
            <strong>Choose PDF</strong> to browse, or click{' '}
            <strong>Load demo RFP</strong> for a sample.
          </>,
          <>
            Watch the <strong>progress indicator</strong>: reading the PDF →
            extracting text &amp; coordinates (page by page, including scanned pages
            via OCR) → matching compliance rules → running vault gap analysis.
          </>,
          <>
            When it finishes you land in the <strong>tender workspace</strong> with
            the compliance matrix on the left and the source PDF on the right.
            Requirements are colour-coded: fulfilled (linked vault doc), action
            required, or outstanding.
          </>,
          <>
            The tender card on the list shows a live <strong>closing countdown</strong>,
            the submission method (email / physical / portal), page count and progress
            bar. Click any card to return to its workspace.
          </>
        ]
      },
      {
        id: 'matrix',
        icon: <ListChecks size={16} />,
        title: 'Using the compliance matrix',
        minutes: '~4 min',
        summary:
          'Understand every requirement, find its source clause, and manage document links.',
        steps: [
          <>
            In the workspace, the <strong>left pane</strong> lists every requirement
            the shredder found, grouped with status badges. The bar at the top
            summarizes fulfilled / action-required / outstanding counts.
          </>,
          <>
            <strong>Click a requirement</strong> — the PDF viewer on the right jumps
            to and highlights the exact source clause. Use the zoom controls and
            page navigation to read it in detail.
          </>,
          <>
            Requirements with a <strong>confidence badge</strong> show how strongly a
            vault document matched. The <em>“Also found”</em> list under a
            requirement offers alternative vault docs when the match is ambiguous.
          </>,
          <>
            Open <strong>Company vault</strong> (top bar) to link or unlink vault
            documents for the selected requirement, then press{' '}
            <strong>Re-run gap</strong> to recompute statuses.
          </>,
          <>
            Scanned (image-only) pages count toward the <strong>scanned pages</strong>{' '}
            badge on the tender card — the OCR step handles them automatically.
          </>
        ]
      },
      {
        id: 'readiness',
        icon: <ListChecks size={16} />,
        title: 'Bid readiness score',
        minutes: '~2 min',
        summary:
          'A weighted 0–100 score telling you exactly what to fix first before submitting.',
        steps: [
          <>
            In the tender workspace press <strong>Bid readiness</strong> in the top
            bar to open the drawer.
          </>,
          <>
            The <strong>score ring</strong> combines requirement completion, vault
            health, profile completeness and signature checks with fixed weights
            (30 / 25 / 20 / 15 / 10).
          </>,
          <>
            The <strong>Biggest gain</strong> section names the single action that
            lifts your score the most — e.g. renew an expired certificate or link a
            missing document.
          </>,
          <>
            Work the list top-down, pressing <strong>Re-run gap</strong> after each
            change to see the score move.
          </>
        ]
      },
      {
        id: 'issuers',
        icon: <Building2 size={16} />,
        title: 'Recognized issuers (letterhead memory)',
        minutes: '~2 min',
        summary:
          'Recurring buyers are auto-recognized from their letterhead, with their usual submission logistics on file.',
        steps: [
          <>
            Every time you shred a tender, Zanostack Tenders analyses the{' '}
            <strong>letterhead</strong> to identify the issuing authority — even
            across different renderings (“Dept of …” vs “DEPARTMENT OF …” vs “DWS”).
          </>,
          <>
            Find the <strong>Recognized issuers</strong> section on the Tenders page
            (below your tender list). Each template shows how many tenders you've
            seen from them, their reference-number style, address, contact and
            usual submission method.
          </>,
          <>
            Templates update themselves each time a new tender from the same issuer
            is shredded (seen-count and last-seen increase).
          </>,
          <>
            Press the <strong>trash icon</strong> on a template card to forget that
            issuer.
          </>
        ]
      }
    ]
  },
  {
    id: 'vault',
    label: 'Document vault',
    guides: [
      {
        id: 'vault-browse',
        icon: <FolderOpen size={16} />,
        title: 'Browsing & filtering documents',
        minutes: '~3 min',
        summary:
          'Find any certificate fast with category and health filters; expired docs always sort to the top.',
        steps: [
          <>
            Open <strong>Documents</strong> in the sidebar. Cards show category icon,
            title, health badge and expiry summary.
          </>,
          <>
            Filter by <strong>category</strong> — compliance, financial, technical,
            governance or CV — and by <strong>health</strong> — valid, expired, stale
            stamp, no expiry info.
          </>,
          <>
            Cards are sorted with <strong>expired first</strong>, then stale stamps,
            so the riskiest documents are always at the top of the grid.
          </>,
          <>
            <strong>Click a card</strong> to open the detail panel: metadata, issue /
            expiry / certified dates, and an <em>Open PDF</em> link. Click again (or
            the × button) to close.
          </>
        ]
      },
      {
        id: 'police-stamp',
        icon: <CalendarClock size={16} />,
        title: 'The 90-day police-stamp rule',
        minutes: '~1 min',
        summary:
          'Certified documents older than 90 days are flagged stale — SA procurement convention.',
        steps: [
          <>
            South African public tenders typically reject certified copies whose{' '}
            <strong>commissioner of oath's stamp is older than 90 days</strong>{' '}
            (3 months) at submission.
          </>,
          <>
            Zanostack Tenders computes the age from each document's{' '}
            <strong>certified date</strong> and flags it{' '}
            <em>Stale stamp</em> (amber) once it passes the window.
          </>,
          <>
            Stale stamps appear in the Overview <em>Needs attention</em> banners and
            in the <strong>renewal runway</strong> — re-certify at a police station
            and update the document's certified date.
          </>
        ]
      }
    ]
  },
  {
    id: 'customers-profile',
    label: 'Customers & profile',
    guides: [
      {
        id: 'customers',
        icon: <Users size={16} />,
        title: 'Tracking customer requirements',
        minutes: '~3 min',
        summary:
          'See which customers require which documents and how many you can satisfy today.',
        steps: [
          <>
            Open <strong>Customers</strong> and use the status tabs (All / Active /
            Prospect / Inactive) to filter the list.
          </>,
          <>
            Each card shows a <strong>“N/M docs ready”</strong> progress bar — how
            many of that customer's required documents are fulfilled by your vault.
          </>,
          <>
            Click a customer to open the detail view: contact person, notes and the{' '}
            <strong>required-documents tracker</strong> listing each requirement
            with a checkmark when fulfilled and the linked vault document.
          </>,
          <>
            Missing requirements show what to obtain — fulfil them by adding the
            matching document to your vault, then linking it here.
          </>
        ]
      },
      {
        id: 'profile',
        icon: <Building2 size={16} />,
        title: 'Keeping your company profile complete',
        minutes: '~3 min',
        summary:
          'Registration, tax, B-BBEE and project history — the facts gap analysis checks you against.',
        steps: [
          <>
            Open <strong>Company Profile</strong>. The banner shows your trading
            name, industry, founding year, headcount and B-BBEE badges.
          </>,
          <>
            Review <strong>Registration &amp; compliance</strong>: CIPC number, VAT
            number, tax PIN, CSD supplier number and B-BBEE level — requirements
            like “valid tax clearance” or “registration certificate” match against
            these.
          </>,
          <>
            Keep <strong>directors</strong> and the <strong>project portfolio</strong>{' '}
            current — completed projects count toward your Overview KPIs and support
            experience-related tender requirements.
          </>,
          <>
            Filter the project portfolio by status (All / Completed / In progress /
            Bidding) with the pills above the list.
          </>
        ]
      }
    ]
  },
  {
    id: 'overview-deadlines',
    label: 'Overview & deadlines',
    guides: [
      {
        id: 'overview',
        icon: <BookOpen size={16} />,
        title: 'Reading the Overview page',
        minutes: '~2 min',
        summary:
          'KPIs, attention banners, vault health, pipeline and quick actions at a glance.',
        steps: [
          <>
            The four <strong>KPI cards</strong> (vault documents, active customers,
            tenders loaded, projects completed) are clickable shortcuts to their
            pages.
          </>,
          <>
            <strong>Needs attention</strong> banners list expired documents, stale
            police stamps and docs expiring within 60 days — click a banner to jump
            to the Documents page.
          </>,
          <>
            <strong>Document vault health</strong> and <strong>project pipeline</strong>{' '}
            panels summarize every document and project with a status badge.
          </>,
          <>
            <strong>Quick actions</strong> at the bottom link to the most common
            flows: add a customer, upload a document, shred a tender, edit the
            profile.
          </>
        ]
      },
      {
        id: 'runway',
        icon: <CalendarClock size={16} />,
        title: 'Renewal runway & calendar export',
        minutes: '~2 min',
        summary:
          'One timeline of every dated item — and a one-click .ics export into your calendar.',
        steps: [
          <>
            On the Overview page, the <strong>Renewal runway</strong> lists document
            expiries, 90-day stamp windows, tender closing dates and recommended
            submit-by times in date order — overdue items first, in red.
          </>,
          <>
            Press <strong>Download .ics</strong> to export the upcoming items as a
            calendar file; import it into Outlook / Google Calendar / your phone.
          </>,
          <>
            Tender <strong>closing countdowns</strong> also appear on each tender
            card; inside the final 24 hours you'll see the{' '}
            <em>Inside 24h submit window</em> amber badge — bid box queues close
            early, so submit before the target time, not the closing time.
          </>
        ]
      }
    ]
  },
  {
    id: 'workspaces-help',
    label: 'Workspaces & help',
    guides: [
      {
        id: 'workspaces',
        icon: <Building2 size={16} />,
        title: 'Multiple companies, separate workspaces',
        minutes: '~2 min',
        summary:
          'Manage tenders for several companies without mixing their customers, vaults or tenders.',
        steps: [
          <>
            Click your company name at the <strong>bottom-left</strong> of the sidebar
            to open the workspace switcher.
          </>,
          <>
            Select another company to switch — the active company's customers,
            vault, tenders and profile load everywhere immediately.
          </>,
          <>
            Press <strong>Add company</strong> in the switcher and fill in the
            essentials (trading name is required; the rest is editable later on the
            profile page). The new workspace starts empty.
          </>,
          <>
            Tenders you shred belong to the company that was active at the time —
            switch before shredding to keep the matrix in the right workspace.
          </>
        ]
      },
      {
        id: 'help',
        icon: <HelpCircle size={16} />,
        title: 'Re-running onboarding, tour and this page',
        minutes: '~1 min',
        summary:
          'The welcome walkthrough, guided tour and these tutorials are always available.',
        steps: [
          <>
            The <strong>Help</strong> button at the bottom of the sidebar opens a
            small menu: re-run the <strong>welcome walkthrough</strong>, take the{' '}
            <strong>guided tour</strong>, or open <strong>Tutorials</strong>.
          </>,
          <>
            The <strong>guided tour</strong> spotlights live UI elements one at a
            time — press <em>Next</em> to advance, <em>Esc</em> to end.
          </>,
          <>
            This <strong>Tutorials</strong> page is the reference manual: click any
            guide to expand its steps. Press <em>Take the guided tour</em> at the
            top of this page for the interactive version.
          </>,
          <>
            Your data lives in this browser's <strong>localStorage</strong> — nothing
            is stored on any server. Clearing site data resets the app (including
            the onboarding walkthrough).
          </>
        ]
      }
    ]
  }
]

export function TutorialsPage() {
  const startTour = useTendersStore((s) => s.startTour)
  const [openGuide, setOpenGuide] = useState<string | null>('first-run')
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      {/* header */}
      <div className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Tutorials</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Step-by-step guides for every Zanostack Tenders feature — from your first
              RFP shred to readiness scoring and deadline management.
            </p>
          </div>
          <button
            type="button"
            onClick={startTour}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            <Sparkles size={15} /> Take the guided tour
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-4xl px-8 py-8">
        {GROUPS.map((group) => {
          const groupOpen = openGroup === group.id
          return (
            <section key={group.id} className="mb-6" data-tour="tour-tutorials-page">
              <button
                type="button"
                onClick={() => setOpenGroup((g) => (g === group.id ? null : group.id))}
                className="flex w-full cursor-pointer items-center justify-between rounded-t-xl border border-slate-200 bg-white px-4 py-3 text-left transition-colors hover:bg-slate-50"
              >
                <span className="flex items-center gap-2.5">
                  <GraduationCap size={15} className="text-indigo-500" />
                  <span className="text-sm font-bold text-slate-800">{group.label}</span>
                  <span className="text-[11px] font-normal text-slate-400">
                    {group.guides.length} guide{group.guides.length === 1 ? '' : 's'}
                  </span>
                </span>
                <ChevronDown
                  size={15}
                  className={`text-slate-400 transition-transform ${groupOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {groupOpen && (
                <div className="space-y-3 border-x border-b border-slate-200 bg-slate-50/60 p-3">
                  {group.guides.map((g) => {
                    const open = openGuide === g.id
                    return (
                      <div
                        key={g.id}
                        className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
                      >
                        <button
                          type="button"
                          onClick={() => setOpenGuide((id) => (id === g.id ? null : g.id))}
                          className="flex w-full cursor-pointer items-start justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50"
                        >
                          <span className="flex min-w-0 items-start gap-3">
                            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                              {g.icon}
                            </span>
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900">
                                  {g.title}
                                </span>
                                <Badge tone="slate">{g.minutes}</Badge>
                              </span>
                              <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                                {g.summary}
                              </span>
                            </span>
                          </span>
                          <ChevronDown
                            size={15}
                            className={`mt-1 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
                          />
                        </button>

                        {open && (
                          <div className="border-t border-slate-100 px-4 py-4">
                            <ol className="space-y-3">
                              {g.steps.map((step, i) => (
                                <li key={i} className="flex gap-3">
                                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
                                    {i + 1}
                                  </span>
                                  <div className="min-w-0 text-[13px] leading-relaxed text-slate-600">
                                    {step}
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}

        <p className="pb-4 text-center text-[11px] text-slate-400">
          Still stuck? Re-run the welcome walkthrough from the Help button at the
          bottom of the sidebar.
        </p>
      </div>
    </div>
  )
}
