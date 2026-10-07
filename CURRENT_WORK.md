# CURRENT_WORK.md

## Meta
- **Branch**: `main` (observed pre-checkpoint snapshot)
- **HEAD**: `9a35823` (observed pre-checkpoint snapshot: the V2.2 migration commit. This file is committed in a following documentation-only commit, so after it HEAD is that later commit; see `SHARED_CODING_WORKFLOW.md` section 12)
- **Upstream**: `origin/main`
- **Tree State**: `CLEAN (expected after the final documentation-only commit; observed pre-checkpoint snapshot: only the housekeeping records in CURRENT_WORK.md, NEXT_STEPS.md, DECISIONS.md, SHARED_CODING_WORKFLOW.md and docs/archive/BRANCH_RETIREMENTS.md were modified)`
- **Last Updated**: `2026-10-06`

## Immediate Target
- **Task**: `TBD — the owner selects the next item from NEXT_STEPS.md (items 1-3 are P1); no application work is in progress.`
- **Target Files**: `TBD — discovery required once a task is chosen`
- **Current State**: `Verified 2026-10-06 after git fetch --prune: local main, origin/main, local codex/hosted-waystation-mvp and origin/codex/hosted-waystation-mvp all at 9a35823 (the V2.2 documentation migration; before it, all four were at 452812c). main is the canonical development branch (owner decision 2026-10-06, ADR-037); codex/hosted-waystation-mvp is kept as a historical branch, is no longer mirrored, and may fall behind. codex/hosted-cloud-control was retired 2026-10-06: its tip 564d55e5abd4d85998e6f21a8689d8d1a56ca572 is preserved by the annotated tag archive/hosted-cloud-control (remote target verified), its stale worktree registration was removed, and the local and remote branches were deleted (docs/archive/BRANCH_RETIREMENTS.md). OrbiStation is the public name; repo and WAYSTATION_* identifiers keep the Waystation name (ADR-033). Production is recorded as transfer-only with no worker (QC parked, MAX_QC_BYTES=1, QC mode preview). Source-complete: pay-per-gig v2, download-URL renewal, hardening, storage purge. Deployment recorded in docs/DEPLOY.md (operator records, 2026-09-30): gateway at c141016 (contains pay-per-gig v2), then 7f520bd, then 81e07c1 (purge on, schema v7); portal pinned to 7f520bd; Coinbase off. Owner-confirmed on 2026-10-06 (not independently verified by any session; no credentials or production were accessed): email-the-link, the admin activity dashboard and embedded Stripe checkout are live. Independently verified live state: none. 48 scripts/*-proof.sh exist on disk (counted 2026-10-06; none run).`
- **Blockers**: `NONE`

## Validation
- **Last Run**: `Documentation checks only: git diff --check and git diff --cached --check; untracked-file whitespace check; local-reference check; secret-pattern scan of the staged diff; patch-fidelity check of docs/archive/BRANCH_RETIREMENTS.md against git diff 564d55e~1 564d55e; ancestry, ref and ls-remote verification for each Git step.`
- **Result**: `PASS — whitespace clean; every local reference resolves except three inside the archived history copies (docs/waystation-release.md is a cross-repository reference to the sibling OrbitWebsite repository, client/src/downloader.ts was deleted on purpose, client/public/ is gitignored); no secrets found; archive bodies identical to their HEAD originals (titles and banners changed); the retirement patch matches git output modulo trailing whitespace. NOT RUN — application builds, type-checks, proof scripts, export-client.sh, container commands (documentation-only scope).`

## Handoff Instruction
1. Run `git status --short --branch` and `git rev-parse --short HEAD`. Expect branch `main`, equal to `origin/main`, clean tree, with HEAD at or after `9a35823`; the documentation-only commits that follow it are explained by the snapshot convention. Stop and report any other difference.
2. Ask the owner which `NEXT_STEPS.md` item to start. Do not start application work unprompted.
3. Validate with: `git diff --check && git status --short --branch`
