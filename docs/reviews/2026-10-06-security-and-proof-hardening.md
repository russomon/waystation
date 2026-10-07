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
- **Enforcement, not text scanning** (after review finding 2): each script runs inside a macOS `sandbox-exec` profile that allows network to this machine only, blocks the Docker/Colima sockets, confines file writes to the repository (never `.git` or `.env*`), a private per-run temp dir and the system temp area (nothing under `/tmp` can be unlinked), blocks reads of `.env*` and cloud/SSH credential directories, and permits signals only to processes inside the sandbox. With no sandbox available every script is `NOT_RUN`; there is no unsandboxed mode. `--docker` and `--external` lift the socket and network limits. The old text scan survives only as an early refusal for docker/external use; a clean scan authorizes nothing, and the review-exemption file was deleted.
- **Ports**: a script is `NOT_RUN` while a port it names listens on IPv4 **or** IPv6 loopback (after review finding 4).
- The sandbox reaches this machine's own addresses but no other host; Docker proofs need an explicit `--docker`.

## Repairs after review (findings at `344bb02`)

| Finding | Repair | Evidence |
|---|---|---|
| 1. `DECISIONS.md` was erased | **My error**: a one-line Python edit opened the file for writing before reading it, truncating it in the item-3 commit. Restored from `276df3a`, ADR-040/041 re-added; ADR-001..037 are byte-identical to `main` except ADR-031's added pointer to ADR-040. | New `scripts/test/context-refs.test.mjs`: at least 41 ADRs, consecutive ids, every ADR has Status/Decision/Rationale/Invariant/Date in order, every `ADR-NNN` cited in tracked docs exists. |
| 2. Safety gate failed open | Replaced the scan gate with OS enforcement (above). | Real-sandbox tests: a connect hidden in a variable is refused with `EPERM` while loopback works; a nested helper script is equally confined; deleting a directory via a variable under `$HOME` or `/tmp` fails; writes to `$HOME`, `.git` and `.env` reads fail; a foreign process survives a `kill -9` while the script's own child can be signalled. Four weakenings of the profile (network, unlink, signals, IPv6 probe) were each caught. |
| 3. `toggle` deleted `/tmp/toggle-work` | `proof-review.json` deleted. `toggle-proof.sh` now reads its clip from its own `mktemp` directory and removes nothing outside it. | The sandbox would also refuse the old `rm`. `toggle` passes in both suite runs. |
| 4. IPv6 listeners missed; port-wide kills | Port preflight probes `127.0.0.1` and `::1`. The sandbox prevents signalling strangers. `upload-recovery`, `mediated-download` and `storage-renewal` proofs now signal only process trees they started (the other proofs still `lsof`-kill by port; the sandbox makes that harmless, and NEXT_STEPS item 7 keeps the cleanup). | Deterministic IPv4/IPv6 probe tests, plus a real `::1` listener test (skipped where `::1` is unavailable; it ran here). |

## Validation run (all local; no live service, credential or production access)

| Command | Result |
|---|---|
| `( cd gateway && npx tsc --noEmit )` | pass |
| `( cd gateway && npm test )` | 16 of 16 pass |
| `node --test scripts/test/*.test.mjs` (`npm run test:runner`) | 38 of 38 pass (34 runner incl. real-sandbox enforcement, 4 decision-record checks) |
| `npm -w client run build`, pipeline `import worker` | pass (before the repairs; no source touched since) |
| `node scripts/run-proofs.mjs` (whole suite, **sandboxed**, rerun after the repairs) | **44 passed, 1 failed, 0 skipped, 4 not run of 49: FAILED, not an acceptance** (the same result as the earlier unsandboxed run) |

- **Failed**: `qc` (`scripts/qc-proof.sh`: "metering missing entries", no `thumbnail` ledger entry). It fails identically on a detached worktree of `main` at `b16a109`, so it predates these changes. Not diagnosed.
- **Not run**: `archive-tools-docker`, `broadcast-qc-docker`, `compute`, `docker`. They need Docker; the daemon also hosts unrelated containers and two of them build the full worker image. They need `--docker` and owner approval (NEXT_STEPS item 7).
- **Unverified**: no live deployment, no real Cloudflare/Stripe/Resend/B2 behaviour, no browser UI, no test of the email or `/admin/stats` routes. Sandbox enforcement is verified on macOS only; elsewhere the runner refuses to run anything.

## Deployment prerequisites (not executed)
1. Confirm `WAYSTATION_PUBLIC_API_ORIGIN` (`https://api.orbitolive.com` in both compose files) matches the tunnel hostname; without a valid https origin the gateway will not start.
2. Roll out gateway-only with a WAL-safe backup first (`docs/DEPLOY.md`, section "WAYSTATION_PUBLIC_API_ORIGIN").
3. Afterwards, with the owner's authorization, send one forged-header request through the real tunnel and confirm the returned link host.
4. No schema change, no new secret. The client needs no republish: `original.url` is consumed unchanged.

## Git
Branch, final commit and push status are recorded in `CURRENT_WORK.md` and in the final report of the session.
