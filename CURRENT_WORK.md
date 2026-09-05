# Current Work

Repo: waystation
Updated: 2026-09-04
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
| Production source | `5bb5952` |
| Gateway image | `1c3c81e18b4e` — **restored from B2**, not rebuilt |
| Portal | OrbitWebsite `511f52a` at `https://orbitolive.com/waystation/` |
| API | `https://api.orbitolive.com` behind an outbound-only Cloudflare Tunnel |
| QC ceiling | `MAX_QC_BYTES: "1"` — every pipeline service forced off |

Transfers, recipient links, download passwords, verified download, expiry and
the meter ledger all work. Every QC, AI, thumbnail and summary lane is absent —
not disabled in the UI, absent from the deployment.

The full QC engine is **complete in source and proven**, but not deployed. Do
not assume a running worker, a scratch disk, or GMI spend.

## Recently completed

- **2026-09-04** — shared-context V2 migration: `docs/ARCHITECTURE.md`,
  `docs/REPO_MAP.md` and `docs/PROJECT_HISTORY.md` added; handoff files
  restructured into their roles.
- **2026-09-02** — `docs/DEFERRED_TOOLING.md` added and wired into
  `docs/DEPLOY.md` → *"Returning to full QC"*; `AGENTS.md` brought up to date
  with the parked deployment.
- **2026-09-01** — protected transfers shipped as a **gateway-only** production
  change. Optional 1–128 character download password, salted scrypt record,
  transfer-scoped signed HttpOnly unlock cookies. Control DB migrated v2→v3 in
  place, `integrity_check=ok`, existing rows preserved.
- **2026-09-01** — transfer-first sender: Transfer is the default tab, additive
  multi-file selection and drag-and-drop, each file an independent resumable
  transfer with its own share link.

## Validated

- Public health 200; unauthenticated upload initiation 401; unknown recipient
  capability returns a neutral 404.
- All four hosted artifacts match the release manifest.
- Auth-enabled MinIO proof covered one-character passwords, wrong-password
  refusal, all three recipient gates, restart persistence, and rejection at 129
  characters. A real local browser upload proved both progress tracks.
- The image restore path is proven both ways: the running gateway *is* a B2
  restore, and the worker image was downloaded, digest-matched and loaded.

## Open

- **Not explicitly reconfirmed in writing:** that the rotated access code
  authenticates at the portal. Everything downstream has behaved as though it
  does. If a login ever fails, test the code against the stored hash before
  regenerating — that distinguishes "wrong code" from "wrong hash" in one step.
- `codex/hosted-cloud-control` has carried one unmerged commit since
  2026-08-04 ("Show hosted cloud compute selection"). Decide whether to merge
  or delete it.
- There is no proof-suite runner. All 40 `scripts/*-proof.sh` are invoked
  individually.

## Blockers

None.

## Next step

No engineering work is queued or required. Waystation is parked and usable as a
transfer tool.

When work resumes, read `NEXT_STEPS.md` for the queue. If the next task touches
the worker image or brings QC back, read `docs/DEFERRED_TOOLING.md` **first** —
a running full-QC box is the cheapest moment to add deterministic tooling, and
the register exists so that research is not repeated.

## For the next agent

Read `AGENTS.md`, then this file. `docs/ARCHITECTURE.md` explains how the
system fits together and `docs/REPO_MAP.md` says where to look. Do not restart
from the journal in `docs/PROJECT_HISTORY.md` — it is history, and parts of it
were only ever true on their date.
