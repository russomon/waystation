# NEXT_STEPS.md

## Active Queue

1. **[P1] Live-check folder transfers (deployed 2026-10-24)**
   - **Target**: `https://orbitolive.com/orbistation/` (client `d656dd6`), gateway `d656dd6` schema v8, ADR-042
   - **Done When**: the owner has sent a real folder on the live site in Chrome (pick and drag-drop) and Safari, downloaded it with "Download entire folder…" into a real directory and compared it, and saved one file from "Download individual files".
   - **Blocked By**: Owner browser test.

2. **[P1] Deploy the trusted API-origin change (merged)**
   - **Target**: branch `claude/orbistation-security-and-proof-hardening` (`gateway/src/publicOrigin.ts`, `gateway/src/routes.ts`, both compose files, `docs/DEPLOY.md`)
   - **Done When**: the owner has reviewed and merged the branch; before the gateway rebuild the operator has confirmed `WAYSTATION_PUBLIC_API_ORIGIN` in the compose files matches the tunnel hostname (the gateway refuses to start without a valid https origin); after deployment a forged-header request through the real tunnel (one outward request, owner-authorized) returns the configured origin and a download still works. Replaces the open `X-Forwarded-Host` question.
   - **Blocked By**: Deployed 2026-10-24 with `d656dd6` (origin confirmed as the tunnel hostname; the gateway booted with it). Remaining: the owner-authorized forged-header check through the real tunnel.

3. **[P1] Deploy owner-based upload recovery (merged)**
   - **Target**: same branch (`gateway/src/ownership.ts`, `ownUpload` in `gateway/src/routes.ts`)
   - **Done When**: reviewed and merged; after deployment a sender whose session lapsed resumes an upload (owner-authorized check). Known remainder: the QC-only `progressGate` still compares the originating session id, and the quota counters stay session-keyed.
   - **Blocked By**: Deployed 2026-10-24 with `d656dd6`. Remaining: the owner-authorized lapsed-session resume check.

4. **[P2] Record operator facts for the live features**
   - **Target**: `docs/DEPLOY.md`, `docs/HOSTED_FEATURES.md`
   - **Done When**: the operator records how `RESEND_API_KEY` is supplied and whether the sending domain is verified, the Stripe account mode and registered webhook endpoint/events, and the host value of `WAYSTATION_PUBLIC_BASE_URL`. The features themselves are owner-confirmed live (2026-10-06), not independently verified.
   - **Blocked By**: Operator (host access).

5. **[P2] Harden email-the-link and payment redirects**
   - **Target**: `gateway/src/routes.ts` (`/transfers/email`, `publicBaseUrl`), `gateway/src/email.ts`
   - **Done When**: the owner decides whether the sender-typed `fromEmail` (Reply-To, BCC and the "X has sent you" name) must be verified or constrained, and whether `publicBaseUrl` may fall back to the `Origin` header in production; the chosen behaviour is implemented with tests, or recorded as accepted risk. Findings in `docs/HOSTED_FEATURES.md`.
   - **Blocked By**: Owner policy decision.

6. **[P2] Finish the commercial-track follow-ups**
   - **Target**: `docs/COMMERCIAL_DELIVERY_PLAN.md`, `gateway/src/`
   - **Done When**: magic-link recovery exists (a sender who loses their capability URL can regain it by email); the per-grant 1.7× byte budget is enforced and post-send credit top-up exists, or each is explicitly dropped. Byte budget depends on byte counts being visible, which a redirect hides until the CDN worker is deployed.
   - **Blocked By**: NOT BLOCKED for magic-link recovery; byte budget is blocked on a CDN-worker/design decision.

7. **[P2] Usage billing and quota re-scope, together**
   - **Target**: `gateway/src/metering.ts`, `gateway/src/limits.ts`, `docker-compose.transfer.yml` (`MAX_JOBS_PER_SESSION`, `MAX_DAILY_JOBS`)
   - **Done When**: ledger events feed Stripe or Lago meters, and upload ceilings are expressed per owner and in bytes instead of a global daily count (ADR-028). Today `MAX_DAILY_JOBS` is a global count that gives the twenty-first sender an opaque refusal.
   - **Blocked By**: A pricing decision from the owner.

8. **[P2] Run the Docker proofs under the new isolation and reach a full-suite acceptance**
   - **Target**: `scripts/docker-proof.sh`, `compute-proof.sh`, `archive-tools-docker-proof.sh`, `broadcast-qc-docker-proof.sh`, `scripts/lib/docker-isolation.sh`
   - **Done When**: with the owner's approval the three runnable Docker proofs have run one at a time on the shared daemon (`node scripts/run-proofs.mjs --docker`), with a before/after inventory showing only their own labelled objects came and went, `compute-proof.sh` is redesigned on a reviewed private network plan (proposal in its header; it would show routing and provenance labels only, not host-versus-container execution, so it needs the owner's approval before it is implemented or counted as equivalent coverage; it is BLOCKED until then because its MinIO/gateway exposure could not be made private) and runs too, and the whole suite prints `ACCEPTED`. The isolation is implemented and tested without a daemon; the `qc-proof.sh` failure is fixed (the free deterministic poster is asserted unbilled, and `thumbnail-metering-proof.sh` asserts an AI poster is billed once). Remaining prerequisites are listed in `docs/reviews/2026-10-06-security-and-proof-hardening.md`: approve running Docker workloads; decide the gateway image (the only local one predates this branch's gateway changes, so `docker-proof` is BLOCKED unless `--docker-build`, which needs external mirrors, is authorized); name the worker image (candidate `waystation-worker:local-c795ad13b6fd`, verified byte-for-byte at run time); expect first-run tuning of the resource caps. Later: remaining proofs still `lsof`-kill by port (the sandbox makes that harmless).
   - **Blocked By**: Owner approval to run Docker workloads, and the gateway-image decision.

9. **[P2] Owner confirmations of earlier work**
   - **Target**: merged verified download (`539c4ab`, 2026-09-08); access-code rehearsal check 17 (2026-09-17)
   - **Done When**: the owner confirms the file is playable after a pause/resume and the status line reads "every range verified against BLAKE3" for a sub-4 GB transfer; and records whether the check-17 sequence (issue, use, revoke, bounce a throwaway code) was completed. Four access codes existed on 2026-09-30, but completion was never recorded.
   - **Blocked By**: Owner

10. **[P2] Decide link-lifetime selection for comped and admin links**
   - **Target**: `gateway/src/routes.ts` (`RECIPIENT_LINK_TTL_DAYS`, expiry in `/uploads/complete`), `client/src/main.ts`
   - **Done When**: the owner decides whether comped/admin senders get the weeks selector that paid senders have, and it is built or recorded as declined. Selection for paid links is already done (ADR-032).
   - **Blocked By**: Owner decision

11. **[P2] Triage the parked engineering backlog**
    - **Target**: `docs/archive/NEXT_STEPS_2026-09-30.md` (Planned, Later, Blocked sections), `docs/DEFERRED_TOOLING.md`
    - **Done When**: each retained item (deploy policy v1.4, synthetic-origin QC, OpenCV, jury policy 1.1, real-face lip-sync validation, Dolby Vision metadata, native sender, queue/autoscaling, generated-media live calibration) is moved to an issue tracker or roadmap by the owner, or explicitly dropped. QC is parked, so none is urgent.
    - **Blocked By**: Owner classification; no issue tracker or roadmap is configured in the repository.
