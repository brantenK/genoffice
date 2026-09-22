# BRIEFING — 2026-09-15T04:53:30Z

## Mission
Execute Phase 2 (Durability) remaining work for Tenders 9/10 hardening in `apps/tenders`: Live regression smoke, renderer v2 persistence cutover, and Phase 2 Oracle gate.

## 🔒 My Identity
- Archetype: orchestrator
- Roles: orchestrator, user_liaison, human_reporter, successor
- Working directory: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6
- Original parent: parent
- Original parent conversation ID: 5eb1f584-eb70-49a1-b86d-ca92126b28a4

## 🔒 My Workflow
- **Pattern**: Project
- **Scope document**: C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\SCOPE.md
1. **Decompose**: Decompose Phase 2 (Durability) remaining work into 3 clear tasks:
   - Task 2A: Live Regression Smoke of privileged IPC handlers in built Electron app
   - Task 2B: Renderer v2 Persistence Cutover (loadStoreV2 hydration, saveStoreV2 mutations, SaveStatus UI, multi-window sync, remove domain localStorage)
   - Task 2C: Quality Gates, E2E verification, and Phase 2 Oracle Gate Review
2. **Dispatch & Execute**:
   - Direct iteration loop for each milestone with Explorer -> Worker -> Reviewer (lighter gate: 1 reviewer per increment, Oracle gate at phase end per policy)
3. **On failure**:
   - Retry -> Replace -> Skip -> Redistribute -> Redesign -> Escalate
4. **Succession**: At 16 spawns, write handoff.md and spawn successor
- **Work items**:
  1. Task 2A: Live Regression Smoke [pending]
  2. Task 2B: Renderer v2 Persistence Cutover [pending]
  3. Task 2C: Quality Gates & Oracle Gate Review [pending]
- **Current phase**: 1
- **Current focus**: Task 2A & 2B Initial Survey and Planning

## 🔒 Key Constraints
- Never write, modify, or create source code files directly.
- Never run build/test commands yourself — require workers to do so.
- Never investigate or explore the problem at the code level — dispatch Explorers for technical investigation.
- File editing tools permitted ONLY for metadata/state files (.md) in .agents/orchestrator_6.
- Audit enforcement: Forensic auditor integrity violation is a binary veto.
- Gate policy: Lighter gate (one reviewer per increment, Oracle gate only at phase end, batch findings).
- Deferred items (do NOT implement now): Rotating backups + recovery UI, managed-file lifecycle (trash/undo/orphan reconciliation), main-owned readiness snapshot binding.
- Isolated scratch userData under %LOCALAPPDATA%\Temp\opencode\. Never touch real user profiles or terminate unrelated processes (PID 21200).
- Never reuse a subagent after it has delivered its handoff — always spawn fresh.

## Current Parent
- Conversation ID: 5eb1f584-eb70-49a1-b86d-ca92126b28a4
- Updated: not yet

## Key Decisions Made
- Decomposed Phase 2 into Task 2A (Live Smoke), Task 2B (Renderer v2 Cutover), and Task 2C (Quality Guards & Oracle Gate).
- Adopt lighter gate policy as specified in dispatch: 1 reviewer per increment, Oracle gate at phase end.

## Team Roster
| Agent | Type | Work Item | Status | Conv ID |
|-------|------|-----------|--------|---------|
| spec_miner_survey_1 | teamwork_preview_spec_miner | Survey specs, invariants & schemas | in-progress | 0882ab17-3556-4826-b29a-a6d962cf68b9 |
| explorer_renderer_survey_2 | teamwork_preview_explorer | Survey renderer store & IPC bindings | in-progress | 3d985998-39de-4a89-89c3-02aea8b710d9 |
| explorer_smoke_survey_3 | teamwork_preview_explorer | Survey smoke tests & quality guards | in-progress | 3c8063fe-05aa-4b5c-98d8-1918ef83aa1f |

## Succession Status
- Succession required: no
- Spawn count: 3 / 16
- Pending subagents: 0882ab17-3556-4826-b29a-a6d962cf68b9, 3d985998-39de-4a89-89c3-02aea8b710d9, 3c8063fe-05aa-4b5c-98d8-1918ef83aa1f
- Predecessor: none
- Successor: not yet spawned

## Active Timers
- Heartbeat cron: a9d4a245-3b25-475a-8aa2-4fa2652d4f58/task-12
- Safety timer: none

## Artifact Index
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\ORIGINAL_REQUEST.md — Authoritative user request
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\DISPATCH.md — Task assignment
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\BRIEFING.md — Persistent working memory
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\progress.md — Progress & liveness heartbeat
- C:\Users\brant\OneDrive\Documents\GenOffice\genoffice\.agents\orchestrator_6\SCOPE.md — Milestone decomposition & tracking
