# OrbitXfer Web

Send huge media — it arrives smarter. High-speed delivery over **Backblaze B2**
(the cloud waystation) with an AI enrichment pipeline (**Genblaze + GMI Cloud**)
that runs while the file is parked, and a verifiable provenance trail.

Built for the [Backblaze Generative Media Hackathon](https://backblaze-generative-media.devpost.com/).

## Flow

```
browser ──parallel multipart (BLAKE3)──▶ B2 (originals)
                                          │ object-created Event Notification
                                          ▼
                                   gateway /api/events/b2
                                          │ dispatch
                                          ▼
                              Genblaze pipeline (GMI Cloud)
                       transcode preview · transcribe · caption · summarize · tag
                                          │ derivatives + provenance manifest
                                          ▼
                                  B2 (derivatives/)   ──CDN──▶ recipient
        progress streams the whole way via SSE (gateway /api/progress/:id)
```

## Layout

| Path | What |
|---|---|
| `gateway/` | Control plane (Hono/Node): presigned URLs, `ListParts` resume, **B2 event webhook → pipeline**, SSE progress. Never touches bytes. |
| `client/` | Browser app (Vite/TS): chunk + BLAKE3 + parallel multipart upload, resumable; verified download. |
| `crates/blake3-outboard/` | Rust→wasm BLAKE3 (root now; bao outboard for verified range download next). |
| `cdn-worker/` | Cloudflare Worker: token-gated streaming from the private B2 bucket (free B2→CF egress). |
| `pipeline/` | Python Genblaze worker: fan-out AI steps on GMI Cloud, writes manifest to B2. |
| `config/` | B2 CORS + Event Notification rule. |

## Run (local)

One command brings up the whole stack on MinIO (no cloud creds needed) — open
`localhost:5173`, drag in a small video, watch the pipeline, open the share link:

```bash
# one-time setup
npm install                                    # workspaces
npm run build:wasm                             # needs cargo + wasm-pack
( cd pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt )  # needs ffmpeg

# every time
bash scripts/dev-up.sh                          # MinIO + gateway + pipeline + Vite client
#   GMI_API_KEY=... bash scripts/dev-up.sh      # to enable the real summarize step
```

Or run pieces individually: `npm run dev:gateway` · `dev:client` · `dev:pipeline`.
For real B2 webhooks in dev, expose the gateway: `cloudflared tunnel --url http://localhost:8787`.

Multipart is assembled server-side from `ListParts`, so the browser never reads
part ETags — no cross-origin Expose-Headers needed (works on MinIO and B2).

## Status

- ✅ **Phase 1 — transfer, verified end-to-end** (`gateway/scripts/e2e.mjs`,
  passed at 40 MB + 250 MB on a real S3 API): presigned multipart upload →
  `ListParts` resume → complete → download → BLAKE3 verify.
- ✅ **Phase 2 slice — reactive loop, verified end-to-end**
  (`scripts/phase2-loop-proof.sh`): signed B2 event → gateway → pipeline
  doing **real work** (ffprobe metadata + ffmpeg poster frame) → provenance
  manifest + derivatives in storage → live SSE progress. Loop-safe
  (outputs under `derivatives/`).
- ✅ **Recipient delivery page** (`/?t=<id>`) — preview, AI summary,
  download, and a working **Verify provenance** button (re-hashes the
  original + derivatives, compares to the manifest). Endpoint
  `GET /api/transfers/:id`; proven by `scripts/delivery-proof.sh`.
- ✅ **bao outboard — verified, resumable, tamper-checked range download.**
  Upload produces a `.obao` sidecar; download pulls the object in
  chunk-aligned ranges and verifies each against the BLAKE3 root before
  accepting (`crates/blake3-outboard` + `client/src/downloader.ts`).
  Native cargo tests + the comprehensive `gateway/scripts/e2e.mjs` cover it.
- ✅ **B2 Object Lock on the manifest** — when `MANIFEST_LOCK_DAYS > 0`, the
  provenance manifest is written WORM (COMPLIANCE retention): immutable,
  even to the account owner, until expiry. Proven by
  `scripts/object-lock-proof.sh` (locked version cannot be deleted).
  Requires the bucket created with Object Lock enabled.
- ⏳ Swap the **summarize/transcribe** seam in `pipeline/worker.py` for a real
  GMI Cloud / Genblaze call (gated on `GMI_API_KEY` today).

Reproduce locally (no cloud creds), each self-contained on MinIO + ffmpeg:
`bash scripts/phase2-loop-proof.sh` · `bash scripts/delivery-proof.sh` ·
`node gateway/scripts/e2e.mjs` (with a gateway pointed at MinIO/B2).

## Gotchas

1. **B2 CORS must `exposeHeaders: ["ETag"]`** or `complete` fails (`config/b2-cors.json`).
2. **Pipeline writes go under `derivatives/`** so they don't re-trigger the event; the gateway also drops `.obao` sidecars.
3. On Cloudflare Workers, the gateway's presigning would switch from `@aws-sdk` to `aws4fetch` (already used by `cdn-worker`).
