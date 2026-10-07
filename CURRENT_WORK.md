# CURRENT_WORK.md

## Meta
- **Branch**: `claude/orbistation-security-and-proof-hardening` (observed pre-checkpoint snapshot)
- **HEAD**: `6b5ccb0` (observed pre-checkpoint snapshot: the last commit before the Docker-isolation checkpoint; 179e3b1 and the commit(s) that follow it are this pass's scoped commits; after that commit HEAD is the checkpoint, see `SHARED_CODING_WORKFLOW.md` section 12)
- **Upstream**: `origin/claude/orbistation-security-and-proof-hardening`
- **Tree State**: `CLEAN (expected after the final checkpoint commit; observed pre-checkpoint snapshot: uncommitted Docker-isolation scripts, tests and documents)`
- **Last Updated**: `2026-10-07`

## Immediate Target
- **Task**: `Owner reviews the proof repair and the Docker isolation, then decides whether to approve running the four Docker proofs and which gateway image to use; independent review of the unmerged review branch continues.`
- **Target Files**: `gateway/src/publicOrigin.ts`, `gateway/src/ownership.ts`, `gateway/src/routes.ts`, `scripts/run-proofs.mjs`, `scripts/upload-recovery-proof.sh`, `docs/HOSTED_FEATURES.md`, `docs/reviews/2026-10-06-security-and-proof-hardening.md`
- **Current State**: `main and origin/main are at b16a109 and were not touched. The review branch is unmerged, undeployed and has no pull request. 2026-10-07 pass: the qc-proof.sh failure was a stale proof expectation and is repaired with the billing behaviour preserved (a deterministic fallback poster is free; an AI-selected poster is billed once per the existing billable-event contract; no application, price or payment code changed). scripts/qc-proof.sh now asserts the free fallback; the new scripts/thumbnail-metering-proof.sh asserts the billed AI case against a local mock GMI; four worker-billing mutations were each caught and the worker restored. The four Docker proofs were rewritten to be isolated (scripts/lib/docker-isolation.sh: approval gates, unique labelled resources, label-only cleanup, no .env, no mounts, loopback ports, resource caps, no builds/pulls/tags of shared names, byte-identical image verification) and tested without a daemon; none was executed, nothing was built, pulled or tagged. The only local gateway image predates this branch and cannot match, so docker-proof is BLOCKED on a gateway image; the worker candidate is unverified. Sandboxed non-Docker suite at this pass: 46 passed, 0 failed, 0 skipped, 4 not run (docker): INCOMPLETE, no suite acceptance. Earlier findings and repairs from the 2026-10-06 reviews are unchanged. Production is recorded as transfer-only (docs/DEPLOY.md); nothing on this branch is deployed.`
- **Blockers**: `Owner decisions: approve (or decline) running the Docker proofs on the shared daemon one at a time; decide the gateway image (authorize --docker-build with external network access, or leave docker-proof BLOCKED). Independent review and owner decision to merge. Deployment prerequisites in docs/DEPLOY.md are unchanged.`

## Validation
- **Last Run**: `node scripts/run-proofs.mjs --only qc (11 scripts, sandboxed); node scripts/run-proofs.mjs --only thumbnail-metering; four worker-billing mutations; node --test scripts/test/*.test.mjs; bash -n on all proofs; node scripts/run-proofs.mjs (whole suite, sandboxed); plan-mode runs of the four Docker proofs against a stub docker; read-only docker image inspect of three existing images; git diff --check; staged secret-pattern scan`
- **Result**: `PASS with 4 NOT RUN — 70 of 70 runner, decision-record and Docker-isolation tests; --only qc: 10 passed, 0 failed, 1 not run; thumbnail-metering: pass; mutations: caught; full sandboxed suite: 46 passed, 0 failed, 0 skipped, 4 not run (archive-tools-docker, broadcast-qc-docker, compute, docker), so INCOMPLETE and no full-suite acceptance. No Docker workload was started and no image built, pulled or tagged; no live service or credential was touched.`

## Handoff Instruction
1. Run `git status --short --branch` and `git rev-parse --short HEAD`; expect branch `claude/orbistation-security-and-proof-hardening`, a clean tree, HEAD at or after `179e3b1`. Stop and report any difference the snapshot convention does not explain.
2. Read `docs/reviews/2026-10-06-security-and-proof-hardening.md`, then review `git diff main...HEAD`. Do not merge, open a pull request or deploy without the owner's decision.
3. Validate with: `( cd gateway && npx tsc --noEmit && npm test ) && node --test scripts/test/*.test.mjs && git diff --check`
