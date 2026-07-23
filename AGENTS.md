# Agent Guidance

## Project

Waystation is a cloud-waystation media delivery system: verified transfer to
Backblaze B2 with a broadcast-grade QC engine, an AI/prompt-native QC lane on
GMI Cloud, read-only agentic reporting, and WORM-locked Genblaze provenance. Built for the
Backblaze Generative Media Hackathon (submission deadline 2026-08-03).

GitHub: `git@github.com:russomon/waystation.git` (public)

## Start Here

- `README.md` — architecture, the judge-facing proof scripts, deploy guide.
- `CURRENT_WORK.md` — the current handoff state.
- `NEXT_STEPS.md` — the short forward queue.
- `DECISIONS.md` — durable project decisions.
- `SHARED_CODING_WORKFLOW.md` — the cross-computer handoff routine.
- `SETUP.md` — Backblaze B2 / GMI account setup for a fresh environment.

## Layout

| Path | What |
|---|---|
| `gateway/` | Hono/Node control plane: presigned URLs, B2 event webhook, SSE, metering. Never touches file bytes. |
| `client/` | Vite/TS sender + recipient delivery page; Rust→wasm BLAKE3/bao. |
| `pipeline/` | Python 3.13 FastAPI worker: deterministic QC, agentic AI reporting, Genblaze manifests. |
| `crates/blake3-outboard/` | Rust→wasm BLAKE3 + bao outboard. |
| `cdn-worker/` | Cloudflare Worker for token-gated B2 streaming. |
| `scripts/` | One-command proof scripts + live/dev drivers. |
| `docs/` | Devpost copy and the demo shot list. |

## Project Rules

- Waystation is a **separate product** from OrbitXfer (the P2P desktop app).
  Do not merge the two repos or move code between them without being asked.
- **Every capability claim must have a proof script.** If you add a feature,
  add or extend a `scripts/*-proof.sh` that asserts it, and keep the existing
  proofs green. Claims in `README.md` / `docs/devpost-about.md` must be
  reproducible or explicitly marked as honestly gated.
- **Never commit secrets.** `.env` is gitignored and the full history has been
  scanned clean. Also keep out: `vendor/` (Photon jars), `node_modules/`,
  `pipeline/.venv/`, `.devdata/`, `target/`, `client/public/` test fixtures.
- **Internal/competitive documents stay out of this repo** — they live in the
  user's Claude project directory, not here. This repo is public.
- Deterministic checks (ffmpeg/ffprobe measurements, Photon, hashes) and AI
  checks (GMI vision/ASR/prompt engines) are **separate lanes**. AI verdicts
  annotate; they never overwrite an instrument reading.
- Waystation is a **read-only QC reporter**. Do not add media repair or
  transformation actions to the QC path. Every applicable registered risk
  must receive an explicit disposition, including unresolved gaps.
- The pipeline worker is **stateless** — everything durable lands in B2. Keep
  it that way so it deploys anywhere and scales horizontally.
- Python **3.13+** is required (`genblaze-core` floor).

## Useful Commands

```sh
# fresh machine
npm install                                     # workspaces
npm run build:wasm                              # needs cargo + wasm-pack
( cd pipeline && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt )
bash scripts/fetch-photon.sh                    # optional: IMF/Photon (needs openjdk + maven)

# run the whole stack locally on MinIO (no cloud creds)
bash scripts/dev-up.sh                          # → localhost:5173

# real B2 + GMI, public webhook via cloudflared
bash scripts/live-event-run.sh
bash scripts/b2-register-events.sh              # once Backblaze enables Event Notifications

# containers
docker compose up --build
```

## Done Means

- The relevant proof scripts pass (see `SHARED_CODING_WORKFLOW.md`).
- `gateway` type-checks, `client` builds, `pipeline` imports.
- `CURRENT_WORK.md`, `NEXT_STEPS.md`, `DECISIONS.md` updated.
- Committed and pushed to `origin/main`.
