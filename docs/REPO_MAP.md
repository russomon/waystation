# Repo Map

Where to look. For *how it works* see `docs/ARCHITECTURE.md`.

## Shared context (repository root)

```
AGENTS.md                  durable instructions for every coding agent — read first
CLAUDE.md                  Claude Code specifics only
CURRENT_WORK.md            current state and the exact next step
NEXT_STEPS.md              the work queue
DECISIONS.md               47 dated durable decisions and their rationale
SHARED_CODING_WORKFLOW.md  session startup, validation commands, handoff
README.md                  front door: architecture summary, proof scripts, status
SETUP.md                   B2 / GMI account setup for a fresh environment
```

## Source

```
gateway/src/               Hono/Node control plane — 12 modules
  server.ts                  entry point: app assembly, CORS, boot banner
  routes.ts                  every HTTP route
  auth.ts                    access codes, sessions, recipient unlock
  db.ts                      SQLite schema + migrations (schema v3)
  s3.ts                      B2 presigning and multipart bookkeeping
  limits.ts                  size ceilings, service policy, verification mode
  events.ts  pipeline.ts     B2 webhook · worker dispatch
  sse.ts  store.ts           progress fan-out
  metering.ts  env.ts        usage ledger · environment loading

client/src/                Vite + TypeScript browser app — 11 modules
  main.ts                    the sender
  delivery.ts                the recipient page
  uploader.ts                resumable multipart, concurrency 6
  resumeStore.ts             resume state
  hashWorker.ts hashClient.ts  BLAKE3 off the main thread
  downloader.ts blake3.ts    verified download
  fileQueue.ts clipboard.ts config.ts

pipeline/                  Python 3.13 FastAPI worker
  worker.py                  entry point — GET /healthz, POST /jobs
  qc/                        30 analyzer modules
    util.py                    shared ffmpeg helpers, bounded analysis windows
    report.py                  the check/tier model and finalize()
    structural.py video.py audio.py text.py    core deterministic lanes
    broadcast.py phase2.py imf.py deep_package.py    profile adapters
    agentic.py generated.py hybrid.py interpretive*.py    AI lanes
    jury.py foundry.py calibration.py    the reliability passport
    archive_tools.py mediainfo.py qctools.py avsync.py    external instruments
  policies/                  versioned JSON policy packs
  requirements.txt  Dockerfile

cdn-worker/src/index.ts    Cloudflare Worker: token-gated B2 streaming
crates/blake3-outboard/    Rust → wasm: BLAKE3 + bao outboard (src/lib.rs)
```

## Operations

```
scripts/                   40 *-proof.sh capability proofs, plus drivers:
                             dev-up.sh, live-run.sh, live-event-run.sh
                             fetch-photon.sh, fetch-syncnet.sh
                             export-images.sh, export-client.sh
                             preflight-scratch.sh, b2-register-events.sh
                             make-access-code.mjs, verify-b2.sh
config/                    b2-cors.json, b2-event-notification.json
calibration/               corpus intake and benchmark JSON schemas
docker-compose.yml         local development on MinIO
docker-compose.prod.yml    full QC — gateway + worker + cloudflared + scratch
docker-compose.transfer.yml  transfer-only — gateway + cloudflared, no worker
```

## Documentation

```
docs/ARCHITECTURE.md       how the system works
docs/REPO_MAP.md           this file
docs/DEPLOY.md             provisioning, live deployment record, restore paths
docs/DEFERRED_TOOLING.md   worker-image tooling queued for when QC resumes
docs/US_BROADCAST_BASELINE.md  the versioned house broadcast baseline
docs/QC_CALIBRATION.md     corpus intake gate
docs/AI_INTERPRETIVE_RUN.md    explicit interpretive run records
docs/DEEP_PACKAGE_AND_SHADOW_EVALUATION.md
docs/SYNTHETIC_ORIGIN_PLAN.md  designed, deliberately NOT implemented
docs/PROJECT_HISTORY.md    archived session journal — history, not current state
docs/demo-script.md  docs/devpost-about.md    hackathon-era material
```

## Not source-controlled

Generated, vendored or installed — never edit, never commit:

```
node_modules/              npm workspaces
pipeline/.venv/            Python virtualenv
pipeline/__pycache__/
vendor/                    Netflix Photon jars (scripts/fetch-photon.sh)
crates/*/pkg/  pkg-node/   wasm-pack output
crates/*/target/           Rust build
.env                       real B2 / GMI credentials — never print or commit
```

## Where do I look for…

| Task | Start at |
|---|---|
| an HTTP endpoint | `gateway/src/routes.ts` |
| upload / resume behaviour | `client/src/uploader.ts`, `gateway/src/s3.ts` |
| a size ceiling or service toggle | `gateway/src/limits.ts` |
| the database schema | `gateway/src/db.ts` |
| a QC check | `pipeline/qc/` — the orchestrator is `run_qc()` in `pipeline/worker.py` |
| adding an external instrument | `pipeline/qc/archive_tools.py` + `docs/DEFERRED_TOOLING.md` |
| what is deployed | `docs/DEPLOY.md` |
| why something is the way it is | `DECISIONS.md` |
