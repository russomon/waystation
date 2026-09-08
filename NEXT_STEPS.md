# Next Steps

Repo: waystation

The actionable work queue. Current state lives in `CURRENT_WORK.md`; durable
decisions in `DECISIONS.md`. Keep this file short — an item that is finished
gets deleted, an item that stops making sense moves to **Obsolete** with a
reason.

Waystation is currently **parked** as an engine: production is transfer-only
with no worker. The active *direction*, decided 2026-09-05, is to turn it into a
client-facing paid transfer service — see **`docs/COMMERCIAL_DELIVERY_PLAN.md`**,
which holds the design and the decisions already taken.

## Commercial track — the main line of work

Each step depends on the one above it. Full rationale in
`docs/COMMERCIAL_DELIVERY_PLAN.md`; do not start one of these without reading
it, because several obvious-looking shortcuts are already ruled out there.

1. **Payment + identity.** Take the card, capture the email, mint a durable
   `owner_id`, and write it where the ephemeral `sessionId` goes today. Email
   the sender their capability URL at creation. Payment comes **first, not
   last** — it produces the identity everything else is keyed to, and for
   pay-per-use it *is* the authorization. **No signup, no passwords, no
   dashboard**: email identifies, the capability URL authorizes.
2. ~~**Gateway-mediated download + egress metering.**~~ **DONE 2026-09-05.**
   `GET /transfers/:id/original` redirects to a freshly minted presigned URL
   after re-checking revocation and expiry, and meters egress once per transfer
   per hour rather than once per range. Proven by
   `scripts/mediated-download-proof.sh`. Credits and grant issuance hang off
   this endpoint next.
3. **Download credits.** Grants with a 1.7× byte budget, 7-day resume, default
   2 per link, top-up any time. Counting *requests* is wrong — see the plan.
4. **Per-transfer expiry selection** (7 / 14 / 21 / 30 days). Small: the
   `expires_at` column is already per-transfer, only the input is global.
5. **Magic-link recovery** for a sender who loses their capability URL —
   the only path that may act on an email, because delivering to the address
   proves control of it.
6. **Usage billing** — Stripe or Lago meters. The ledger in
   `gateway/src/metering.ts` is already shaped 1:1 onto a meter event.
7. **Re-scope the upload quotas.** Do this WITH billing, not before — the right
   ceiling is a pricing question, and raising the numbers now would only defer
   the same problem.

   `MAX_JOBS_PER_SESSION` and `MAX_DAILY_JOBS` are named for jobs but count
   **completed uploads in a rolling 24 hours**, checked at `POST /uploads`.
   Production runs 10 and 20; the code defaults are 20 and 200.

   They were **QC cost controls**: every completed upload used to fire the
   pipeline and spend real money on GMI calls, so capping uploads capped spend.
   In transfer-only mode no pipeline runs, so they now cap the only thing the
   product does, for a reason that no longer applies.

   Two problems, in order of severity:

   - **`MAX_DAILY_JOBS` is global, not per user.** Twenty transfers across
     *everybody* in a rolling day is a hard business ceiling, and the twenty-first
     client gets an opaque "This deployment has reached its daily job ceiling."
   - **An upload count is the wrong unit.** Spend is now storage and egress, so
     a 5 GB transfer and a 5 MB one cost wildly different amounts and consume one
     slot each. A gigabyte cap expresses the real risk; a count does not.

   `MAX_JOBS_PER_SESSION` also stops meaning much once accounts exist — a fresh
   login already starts a new session and a new count, so the meaningful unit
   becomes per-account, which is what `owner_id` provides.

   Precedent for treating this as urgent-when-it-lands rather than theoretical:
   `MAX_ACTIVE_UPLOADS_PER_SESSION=1`, also a hackathon-era control, wedged a
   real session on 2026-09-08 when a Wi-Fi drop left an upload unfinished.

## Now

- ~~**Unify byte formatting on decimal units.**~~ **DONE 2026-09-08.** One
  shared `client/src/format.ts`, decimal, used by both pages; the sender no
  longer says GiB while the recipient says GB. Operator-facing surfaces stay
  binary as specified. Guarded in `transfer-mode-proof.sh` and mutation-tested.

- **Decide the fate of `codex/hosted-cloud-control`.** It has carried one
  unmerged commit — "Show hosted cloud compute selection" — since 2026-08-04.
  Merge it or delete the branch; a month-old dangling branch is a trap for the
  next agent.
- **Add a proof-suite runner.** There are 40 `scripts/*-proof.sh` and no way to
  run them as a suite, so "the proofs are green" is currently a manual claim.
  A discovery-based runner (`ls scripts/*-proof.sh`, run each, tally
  `PASS ✓` / `FAIL`, honour the self-skip convention) also stops the table in
  `SHARED_CODING_WORKFLOW.md` from drifting again.

## Planned

Real engineering, deliberately deferred. Any of these can start whenever.

- **Deterministic tooling for the worker image.** Register in
  `docs/DEFERRED_TOOLING.md` — currently OpenCV, with the pin, the derived-layer
  build and the integration point already worked out. Do this while a full-QC
  box is already up; that is the cheap moment.
- ~~**Parallel ranged downloads.**~~ **DONE 2026-09-07, measured and tuned.**
  1 connection 23.2 MB/s, 6 → 76.7, 12 → 91.1 (729 Mb/s, near the 800 Mb/s
  line). `DOWNLOAD_CONCURRENCY` raised to 12; past 12 is untested. Full record
  in `docs/DEPLOY.md`. **Measure over gigabytes** — sub-1 GB samples measure TCP
  slow-start, not capacity, and produced two badly wrong readings before this.

- **Decide on synthetic-origin QC.** Full design preserved in
  `docs/SYNTHETIC_ORIGIN_PLAN.md` — deliberately not implemented. The deciding
  factor is whether a corpus can be assembled; the code is the cheaper half.
- **Deploy policy v1.4.** Complete in source since 2026-08-02, never deployed.
  Adds bounded advisory MXF, IMF and HDR/Dolby metadata evidence, the house
  delivery template, hash-validated shadow packets and offline Wilson
  evaluation. It claims no AS/IMF/HDR/Dolby conformance. Production still runs
  **v1.1.0** with `AI_INTERPRETIVE_SHADOW=false`; deploying is a separate
  explicit decision.

## Later

- **Native sender for large-file verification.** BLAKE3 range verification stops
  at 16 GiB because the outboard is built in browser wasm, not because of any
  limit in BLAKE3 or storage. `docs/NATIVE_SENDER_PLAN.md` sketches using
  OrbitXfer as an alternative *sender* so the recipient keeps verification with
  no install — and weighs the probably-better alternative of generating the
  outboard server-side. Idea only; not designed in detail.

- **Jury policy 1.1 candidate.** From live pair-policy data: both models caught
  5/5 plants standalone, yet the deployed policy scored 3 reproduced /
  2 contested, because `match_key` requires identical `evidence_ids` — a juror
  flagging the same mutation across a *different* consecutive evidence pair
  reads as contested. Honest but conservative. Consider relaxing to
  overlap-based matching under a bumped `JURY_POLICY_VERSION`, then re-publish
  proficiency: exactly the drift-invalidation flow the passport was designed for.
- **Validate the hybrid lip-sync instance on a real-face clip.** The cartoon
  stimulus proved the mechanism; real mouths are subtler. Do this before leaning
  on it for any certification-adjacent claim.
- **Hybrid framework, next specs.** `qc/hybrid.py` makes logo/watermark
  **persistence** and shot-content **continuity** straightforward new
  `HybridCheck` instances.
- **Dolby Vision dynamic-metadata canvas verification** via `dovi_tool` —
  currently an explicit `REVIEW_REQUIRED` registry item and a real
  specialist-tool gap.
- Queue between gateway and workers, then autoscaling on backlogged
  media-minutes — the metering ledger is already the right signal.
- Per-customer billing on the metering ledger (Stripe/Lago meters).
- Deeper ABR support: segment/ladder playback rather than manifest lint.
- Full-timeline dead-pixel tracking and dedicated click/pop/test-tone
  classifiers. The agentic reporter samples scene/anomaly frames and audio
  windows and requests more evidence, but does not claim exhaustive timeline
  clearance.

## Blocked

Not blocked by defects — blocked on inputs that do not exist yet.

- **Promoting Phase 2 / Phase 3-4 thresholds beyond advisory** needs real,
  decision-backed accepted and rejected deliveries. Do not broaden authority
  from synthetic fixtures alone. Intake gate: `calibration/`,
  `docs/QC_CALIBRATION.md`, `scripts/phase2-quality-proof.sh`.
- **Live calibration of the remaining generated-media stages.** The 2026-07-24
  proficiency session put real GMI through 10 blind assets and validated two of
  five model stages — the coarse **scene ledger** and **native-resolution
  typography**, plus their deterministic reducers, at 5/5 sensitivity and 5/5
  specificity. Still live-unvalidated, mock-proven only: the **planner**
  (`plan_prompt`), the **jittered fine verification** pass, **prompt adherence**,
  and the **artifact/anatomy specialist**. To close it, run one representative
  generated clip plus its `.genblaze.json` through real GMI. Tune prompts or
  normalizers only if a concrete failure appears, and add that failure to
  `scripts/synthetic-qc-proof.sh`.

### The deployed Passport is honestly `UNCALIBRATED`. Leave it that way.

A proficiency manifest exists, WORM-locked on B2 under `proficiency/`
(COMPLIANCE; bound to commit `e85fd947`). **That record is bound to `e85fd947`,
which is not what production runs.**

> **Do not set `WAYSTATION_COMMIT` to an older manifest's commit on the
> production deployment.** `citation_state()` compares the recorded
> configuration against the running one; overriding the commit to match an
> older manifest would manufacture an EXACT citation for code that did not
> produce those numbers. That is falsifying the binding, and it is the one
> thing the whole Passport design exists to prevent. `UNCALIBRATED` is the
> truthful state.

The only honest route to a citable Passport is to publish a *new* manifest
against the exact deployed configuration — commit, model identities, prompts,
reducers, sampling — from a clean worktree, then point
`PROFICIENCY_MANIFEST_PATH` at it. Re-run `--publish` whenever any of those
change; the citation is *supposed* to flip to UNCALIBRATED when they do. Never
alter the production Passport configuration to chase a green label.

## Obsolete

Kept briefly so nobody re-queues them. The Backblaze Generative Media Hackathon
was submitted on 2026-08-03 and judging closed 2026-08-12.

- ~~Record the demo video~~ — the procedure survives in `docs/demo-script.md`
  if a product demo is ever wanted, but no deadline drives it.
- ~~Prepare the 20–45 s showcase asset~~ — same.
- ~~Re-paste the Devpost "What it does" / "What's next" copy~~ — the Devpost
  page is closed; `docs/devpost-about.md` remains as marketing source material.
- ~~Install `mediainfo` on the recording machine~~ — recording-specific polish.
