# Shared Coding Workflow

Use this routine when moving Waystation between computers, Codex, and Claude
Code. GitHub is the source of truth; consumer file sync (iCloud, Dropbox,
Google Drive) is never used for live source.

## Start On A Computer

```sh
cd /Users/Shared/Orbit/Code/waystation
git status --short --branch          # establish the CURRENT branch — do not assume
git fetch origin
git pull --ff-only                   # fast-forward only, never a merge commit
```

**Do not switch branches to start work.** `codex/hosted-waystation-mvp` is the
trunk — it holds the whole history, and `main` is fast-forwarded to follow it.
Work on whatever branch the repository is already on.

Stop and report, rather than changing anything, if:

- there are uncommitted changes you did not make;
- `git pull --ff-only` refuses because the branches have diverged;
- the current branch has no upstream, or points somewhere unexpected.

Then read, in order:

- `AGENTS.md` — the rules
- `CURRENT_WORK.md` — where we are and the next step
- `NEXT_STEPS.md` — the queue
- `docs/ARCHITECTURE.md` — how the system works, if the task is unfamiliar
- `docs/REPO_MAP.md` — where things live
- `DECISIONS.md` — before contradicting an existing choice
- `CLAUDE.md` when using Claude Code; `SETUP.md` when touching B2 or GMI

## Fresh-Machine Setup

```sh
npm install                                     # workspaces
npm run build:wasm                              # needs cargo + wasm-pack
( cd pipeline && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt )
bash scripts/fetch-photon.sh                    # optional: IMF/Photon (needs openjdk + maven)
cp .env.example .env                            # then fill in per SETUP.md — never commit .env
```

Host tools: `ffmpeg`/`ffprobe`, `minio` (for the proof scripts), optionally
`mediainfo`, `docker`/`colima`, `cloudflared`, `openjdk` + `maven`.

## During Development

- **Read the existing implementation before introducing a pattern.** This
  codebase has settled conventions — bounded ffmpeg windows in `qc/util.py`,
  the check/tier model in `qc/report.py`, the service-policy reducer in
  `gateway/src/limits.ts`. Extend them rather than inventing a parallel one.
- Keep changes focused. Do not fold unrelated cleanup, formatting or dependency
  bumps into a feature commit.
- Preserve work you did not start. If you find unrelated uncommitted changes,
  leave them alone and say so.
- Never use destructive Git: no `push --force`, `reset --hard`, history
  rewriting, or discarding changes you did not make.
- When a durable decision gets made, write it to `DECISIONS.md` in the same
  commit — that is what stops the next agent from re-litigating it.

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
| `scripts/access-proof.sh` | hosted-MVP access control: session required on every upload route, cross-session ownership refused, input validation, exact credentialed CORS + preflight-before-auth, cost ceilings + kill switch, recipient scoping, `/healthz` non-disclosure |
| `scripts/coverage-proof.sh` | detection-coverage upgrades: tiled signal analysis, blind-pass audio, scene/anomaly frame selection, duration scaling, lip-sync proxy |
| `scripts/avsync-proof.sh` | SyncNet AV-sync analyzer: honest-absence FYI, model cannot clear lip_sync; measures offset when SyncNet installed |
| `scripts/hybrid-proof.sh` | perceive-then-compute hybrid: align recovers/abstains, channel-semantics flags dialogue-on-LFE, hybrid WARN→SUSPECTED but PASS never CLEARs (no cloud) |
| `scripts/agentic-qc-proof.sh` | agentic charter, evidence allowlist, 18-risk accounting, no-repair contract |
| `scripts/qc-proof.sh` | deterministic AV + caption QC |
| `scripts/netflix-qc-proof.sh` | Netflix profile, tiers, reporter-only mode, PSE, VMAF |
| `scripts/ai-qc-proof.sh` | blind/informed/critic passes, adaptive evidence, ASR, escalation |
| `scripts/synthetic-qc-proof.sh` | synthetic/generative lane + prompt adherence + reliability-passport fields |
| `scripts/jury-proof.sh` | blind cross-family jury: reducer replay, contested-stays-suspected, prompt blindness, honest single_source |
| `scripts/proficiency-proof.sh` | proficiency foundry: blind planted-defect scoring, manifest provenance, citation states, dirty-worktree refusal, WORM publish |
| `scripts/toggle-proof.sh` | sender service toggles / transfer-only |
| `scripts/delivery-proof.sh` | delivery endpoint + Genblaze manifest verify |
| `scripts/object-lock-proof.sh` | WORM manifest immutability |
| `scripts/phase2-loop-proof.sh` | signed event → pipeline → derivatives |
| `scripts/compute-proof.sh` | local vs Docker worker routing (needs docker) |
| `scripts/docker-proof.sh` | the shipped containers run the full loop (needs docker) |
| `scripts/photon-proof.sh` | Netflix Photon executes on an IMF package |
| `scripts/mediainfo-proof.sh` | optional MediaInfo wrapper/profile checks |
| `scripts/archive-tools-proof.sh` | optional QCTools/MediaConch availability, provenance, and never-silent missing behavior |
| `scripts/archive-tools-docker-proof.sh` | worker image contains pinned headless qcli/MediaConch, qcli generates a report, and no GUI apps exist (needs docker) |
| `scripts/broadcast-qc-proof.sh` | versioned U.S. broadcast XDCAM baseline with actual good/bad media and pure reducer fixtures |
| `scripts/broadcast-qc-docker-proof.sh` | pinned MediaConch MAXML metadata-policy pass/fail outcomes (needs docker) |
| `scripts/ai-authority-proof.sh` | pure dual-key READY/HOLD/REJECT reducer: immutable deterministic gate, evidence/confidence/corroboration rules, shadow/hold/enforce modes |
| `scripts/ai-interpretive-run-proof.sh` | explicit AI planner, parallel specialists, synthesis, B2 evidence hashes, sanitizer, fallback, and dual-key isolation (mock, zero spend) |
| `scripts/ai-interpretive-loop-proof.sh` | full local gateway-worker-MinIO explicit run with four metered mock-GMI stages and SDK-verified manifest |
| `scripts/transfer-mode-proof.sh` | sender contract: transfer-first mode, additive multi-file queue, drag/drop, optional recipient passwords, honest concurrent progress, copyable share URLs |
| `scripts/recipient-password-proof.sh` | optional recipient password over the real gateway + MinIO multipart path |
| `scripts/authority-boundary-proof.sh` | deterministic delivery authority + advisory PSE (no network or media I/O) |
| `scripts/triage-proof.sh` | cost-aware AI triage: the router changes spend decisions only, never verdicts |
| `scripts/ai-thumbnail-proof.sh` | AI poster selection against an SDK-shaped mock; no network or spend |
| `scripts/audio-map-proof.sh` | declared audio-track mapping (pure reducer) |
| `scripts/caption-transport-proof.sh` | bounded SCC decode + CEA transport continuity |
| `scripts/qctools-analysis-proof.sh` | QCTools report reducer, plus missing/malformed states |
| `scripts/phase2-quality-proof.sh` | Phase 2 reducer fixtures — behaviour only, not acceptance |
| `scripts/deep-package-proof.sh` | Phase 3 package/metadata reducers — no conformance claim |
| `scripts/interpretive-shadow-proof.sh` | versioned prompt compiler + opt-in shadow reducer; no spend |
| `scripts/shadow-evaluation-proof.sh` | offline AI-shadow reviewer/evaluation; no model call |
| `scripts/qc-calibration-proof.sh` | calibration intake; no policy file is read or modified |
| `scripts/qc-benchmark-proof.sh` | offline benchmark intake; no commercial result is fabricated |

Each prints `PASS ✓` or `FAIL`. Scripts that need docker/Photon self-skip with
instructions when the dependency is absent.

> **`ls scripts/*-proof.sh` is authoritative, not this table.** The table went
> stale once already — it listed 26 of 40. Before claiming the suite is green,
> enumerate from disk. There is no suite runner yet; see `NEXT_STEPS.md`.

## Handoff Before Switching

1. Update `CURRENT_WORK.md` with what changed, what was validated, and the
   exact next step.
2. Update `NEXT_STEPS.md` if the queue changed.
3. Update `DECISIONS.md` if a durable project decision was made.
4. Run the relevant checks above.
5. Commit and push.

```sh
git status --short
git add <changed-shared-context-files> <changed-source-files>
git commit -m "Describe the completed work"
git push origin "$(git branch --show-current)"     # the working branch, not a guess
```

`main` is then fast-forwarded to match, so the GitHub default branch keeps
telling the truth:

```sh
git checkout main && git merge --ff-only codex/hosted-waystation-mvp
git push origin main && git checkout codex/hosted-waystation-mvp
```

Finally, report: **branch, HEAD, what was validated, and the exact next step.**
Do not leave unexplained uncommitted work — but equally, do not commit
incomplete or misleading work merely to produce a clean tree. If something is
left uncommitted on purpose, say which files and why.

## Branch Discipline

- **`codex/hosted-waystation-mvp` is the trunk.** It holds the entire history —
  105 commits back to the first scaffold — and ordinary work happens there. The
  `codex/` prefix is only a name from when the work started; it does not mean
  the branch belongs to a particular agent.
- **`main` is a follower**, fast-forwarded to the trunk after each push. The two
  should always be equal; if they are not, say so before doing anything else.
- Use a separate named branch only for parallel or risky work, and merge or
  delete it promptly — a stale branch is a trap for the next agent.
- Before switching machines, make sure the current branch is pushed.
- On the next machine, pull before opening a coding agent.

## Secrets

`.env` holds real Backblaze B2 and GMI Cloud credentials and is gitignored.
Never echo, print, or commit secret values — lint by length/prefix only. Also
keep out of Git: `vendor/` (Photon jars), `node_modules/`, `pipeline/.venv/`,
`.devdata/`, `target/`, `crates/*/pkg*/`, and test fixtures written into
`client/public/`.
