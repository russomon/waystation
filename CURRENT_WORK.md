# CURRENT_WORK.md

## Meta
- **Branch**: `claude/orbistation-security-and-proof-hardening` (observed pre-checkpoint snapshot)
- **HEAD**: `0df8918` (observed pre-checkpoint snapshot: the last commit before the temp-confinement repair; after that commit HEAD is the checkpoint, see `SHARED_CODING_WORKFLOW.md` section 12)
- **Upstream**: `origin/claude/orbistation-security-and-proof-hardening`
- **Tree State**: `CLEAN (expected after the final checkpoint commit; observed pre-checkpoint snapshot: uncommitted temp-confinement repair)`
- **Last Updated**: `2026-10-06`

## Immediate Target
- **Task**: `Independent review of the unmerged review branch (trusted API origin, owner-based upload recovery, live-feature documentation, proof runner); the owner decides on merge and deployment.`
- **Target Files**: `gateway/src/publicOrigin.ts`, `gateway/src/ownership.ts`, `gateway/src/routes.ts`, `scripts/run-proofs.mjs`, `scripts/upload-recovery-proof.sh`, `docs/HOSTED_FEATURES.md`, `docs/reviews/2026-10-06-security-and-proof-hardening.md`
- **Current State**: `main and origin/main are at b16a109 and were not touched. The review branch (0df8918 plus one temp-confinement repair) is unmerged, undeployed and has no pull request. The 2026-10-06 reviews found five issues, all repaired on the branch: (5) the sandbox still let a script overwrite, truncate or rename other programs' files in /tmp and /var/folders, so writes are now confined to the repo and the run's own directory and every proof keeps its logs and fixtures there; (1) DECISIONS.md had been truncated by my own editing error and is restored with ADR-001..041 plus a test guarding it; (2) the proof runner now enforces its limits with a macOS sandbox instead of trusting a text scan; (3) the toggle proof no longer deletes a fixed /tmp directory and the exemption file is gone; (4) the port check covers IPv6 and the sandbox blocks signalling processes a script did not start. Source-complete and locally validated: download links from a configured WAYSTATION_PUBLIC_API_ORIGIN (production refuses to start without it); upload ownership by recorded owner; a discovery-based proof runner. Email-the-link, the admin dashboard and embedded Stripe checkout are documented from source and owner-confirmed live on 2026-10-06, not independently verified. docs/DEPLOY.md is unchanged apart from the unexecuted API-origin prerequisites; nothing on this branch is deployed. Local sandboxed full-suite rerun: 44 passed, 1 failed (qc-proof.sh, which also fails on main at b16a109), 0 skipped, 4 not run (docker): no suite acceptance. codex/hosted-waystation-mvp is kept as a historical branch.`
- **Blockers**: `Independent review and owner decision to merge. Deployment needs the operator prerequisites in docs/DEPLOY.md (confirm WAYSTATION_PUBLIC_API_ORIGIN). Docker proofs need owner approval to run on the shared Docker daemon.`

## Validation
- **Last Run**: `( cd gateway && npx tsc --noEmit ); ( cd gateway && npm test ); node --test scripts/test/*.test.mjs; node scripts/run-proofs.mjs (whole suite, sandboxed, local MinIO and mocks only); git diff --check; staged secret-pattern scan`
- **Result**: `PASS — tsc clean; 16 of 16 gateway unit tests; 40 of 40 runner and decision-record tests (including real sandbox-enforcement tests). Suite: 44 passed, 1 FAILED (qc: "metering missing entries", pre-existing on main), 0 skipped, 4 NOT RUN (archive-tools-docker, broadcast-qc-docker, compute, docker: need --docker); FAILED, not an acceptance. No live service, credential or production access was used.`

## Handoff Instruction
1. Run `git status --short --branch` and `git rev-parse --short HEAD`; expect branch `claude/orbistation-security-and-proof-hardening`, a clean tree, HEAD at or after `0df8918`. Stop and report any difference the snapshot convention does not explain.
2. Read `docs/reviews/2026-10-06-security-and-proof-hardening.md`, then review `git diff main...HEAD`. Do not merge, open a pull request or deploy without the owner's decision.
3. Validate with: `( cd gateway && npx tsc --noEmit && npm test ) && node --test scripts/test/*.test.mjs && git diff --check`
