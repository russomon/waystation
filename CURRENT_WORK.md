# CURRENT_WORK.md

## Meta
- **Branch**: `claude/orbistation-security-and-proof-hardening` (observed pre-checkpoint snapshot)
- **HEAD**: `c324342` (observed pre-checkpoint snapshot: the last commit before the final documentation-and-runner checkpoint; after that commit HEAD is the checkpoint, see `SHARED_CODING_WORKFLOW.md` section 12)
- **Upstream**: `origin/claude/orbistation-security-and-proof-hardening`
- **Tree State**: `CLEAN (expected after the final checkpoint commit; observed pre-checkpoint snapshot: uncommitted proof runner, review summary, workflow and queue updates)`
- **Last Updated**: `2026-10-06`

## Immediate Target
- **Task**: `Independent review of the unmerged review branch (trusted API origin, owner-based upload recovery, live-feature documentation, proof runner); the owner decides on merge and deployment.`
- **Target Files**: `gateway/src/publicOrigin.ts`, `gateway/src/ownership.ts`, `gateway/src/routes.ts`, `scripts/run-proofs.mjs`, `scripts/upload-recovery-proof.sh`, `docs/HOSTED_FEATURES.md`, `docs/reviews/2026-10-06-security-and-proof-hardening.md`
- **Current State**: `main and origin/main are at b16a109 and were not touched. The review branch adds four reviewable commits plus a final checkpoint on top of it; nothing is merged, deployed or opened as a pull request. Source-complete and locally validated on the branch: download links from a configured WAYSTATION_PUBLIC_API_ORIGIN (production refuses to start without it); upload ownership by recorded owner; a discovery-based proof runner. Email-the-link, the admin dashboard and embedded Stripe checkout are documented from source and owner-confirmed live on 2026-10-06, not independently verified. Deployment recorded in docs/DEPLOY.md is unchanged (operator records of 2026-09-30); the branch's changes are NOT deployed. Local full-suite result with the runner: 44 passed, 1 failed (qc-proof.sh, which also fails on main at b16a109), 0 skipped, 4 not run (docker), so no suite acceptance. codex/hosted-waystation-mvp is kept as a historical branch.`
- **Blockers**: `Independent review and owner decision to merge. Deployment needs the operator prerequisites in docs/DEPLOY.md (confirm WAYSTATION_PUBLIC_API_ORIGIN). Docker proofs need owner approval to run on the shared Docker daemon.`

## Validation
- **Last Run**: `( cd gateway && npx tsc --noEmit ); ( cd gateway && npm test ); node --test scripts/test/run-proofs.test.mjs; npm -w client run build; pipeline import check; node scripts/run-proofs.mjs (whole suite, local MinIO and mocks only); git diff --check; staged secret-pattern scan`
- **Result**: `PASS — tsc clean; 16 of 16 gateway unit tests; 25 of 25 runner tests; client build and worker import pass. Suite: 44 passed, 1 FAILED (qc: "metering missing entries", pre-existing on main), 0 skipped, 4 NOT RUN (archive-tools-docker, broadcast-qc-docker, compute, docker: need --docker); FAILED, not an acceptance. No live service, credential or production access was used.`

## Handoff Instruction
1. Run `git status --short --branch` and `git rev-parse --short HEAD`; expect branch `claude/orbistation-security-and-proof-hardening`, a clean tree, HEAD at or after `c324342`. Stop and report any difference the snapshot convention does not explain.
2. Read `docs/reviews/2026-10-06-security-and-proof-hardening.md`, then review `git diff main...HEAD`. Do not merge, open a pull request or deploy without the owner's decision.
3. Validate with: `( cd gateway && npx tsc --noEmit && npm test ) && node --test scripts/test/run-proofs.test.mjs && git diff --check`
