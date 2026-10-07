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
| `( cd gateway && npm test )` | 16 of 16 pass |
| `node --test scripts/test/*.test.mjs` (`npm run test:runner`) | 40 of 40 pass (36 runner incl. real-sandbox enforcement, 4 decision-record checks) |
| `npm -w client run build`, pipeline `import worker` | pass (before the repairs; no source touched since) |
| `node scripts/run-proofs.mjs` (whole suite, **sandboxed**, rerun after the repairs) | **44 passed, 1 failed, 0 skipped, 4 not run of 49: FAILED, not an acceptance** (the same result as the earlier unsandboxed run) |

- **Failed**: `qc` (`scripts/qc-proof.sh`: "metering missing entries", no `thumbnail` ledger entry). It fails identically on a detached worktree of `main` at `b16a109`, so it predates these changes. Not diagnosed.
- **Not run**: `archive-tools-docker`, `broadcast-qc-docker`, `compute`, `docker`. They need Docker; the daemon also hosts unrelated containers and two of them build the full worker image. They need `--docker` and owner approval (NEXT_STEPS item 7).
- **Unverified**: no live deployment, no real Cloudflare/Stripe/Resend/B2 behaviour, no browser UI, no test of the email or `/admin/stats` routes. Sandbox enforcement is verified on macOS only; elsewhere the runner refuses to run anything.

## Diagnosis: `qc-proof.sh` "metering missing entries" (2026-10-07, diagnosis only)

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

**Smallest proposed repair (not implemented; needs your decision).** In `scripts/qc-proof.sh` only: require the `qc` ledger entry; read the thumbnail `step_done` from the already-captured SSE log and assert that a `deterministic_fallback` poster with `gmi_model_calls: 0` produced no `billable` block and no `thumbnail` ledger entry (keeping a "poster object exists" assertion). That tests the current contract rather than deleting the check. Optionally add the positive case (mock GMI selects the poster; the ledger shows one `thumbnail` unit) to a mock-GMI proof such as `ai-qc-proof.sh`. **Policy question for you:** is "free deterministic poster, billed AI poster" the intended product rule (decision records and the worker comment at `worker.py:3267-3269` say a redundant poster-selection call must not be billed)? If you would rather bill every poster, the repair belongs in `worker.py` instead, and that is a billing change I did not make.

## Docker proofs: isolation plan (prepared, NOT executed)

Nothing was started, built, tagged or removed. Read-only observations of the shared daemon (Docker 29.5.2, Compose 5.3.1, Colima VM: 4 CPUs, 5.8 GiB RAM, **build cache 0 B**) on 2026-10-07: ten OrbiSphere containers are running (about 1.2 GiB combined), four OrbiSphere compose projects exist, and the daemon holds 117 images and 37 volumes, among them `waystation-worker:latest`, `waystation-gateway:latest`, `waystation-worker:local-c795ad13b6fd`, `waystation-worker:compute-proof-49ac1619a536`, `waystation-archive-tools-proof:local`, `waystation-broadcast-qc-proof:local`, the volume `waystation-local-cloud-scratch` and the stopped container `waystation-local-cloud-worker`. The current `pipeline/` fingerprint is `c795ad13b6fd`.

| Proof | Image / build | Mounts, ports, names | Cleanup | Hazards to the shared daemon |
|---|---|---|---|---|
| `docker-proof` | `docker compose -f docker-compose.yml -f scripts/docker-proof.override.yml up -d --build`: builds `waystation-gateway` and `waystation-worker`, pulls/uses `minio/minio` | project name defaults to the directory name `waystation`; volume `waystation_scratch` on `/tmp`; host ports **8787** and **9000** | `down -v` of that project | **Retags** the existing `waystation-worker:latest` and `waystation-gateway:latest`; `down -v` removes the default project's volumes; services use `env_file: .env`, and the override only replaces some variables, so any other real value in `.env` would enter the containers (and Compose cannot read `.env` inside the sandbox) |
| `compute` | one `docker build -t waystation-worker:compute-proof-<fingerprint>` if absent, then `docker run -d --name ws-cloud-worker -p 8001:8000` against a host MinIO and gateway | fixed container name, ports 8787/8000/8001/9000, `host.docker.internal:9000` | `docker rm -f ws-cloud-worker`; port-wide `lsof | kill` | needs the tag `...compute-proof-c795ad13b6fd`, which does not exist (only `-49ac1619a536` does), so it would **rebuild from scratch**; fixed container name could clobber a same-named container |
| `archive-tools-docker` | `docker build -t waystation-archive-tools-proof:local pipeline` | `docker run --rm --entrypoint sh` ephemeral, no mounts, no ports | `--rm` | **Retags** the existing `:local` image (built 2026-08-02, older than the last `pipeline/` change of 2026-08-03); full rebuild |
| `broadcast-qc-docker` | `docker build -t waystation-broadcast-qc-proof:local pipeline` | same as above | `--rm` | same retagging and rebuild |

**Build cost and network.** `pipeline/Dockerfile` is a three-stage build: Maven Central dependency download for Photon, an `apt-get` plus a `git clone` and compile of QCTools at pinned commit `29bc627…`, then `apt-get` for `mediaconch=25.04-2`, and `pip install -r requirements.txt`. With no build cache every build contacts external mirrors and compiles QCTools on a VM shared with the OrbiSphere workloads, and `AGENTS.md` records that a rebuild can fail for unrelated reasons (the pinned Debian package rotates out). The base images (`python:3.13-slim`, `maven:3.9-eclipse-temurin-21`, `node:22-slim`, `minio/minio`) are already local. These builds are therefore outside "no live service" without your explicit approval.

**Proposed isolation plan (for your decision).**
1. *Prefer existing images; do not build.* `compute`: add a second tag to the matching image (`docker tag waystation-worker:local-c795ad13b6fd waystation-worker:compute-proof-c795ad13b6fd`, which copies no data and replaces nothing), after checking the two share an ID and that the image was built from the current `pipeline/` tree. `archive-tools-docker` and `broadcast-qc-docker`: their images predate `pipeline/`'s last change, so either accept that they prove the 2026-08-02 image, or have you approve one rebuild.
2. *Unique names.* Run `docker-proof` under a throwaway project (`COMPOSE_PROJECT_NAME=wsproof-<random>`), with image tags overridden to `wsproof-<random>-*` so existing `waystation-*:latest` tags are untouched, and `down -v` scoped to that project only. Use a unique container name for `compute` (`ws-cloud-worker-<random>`). Keep every `docker run` ephemeral (`--rm`).
3. *No `.env`.* Run compose from a run-owned copy of the compose files with `env_file` removed, and pass only synthetic variables; confirm nothing named `.env` is read.
4. *Ports.* Keep the runner's loopback preflight (8787, 8000, 8001, 9000 free on IPv4 and IPv6) and add a published-port check against `docker ps`; `-p 127.0.0.1:...` rather than all interfaces.
5. *Resources.* Run one proof at a time with `--memory`/`--cpus` limits that leave the OrbiSphere containers alone (the VM has 5.8 GiB; they use about 1.2 GiB), and stop immediately on memory pressure.
6. *Verification before and after.* Record `docker ps -a`, `docker images`, `docker volume ls` and `docker compose ls` before and after, and require the difference to be exactly this run's own `wsproof-*` objects, which are then removed by name.
7. *Runner.* `--docker` would have to be extended: today it only lifts the sandbox's Docker-socket block. The sandbox does not confine what the Docker daemon itself does, so steps 2-6 (not the sandbox) are the protection, and they belong in the proof scripts or in a wrapper, not in the runner's text scan.

**Decisions needed from you.** (a) Approve the `qc-proof.sh` repair above, and confirm the thumbnail billing rule; (b) approve or change the Docker plan, in particular whether a from-scratch rebuild with external network access is allowed; (c) whether the stale tag-collision behaviour of `docker-proof` (retagging `waystation-*:latest`) should be fixed in the scripts first.

## Deployment prerequisites (not executed)
1. Confirm `WAYSTATION_PUBLIC_API_ORIGIN` (`https://api.orbitolive.com` in both compose files) matches the tunnel hostname; without a valid https origin the gateway will not start.
2. Roll out gateway-only with a WAL-safe backup first (`docs/DEPLOY.md`, section "WAYSTATION_PUBLIC_API_ORIGIN").
3. Afterwards, with the owner's authorization, send one forged-header request through the real tunnel and confirm the returned link host.
4. No schema change, no new secret. The client needs no republish: `original.url` is consumed unchanged.

## Git
Branch, final commit and push status are recorded in `CURRENT_WORK.md` and in the final report of the session.
