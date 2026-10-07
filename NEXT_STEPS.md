# NEXT_STEPS.md

## Active Queue

1. **[P1] Confirm `X-Forwarded-Host` cannot be spoofed through Cloudflare**
   - **Target**: `gateway/src/routes.ts` (`mediatedDownloadUrl`, around lines 985-1005)
   - **Done When**: a forged `X-Forwarded-Host`/`X-Forwarded-Proto` request through the real tunnel is shown to be overwritten, or the link host is taken from a dedicated trusted API-origin setting (new, name TBD; it must hold the public API origin, for example the `api.orbitolive.com` origin, not the sender-page URL) and the header trust is removed, with a proof covering it. `WAYSTATION_PUBLIC_BASE_URL` is not suitable: it is the sender-page base used for payment success/cancel redirects. The source comment asserting Cloudflare sets these headers is currently unverified.
   - **Blocked By**: NOT BLOCKED for a configuration-based fix; a live forged-header test needs the owner's authorization for one outward request to the public API.

2. **[P1] Move upload ownership from session to owner**
   - **Target**: `gateway/src/routes.ts` (`ownUpload`, line 488), `scripts/access-proof.sh`, `scripts/access-codes-proof.sh`
   - **Done When**: a client whose session lapsed mid-upload can log back in and resume it (ListParts reattachment succeeds) because ownership compares `owner_id`, falling back to `session_id` only for pre-identity rows; cross-owner access still returns a neutral 404; both proofs assert it.
   - **Blocked By**: NOT BLOCKED

3. **[P1] Document features that are live but missing from shared context**
   - **Target**: `docs/DEPLOY.md`, `DECISIONS.md`; source in `gateway/src/email.ts` (`d67f9f8`), the admin activity dashboard (`888fd5e`), in-page Stripe checkout (`a4edee7`)
   - **Done When**: each feature is described from source (what it does, its configuration and constraints) and recorded as live. The owner confirmed on 2026-10-06 that email-the-link, the admin dashboard and embedded Stripe checkout are live; that is owner-confirmed, not independently verified. Host configuration (for example how the Resend key is supplied, which appears in no compose file or record) stays `UNKNOWN` until the operator records it.
   - **Blocked By**: NOT BLOCKED for the source description; host configuration needs the operator.

4. **[P2] Finish the commercial-track follow-ups**
   - **Target**: `docs/COMMERCIAL_DELIVERY_PLAN.md`, `gateway/src/`
   - **Done When**: magic-link recovery exists (a sender who loses their capability URL can regain it by email); the per-grant 1.7× byte budget is enforced and post-send credit top-up exists, or each is explicitly dropped. Byte budget depends on byte counts being visible, which a redirect hides until the CDN worker is deployed.
   - **Blocked By**: NOT BLOCKED for magic-link recovery; byte budget is blocked on a CDN-worker/design decision.

5. **[P2] Usage billing and quota re-scope, together**
   - **Target**: `gateway/src/metering.ts`, `gateway/src/limits.ts`, `docker-compose.transfer.yml` (`MAX_JOBS_PER_SESSION`, `MAX_DAILY_JOBS`)
   - **Done When**: ledger events feed Stripe or Lago meters, and upload ceilings are expressed per owner and in bytes instead of a global daily count (ADR-028). Today `MAX_DAILY_JOBS` is a global count that gives the twenty-first sender an opaque refusal.
   - **Blocked By**: A pricing decision from the owner.

6. **[P2] Add a discovery-based proof-suite runner**
   - **Target**: `scripts/` (new runner), `SHARED_CODING_WORKFLOW.md` section 12
   - **Done When**: one command enumerates `scripts/*-proof.sh` from disk, runs each, tallies `PASS ✓` and `FAIL`, honours the self-skip convention, and the workflow stops depending on a hand-kept table.
   - **Blocked By**: NOT BLOCKED

7. **[P2] Owner confirmations of earlier work**
   - **Target**: merged verified download (`539c4ab`, 2026-09-08); access-code rehearsal check 17 (2026-09-17)
   - **Done When**: the owner confirms the file is playable after a pause/resume and the status line reads "every range verified against BLAKE3" for a sub-4 GB transfer; and records whether the check-17 sequence (issue, use, revoke, bounce a throwaway code) was completed. Four access codes existed on 2026-09-30, but completion was never recorded.
   - **Blocked By**: Owner

8. **[P2] Decide link-lifetime selection for comped and admin links**
   - **Target**: `gateway/src/routes.ts` (`RECIPIENT_LINK_TTL_DAYS`, expiry around line 697), `client/src/main.ts`
   - **Done When**: the owner decides whether comped/admin senders get the weeks selector that paid senders have, and it is built or recorded as declined. Selection for paid links is already done (ADR-032).
   - **Blocked By**: Owner decision

9. **[P2] Triage the parked engineering backlog**
    - **Target**: `docs/archive/NEXT_STEPS_2026-09-30.md` (Planned, Later, Blocked sections), `docs/DEFERRED_TOOLING.md`
    - **Done When**: each retained item (deploy policy v1.4, synthetic-origin QC, OpenCV, jury policy 1.1, real-face lip-sync validation, Dolby Vision metadata, native sender, queue/autoscaling, generated-media live calibration) is moved to an issue tracker or roadmap by the owner, or explicitly dropped. QC is parked, so none is urgent.
    - **Blocked By**: Owner classification; no issue tracker or roadmap is configured in the repository.
