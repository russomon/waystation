# SHARED_CODING_WORKFLOW.md — Authoritative Workflow V2.2

This file is the single operating procedure for agents working in this repository. `AGENTS.md` defines universal rules and schemas; this file defines how a session is run.

## 1. Start Safely

From the repository root, inspect the local state before editing:

```bash
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git diff --stat
git remote -v
```

Then read, when present:

1. `AGENTS.md`
2. any more-specific `AGENTS.md` governing the target path
3. `SHARED_CODING_WORKFLOW.md`
4. `CURRENT_WORK.md`
5. `NEXT_STEPS.md`
6. `DECISIONS.md`
7. relevant sections of `docs/ARCHITECTURE.md` and `docs/REPO_MAP.md`
8. platform-specific guidance only when using that platform

Do not edit yet. Compare the documented branch, HEAD, tree state, immediate task, and blockers with the observed repository state.

## 2. Establish the Working Branch

Use this decision order:

1. If the tree is dirty, preserve it. Inspect enough to identify the changes. Do not switch branches, pull, stash, reset, clean, or incorporate the changes until their ownership and relationship to the task are understood.
2. If the current branch is valid and consistent with `CURRENT_WORK.md`, remain on it.
3. If the tree is clean and `CURRENT_WORK.md` clearly names another existing branch, verify that branch and its upstream before switching.
4. If the intended branch is `TBD`, `UNKNOWN`, missing, or inconsistent with Git, stop before changing branches and report the ambiguity.
5. Never switch to the default branch merely by habit.

## 3. Verify and Synchronize Remote State

If a remote is configured and network access is allowed, refresh remote references:

```bash
git fetch --prune origin
```

Identify the upstream and compare ancestry:

```bash
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rev-list --left-right --count HEAD...'@{upstream}'
```

Interpret the counts as local-only and upstream-only commits.

- `0 0`: synchronized.
- `0 N`: local branch is behind; if the tree is clean, fast-forward with `git pull --ff-only` or the repository's documented equivalent.
- `N 0`: local branch is ahead; do not push unless the current request or closing procedure authorizes it.
- `N M`: diverged; stop and report. Do not merge, rebase, reset, or force-push without explicit direction.
- No upstream or inaccessible remote: record the limitation; do not claim synchronization.

After any synchronization, re-run:

```bash
git status --short --branch
git rev-parse --short HEAD
```

Remote status is verified only after a successful authenticated fetch. A cached tracking reference or failed web request is not proof of current remote state.

## 4. Confirm the Handoff

Before implementation, report or internally establish:

- current branch and HEAD;
- clean or dirty tree, including relevant uncommitted work;
- upstream and synchronization status;
- immediate target and known target files;
- applicable decisions and architecture boundaries;
- validation expectations;
- blockers, contradictions, and `TBD`/`UNKNOWN` fields.

If repository state contradicts the handoff, trust verified evidence, preserve both states, and resolve or report the discrepancy before editing.

## 5. Load Context Economically

Start with repository context, change summaries, relevant entry points, and targeted tests. Inspect full diffs, broader history, generated files, or unrelated subsystems only when needed.

Use `docs/REPO_MAP.md` to locate code and `docs/ARCHITECTURE.md` to understand boundaries. Do not infer behavior from filenames alone. Mark unresolved facts `UNKNOWN` and state how they can be verified.

## 6. Work Within Scope

- Make the smallest coherent change that satisfies the current request.
- Preserve unrelated edits and untracked files.
- Follow more-specific repository instructions for files within their scope.
- Do not broaden a review-only, planning, documentation, or diagnostic request into implementation.
- Do not change architecture, security controls, deployment state, external systems, or adjacent repositories unless authorized.
- Never expose or commit secrets, credentials, tokens, private keys, or sensitive generated evidence.
- Update context files during the work only when doing so prevents a misleading handoff; otherwise finalize them after validation.

## 7. Validate Proportionately

Use the repository's documented commands and the checks appropriate to the changed surface. Typical layers are:

1. targeted tests for changed behavior;
2. formatting, linting, or static analysis;
3. broader test/build checks required by repository policy;
4. manual or integration verification where automation is insufficient.

Record exact commands and results. Distinguish pass, fail, and not run. Do not translate skipped or unavailable checks into success. If a check can mutate data, infrastructure, or external systems, confirm it is in scope before running it.

## 8. Review the Final Change Set

Before checkpointing:

```bash
git status --short --branch
git diff --stat
git diff --check
```

Review the complete relevant diff. Confirm every change is intentional and no temporary, generated, debug, cache, secret, credential, or unrelated file is included.

## 9. Update Shared Context

Apply the schemas in `AGENTS.md`.

- `CURRENT_WORK.md`: replace the old snapshot with the verified current state, validation result, blockers, and exact handoff.
- `NEXT_STEPS.md`: reorder only the concise active queue; remove completed items and identify real blockers.
- `DECISIONS.md`: add or supersede entries only for durable decisions, including rationale and invariant.
- `docs/ARCHITECTURE.md`: update only when stable structure, boundaries, interfaces, or rationale changed.
- `docs/REPO_MAP.md`: update only when locations or responsibilities changed enough to mislead.
- `AGENTS.md` or this workflow: update only when the shared contract itself changed.

Distill conclusions; never paste chat logs or terminal transcripts.

Because a new commit changes `HEAD`, use the planned commit value or a clearly labeled pre-commit value while drafting `CURRENT_WORK.md`, then correct it after the checkpoint if needed. Do not amend merely to chase a self-referential hash; repository policy may permit `HEAD` to name the code commit immediately preceding a documentation-only handoff commit. If so, state that convention explicitly.

## 10. Create a Checkpoint

Prefer a clean, pushed checkpoint when the work is coherent and the closing request authorizes commit and push.

1. Stage only intentional files.
2. Review the staged diff and run `git diff --cached --check`.
3. Commit with a descriptive message.
4. Push the current branch to its configured upstream, without force.

Do not rewrite history, force-push, hard-reset, discard changes, or hide unfinished work.

If the work is not appropriate to commit, preserve it in place and make the dirty state explicit in `CURRENT_WORK.md` and the final report. A clean tree is preferred; a truthful dirty handoff is required.

## 11. Verify and Report the Handoff

After checkpointing, verify:

```bash
git status --short --branch
git rev-parse --short HEAD
```

When remote access is available, verify the pushed relationship rather than assuming it.

The final handoff report must state:

- final branch and HEAD;
- upstream/push status and whether it was verified;
- clean or dirty tree;
- material changes;
- exact validation commands and results;
- context files updated;
- unresolved failures, blockers, uncertainty, or uncommitted work;
- the first concrete action for the next agent.

Never claim completion from aggregate green output alone. Completion requires the requested scope, relevant validation, final state, and blockers to be reported accurately.

## 12. Repository Profile — Waystation / OrbiStation

Repository-specific values for the procedure above. They add to it and do not replace it.

### Location and platform files

- Repository root: `/Users/Shared/Orbit/Code/waystation`; remote `origin` (SSH) is `git@github.com:russomon/waystation.git` and is **public**.
- Adapters: `.cursor/commands/resume.md` and `handoff.md` and `CLAUDE.md` point here and hold no procedure. Read `SETUP.md` when touching B2 or GMI, and `docs/DEPLOY.md` before touching production.

### Branch policy (owner decision 2026-10-06; ADR-037)

- `main` is the **canonical development branch** going forward. Ordinary work happens on `main`. The earlier arrangement (`codex/hosted-waystation-mvp` as trunk, `main` as follower) is replaced; the `codex/` prefix was only a name from when the work started.
- Use a separate named branch only for parallel or risky work, and merge or delete it promptly; a stale branch is a trap for the next agent. Make sure the current branch is pushed before switching machines.
- **Transition (completed 2026-10-06).** The V2.2 checkpoint was committed on `codex/hosted-waystation-mvp` and `main` adopted it by fast-forward. `codex/hosted-waystation-mvp` is kept as a historical branch, is no longer mirrored, and may fall behind `main`; do not do new work there. To advance `main` from another branch, verify `git merge-base --is-ancestor main <branch>`, then `git merge --ff-only <branch>` and `git push origin main`, each step explicitly authorized, stopping on any divergence.
- No branch deletion is authorized by this policy. Remove a worktree registration only after confirming its directory is missing and a prune dry-run lists exactly that one registration (never a broad prune). `codex/hosted-cloud-control` was retired on 2026-10-06; its tip is the tag `archive/hosted-cloud-control` (`docs/archive/BRANCH_RETIREMENTS.md`).
- Never force-push, reset hard, or rewrite history.

### Handoff snapshot convention

`CURRENT_WORK.md` **Meta** records an observed, pre-checkpoint snapshot: the Branch, HEAD, Upstream and Tree State seen while the file was being written. A documentation-only checkpoint commit necessarily changes HEAD and cleans the tree, so after such a commit HEAD names the code commit that preceded it, and a clean tree is expected. Do not invent a future hash, and do not amend repeatedly to chase a self-referential hash. An incoming agent verifies Git itself (section 1) and trusts what it observes; a difference explained by the documentation checkpoint is not a reason to stop. Any other difference is.

### Fresh-machine setup

```sh
npm install                                     # workspaces
npm run build:wasm                              # needs cargo + wasm-pack
( cd pipeline && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt )
bash scripts/fetch-photon.sh                    # optional: IMF/Photon (needs openjdk + maven)
cp .env.example .env                            # then fill in per SETUP.md; never commit .env
```

Host tools: `ffmpeg`/`ffprobe`, `minio` (for the proof scripts), optionally `mediainfo`, `docker`/`colima`, `cloudflared`, `openjdk` + `maven`. Run the whole stack locally on MinIO with `bash scripts/dev-up.sh` (localhost:5173), or on real B2 + GMI with `bash scripts/live-event-run.sh`.

### Validation commands

Compile checks are cheap; run all three whenever source changed:

```sh
( cd gateway && npx tsc --noEmit )              # gateway type-check
( cd gateway && npm test )                      # gateway unit tests (node:test)
npm -w client run build                         # client build
( cd pipeline && PIPELINE_SHARED_SECRET=x B2_BUCKET=b B2_S3_ENDPOINT=http://x \
    B2_KEY_ID=x B2_APP_KEY=x B2_REGION=x .venv/bin/python -c "import worker" )
```

Documentation-only work (including shared-context migration) needs none of these. Validate it with `git diff --check`, a local-reference check, and a secret scan instead, and say that the application checks were not run.

Proof scripts are self-contained on MinIO + ffmpeg and need no cloud credentials. Run those covering the area touched, and all of them before a submission-worthy handoff. Each prints `PASS ✓` or `FAIL`; scripts that need docker or Photon self-skip with instructions. **`ls scripts/*-proof.sh` is authoritative, not this table or any stored count**; the table went stale before. Do not run proofs for a documentation-only or review-only request.

**Suite runner.** `node scripts/run-proofs.mjs` (`npm run proofs`) discovers every `scripts/*-proof.sh`, runs them one at a time, and reports each as exactly one of `PASS`, `FAIL`, `SKIP` or `NOT_RUN`. Only a run in which every discovered script passed prints `ACCEPTED`; any skip or not-run makes it `INCOMPLETE, NOT AN ACCEPTANCE` (exit 2), a failure exits 1, and `--only`/`--skip` runs are labelled a selection. **A text scan of a script is never what authorizes it** (URLs and paths can sit in variables, a script can call another script). Each script runs inside a macOS `sandbox-exec` profile that enforces: network to this machine only, no Docker/Colima socket, file writes only to the repository (never `.git` or `.env*`) and a private, uniquely created per-run temp directory (`TMPDIR`, caches and the JVM temp dir point at it; `/tmp`, `/var/folders` and home caches are not writable, so no pre-existing file elsewhere can be created over, overwritten, truncated, renamed or deleted; proofs keep their logs and fixtures in `$TT`, which is `$TMPDIR`), no reads of `.env*` or cloud/SSH credential directories, and signals only to processes inside the sandbox (so a port-wide `kill` cannot terminate a stranger). Ambient credentials are dropped from the environment. With no sandbox available (not macOS, or already sandboxed) every script is `NOT_RUN`; there is no unsandboxed mode. `--docker` and `--external` lift the Docker-socket and network limits for scripts that need them; `--docker` also marks the Docker proofs approved, and `--docker-build` / `--docker-pull` additionally authorize image builds / pulls (external mirrors). The sandbox does **not** constrain what the Docker daemon does for a script that can reach it, so the four Docker proofs enforce their own isolation through `scripts/lib/docker-isolation.sh`: unique labelled resources, cleanup by label only, no `.env`, no host mounts, loopback ports, resource caps, no builds/pulls/tags of shared names, and an existing image is used only if its application files are byte-identical to this tree (otherwise BLOCKED). A script is also `NOT_RUN` while a port it names is in use on IPv4 or IPv6 loopback. `--list` shows what the runner would do without running anything. Its tests, including real sandbox-enforcement tests, are `node --test scripts/test/*.test.mjs` (`npm run test:runner`; also covers the decision-record checks and the Docker-isolation guard, which never reaches a daemon); gateway unit tests are `( cd gateway && npm test )`.

| Script | Covers |
|---|---|
| `scripts/access-proof.sh` | hosted-MVP access control: session required on every upload route, cross-owner ownership refused (and same-owner new session allowed), input validation, exact credentialed CORS + preflight-before-auth, cost ceilings + kill switch, recipient scoping, `/healthz` non-disclosure |
| `scripts/coverage-proof.sh` | detection-coverage upgrades: tiled signal analysis, blind-pass audio, scene/anomaly frame selection, duration scaling, lip-sync proxy |
| `scripts/avsync-proof.sh` | SyncNet AV-sync analyzer: honest-absence FYI, model cannot clear lip_sync; measures offset when SyncNet installed |
| `scripts/hybrid-proof.sh` | perceive-then-compute hybrid: align recovers/abstains, channel-semantics flags dialogue-on-LFE, hybrid WARN→SUSPECTED but PASS never CLEARs (no cloud) |
| `scripts/agentic-qc-proof.sh` | agentic charter, evidence allowlist, 18-risk accounting, no-repair contract |
| `scripts/qc-proof.sh` | deterministic AV + caption QC |
| `scripts/netflix-qc-proof.sh` | Netflix profile, tiers, reporter-only mode, PSE, VMAF |
| `scripts/ai-qc-proof.sh` | blind/informed/critic passes, adaptive evidence, ASR, escalation |
| `scripts/synthetic-qc-proof.sh` | synthetic/generative lane + prompt adherence + reliability-passport fields |
| `scripts/jury-proof.sh` | blind cross-family jury: reducer replay, contested-stays-suspected, prompt blindness, honest single_source |
| `scripts/proficiency-proof.sh` | proficiency foundry: blind planted-defect scoring, manifest provenance, citation states, dirty-worktree refusal, WORM publish |
| `scripts/toggle-proof.sh` | sender service toggles / transfer-only |
| `scripts/delivery-proof.sh` | delivery endpoint + Genblaze manifest verify |
| `scripts/object-lock-proof.sh` | WORM manifest immutability |
| `scripts/phase2-loop-proof.sh` | signed event → pipeline → derivatives |
| `scripts/compute-proof.sh` | local vs Docker worker routing (needs docker) |
| `scripts/docker-proof.sh` | the shipped containers run the full loop (needs docker) |
| `scripts/photon-proof.sh` | Netflix Photon executes on an IMF package |
| `scripts/mediainfo-proof.sh` | optional MediaInfo wrapper/profile checks |
| `scripts/archive-tools-proof.sh` | optional QCTools/MediaConch availability, provenance, and never-silent missing behavior |
| `scripts/archive-tools-docker-proof.sh` | worker image contains pinned headless qcli/MediaConch, qcli generates a report, and no GUI apps exist (needs docker) |
| `scripts/broadcast-qc-proof.sh` | versioned U.S. broadcast XDCAM baseline with actual good/bad media and pure reducer fixtures |
| `scripts/broadcast-qc-docker-proof.sh` | pinned MediaConch MAXML metadata-policy pass/fail outcomes (needs docker) |
| `scripts/ai-authority-proof.sh` | pure dual-key READY/HOLD/REJECT reducer: immutable deterministic gate, evidence/confidence/corroboration rules, shadow/hold/enforce modes |
| `scripts/ai-interpretive-run-proof.sh` | explicit AI planner, parallel specialists, synthesis, B2 evidence hashes, sanitizer, fallback, and dual-key isolation (mock, zero spend) |
| `scripts/ai-interpretive-loop-proof.sh` | full local gateway-worker-MinIO explicit run with four metered mock-GMI stages and SDK-verified manifest |
| `scripts/resumable-download-proof.sh` | resumable downloads: a resumed writable keeps existing data, skipped + remaining ranges tile the file exactly at every interruption point, and an interrupted download finished on a second attempt is byte-identical |
| `scripts/parallel-download-proof.sh` | parallel ranged download: the range plan tiles [0,total) exactly with inclusive ends across eight sizes, and six concurrent connections through the mediated redirect reassemble out of order into a byte-identical file |
| `scripts/mediated-download-proof.sh` | gateway-mediated download: no storage URL or credential in the payload, byte-identical delivery through the redirect, Range survives it, a protected transfer's link refused without the unlock cookie (copied links do not bypass the password), per-transfer and sliding unlock, immediate revocation, egress metered once per download rather than once per range |
| `scripts/storage-renewal-proof.sh` | storage-URL renewal: proactive renewal before expiry, reactive single-flight renewal after a refusal (12 ranges, one gateway trip), revocation stops a running download, renewals never re-meter egress, continuation tokens domain-separated from unlock cookies |
| `scripts/purge-proof.sh` | storage purge on a versioned bucket: dry-run default deletes nothing, every version and delete marker removed past the grace period (expired and revoked), inside-grace/live/non-UUID rows untouched, rows kept and marked, 8-character id prefixes in logs |
| `scripts/transfer-mode-proof.sh` | sender contract: transfer-first mode, additive multi-file queue, drag/drop, optional recipient passwords, honest concurrent progress, copyable share URLs |
| `scripts/recipient-password-proof.sh` | optional recipient password over the real gateway + MinIO multipart path: hashed and persistent, 4-character minimum for new transfers (older links still open), 20 wrong guesses lock a link from any number of addresses, a deployment-wide 60/min unlock cap |
| `scripts/qc-preview-proof.sh` | QC preview: `WAYSTATION_QC_MODE=preview` refuses a client's QC initiate (403, no row) before spend, admin stays live, `/session` reports the mode per viewer, default live |
| `scripts/access-codes-proof.sh` | named sender access codes: v3 → current-schema migration (target read from `db.ts`), admin-issued or admin-chosen (case-sensitive, no collisions), shown once, hash-only storage, neutral 404 for non-admins, owner_id recorded, live revocation, ownerless cookies rejected, deployment-wide login cap |
| `scripts/upload-recovery-proof.sh` | owner-based upload recovery: the same owner on a new session resumes (ListParts, part signing, completion), another owner or a forged owner field gets the neutral 404 identical to a missing upload, no session is 401, legacy ownerless rows keep session-only access, cross-session recovery stops at the active-upload window, and revocation wins over re-login (also `gateway/test/ownership.test.ts`) |
| `scripts/thumbnail-metering-proof.sh` | poster billing against a local mock GMI: an AI-selected poster is billed once (1 call, `billable` run x1, ledger `thumbnail` = 1, poster present), an unusable answer after a paid call is billed once and falls back, a provider error is a free fallback with no ledger charge |
| `scripts/payment-gateway-proof.sh` | pay-per-gig checkout: pricing and v2 price table, v4→v6 migration, webhook signature, payment-backed session, upload budget, `downloads_allowed` = chosen + 1, grant reuse and exhaustion, weeks-based expiry, per-grant metering |
| `scripts/authority-boundary-proof.sh` | deterministic delivery authority + advisory PSE (no network or media I/O) |
| `scripts/triage-proof.sh` | cost-aware AI triage: the router changes spend decisions only, never verdicts |
| `scripts/ai-thumbnail-proof.sh` | AI poster selection against an SDK-shaped mock; no network or spend |
| `scripts/audio-map-proof.sh` | declared audio-track mapping (pure reducer) |
| `scripts/caption-transport-proof.sh` | bounded SCC decode + CEA transport continuity |
| `scripts/qctools-analysis-proof.sh` | QCTools report reducer, plus missing/malformed states |
| `scripts/phase2-quality-proof.sh` | Phase 2 reducer fixtures — behaviour only, not acceptance |
| `scripts/deep-package-proof.sh` | Phase 3 package/metadata reducers — no conformance claim |
| `scripts/interpretive-shadow-proof.sh` | versioned prompt compiler + opt-in shadow reducer; no spend |
| `scripts/shadow-evaluation-proof.sh` | offline AI-shadow reviewer/evaluation; no model call |
| `scripts/qc-calibration-proof.sh` | calibration intake; no policy file is read or modified |
| `scripts/qc-benchmark-proof.sh` | offline benchmark intake; no commercial result is fabricated |

### Done means (for source changes)

- Relevant proof scripts pass and the three compile checks pass.
- `CURRENT_WORK.md`, `NEXT_STEPS.md` and `DECISIONS.md` are updated per `AGENTS.md`, and any production-affecting change is recorded in `docs/DEPLOY.md` by the operator who performed it.
- Committed on the working branch and pushed when the closing request authorizes it; `main` is the canonical branch and adopts work only per the branch policy above.

### Secrets and artifacts

`.env` and `.env.local` hold real Backblaze B2 and GMI credentials and are gitignored; never open, echo, print or commit them, and lint by length or prefix only. Keep out of Git: `vendor/`, `node_modules/`, `pipeline/.venv/`, `.devdata/`, `target/`, `crates/*/pkg*/`, `client/public/` fixtures, `client/dist/`, and `*.db*` control-database files. Access codes, recipient capability IDs and tickets are bearer tokens: at most 8 characters in any record.

The local `.env` still names the production B2 key deleted on 2026-09-30 (`docs/DEPLOY.md`), so local scripts that talk to real B2 (`live-run.sh`, `verify-b2.sh`, and similar) fail until given their own key. The proof suite uses MinIO and is unaffected.
