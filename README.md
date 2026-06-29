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

```bash
cp .env.example .env            # fill in B2 + secrets
npm install                     # installs gateway/client/cdn-worker workspaces
npm run build:wasm              # needs: cargo + wasm-pack
npm run dev:gateway             # :8787
npm run dev:client              # :5173  (proxies /api → gateway)
npm run dev:pipeline            # :8000  (needs: python deps + ffmpeg)
# expose the gateway for B2 webhooks in dev:  cloudflared tunnel --url http://localhost:8787
```

## Status

- ✅ Upload (presigned multipart, parallel, resumable via `ListParts`)
- ✅ BLAKE3 root content-address; verified whole-file download
- ✅ B2 Event Notification → gateway → Genblaze pipeline dispatch → SSE progress
- ⏳ **v1:** bao outboard for verified *range/resumable* download
- ⏳ Real Genblaze/GMI step bodies (seams marked `TODO` in `pipeline/worker.py`)
- ⏳ Recipient delivery page + provenance `verify` button + B2 Object Lock

## Gotchas

1. **B2 CORS must `exposeHeaders: ["ETag"]`** or `complete` fails (`config/b2-cors.json`).
2. **Pipeline writes go under `derivatives/`** so they don't re-trigger the event; the gateway also drops `.obao` sidecars.
3. On Cloudflare Workers, the gateway's presigning would switch from `@aws-sdk` to `aws4fetch` (already used by `cdn-worker`).
