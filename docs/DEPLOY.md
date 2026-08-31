# Deploying the hosted MVP (Vultr + Cloudflare Tunnel)

Target shape — **all-cloud**: gateway, worker and cloudflared run together on
one VPS. There is no second machine and no dependency on any laptop.

```
orbitolive.com/waystation/   (Cloudflare Pages, pinned static release)
        │ control traffic only: session, sign, complete, transfer, SSE
        ▼
api.orbitolive.com → Cloudflare edge → Tunnel → cloudflared ─┐ private network
                                                   gateway:8787 → worker:8000
        browser ⇄ Backblaze B2 direct (presigned multipart PUT / ranged GET)
        worker  ⇄ Backblaze B2 direct
```

Cloudflare carries only small control messages, the B2 webhook and SSE. The
master file never passes through it.

**Host:** Vultr, ~4 vCPU / 8 GB RAM / 80+ GB SSD, **Ubuntu 24.04 LTS**.

> **Build on the VPS.** Any images built on an Apple-Silicon Mac are
> `linux/arm64` and will not run on an x86_64 host. `docker compose build` on
> the VPS produces `linux/amd64` natively. Do not copy local images across.

---

## 1 · Provision and harden the host

```bash
ssh root@<vps-ip>
adduser waystation && usermod -aG sudo waystation
# copy your key to the new user, then disable password + root SSH login
```

`/etc/ssh/sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`, then
`systemctl restart ssh`.

Firewall — **no inbound ports are needed at all**, because cloudflared dials
*out*:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw enable
```

No 80, no 443, no 8000, no 8787. Outbound TCP/UDP **7844** (tunnel) and HTTPS/DNS
(B2, GMI, package registries) must be permitted — `allow outgoing` covers it.

## 2 · Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker --version && docker compose version
```

## 2b · Scratch data disk  ⚠ *required*

The worker decodes, samples and re-encodes masters in temporary directories. A
single job can transiently use several times the source file size, so that work
gets a **dedicated data disk** — never the root filesystem, never the
container's writable layer.

Attach a block volume, then partition/format/mount it **once** (host
administration; the repo never does this for you and must never reformat a disk
that already holds data). Persist it in `/etc/fstab` by UUID with `nofail`:

```
UUID=<uuid> /mnt/waystation-scratch ext4 defaults,nofail 0 2
```

> Exactly **one** fstab entry per mount point. A LABEL= line and a UUID= line
> for the same path both "work", but systemd then generates two competing
> `.mount` units — remove the duplicate.

Create the layout and validate:

```bash
bash scripts/preflight-scratch.sh --create
```

It checks that the path is a real mount point, is not the root device, has free
space, has the full directory layout, and is genuinely writable (by writing).
It never formats or mounts anything.

Current deployment: `/dev/vdb1`, ext4, ~390 G at `/mnt/waystation-scratch`.

Layout under `/mnt/waystation-scratch/waystation/`:

| Directory | Used today |
|---|---|
| `tmp/` | **yes** — all worker scratch (`TMPDIR`), bound to `/tmp` as well |
| `cache/` | **yes** — `XDG_CACHE_HOME`, `TORCH_HOME` (SyncNet weights ≈1.6 GB), `MPLCONFIGDIR` |
| `logs/` | reserved — logs currently go to the Docker json-file driver, not to disk |
| `uploads/` `jobs/` `runs/` `artifacts/` `exports/` | reserved — **not used today.** Waystation streams uploads browser→B2 and writes derivatives straight back to B2, so nothing stages locally. Created for convention and future use; expect them to stay empty. |

### Overrides

`WAYSTATION_SCRATCH` is the **single source of truth**. The preflight derives
the filesystem to validate *from it* (via `findmnt`), so an override moves the
checks with it and the two cannot drift apart.

| Variable | Default | Purpose |
|---|---|---|
| `WAYSTATION_SCRATCH` | `/mnt/waystation-scratch/waystation` | Scratch root. Compose binds this to `/scratch`; preflight validates whatever filesystem backs it. |
| `WAYSTATION_SCRATCH_MOUNT` | *(unset — derived)* | **Optional pin.** Only set this to assert a specific mount point. If the mount actually backing `WAYSTATION_SCRATCH` is not this, preflight fails. |
| `WAYSTATION_SCRATCH_DEVICE` | *(unset)* | **Optional pin** on the backing device, e.g. `/dev/vdb1`. |
| `WAYSTATION_SCRATCH_MIN_FREE_GB` | `20` | Minimum free space. |

Set only `WAYSTATION_SCRATCH` unless you have a reason to assert more. The pins
exist to catch drift on a host you do not fully control; a mismatch is a hard
failure, not a warning, because a silently-wrong mount is the failure mode this
whole section exists to prevent.

Whatever you set, **a scratch path that resolves to the root filesystem fails
loudly** — that is the one condition the check refuses to let past.

The preflight is Linux-only (it needs `findmnt`). On macOS it exits 0 with a
note: local development uses `docker-compose.yml`, which has no scratch disk.

**The `control` volume deliberately stays on the root disk.** It holds
transfers, uploads and the meter ledger — small, durable state, not scratch.
Keeping it off a disk named "scratch" is what makes "never delete the control
volume" a safe rule.

## 3 · Source

Both repositories are **public**, so clone over HTTPS — the VPS needs no
GitHub credentials, no deploy key and no SSH agent forwarding:

```bash
git clone https://github.com/russomon/waystation.git
cd waystation
git switch codex/hosted-waystation-mvp     # production explicitly tracks this release branch
```

(If the repository is ever made private, this step instead needs a read-only
**deploy key** on the VPS — `ssh-keygen -t ed25519`, add the public half under
GitHub → repo → Settings → Deploy keys — or a fine-grained PAT. Do not forward
your personal SSH agent to a server.)

## 4 · Secrets

Generate the judge code and session secret **on your Mac** (the code prints
once — store it in a password manager, hand it to judges privately, and never
commit it, put it in Devpost text, or show it on screen):

```bash
node scripts/make-access-code.mjs
```

> ### Quote the hash. This one bites hard.
>
> **Docker Compose expands `$NAME` inside `env_file` values.** A scrypt hash is
> full of `$`, and its base64 segments usually start with a letter — so an
> unquoted hash is silently corrupted before it reaches the container.
> Measured, not theorised:
>
> ```
> in .env :  WAYSTATION_ACCESS_CODE_HASH=scrypt$16384$8$1$AAAA==$BBBB=
> container:  scrypt$16384$8$1===          ← $AAAA and $BBBB eaten
> ```
>
> Copy the line from `make-access-code.mjs` **exactly as printed** — it is
> already single-quoted, which survives interpolation intact. `$$`-escaping
> each `$` works too. The gateway now validates the hash structure at boot and
> refuses to start on a mangled one, so this fails loudly rather than
> accepting the code box and rejecting every correct code.

Create `/home/waystation/waystation/.env` on the VPS — never committed:

```bash
B2_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
B2_REGION=<region>
B2_BUCKET=OrBucket
B2_KEY_ID=<key id>
B2_APP_KEY=<application key>
B2_EVENT_SIGNING_SECRET=<from the B2 event rule>
PIPELINE_SHARED_SECRET=<random>
GMI_API_KEY=<gmi key>
GMI_BASE_URL=https://api.gmi-serving.com
# Paste these two lines verbatim from make-access-code.mjs, quotes included:
WAYSTATION_ACCESS_CODE_HASH='scrypt$16384$8$1$<salt>$<hash>'
WAYSTATION_SESSION_SECRET='<session secret>'
TUNNEL_TOKEN=<from Cloudflare, step 5>
MANIFEST_LOCK_DAYS=1
```

```bash
chmod 600 .env
```

`CDN_BASE` / `CDN_TOKEN_SECRET` are deliberately **absent**: the MVP does not
deploy the Cloudflare CDN Worker in `cdn-worker/`. The delivery page serves
presigned B2 URLs from `GET /transfers/:id`, so nothing needs them. Without
them `GET /transfers/:id/download` returns `501 cdn_unconfigured` rather than a
broken link — deploy the Worker first if you ever want that route.

Everything else (auth mode, origins, ceilings, the compute pin) is already set
in `docker-compose.prod.yml` — read it before deploying.

### Large-file ceiling and verification modes

Hosted production accepts masters up to **350 GiB**:

```text
MAX_UPLOAD_BYTES=375809638400
```

The current bao outboard implementation buffers the whole outboard in browser
wasm/JS memory, so verified-range mode is capped separately:

```text
VERIFIED_RANGE_MAX_BYTES=17179869184   # 16 GiB
ALLOW_ROOT_ONLY_UPLOADS=true
```

Transfers at or below `VERIFIED_RANGE_MAX_BYTES` keep the full bao outboard and
offer verified-range download. Larger transfers use **root-only large-file
mode**: the browser still computes and stores the whole-file BLAKE3 root, but it
does not create a `.obao` sidecar and the delivery page does not offer
verified-range download. This is explicit policy, not a silent fallback.

The worker still downloads the whole master to scratch for QC/thumbnail/summary
work. To protect the 390 GB scratch disk, production disables every worker
service above:

```text
MAX_QC_BYTES=107374182400              # 100 GiB
MAX_ACTIVE_UPLOADS_PER_SESSION=1
```

Anything above `MAX_QC_BYTES` is transfer-only regardless of the sender's
checkboxes. The gateway stores that decision before the B2 event path can
dispatch, so a restart cannot resurrect QC for an oversized transfer.

## 5 · Cloudflare Tunnel  ⚠ *owner approval*

Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared):

- Name: `waystation-production`
- Public hostname: `api.orbitolive.com` → Service `http://gateway:8787`
- Copy the tunnel token into `.env` as `TUNNEL_TOKEN`

Cloudflare creates the DNS record for `api.orbitolive.com` automatically. Only
the token enters the cloudflared container — never the application `.env`.

## 6 · Build and start

```bash
bash scripts/preflight-scratch.sh                   # must PASS before starting
docker compose -f docker-compose.prod.yml config -q # validates the compose file
docker compose -f docker-compose.prod.yml build     # ~10-20 min first time, amd64
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs gateway | head -20
```

The worker build compiles only QCTools' headless `qcli` target from pinned
upstream revision `29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2` and installs the
Debian `mediaconch` CLI package at `25.04-2`. It installs no QCTools or
MediaConch GUI application. Verify a newly built image before deployment with:

```bash
bash scripts/archive-tools-docker-proof.sh
bash scripts/broadcast-qc-docker-proof.sh
```

The archive-tools proof verifies installation/provenance and real qcli report
generation. The broadcast proof verifies that MediaConch 25.04 emits MAXML
facts and Waystation's v1 U.S. XDCAM baseline reducer passes/fails known media
shapes. This metadata-policy adapter is active only when profile
`us_broadcast_xdcam_hd_422_v1` is selected; it is not a universal network or
MXF implementation-conformance claim. QCTools is active for this profile as a
bounded advisory evidence collector: up to three eight-second excerpts,
validated signalstats only, with raw XML report hashes. It never makes a
broadcast-compliance decision; unavailable/failed/malformed analysis is
explicitly `FYI · not_checked`.

The worker also compiles targeted deterministic-review packets. Model execution
is spend-disabled by default and must remain explicit:

```text
AI_INTERPRETIVE_SHADOW=false
AI_INTERPRETIVE_SHADOW_MAX_PACKETS=4
ALLOW_AI_INTERPRETIVE=false
AI_INTERPRETIVE_RUN_ENABLED=false
AI_INTERPRETIVE_AUTHORITY_MODE=shadow
```

The legacy AI Interpretive Shadow remains advisory. The separate explicit run
now has a versioned dual-key reducer with `shadow`, `hold`, and `enforce` modes.
Raw model output never changes deterministic checks/status/tiers and can never
clear a deterministic rejection. Production remains gated off and `shadow`;
source support is not runtime activation.

The separate user-visible explicit run is also spend-disabled by default. It
requires gateway permission, worker permission, and sender selection. Its
staged release and rollback procedure is in `docs/AI_INTERPRETIVE_RUN.md`.

### Production worker record — 2026-08-02

The worker-only deployment was built from source commit `ecfcc01` and runs
image `sha256:753b834fbac52381f7a2e6a24795efb42615d7f21fab283d006eb9a583afd9e9`
(created `2026-08-02T20:18:54Z`). Before restart, the image proved qcli
`1.4+29bc627` at the full pinned revision, MediaConch CLI `25.04` from package
`25.04-2`, policy v1.1.0, and imports/routes for deterministic QC, prompt
compilation, cost-aware triage, and interpretive shadow.

Only `worker` was recreated with `--no-deps`; gateway and cloudflared container
IDs were unchanged. The replacement became healthy, internal and public
health endpoints returned `{"ok":true}`, and its image ID matched the inspected
image. Scratch preflight passed on `/dev/vdb1` (ext4, 390 G free), and the
running worker retained the `/scratch` and `/tmp` data-disk bind mounts. No
historical upload was replayed. Future uploads use the cost-aware triage route;
`AI_INTERPRETIVE_SHADOW=false` keeps the new advisory model pass spend-disabled.

Source policy v1.4.0 and its Phase 2-4 plus authority-hardening adapters were
completed after this production record. They include deterministic-only
canonical delivery authority, advisory-only PSE screening, isolated AI shadow
observations, statistical calibration gates, bounded SCC/MCC/RCWT caption
transport analysis, declared audio mapping, bounded MXF/IMF/HDR/Dolby evidence,
a versioned house-template layer, and offline commercial/shadow evaluation
schemas. They are not part of the image above and require a separate worker
deployment decision. AI shadow also remains disabled by default. Do not infer
runtime activation from the host branch or documentation state.

Later source adds the explicit AI review planner and dual-key delivery policy.
That source is also not in the recorded production image. Both paid-run gates
remain false and production authority mode remains `shadow`; no deployment or
AI-spend change was made by the source implementation.

Customer-specific baseline values can be overridden with
`WAYSTATION_BROADCAST_POLICY_OVERRIDES` JSON. Unknown keys fail closed, and
the override plus effective-policy hash are retained in `qc_report.json`; see
`docs/US_BROADCAST_BASELINE.md`.

If the worker fails with a bind-mount error naming `/mnt/waystation-scratch`,
that is the guard working: the scratch path is missing or the disk is not
mounted. Run the preflight above — do **not** "fix" it by creating the
directory on the root disk, which is precisely what the guard prevents.

Confirm heavy writes land on the data disk and not on `/`:

```bash
df -hT /mnt/waystation-scratch /          # watch scratch grow, / stay flat
docker compose -f docker-compose.prod.yml exec worker sh -c 'echo $TMPDIR; df -hT /scratch /tmp'
```

The gateway boot log must show — and **must not** show any secret:

```
auth: access-code (session ttl 3600s)
origins: https://orbitolive.com, https://www.orbitolive.com
state: /data/waystation.db
limits: uploads=accepting max=0.5GiB ... compute=PINNED:cloud
```

If it refuses to start, that is deliberate: under `NODE_ENV=production` the
gateway fails closed on a missing code hash, a short session secret, auth
disabled, or an ephemeral database.

Verify from anywhere:

```bash
curl https://api.orbitolive.com/healthz     # -> {"ok":true}
```

## 7 · Backblaze  ⚠ *owner approval*

**CORS** — add the production origins (browsers PUT parts and GET derivatives
directly; without this the first part upload fails):

```json
[{ "corsRuleName": "orbitolive",
   "allowedOrigins": ["https://orbitolive.com", "https://www.orbitolive.com"],
   "allowedOperations": ["s3_put", "s3_get", "s3_head"],
   "allowedHeaders": ["*"], "exposeHeaders": ["ETag"], "maxAgeSeconds": 3600 }]
```

**Event notification** — point the `b2:ObjectCreated:*` rule (prefix
`transfers/`) at:

```
https://api.orbitolive.com/api/events/b2
```

A stable hostname finally retires re-registering an ephemeral quick-tunnel
before every demo.

**Lifecycle** — add a rule to abort incomplete multipart uploads after ~1 day so
abandoned uploads do not accrue storage.

## 8 · Publish the portal  ⚠ *owner approval*

> **Done on 2026-07-28.** OrbitWebsite `codex/waystation-mvp` was merged to
> `main` (`d432d2c`) and Cloudflare Pages serves the pinned release live. The
> sequence below is retained as the procedure for the *next* release.
>
> One trap worth keeping: Pages answers `200` for **every** path under
> `/waystation/` with a site-wide fallback page until the new deploy lands, so a
> status-code probe gives a false positive. Wait on
> `release-manifest.json` **parsing as JSON** — the fallback returns it as
> `text/html`.

**Order matters.** The release currently pinned in `codex/waystation-mvp`
stays exactly as it is until the API is up and passing. Only then re-export, so
the artifact records the *final* Waystation commit rather than an interim one.

Sequence:

1. Steps 6 and 7 pass — `https://api.orbitolive.com/healthz` returns
   `{"ok":true}`, B2 CORS is live, and the webhook is repointed.
2. From a **clean** Waystation worktree at the final commit:
   ```bash
   bash scripts/export-client.sh          # pins api base + compute=cloud
   ```
3. In OrbitWebsite, on `codex/waystation-mvp`:
   ```bash
   bash scripts/verify-waystation-release.sh    # must PASS
   cd orbitolive && npm run build               # site still builds
   git add orbitolive/public/waystation && git commit   # note the source commit
   ```
4. Run the §9 rehearsal below.
5. **Only then** merge `codex/waystation-mvp` — OrbitWebsite `main` deploys
   automatically, so merging is publication.

## 9 · Rehearsal before recording

All fourteen checks, from a clean private browser (roadmap §7.11):

1. open `https://orbitolive.com/waystation/`
2. a **wrong** code is refused
3. the **judge code** starts a sender session
4. upload the designated small demo asset
5. media goes **directly to B2** — devtools shows PUTs to Backblaze, not to the API
6. the **B2 webhook** reaches the gateway through the tunnel
7. **only the selected services** run
8. **progress SSE** updates the hosted page
9. the **recipient link** opens in a second private browser with **no** sender session
10. QC, generated-media evidence, passport and provenance **render**
11. **download and verify** the result
12. `docker compose -f docker-compose.prod.yml restart gateway` → the transfer
    is **still usable** (options, BLAKE3 root and recipient link survive)
13. **budget and meter records remain correct** — a distinct check from 12:
    ```bash
    # the ledger survived the restart AND did not double-count
    curl -s -b judge.cookies https://api.orbitolive.com/api/transfers/<id>/usage
    ```
    Confirm the units match what actually ran (one `transfer` entry, one `qc`
    entry per run, no duplicates), and that the session/daily job counters still
    reflect the true number of completed jobs.
14. **no public service ports** — from another machine:
    ```bash
    nc -zv <vps-ip> 8787 ; nc -zv <vps-ip> 8000 ; nc -zv <vps-ip> 443
    ```
    all must fail; only the tunnel reaches the gateway.

Capture timestamps, commit ids, model ids, the transfer id and proof results —
never secrets.

**Deployment is not "done" until a VPS exists, `/healthz` answers publicly, and
all fourteen checks above pass.** Until then this is a prepared, locally-proven
configuration and should be described as exactly that.

### Rehearsal record — 2026-07-28 · **14/14 PASSED**

Deployed commit `578d37cd7e8ab4403e3fcd8e377f4a43fd8c8a01` (clean worktree on the
VPS). Portal release pinned to the same commit, published as OrbitWebsite
`d432d2c`. Transfer id **`d292c10b…`**. Models:
`google/gemini-3.5-flash` for both the AI and synthetic lanes; `juror_model:
null`. Asset: `demo-master.mp4` (782,981 B, h264 640×360, 30 fps, 10.0 s) plus
`demo-captions.srt` (239 B) — the **infrastructure rehearsal asset, not the demo
asset**. End-to-end 23:23:28Z → ~23:27:04Z (**~3 m 36 s**).

| # | Check | Result |
|---|---|---|
| 1 | portal opens | ✓ manifest pins `578d37cd7e8a`; both meta pins correct; wasm `application/wasm`; 0 root-absolute `/assets/` refs |
| 2 | wrong code refused | ✓ `401 bad_code` |
| 3 | judge code starts session | ✓ `hasSession:true` (verified in-browser with credentials); gate hidden, compute selector hidden |
| 4 | upload demo asset | ✓ transfer `d292c10b…` |
| 5 | media direct to B2 | ✓ 3 PUTs → `s3.us-west-004.backblazeb2.com` totalling **832,124 B**; largest API request body **416 B** |
| 6 | B2 webhook through the tunnel | ✓ `pipeline_queued` + exactly one `POST /jobs` from the gateway (`172.18.0.3`) + `DEV_TRIGGER_ON_COMPLETE` unset + B2 rule enabled/unsuspended |
| 7 | only selected services run | ✓ `summarize` produced **only** `step_skipped · disabled by sender` — no `step_started`, no `step_done`, no output, no meter entry |
| 8 | progress SSE | ✓ `withCredentials:true`, 20 events, 0 errors |
| 9 | recipient link, no sender session | ✓ 200 with **no cookie**; unknown transfer **404 not 401**; `/usage` 401; foreign-key and traversal `/download` both 404 |
| 10 | QC, evidence, passport, provenance render | ✓ Passport `UNCALIBRATED · "no proficiency manifest for this configuration"`, jury `SINGLE_SOURCE · no juror configured`; generated-media coverage 5/14 assessed, 2 suspected; findings capped at ISSUE |
| 11 | download and verify | ✓ **two mechanisms separately** — SHA-256 3/3 against pipeline `manifest.json`; BLAKE3/Bao ranged verify → `downloaded ✓ (verified)` |
| 12 | survives gateway restart | ✓ recipient doc identical modulo presign params; BLAKE3 root, options and link intact |
| 13 | meter persistence + uniqueness | ✓ ledger identical across restart: 7 rows / 7 distinct keys, no name twice, no `summarize`; counters 1/10 session, 1/60 daily, 0/2 active |
| 14 | no public service ports | ✓ 8787/8000/80/443/9000 closed before **and after** the restart; only SSH 22 |

Local proof suite at the shipped commit: **19 discovered, 19 passed, 0 failed.**

Honest limits recorded rather than papered over:

- **Prompt-adherence QC: NOT RUN** — no source generation record was supplied
  with this asset. A disclosed limitation, not a failure, and not one of the 14
  checks. No generation record was invented to manufacture a pass.
- **`UNCALIBRATED` and `SINGLE_SOURCE` are correct output**, not defects: the
  production configuration has no published proficiency manifest and no second
  juror is configured.
- Check 13 establishes **persistence and observed uniqueness**. It is not a
  proof of `recordMeter()` idempotency — nothing forced a replay. `meter_events`
  has `idempotency_key` as its PRIMARY KEY, so duplicates are structurally
  impossible at the storage layer, but the collapse-on-replay behaviour is
  proven in the local suite, where a callback can be deliberately re-sent.
- Conditional meter lines `qc_ai_escalation`, `qc_ai_evidence_audio`,
  `qc_hybrid_audio` and `qc_jury` correctly did not fire on this asset.

---

## Transfer-only mode (parked / low-cost deployment)

When QC is not needed — a paused project that still moves files — the worker can
be dropped entirely. **Transfer-only never invokes it**: with every service flag
off, the gateway publishes `pipeline_skipped` and no job is dispatched.

```bash
docker compose -f docker-compose.transfer.yml up -d
```

### Sizing

Measured on the full stack: **gateway 118.8 MiB, cloudflared 17.7 MiB** — about
137 MiB total, near-zero CPU. The full stack's 8 GB / 4 vCPU is sized for ffmpeg,
not for signing URLs. **1 vCPU / 1 GB / 25 GB, with no block volume, is ample.**

The gateway has **no `/scratch` mount** (`ls /scratch` inside it → no such file).
The scratch binds are worker-only, which is what lets this mode run with no
attached volume at all.

### How it is enforced

`MAX_QC_BYTES: "0"`. `applyServicePolicy(requested, bytes)` forces every
`PIPELINE_SERVICE_KEY` false when `bytes > MAX_QC_BYTES`; at 0 that is every
upload. This reuses the proven policy path rather than adding a switch, and is:

- **durable** — written into `options_json`, so a restart cannot resurrect QC
- **authoritative** — server-side, not a hidden checkbox
- **disclosed** — the sender is told via `services_disabled`, not silently downgraded

`PIPELINE_URL`, `PIPELINE_URL_CLOUD` and `GATEWAY_PUBLIC_URL` are explicitly set
**empty** rather than omitted: `env_file: .env` is read first, and a `.env`
carried over from a full-QC host may define them. Emptying them makes the
resolved config unambiguous whatever `.env` contains.

Confirm the mode is live from the boot banner: **`maxQC=0.0GiB`**.

### What works, and what does not

| Works | Does not |
|---|---|
| access-code auth, sliding sessions | all QC lanes |
| direct-to-B2 multipart, resumable | AI / interpretive analysis |
| BLAKE3 + bao verified download | thumbnails, summaries |
| recipient links, expiry, revocation | |
| meter ledger, transfer provenance | |

**Keep `B2_EVENT_SIGNING_SECRET` in `.env`.** The B2 event rule is unchanged and
still fires `ObjectCreated`; the gateway verifies the HMAC before answering.
Without it every event returns 401. `GMI_API_KEY` and `PIPELINE_SHARED_SECRET`
are unused in this mode.

The `control` volume is shared with the prod stack, so switching either way
preserves every transfer, recipient link and meter row.

### Returning to full QC

1. Attach a block volume, mount at `/mnt/waystation-scratch`, **one** fstab entry
   by UUID with `nofail`.
2. `bash scripts/preflight-scratch.sh --create` — must PASS.
3. `docker compose -f docker-compose.prod.yml up -d`.

The volume can be any size; it is blank working space. Nothing carries over —
the deterministic tools live in the **worker image**, not on the scratch disk.

## Image archive (provider-independent restore)

```bash
bash scripts/export-images.sh              # export + upload to B2
bash scripts/export-images.sh --local-only # tarballs only
```

A Vultr snapshot already contains these images, so this is insurance, not
duplication — for three reasons:

1. **The Dockerfile is a recipe with a shelf life.** It pins
   `mediaconch=25.04-2`, but Debian rotates old versions out of the main
   archive. Months from now that build can simply fail.
2. A snapshot is **provider-locked**; a tarball restores anywhere.
3. A snapshot contains `.env` — every B2/GMI/session secret. **These tarballs do
   not**, so they are the safer artifact to retain or move.

Uploaded to `artifacts/images/` — deliberately **not** under `transfers/`, which
would trip the B2 event rule on a build artifact. The script refuses that prefix.

Current archive (2026-08-31): worker `753b834fbac5` **372 MB**, gateway
`1c3c81e18b4e` **99 MB**, plus a JSON manifest of ids, build dates, sizes and
SHA-256 digests. **~470 MB total, about $0.003/month.** Verified by round-trip:
the gateway artifact re-downloaded and re-digested to `868c6d4c1c9ad221…`,
matching the export.

Restore:

```bash
# fetch from s3://<bucket>/artifacts/images/ with any S3 client
shasum -a 256 <file>          # compare against the manifest
docker load < <file>
```

No Debian archive, no rebuild, no provider lock-in.

## Runbook

**Stop new spend** (recipient links keep working):

```bash
# edit docker-compose.prod.yml: WAYSTATION_ACCEPT_UPLOADS: "false"
docker compose -f docker-compose.prod.yml up -d gateway
```

**Disable an expensive service** — set `ALLOW_AI_QC` or `ALLOW_SYNTHETIC_QC`
to `"false"` and restart the gateway. The API is authoritative; the UI follows.

**Rotate the judge code** — regenerate, update `WAYSTATION_ACCESS_CODE_HASH`,
restart the gateway, reissue instructions privately, retire the old code.

**Invalidate every session** — rotate `WAYSTATION_SESSION_SECRET`, restart.

**Rotate the tunnel token** — rotate in Cloudflare, update `.env`, restart
cloudflared. No rebuild.

**Roll back the frontend** — restore the previous checksummed release in
OrbitWebsite and redeploy that commit.

**Roll back the backend** — check out the previous commit and rebuild. Never
delete the `control` volume; it holds transfers, uploads and the meter ledger.

**Add measured lip-sync later** (after the base MVP is stable):

```bash
INSTALL_SYNCNET=1 docker compose -f docker-compose.prod.yml build worker
docker compose -f docker-compose.prod.yml up -d worker
```

Adds ~1.6 GB to the image and wants the full 8 GB of RAM.

**Incident evidence** — preserve gateway/worker logs, the `control` volume,
manifest references, image digests and the relevant Cloudflare/B2 event ids.
Never copy credentials into notes.
