# Current Work

Repo: waystation
Updated: 2026-09-11
Branch: `codex/hosted-waystation-mvp` (the trunk — `main` is fast-forwarded to
follow it, and the two should always be equal)

Compact current-state handoff. Keep it that way: this file answers "where are
we and what is the next step", nothing else. Durable decisions go to
`DECISIONS.md`, deployment evidence to `docs/DEPLOY.md`, and finished session
narrative to `docs/PROJECT_HISTORY.md`.

## State

**QC development is parked. Production is transfer-only and has no worker.**

| | |
|---|---|
| Live stack | `docker-compose.transfer.yml` — gateway + cloudflared only |
| Host | Vultr Los Angeles, 1 vCPU / 1 GB / 25 GB, no block volume |
| Gateway source | `9a47e9e` — pulled and rebuilt in place 2026-09-11 (gateway container only; cloudflared untouched since 2026-09-01) |
| Portal | OrbitWebsite `b7fb649`, client pinned to `539c4ab`, at `https://orbitolive.com/waystation/` |
| API | `https://api.orbitolive.com` behind an outbound-only Cloudflare Tunnel |
| QC ceiling | `MAX_QC_BYTES: "1"` — every pipeline service forced off |
| Upload ceilings | `MAX_ACTIVE_UPLOADS_PER_SESSION=3` (24 h window), jobs/session 10, jobs/day 20 (global) |

Transfers, recipient links, download passwords, mediated parallel downloads
(resumable, pausable, range-verified under ~4 GB), upload pause/resume, expiry
and the meter ledger all work. Every QC, AI, thumbnail and summary lane is absent —
not disabled in the UI, absent from the deployment.

The full QC engine is **complete in source and proven**, but not deployed. Do
not assume a running worker, a scratch disk, or GMI spend.

## Recently completed

- **2026-09-11** — the sender is asked for the password too. `recipientGate`
  takes the unlock cookie only; a separate `progressGate` keeps the sender
  exemption on `/progress/:id` alone, so the parked QC send-page stream is
  unchanged. Gateway rebuilt on the VPS. `DECISIONS.md` 2026-09-11.
- **2026-09-08** — verification merged into the single download (the separate
  "Download (verified)" button and `client/src/downloader.ts` are gone);
  `planRanges` is 1024-aligned for bao; one decimal `client/src/format.ts` for
  both pages; "Resume send" label; interrupted uploads no longer wedge a session
  (`countActive` is age-bounded, ceiling raised 1→3).
- **2026-09-07** — downloads are gateway-mediated (`GET /transfers/:id/original`,
  `?format=json` because a browser cannot fetch a cross-origin redirect), links
  built from `X-Forwarded-Proto`/`Host`, twelve parallel ranges (measured 91 MB/s
  ≈ 729 Mb/s), resumable via Range + IndexedDB bookkeeping with the record
  written **only after `close()`**, pause buttons for download and upload,
  out-of-space named as the cause. Rehearsal 15/15 + 1 N/A; access code rotated.
- **2026-09-04** — shared-context V2 migration; **2026-09-11** upgraded to
  V2.1 (`.cursor/commands/` wrappers).
- **2026-09-01** — protected transfers and the transfer-first sender shipped
  (details in `docs/PROJECT_HISTORY.md` and `DECISIONS.md`).

## Validated

- 2026-09-11: `recipient-password-proof.sh` (sender 401 on the three delivery
  routes, 200 on progress — both mutation-tested) plus mediated-download,
  transfer-mode, access, delivery, resumable-download and parallel-download
  proofs all PASS; gateway type-checks; production health 200, unknown id 404.
- 2026-09-08: a real 7.52 GB and a 28 GB browser download exercised the FSA
  save path, pause/resume, and the concurrency measurements in `docs/DEPLOY.md`.
- 2026-09-07: release rehearsal 15/15 transfer-path checks, QC check 10 N/A.
- Every proof guard added this month was mutation-tested before it was trusted.

## Open

- **`X-Forwarded-Host` trust.** `mediatedDownloadUrl` builds the download link
  from `X-Forwarded-Proto`/`X-Forwarded-Host`. Confirm a client cannot supply
  those through Cloudflare (cloudflared should overwrite them); if it can, the
  link host must come from configuration instead. Not yet checked.
- **Awaiting user confirmation** that the merged verified download (`539c4ab`)
  produces a playable file after a pause/resume, and that the status line
  reports "every range verified against BLAKE3" for a sub-4 GB transfer.
- `codex/hosted-cloud-control` has carried one unmerged commit since
  2026-08-04 ("Show hosted cloud compute selection"). Decide whether to merge
  or delete it.
- There is no proof-suite runner. All 43 `scripts/*-proof.sh` are invoked
  individually.

## Blockers

None.

## Next step

The engine is parked, but the **direction is set**: turn Waystation into a
client-facing paid transfer service. `docs/COMMERCIAL_DELIVERY_PLAN.md` holds
the design and the decisions already taken; `NEXT_STEPS.md` holds the ordered
track. Steps 2 (mediated download) and 5 (parallel ranges) are done. **Step 1,
payment + identity, remains blocked on an undecided pricing model** — nothing
on the commercial track can start until the user decides what is charged for.

Until then the actionable items are the two in **Open** above and the two
under **Now** in `NEXT_STEPS.md`. If the next task touches the worker image or
brings QC back, read `docs/DEFERRED_TOOLING.md` **first**.

## For the next agent

Read `AGENTS.md`, then this file. `docs/ARCHITECTURE.md` explains how the
system fits together and `docs/REPO_MAP.md` says where to look. Do not restart
from the journal in `docs/PROJECT_HISTORY.md` — it is history, and parts of it
were only ever true on their date.
