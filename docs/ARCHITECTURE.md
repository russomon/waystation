# Architecture

How Waystation fits together. For *where* things live see `docs/REPO_MAP.md`;
for what is currently deployed see `docs/DEPLOY.md`; for why things are the way
they are see `DECISIONS.md`.

## System purpose

Waystation moves large media files to Backblaze B2 with cryptographic
verification, and — when asked — runs a broadcast-grade QC report over them
before delivering a recipient link.

Two properties shape every design choice:

1. **The control plane never touches file bytes.** Browsers upload directly to
   B2 with presigned URLs. The gateway signs, records and reports; it never
   proxies media.
2. **Deterministic instruments and AI are separate gates.** AI can describe and
   advise. It can never clear, overwrite or downgrade an instrument reading.
   See *Architectural constraints* below.

## High-level architecture

```
browser (client/)                    Backblaze B2
  │  presign, bookkeeping                 ▲  direct multipart PUT
  ▼                                       │
gateway (gateway/src/)  ──────────────────┘
  │  Hono/Node · SQLite · SSE
  │
  │  HMAC-signed b2:ObjectCreated ──► POST /events/b2
  │
  ├─► POST /jobs ──► worker (pipeline/)   FastAPI · ffmpeg · QC · Genblaze
  │                    │
  │   ◄── POST /internal/progress ────────┘
  │
  └─► SSE /progress/:id ──► sender UI
                             recipient delivery page
                                  │
                                  └─► cdn-worker (Cloudflare) ──► B2
```

## Major components

### Gateway — `gateway/src/`

Hono on `@hono/node-server`. Entry point `server.ts`. The only stateful service.

| Module | Responsibility |
|---|---|
| `server.ts` | app assembly, CORS, boot banner |
| `routes.ts` | every HTTP route |
| `auth.ts` | access-code login, sliding sessions, recipient unlock |
| `db.ts` | SQLite schema and migrations |
| `s3.ts` | B2 presigning, multipart bookkeeping |
| `limits.ts` | size ceilings and the service-policy reducer |
| `events.ts` | B2 event webhook verification |
| `pipeline.ts` | worker dispatch |
| `sse.ts`, `store.ts` | progress fan-out |
| `metering.ts` | the usage ledger |
| `env.ts` | environment loading — imported **first**, before `s3.ts` reads it |

**Routes.** Sender: `POST /session`, `/session/logout`, `/uploads`,
`/uploads/parts`, `/uploads/complete`, `/uploads/outboard-url`,
`/uploads/sidecar-url`. Recipient: `GET /transfers/:id`,
`/transfers/:id/download`, `POST /transfers/:id/unlock`,
`GET /transfers/:id/usage`. Machine: `POST /events/b2`,
`POST /internal/progress`, `GET /progress/:transferId` (SSE).

One deliberate ordering detail: **CORS is registered before the session gate.**
Hono's `cors()` answers an `OPTIONS` preflight and returns without calling
`next()`, so a preflight can never reach auth. With auth first, every
credentialed cross-origin request would fail at preflight.

### Client — `client/src/`

Vite + TypeScript. `main.ts` is the sender, `delivery.ts` the recipient page.

Uploads run through `uploader.ts` (resumable multipart, concurrency 6) with
`resumeStore.ts` persisting resume state. Hashing runs in a Web Worker
(`hashWorker.ts` / `hashClient.ts`) so BLAKE3 finalization cannot block the main
thread — a lesson learned the hard way on a 27 GiB master. `downloader.ts`
handles verified download; `delivery.ts` owns the save-picker streaming path.

### Worker — `pipeline/`

FastAPI on uvicorn. `worker.py` exposes exactly two routes: `GET /healthz` and
`POST /jobs`. **Stateless** — everything durable lands back in B2, so it deploys
anywhere and scales horizontally.

`pipeline/qc/` holds 30 modules. The orchestrator `run_qc()` runs analyzer
groups in a fixed order — structural parsing, then signal video, then audio,
then text — each wrapped so a crashed probe degrades to a finding instead of
killing the report. `pipeline/policies/` holds versioned JSON policy packs.

Deterministic analysis shells out to ffmpeg/ffprobe over **bounded windows**
(`qc/util.py: analysis_windows`) so runtime stays flat on long masters. Optional
external instruments — MediaInfo, MediaConch, QCTools qcli, Netflix Photon,
SyncNet — report an explicit FYI when absent, never a silent pass.

### CDN worker — `cdn-worker/`

A Cloudflare Worker. Verifies the gateway's short-lived HMAC token, then streams
the object from the private bucket. B2→Worker egress is free under the Bandwidth
Alliance and Cloudflare caches hot ranges; range requests pass through so
verified streaming works.

### Hashing crate — `crates/blake3-outboard/`

Rust compiled to wasm. BLAKE3 plus a bao outboard for range verification. The
outboard measures ~6% of source size. Above 16 GiB the client switches to
root-only mode and skips the `.obao` — `verificationModeForSize()` decides, and
the server is authoritative.

## Data flow

**Transfer.** Sender authenticates → `POST /uploads` initiates a multipart
upload and records the transfer → `POST /uploads/parts` returns presigned part
URLs → the **browser PUTs parts directly to B2** → `POST /uploads/complete`
assembles from the part list B2 itself holds, so the browser never needs part
ETags and no CORS `Expose-Headers` is required.

**QC (when ordered).** B2 fires `b2:ObjectCreated` → `POST /events/b2` verifies
the HMAC → the gateway dispatches `POST /jobs` to the worker → the worker runs
deterministic QC, then the AI lanes if enabled, writes a Genblaze manifest under
Object Lock, and posts back to `POST /internal/progress` → the gateway fans out
over SSE to the sender and the delivery page.

With every service flag off — the current production posture — the gateway
publishes `pipeline_skipped` and **no job is dispatched at all**.

**Delivery.** The recipient opens `/transfers/:id`, unlocks with a password if
one was set, and downloads either through a presigned B2 GET or the CDN worker.

## Persistence and state

SQLite in the `control` Docker volume at `/data`. Three tables — `transfers`,
`uploads`, `meter_events` — at **schema v3**, migrated in place via
`PRAGMA user_version` (`gateway/src/db.ts`).

It runs in **WAL mode**, which has bitten this project: `cp waystation.db`
yields a nearly empty file that still passes `integrity_check`. Always back up
with `VACUUM INTO`. See `docs/DEPLOY.md`.

The worker holds no state. Scratch space is temporary and, in the full-QC
deployment, bound to a dedicated data disk so heavy writes never reach the root
filesystem.

## External dependencies

| Service | Used for |
|---|---|
| **Backblaze B2** | object storage, S3 multipart, Event Notifications, Object Lock (COMPLIANCE/WORM), lifecycle rules, versioning |
| **GMI Cloud** | the AI QC lanes — vision, ASR, prompt engines |
| **Cloudflare** | Tunnel (outbound-only ingress, so no inbound ports and a new instance IP needs no DNS change), Pages for the static portal, Workers for token-gated streaming |
| **Genblaze SDK** | `genblaze-core` orchestration and canonical provenance manifests |

## Build and runtime model

An npm workspace (`gateway`, `client`, `cdn-worker`) plus a Python 3.13 venv for
`pipeline/` and a Rust/wasm crate. Three compose files, and the choice between
them *is* the deployment posture:

| File | Stack |
|---|---|
| `docker-compose.yml` | local development, MinIO |
| `docker-compose.prod.yml` | full QC — gateway, worker, cloudflared, scratch disk |
| `docker-compose.transfer.yml` | **transfer-only** — gateway + cloudflared, no worker |

They are standalone rather than layered overrides, because Compose merges
additively: an override can add a service but cannot remove one.

## Architectural constraints

Violating these silently breaks guarantees the project makes publicly.

- **Only instruments reject.** No AI finding may be a BLOCKER;
  `checks_from_findings` caps every agentic finding at ISSUE. Only the explicit,
  versioned AI authority reducer may turn corroborated, evidence-cited
  interpretive findings into HOLD/REJECT.
- **Waystation reports; it never repairs.** No transformation or remediation in
  the QC path.
- **The worker is stateless.** Keep it that way.
- **The gateway never touches file bytes.**
- **Every capability claim needs a passing proof script.** See
  `SHARED_CODING_WORKFLOW.md`.
- **Production is fail-closed.** With `NODE_ENV=production` the gateway refuses
  to boot on a missing code hash, a short session secret, disabled auth, or an
  ephemeral database.
- **The server is authoritative, never the UI.** Hiding a control is not
  enforcement; ceilings and service policy are applied server-side and written
  durably into the transfer's options.

## Related documentation

`docs/REPO_MAP.md` · `docs/DEPLOY.md` · `docs/DEFERRED_TOOLING.md` ·
`docs/US_BROADCAST_BASELINE.md` · `docs/QC_CALIBRATION.md` ·
`docs/AI_INTERPRETIVE_RUN.md` · `docs/DEEP_PACKAGE_AND_SHADOW_EVALUATION.md` ·
`docs/SYNTHETIC_ORIGIN_PLAN.md` (designed, deliberately not implemented)
