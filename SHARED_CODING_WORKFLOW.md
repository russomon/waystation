# Shared Coding Workflow

Use this routine when moving Waystation between computers, Codex, and Claude
Code. GitHub is the source of truth; consumer file sync (iCloud, Dropbox,
Google Drive) is never used for live source.

## Start On A Computer

```sh
cd /Users/Shared/Orbit/Code/waystation      # see the path note below
git status --short --branch
git fetch origin
git switch main
git pull --ff-only
```

If there are uncommitted changes you did not make, stop and report before
changing anything.

Then ask the coding agent to read:

- `AGENTS.md`
- `CLAUDE.md` when using Claude Code
- `CURRENT_WORK.md`
- `NEXT_STEPS.md`
- `DECISIONS.md`
- `SETUP.md` when the task touches B2 or GMI credentials

### Path note

On the M4 mini this checkout is still at
`/Users/Shared/Orbit/Code/orbitxfer-web` (the directory predates the rename to
Waystation). A fresh clone should use `.../Code/waystation`. See
`NEXT_STEPS.md`.

## Fresh-Machine Setup

```sh
npm install                                     # workspaces
npm run build:wasm                              # needs cargo + wasm-pack
( cd pipeline && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt )
bash scripts/fetch-photon.sh                    # optional: IMF/Photon (needs openjdk + maven)
cp .env.example .env                            # then fill in per SETUP.md — never commit .env
```

Host tools: `ffmpeg`/`ffprobe`, `minio` (for the proof scripts), optionally
`docker`/`colima`, `cloudflared`, `openjdk` + `maven`.

## Checks Before Handoff

Run the checks relevant to what changed. Compile checks are cheap — run all
three every time:

```sh
( cd gateway && npx tsc --noEmit )              # gateway type-check
npm -w client run build                         # client build
( cd pipeline && PIPELINE_SHARED_SECRET=x B2_BUCKET=b B2_S3_ENDPOINT=http://x \
    B2_KEY_ID=x B2_APP_KEY=x B2_REGION=x .venv/bin/python -c "import worker" )
```

Proof scripts — self-contained on MinIO + ffmpeg, no cloud creds needed. Run
the ones covering the area you touched; run all before a submission-worthy
handoff:

| Script | Covers |
|---|---|
| `scripts/qc-proof.sh` | deterministic AV + caption QC |
| `scripts/netflix-qc-proof.sh` | Netflix profile, tiers, self-heal, PSE, VMAF |
| `scripts/ai-qc-proof.sh` | AI lane: vision, ASR caption accuracy, escalation |
| `scripts/synthetic-qc-proof.sh` | synthetic/generative lane + prompt adherence |
| `scripts/toggle-proof.sh` | sender service toggles / transfer-only |
| `scripts/delivery-proof.sh` | delivery endpoint + Genblaze manifest verify |
| `scripts/object-lock-proof.sh` | WORM manifest immutability |
| `scripts/phase2-loop-proof.sh` | signed event → pipeline → derivatives |
| `scripts/compute-proof.sh` | local vs Docker worker routing (needs docker) |
| `scripts/docker-proof.sh` | the shipped containers run the full loop (needs docker) |
| `scripts/photon-proof.sh` | Netflix Photon executes on an IMF package |

Each prints `PASS ✓` or `FAIL`. Scripts that need docker/Photon self-skip with
instructions when the dependency is absent.

## Handoff Before Switching

1. Update `CURRENT_WORK.md` with what changed, what was validated, and the
   exact next step.
2. Update `NEXT_STEPS.md` if the queue changed.
3. Update `DECISIONS.md` if a durable project decision was made.
4. Run the relevant checks above.
5. Commit and push.

```sh
git status --short
git add AGENTS.md CLAUDE.md CURRENT_WORK.md NEXT_STEPS.md DECISIONS.md SHARED_CODING_WORKFLOW.md
git add <changed-source-files>
git commit -m "Describe the completed work"
git push origin main
```

## Branch Discipline

- Use `main` for sequential work when only one computer is active.
- Use a named branch for parallel or risky work.
- Before switching machines, make sure the current branch is pushed.
- On the next machine, pull before opening a coding agent.

## Secrets

`.env` holds real Backblaze B2 and GMI Cloud credentials and is gitignored.
Never echo, print, or commit secret values — lint by length/prefix only. Also
keep out of Git: `vendor/` (Photon jars), `node_modules/`, `pipeline/.venv/`,
`.devdata/`, `target/`, `crates/*/pkg*/`, and test fixtures written into
`client/public/`.
