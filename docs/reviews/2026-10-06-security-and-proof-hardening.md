# Review summary: security and proof hardening (2026-10-06)

**Branch**: `claude/orbistation-security-and-proof-hardening`, from `main` at `b16a10979d92540290e369296f22990027acaf20`. Nothing is merged, deployed or opened as a pull request. `main` was not touched.

**Next instruction for the reviewer**: read this file, then `git log --oneline main..HEAD` and `git diff main...HEAD`. Review the four commits independently. Do not merge or deploy without the owner's decision; the deployment prerequisites below have not been executed.

## Acceptance criteria

| # | Item | Status |
|---|---|---|
| 1 | Trusted API-origin handling | **Done in source and locally validated.** Operator prerequisite open. |
| 2 | Owner-based upload recovery | **Done in source and locally validated.** One remainder noted below. |
| 3 | Document the live features | **Done.** Operator facts remain UNKNOWN by design. |
| 4 | Discovery-based proof runner | **Done and tested.** The suite is not green: one pre-existing failure and four not run. |

### 1. Trusted API origin
- **Changed**: `original.url` is built from `WAYSTATION_PUBLIC_API_ORIGIN` plus the fixed `/api` mount (`gateway/src/publicOrigin.ts`). `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto` are never read for it. Production refuses to start when the setting is absent or invalid; development falls back to the request host only when it is loopback, over http, otherwise `GET /api/transfers/:id` returns `503 public_origin_unconfigured`. `WAYSTATION_PUBLIC_BASE_URL` is untouched and stays the sender-page/payment-redirect base. Protected-download authorization is unchanged (the link carries no credential).
- **Compatibility**: a gateway built from this source will not start in production without a valid https origin. Both compose files set `https://api.orbitolive.com`; that value is taken from the deployment records and must be confirmed.
- **Other link generators inspected**: the emailed page link and payment redirects use `publicBaseUrl` (`WAYSTATION_PUBLIC_BASE_URL`, falling back to the allowed-origin `Origin` header). Not changed; queued as NEXT_STEPS item 4.
- **Tests**: 7 unit tests (`gateway/test/publicOrigin.test.ts`); `scripts/mediated-download-proof.sh` extended with forged `Host`/`X-Forwarded-*` cases, prefix preservation and four invalid-configuration boot refusals; `storage-renewal-proof.sh` updated. A mutation that re-trusted `X-Forwarded-Host` was caught.

### 2. Owner-based upload recovery
- **Changed**: `ownUpload` now uses `mayUseUpload` (`gateway/src/ownership.ts`): the signed session's owner must equal the upload's recorded owner. A legacy row with no owner uses session-id comparison only; a failed owner comparison never falls back. A *different* session than the one that started the upload may recover only an `active` or `complete` upload younger than `ACTIVE_UPLOAD_WINDOW_HOURS`. Non-owners get the same neutral 404 as a missing upload. Identity comes only from the signed session.
- **Entitlements unchanged**: `requireSession` still rejects revoked codes and unpaid orders on every call; paid owner ids are unique per order; completion applies the order's own downloads and expiry. Quotas stay session-keyed.
- **Not changed (remainder)**: the QC-only `progressGate` still compares the originating session id; the parked QC send page is the only user.
- **Tests**: 9 unit tests (`gateway/test/ownership.test.ts`); new `scripts/upload-recovery-proof.sh` (same-owner resume, other owner, forged owner field/header, unauthenticated, legacy, window, revocation); a paid-order recovery case in `payment-gateway-proof.sh`; `access-proof.sh` updated, because it had asserted denial for a second login of the *same* owner. Two mutations were caught.
- **No policy blocker** was hit.

### 3. Live-feature documentation
- `docs/HOSTED_FEATURES.md` documents email-the-link, the admin dashboard and embedded Stripe checkout from source, with configuration names only, and ADR-040/041. Their live status is recorded as **owner-confirmed on 2026-10-06, not independently verified**. Operator details (Resend key supply and domain verification, Stripe mode and webhook registration, host value of `WAYSTATION_PUBLIC_BASE_URL`) are UNKNOWN. `.env.example` now lists `STRIPE_PUBLISHABLE_KEY`, `RESEND_API_KEY` and `WAYSTATION_EMAIL_FROM` as names. `docs/REPO_MAP.md` was corrected.
- **Findings, not fixed**: the email `fromEmail` is unverified; `publicBaseUrl` can fall back to the `Origin` header.

### 4. Proof runner
- `scripts/run-proofs.mjs` (`npm run proofs`): discovers `*-proof.sh`; reports `PASS`/`FAIL`/`SKIP`/`NOT_RUN`; a full pass alone prints `ACCEPTED`; skips and not-runs print `INCOMPLETE, NOT AN ACCEPTANCE` (exit 2); failures exit 1; `--only`/`--skip` is labelled a selection.
- **Enforcement, not text scanning** (after review finding 2): each script runs inside a macOS `sandbox-exec` profile that allows network to this machine only, blocks the Docker/Colima sockets, confines file writes to the repository (never `.git` or `.env*`) and a private, uniquely created per-run temp directory (shared `/tmp`, `/var/folders` and home caches are not writable at all), blocks reads of `.env*` and cloud/SSH credential directories, and permits signals only to processes inside the sandbox. With no sandbox available every script is `NOT_RUN`; there is no unsandboxed mode. `--docker` and `--external` lift the socket and network limits. The old text scan survives only as an early refusal for docker/external use; a clean scan authorizes nothing, and the review-exemption file was deleted.
- **Ports**: a script is `NOT_RUN` while a port it names listens on IPv4 **or** IPv6 loopback (after review finding 4).
- The sandbox reaches this machine's own addresses but no other host; Docker proofs need an explicit `--docker`.

## Repairs after review (findings at `344bb02`)

| Finding | Repair | Evidence |
|---|---|---|
| 1. `DECISIONS.md` was erased | **My error**: a one-line Python edit opened the file for writing before reading it, truncating it in the item-3 commit. Restored from `276df3a`, ADR-040/041 re-added; ADR-001..037 are byte-identical to `main` except ADR-031's added pointer to ADR-040. | New `scripts/test/context-refs.test.mjs`: at least 41 ADRs, consecutive ids, every ADR has Status/Decision/Rationale/Invariant/Date in order, every `ADR-NNN` cited in tracked docs exists. |
| 2. Safety gate failed open | Replaced the scan gate with OS enforcement (above). | Real-sandbox tests: a connect hidden in a variable is refused with `EPERM` while loopback works; a nested helper script is equally confined; deleting a directory via a variable under `$HOME` or `/tmp` fails; writes to `$HOME`, `.git` and `.env` reads fail; a foreign process survives a `kill -9` while the script's own child can be signalled. Four weakenings of the profile (network, unlink, signals, IPv6 probe) were each caught. |
| 3. `toggle` deleted `/tmp/toggle-work` | `proof-review.json` deleted. `toggle-proof.sh` now reads its clip from its own `mktemp` directory and removes nothing outside it. | The sandbox would also refuse the old `rm`. `toggle` passes in both suite runs. |
| 4. IPv6 listeners missed; port-wide kills | Port preflight probes `127.0.0.1` and `::1`. The sandbox prevents signalling strangers. `upload-recovery`, `mediated-download` and `storage-renewal` proofs now signal only process trees they started (the other proofs still `lsof`-kill by port; the sandbox makes that harmless, and NEXT_STEPS item 7 keeps the cleanup). | Deterministic IPv4/IPv6 probe tests, plus a real `::1` listener test (skipped where `::1` is unavailable; it ran here). |

## Second repair: shared temporary areas (re-review finding at `0df8918`)

The first sandbox still allowed writes throughout `/private/tmp` and `/private/var/folders` and only blocked unlinking, so another program's temporary file could be overwritten, truncated or renamed. Now the profile allows writes only to the repository and the run's own directory (plus null/tty/random device nodes). `TMPDIR`, npm and XDG caches and the JVM temp dir point into that directory, and every proof now keeps its logs and fixtures there: 22 scripts use `$TT` (= `$TMPDIR`) instead of fixed `/tmp/...` paths, and all 28 that make temp directories call `mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX"` (BSD `mktemp -d` ignores `TMPDIR`). The two Docker proofs' `/tmp` paths are inside their containers and were left alone; `triage-proof.sh` only passes a non-existent path string. New tests prove a bystander file in `/private/tmp`, in the system temp area and in `~/.cache` cannot be overwritten, truncated, appended to, renamed over, hard-linked, chmod-ed, deleted, or given a created sibling, and that the run directory is private, fully usable and removed afterwards. Restoring the old permissive profile makes three tests fail.

## Validation run (all local; no live service, credential or production access)

| Command | Result |
|---|---|
| `( cd gateway && npx tsc --noEmit )` | pass |
| `( cd gateway && npm test )` | 16 of 16 pass (no gateway or pipeline source changed in the 2026-10-07 pass) |
| `node --test scripts/test/*.test.mjs` (`npm run test:runner`) | 70 of 70 pass: 36 runner incl. real-sandbox enforcement, 4 decision-record checks, 30 Docker-isolation |
| `bash -n` on every `scripts/*-proof.sh` and `scripts/lib/*.sh` | pass |
| `node scripts/run-proofs.mjs` (whole suite, sandboxed, at the 2026-10-07 repair) | **46 passed, 0 failed, 0 skipped, 4 not run of 50: INCOMPLETE, NOT AN ACCEPTANCE** |

- **Not run**: `archive-tools-docker`, `broadcast-qc-docker`, `compute`, `docker`. Docker execution, builds, pulls and tagging are not approved; see the Docker section below. The four were never started in any form. Their scripts were exercised only in plan mode and against a stub `docker`.
- **Unverified**: no live deployment, no real Cloudflare/Stripe/Resend/B2 behaviour, no browser UI, no test of the email or `/admin/stats` routes; the Docker proofs against a real daemon; sandbox enforcement outside macOS (there, the runner refuses to run anything).
- History: the earlier full-suite runs of 2026-10-06 (44 passed, 1 failed, 4 not run) failed only on `qc` before the repair below.

## Diagnosis: `qc-proof.sh` "metering missing entries" (2026-10-07; repaired, see Resolution)

**Verdict: a stale proof expectation, not an application defect.** The deterministic poster fallback is intentionally unbilled since `61b0105` (2026-08-03); the proof still expects a billed `thumbnail` ledger entry. Nothing was changed to obtain a pass.

**Reproduction.** `node scripts/run-proofs.mjs --only qc` (`--only` matches substrings, so this selected 11 scripts) at `6b5ccb0`: 9 passed, `qc` FAILED (exit 1: "metering (clean): {'qc': '0.05 minutes'}", "FAIL: metering missing entries"), `broadcast-qc-docker` NOT_RUN. Then `scripts/qc-proof.sh` was run once more with a run-owned `TMPDIR` so the logs survived; the thumbnail event of both transfers read: `step_done` / `thumbnail` / `selection_method: deterministic_fallback` / `model: deterministic-poster-fallback/1.0` / `gmi_model_calls: 0`, with no `billable` block, and `thumb.jpg` was produced. The only billable event in each stream was the QC minutes. Diagnostic data was removed afterwards.

**Causal chain.**
1. `scripts/qc-proof.sh:119-120` requires both `qc` and `thumbnail` in the transfer's usage totals. That assertion dates from the metering ledger (`21c9bd1`, 2026-07-16), when the poster step always emitted a billable unit.
2. `pipeline/worker.py:3271-3286`: the thumbnail step emits `billable: {unit: run, units: 1}` **only if** `thumbnail_report["usage"]["billable_events"]` is non-zero.
3. `pipeline/worker.py:652-680`: that count is 1 only when a GMI poster-selection response exists; with no `GMI_API_KEY` ("GMI_API_KEY is not configured") the method is `deterministic_fallback` and the count is 0. The proof runs with no GMI key.
4. `gateway/src/routes.ts:1091-1105` (`/internal/progress`) meters an event only when it carries a `billable` block, so no `thumbnail` ledger entry is written.
5. History: `59e4762` (2026-08-02) added AI-selected thumbnails with an unconditional billable unit; `61b0105` (2026-08-03, "Consolidate interpretive AI and local cloud routing") replaced it with the conditional above and did not touch `qc-proof.sh`. The proof has been stale for two months.

**Pre-existing on `main`.** Yes. A detached, isolated worktree of `main` at `b16a109` (created and removed by this session on 2026-10-06; `main` was not switched or altered) failed with the identical output, and the failure also appeared in every runner run on this branch. It was not run at `61b0105~1`, because the old script hardcodes shared `/tmp` log paths that the current sandbox forbids; the claim that it passed before `61b0105` is inferred from the diff, not executed.

**Affected behavior.**
- *Deployed transfer-only service*: not affected. Production runs no worker, so the poster lane does not exist there (`docs/DEPLOY.md`).
- *Parked QC functionality*: the metering rule itself behaves as designed in the code: a poster is billed per GMI call and a deterministic fallback is free. Only the regression proof is wrong, so it currently cannot detect a real metering regression in the thumbnail lane. No end-to-end proof asserts the positive case (one GMI-selected poster yields exactly one `thumbnail` ledger unit); `scripts/ai-thumbnail-proof.sh` checks `billable_events` at function level only (lines 81, 105, 117).

**Proposed repair (implemented in the Resolution below).** In `scripts/qc-proof.sh` only: require the `qc` ledger entry; read the thumbnail `step_done` from the already-captured SSE log and assert that a `deterministic_fallback` poster with `gmi_model_calls: 0` produced no `billable` block and no `thumbnail` ledger entry (keeping a "poster object exists" assertion). That tests the current contract rather than deleting the check. Optionally add the positive case (mock GMI selects the poster; the ledger shows one `thumbnail` unit) to a mock-GMI proof such as `ai-qc-proof.sh`. **Policy question for you:** is "free deterministic poster, billed AI poster" the intended product rule (decision records and the worker comment at `worker.py:3267-3269` say a redundant poster-selection call must not be billed)? If you would rather bill every poster, the repair belongs in `worker.py` instead, and that is a billing change I did not make.

## Resolution (2026-10-07): proof repaired, billing behaviour preserved

Decision recorded: **a deterministic fallback poster is free; an AI-selected poster is metered by the existing billable-event contract.** No application billing, price or payment behaviour was changed; `git diff main...HEAD` shows no change under `pipeline/`, in `gateway/src/metering.ts`, `pricing.ts` or `payments.ts`, or to the `/internal/progress` metering route; the only `gateway/src` changes are the earlier API-origin and upload-ownership work.

**`scripts/qc-proof.sh`** keeps its `qc` ledger assertion and, for both clips, now asserts: the poster object `derivatives/<id>/thumb.jpg` exists; the thumbnail `step_done` has `selection_method: deterministic_fallback`, `gmi_model_calls: 0` and no `billable` block; and the ledger holds no `thumbnail` charge. It passes.

**`scripts/thumbnail-metering-proof.sh`** (new) drives the real worker-to-gateway path against a local mock GMI on `127.0.0.1:8009` (no key, no paid provider, no external network; the mock answers only the poster-selector prompt and 404s anything else) with only the poster lane enabled. Three transfers:

| Mock answer | Expected and asserted |
|---|---|
| valid selection (`poster-candidate-03`) | `gmi_ai`, `gmi_model_calls` 1, `billable {run, 1}`, ledger `thumbnail` = 1 run, poster object present, selected frame is the ~1.375 s candidate |
| unusable answer | the call was paid for, so `gmi_model_calls` 1, billed once, ledger 1 run, and the poster is the deterministic fallback (this is the current contract of `billable_events: 1 if response is not None`; recorded here so the owner can see it is locked in by a test) |
| HTTP 500 | no response, so `deterministic_fallback`, 0 calls, no billable block, no ledger charge, poster present |

It also asserts the mock saw exactly three poster-selection requests, one per transfer. It starts only processes it owns and skips (rather than killing anyone) if its ports are busy.

**Mutation tests** (each applied to `pipeline/worker.py`, run through the sandboxed runner with exactly `--only qc,thumbnail-metering` plus `--skip` of the nine other scripts the substring match would otherwise add, then restored; `git diff pipeline/` was empty afterwards):

| Mutation | `qc-proof` | `thumbnail-metering-proof` |
|---|---|---|
| bill the free fallback (`if True:` for the billable condition) | FAIL (4 assertions) | FAIL (error case billed) |
| never bill an AI poster (drop the `billable` assignment) | pass (correct: it only sees the free path) | FAIL (valid and invalid cases) |
| a model call counts as zero billable events | pass | FAIL |
| an error response is billed (`billable_events` always 1) | FAIL | FAIL |

**What `--only qc` selects.** `--only` is a substring match, so `--only qc` selects 11 scripts: `agentic-qc`, `ai-qc`, `broadcast-qc`, `broadcast-qc-docker` (NOT_RUN), `netflix-qc`, `qc` (the proof), `qc-benchmark`, `qc-calibration`, `qc-preview`, `qctools-analysis`, `synthetic-qc`. That selection gave 10 passed, 0 failed, 1 not run after the repair. The runner's selection rule was not changed.

## Docker proofs: isolation implemented, execution NOT approved and NOT performed

**What changed (no Docker command was executed to write or test this).** New `scripts/lib/docker-isolation.sh` is sourced by `docker-proof.sh`, `compute-proof.sh`, `archive-tools-docker-proof.sh` and `broadcast-qc-docker-proof.sh`:
- **Approval gates.** Nothing reaches Docker unless `WS_DOCKER_APPROVED=1` (runner `--docker`); builds need `WS_DOCKER_ALLOW_BUILD=1` (`--docker-build`) and pulls `WS_DOCKER_ALLOW_PULL=1` (`--docker-pull`). Unapproved scripts print `SKIP` and do not even call `docker info`. `WS_DOCKER_PLAN=1` prints the exact commands and executes nothing.
- **One door.** Every call goes through `ws_dk`, which allowlists subcommands and refuses `system`, any `prune`, `tag`, `rmi`, `commit`, `push`, `login`, `context`, `image rm/tag`, host mounts, `--env-file`, `--privileged`, host namespaces, the Docker socket, and any published port not on `127.0.0.1`. `run`/`create` need a `--name` starting with the run id and the run label; `rm`/`stop`/`kill`/`exec`/`network rm` need a run-named target; `network create` needs the label; a build may tag only `wsproof/<name>:<run id>`.
- **Unique, labelled, scoped.** Run id `wsproof-<name>-<epoch>-<random>`; every object carries `wsproof.run=<id>`; cleanup removes only objects with that label (plus images tagged by the run itself) and does nothing if the run created nothing. No project-wide `down -v`, no port-wide kill, no removal by shared name.
- **No `.env`, no inherited credentials.** `docker-proof.sh` no longer uses `docker compose` (its default project name, shared `waystation-*` tags and `env_file: .env` were the hazards) and instead creates one labelled network and three labelled containers, passing only explicit synthetic `-e` variables; `scripts/docker-proof.override.yml` was deleted. `docker-compose.yml` itself is therefore no longer exercised by a proof. Containers use `--tmpfs /tmp` instead of a named volume. The runner gives the Docker proofs an empty `DOCKER_CONFIG` so the CLI does not read `~/.docker`.
- **Image identity.** A proof uses an existing local image only if `WS_PROOF_WORKER_IMAGE` / `WS_PROOF_GATEWAY_IMAGE` names it **and** the application files inside it (`requirements.txt worker.py qc policies` for the worker, `package.json tsconfig.json src` for the gateway) are byte-identical, by SHA-256 of every file, to this working tree. A mismatch or missing image prints `SKIP - BLOCKED` (never a pass, never a substitution). Absent a named image and a build authorization the proof is BLOCKED; with `--docker-build` it builds only `wsproof/<kind>:<run id>`.
- **Limits.** `--memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 --security-opt no-new-privileges --cap-drop ALL` on every container; the worker in `docker-proof` and `compute` gets 2 GiB and a 2 GiB `/tmp` tmpfs; the in-image proofs run with `--network none`.
- `compute-proof.sh` also lost its port-wide `lsof | kill`: host processes are tracked by PID and the cloud worker is a labelled container on a free loopback port.

**The host sandbox does not constrain Docker.** `sandbox-exec` confines the script's own process; once a script may reach the Docker socket (`--docker`), the daemon acts outside that confinement. The protection for the shared daemon is therefore the guard above, not the sandbox.

**Tests** (`scripts/test/docker-isolation.test.mjs`, 30; none reaches a daemon, a stub `docker` on `PATH` records any call): the guard refusals above; plan-mode runs of all four scripts (every planned `run` has the run name, label, memory cap, `--cap-drop ALL`, `no-new-privileges` and loopback ports; nothing mentions compose, prune, env files, mounts or shared tags); BLOCKED and unapproved runs make no docker call beyond `info`; static rules (every docker call goes through `ws_dk`, no compose project, no `xargs kill`); the runner's `--docker-build`/`--docker-pull` flags and that the scrubbed environment never carries approval. Guard mutations (allow mounts and env files, allow a non-loopback publish, allow a build of a shared tag, allow `rm` of strangers) were each caught; removing the redundant literal `prune` check changed nothing, because `system`, `volume`, `network`, `container` and `image prune` are already refused by the allowlist.

**Image candidates observed, read-only** (`docker image inspect` of existing images, a metadata read; no container, build, pull or tag): `pipeline/` last changed 2026-08-03 and `waystation-worker:local-c795ad13b6fd` was created 2026-08-03, so it is a plausible worker match, but the byte comparison is itself a `docker run` and has not been performed. The only gateway image (`waystation-gateway:latest`, 2026-08-03) **predates the 2026-10-06 gateway changes on this branch and cannot match**, so `docker-proof` is BLOCKED on a gateway image until a build is authorized. `minio/minio:latest` exists locally. The proofs' `waystation-archive-tools-proof:local` and `waystation-broadcast-qc-proof:local` images (2026-08-02) are no longer used.

**Remaining prerequisites before any Docker execution (none performed):**
1. Your explicit approval to run Docker workloads on the shared daemon, one proof at a time.
2. Decide the gateway image for `docker-proof`: authorize `--docker-build` (external mirrors, no build cache) or accept `docker-proof` staying BLOCKED.
3. Name the worker image (`WS_PROOF_WORKER_IMAGE=waystation-worker:local-c795ad13b6fd` is the candidate); the proof verifies it byte-for-byte or blocks.
4. Capture an inventory before and after (`docker ps -a`, `docker images`, `docker volume ls`, `docker network ls`, `docker compose ls`) and require the difference to be empty, since the proofs remove only their own labelled objects.
5. Resource limits as above; the Colima VM has 4 CPUs and 5.8 GiB, with the OrbiSphere workloads using about 1.2 GiB; stop on memory pressure.
6. Expect first-run tuning: the scripts have been exercised only against a stub and in plan mode, never a real daemon, and `--cap-drop ALL` or the memory caps may need adjusting for the real images.
7. Known residual exposure: in `compute-proof` the container reaches the host MinIO and gateway through `host.docker.internal`, and MinIO listens on all host interfaces for the duration of the proof (as before).

## Deployment prerequisites (not executed)
1. Confirm `WAYSTATION_PUBLIC_API_ORIGIN` (`https://api.orbitolive.com` in both compose files) matches the tunnel hostname; without a valid https origin the gateway will not start.
2. Roll out gateway-only with a WAL-safe backup first (`docs/DEPLOY.md`, section "WAYSTATION_PUBLIC_API_ORIGIN").
3. Afterwards, with the owner's authorization, send one forged-header request through the real tunnel and confirm the returned link host.
4. No schema change, no new secret. The client needs no republish: `original.url` is consumed unchanged.

## Git
Branch, final commit and push status are recorded in `CURRENT_WORK.md` and in the final report of the session.
